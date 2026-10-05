"""Ticket loop: read open tickets through MCP, hand each one to the Boss, and save the decisions.

Run from the project root:  .venv/Scripts/python -m backend.run_tickets [ticket_id ...]
"""
from __future__ import annotations

import asyncio
import json
import sys
import uuid
from datetime import datetime, timezone

from fastmcp import Client

from backend import audit
from backend.models import TeamDeps, Ticket
from backend.team import MCP_CONFIG, ROOT, run_agent

OUT_PATH = ROOT / "output" / "team_run.json"


async def load_open_tickets(run_id: str, ids: list[int] | None = None) -> list[Ticket]:
    """Read the open tickets through the MCP server's get_open_tickets tool."""
    async with Client(MCP_CONFIG) as client:
        res = await client.call_tool("get_open_tickets", {})
    tickets = [Ticket(**t) for t in res.structured_content["tickets"]]
    audit.record("mcp_tool_call", run_id=run_id, agent="ticket_loop", action="get_open_tickets",
                 result=[t.id for t in tickets], outcome="ok")
    return [t for t in tickets if ids is None or t.id in ids]


async def handle_ticket(run_id: str, ticket: Ticket) -> dict:
    deps = TeamDeps(run_id=run_id, ticket_id=ticket.id, chain=["boss"])
    prompt = f"New ticket to resolve:\n{ticket.model_dump_json(indent=2)}"
    try:
        decision, error = (await run_agent("boss", prompt, deps)).model_dump(), None
    except Exception as exc:
        decision, error = None, f"{type(exc).__name__}: {exc}"
    audit.record("ticket_end", run_id=run_id, agent="boss", ticket_id=ticket.id,
                 outcome="decided" if decision else f"stopped: {error}",
                 delegations=len(deps.trace))
    return {
        "ticket": ticket.model_dump(),
        "decision": decision,
        "error": error,
        "delegations": [r.model_dump() for r in deps.trace],
    }


async def main(ids: list[int] | None) -> None:
    run_id = uuid.uuid4().hex[:12]
    audit.record("run_start", run_id=run_id, agent="ticket_loop", inputs={"ticket_ids": ids or "all open"})
    runs = [await handle_ticket(run_id, t) for t in await load_open_tickets(run_id, ids)]
    audit.record("run_end", run_id=run_id, agent="ticket_loop", outcome="completed", tickets=len(runs))
    OUT_PATH.parent.mkdir(exist_ok=True)
    OUT_PATH.write_text(json.dumps(
        {"run_id": run_id, "run_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "runs": runs},
        indent=2,
    ))
    print(f"Saved {len(runs)} ticket run(s) to {OUT_PATH}")


if __name__ == "__main__":
    asyncio.run(main([int(a) for a in sys.argv[1:]] or None))
