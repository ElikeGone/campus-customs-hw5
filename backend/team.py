"""The five Campus Customs agents and the delegation tool that connects them.

Every shop fact comes from the campus-customs MCP server (mcp_server/server.py), which
reads data/campus_customs_new.db. Every agent can delegate to every other agent,
within the limits below.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from fastmcp import Client
from pydantic_ai import Agent, RunContext
from pydantic_ai.mcp import MCPToolset
from pydantic_ai.toolsets import WrapperToolset
from pydantic_ai.usage import UsageLimits

from backend import audit
from backend.llm import make_model
from backend.models import AgentName, AgentReport, DelegationRecord, TeamDeps, TicketDecision

ROOT = Path(__file__).resolve().parent.parent
PROMPTS = Path(__file__).resolve().parent / "prompts"

# Same server as the campus-customs entry in .mcp.json, with absolute paths so it runs from any cwd.
MCP_CONFIG = {
    "mcpServers": {
        "campus-customs": {
            "command": sys.executable,
            "args": [str(ROOT / "mcp_server" / "server.py")],
            "cwd": str(ROOT),
        }
    }
}

# Limits per ticket. The usage counters are shared across every delegated agent on the ticket.
MAX_DELEGATION_DEPTH = 3       # boss -> specialist -> specialist; no deeper
MAX_DELEGATIONS_PER_TICKET = 8
TICKET_USAGE_LIMITS = UsageLimits(
    request_limit=30,          # model requests by all agents combined
    tool_calls_limit=40,       # MCP tools and delegate calls combined
    total_tokens_limit=300_000,
)

# The MCP tools each role may call. Anything outside its lane goes through delegation.
MCP_TOOLS_BY_AGENT: dict[AgentName, set[str]] = {
    "boss": {"get_open_tickets", "check_stock_and_price", "get_invoice_details",
             "get_lease_and_cash", "get_vendors"},
    "inventory": {"check_stock_and_price", "get_vendors"},
    "accounting": {"check_stock_and_price", "get_invoice_details", "get_lease_and_cash", "get_vendors"},
    "facilities": {"get_lease_and_cash"},
    "customer_service": {"check_stock_and_price"},
}

AGENT_NAMES: tuple[AgentName, ...] = tuple(MCP_TOOLS_BY_AGENT)

# MCP tools that change data. Only the backend's human-approval and ticket-status code may
# call them, so no agent may ever have one on its allowlist.
HUMAN_ONLY_MCP_TOOLS = {"apply_approved_payment", "apply_approved_purchase_order", "set_ticket_status"}
assert not any(tools & HUMAN_ONLY_MCP_TOOLS for tools in MCP_TOOLS_BY_AGENT.values()), \
    "An agent must never be allowed to call a write tool."


class AuditedToolset(WrapperToolset[TeamDeps]):
    """Logs every MCP tool call an agent makes to the audit trail."""

    async def call_tool(self, name: str, tool_args: dict[str, Any], ctx: RunContext[TeamDeps], tool) -> Any:
        deps = ctx.deps
        agent = deps.chain[-1] if deps.chain else None
        try:
            result = await super().call_tool(name, tool_args, ctx, tool)
        except Exception as exc:
            audit.record("mcp_tool_call", run_id=deps.run_id, agent=agent, ticket_id=deps.ticket_id,
                         action=name, inputs=tool_args, outcome=f"error: {type(exc).__name__}")
            raise
        audit.record("mcp_tool_call", run_id=deps.run_id, agent=agent, ticket_id=deps.ticket_id,
                     action=name, inputs=tool_args, result=result, outcome="ok")
        return result


async def delegate(ctx: RunContext[TeamDeps], to_agent: AgentName, task: str) -> dict:
    """Hand a task to another agent on the team and get its report back.

    Args:
        to_agent: One of boss, inventory, accounting, facilities, customer_service.
        task: A self-contained description of what you need, including the ticket id and any
            ids, SKUs or sizes involved. The other agent cannot see your conversation.
    """
    deps = ctx.deps
    me = deps.chain[-1]
    depth = len(deps.chain)
    record = DelegationRecord(from_agent=me, to_agent=to_agent, task=task, depth=depth)
    if to_agent == me:
        record.error = "An agent cannot delegate to itself."
    elif to_agent in deps.chain:
        record.error = (
            f"{to_agent} is already working on this request higher up the chain "
            f"({' -> '.join(deps.chain)}). Return your findings in your report instead."
        )
    elif depth >= MAX_DELEGATION_DEPTH:
        record.error = f"Delegation depth limit ({MAX_DELEGATION_DEPTH}) reached. Finish with what you have."
    elif len(deps.trace) >= MAX_DELEGATIONS_PER_TICKET:
        record.error = f"Delegation limit for this ticket ({MAX_DELEGATIONS_PER_TICKET}) reached."
    deps.trace.append(record)
    if record.error:
        audit.record("delegation", run_id=deps.run_id, agent=me, ticket_id=deps.ticket_id,
                     action=f"delegate -> {to_agent}", inputs=task, outcome=f"refused: {record.error}")
        return {"ok": False, "error": record.error}

    audit.record("delegation", run_id=deps.run_id, agent=me, ticket_id=deps.ticket_id,
                 action=f"delegate -> {to_agent}", inputs=task, outcome="started", depth=depth)
    sub_deps = TeamDeps(run_id=deps.run_id, ticket_id=deps.ticket_id,
                        chain=[*deps.chain, to_agent], trace=deps.trace)
    try:
        result = await run_agent(to_agent, task, sub_deps, usage=ctx.usage)
    except Exception as exc:  # surface the failure to the caller instead of guessing
        record.error = f"{type(exc).__name__}: {exc}"
        return {"ok": False, "error": record.error}
    record.result = result if isinstance(result, AgentReport) else None
    return {"ok": True, "report": result.model_dump()}


async def run_agent(name: AgentName, task: str, deps: TeamDeps, usage=None):
    """Run one agent as one audited loop step, within the ticket's shared usage limits."""
    audit.record("agent_step_start", run_id=deps.run_id, agent=name, ticket_id=deps.ticket_id,
                 inputs=task, chain=" -> ".join(deps.chain))
    try:
        result = await TEAM[name].run(task, deps=deps, usage=usage, usage_limits=TICKET_USAGE_LIMITS)
    except Exception as exc:
        audit.record("agent_step_end", run_id=deps.run_id, agent=name, ticket_id=deps.ticket_id,
                     outcome=f"stopped: {type(exc).__name__}: {exc}")
        raise
    out = result.output
    summary = out.decision if isinstance(out, TicketDecision) else out.summary
    audit.record("agent_step_end", run_id=deps.run_id, agent=name, ticket_id=deps.ticket_id,
                 result=summary, outcome="completed",
                 needs_human_approval=out.needs_human_approval,
                 requests_so_far=result.usage.requests)
    return out


def _build_team() -> dict[AgentName, Agent]:
    model = make_model()
    mcp = AuditedToolset(MCPToolset(Client(MCP_CONFIG)))
    team: dict[AgentName, Agent] = {}
    for name in AGENT_NAMES:
        allowed = MCP_TOOLS_BY_AGENT[name]
        team[name] = Agent(
            model,
            name=name,
            deps_type=TeamDeps,
            output_type=TicketDecision if name == "boss" else AgentReport,
            instructions=(PROMPTS / f"{name}.md").read_text(encoding="utf-8"),
            tools=[delegate],
            toolsets=[mcp.filtered(lambda ctx, tool, allowed=allowed: tool.name in allowed)],
            retries=2,
        )
    return team


TEAM: dict[AgentName, Agent] = _build_team()
