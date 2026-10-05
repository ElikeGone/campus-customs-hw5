"""FastAPI backend for the Campus Customs operations dashboard.

Every shop read and write goes through the campus-customs MCP server, which uses
data/campus_customs_new.db. Agents only propose payments and purchase orders. Cash changes
only in POST /proposals/{id}/approve, after a named human explicitly approves.

Run from the backend folder (the assignment's command):  uvicorn main:app --reload --port 8000
or from the project root:                                uvicorn backend.main:app --reload --port 8000
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import uuid
from pathlib import Path

# When started as `uvicorn main:app` from backend/, the project root isn't on sys.path,
# so the `backend.*` imports below would fail. Add it once.
_PROJECT_ROOT = str(Path(__file__).resolve().parent.parent)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastmcp import Client
from fastmcp.exceptions import ToolError
from pydantic import BaseModel, Field

from backend import audit, proposals
from backend.models import Ticket, TicketDecision
from backend.proposals import Proposal
from backend.run_tickets import handle_ticket
from backend.team import MCP_CONFIG, ROOT

ORIGINAL_DB = ROOT / "data" / "campus_customs.db"
WORKING_DB = ROOT / "data" / "campus_customs_new.db"
RUNS_DIR = ROOT / "output" / "api_runs"

app = FastAPI(title="Campus Customs Operations API", version="1.0")

# Only the Vite dev server for the dashboard (frontend/, `npm run dev` on port 5173) may call
# this API from a browser. Override with a comma-separated CORS_ORIGINS if needed.
CORS_ORIGINS = [o.strip() for o in os.getenv(
    "CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

# One operation that changes state at a time: an agent run, an approval or a reset.
_ops_lock = asyncio.Lock()


# ----------------------------------------------------------------------------- models

class TicketOut(Ticket):
    pending_proposals: int = 0


class TicketsResponse(BaseModel):
    today: str | None
    tickets: list[TicketOut]


class RunResponse(BaseModel):
    run_id: str
    ticket_id: int
    decision: TicketDecision | None
    error: str | None
    delegations: list[dict[str, Any]]
    proposals: list[Proposal]
    ticket_status: str


class EventsResponse(BaseModel):
    count: int
    events: list[dict[str, Any]]


class ApproveRequest(BaseModel):
    approved_by: str = Field(min_length=1, description="Name of the human approving this.")
    confirm: Literal[True] = Field(description="Must be true: an explicit human confirmation.")


class RejectRequest(BaseModel):
    rejected_by: str = Field(min_length=1)
    reason: str | None = None


class DecisionResponse(BaseModel):
    proposal: Proposal
    ticket_status: str
    cash_after: float | None = None


class CashResponse(BaseModel):
    account: str
    balance: float
    date: str


class ResetRequest(BaseModel):
    confirm: Literal[True] = Field(description="Must be true: resetting erases all progress.")


class ResetResponse(BaseModel):
    reset: bool
    tickets: list[dict[str, Any]]
    cash: CashResponse


# ----------------------------------------------------------------------------- MCP helpers

async def mcp_call(tool: str, args: dict | None = None) -> dict:
    """Call one tool on the campus-customs MCP server."""
    async with Client(MCP_CONFIG) as client:
        res = await client.call_tool(tool, args or {})
    return res.structured_content


def _tool_error_to_http(exc: ToolError) -> HTTPException:
    msg = str(exc)
    for needle, code in [("Insufficient cash", "insufficient_cash"), ("already", "duplicate"),
                         ("will not ship", "vendor_has_unpaid_invoice"), ("mismatch", "stale_proposal"),
                         ("not found", "not_found")]:
        if needle in msg:
            return HTTPException(404 if code == "not_found" else 409, {"code": code, "message": msg})
    return HTTPException(422, {"code": "refused_by_safety_check", "message": msg})


async def _get_ticket(ticket_id: int) -> dict:
    tickets = (await mcp_call("get_tickets"))["tickets"]
    t = next((t for t in tickets if t["id"] == ticket_id), None)
    if t is None:
        raise HTTPException(404, {"code": "ticket_not_found",
                                  "message": f"Ticket {ticket_id} does not exist.",
                                  "valid_ids": [t["id"] for t in tickets]})
    return t


async def _refresh_ticket_status(ticket_id: int) -> str:
    """Resolve the ticket once every proposal from its latest run is approved."""
    live = [p for p in proposals.list_all(ticket_id) if p.status != "superseded"]
    if not live:
        return (await _get_ticket(ticket_id))["status"]
    latest_run = max(live, key=lambda p: p.created_at).run_id
    latest = [p for p in live if p.run_id == latest_run]
    status = "resolved" if all(p.status == "approved" for p in latest) else "open"
    await mcp_call("set_ticket_status", {"ticket_id": ticket_id, "status": status})
    return status


def _busy() -> HTTPException:
    return HTTPException(409, {"code": "busy", "message": "Another run, approval or reset is in progress."})


# ----------------------------------------------------------------------------- routes

@app.get("/tickets", response_model=TicketsResponse)
async def list_tickets() -> TicketsResponse:
    """Every ticket with its status (open or resolved) and how many proposals await approval."""
    data = await mcp_call("get_tickets")
    pending = proposals.list_all(status="pending")
    return TicketsResponse(today=data["today"], tickets=[
        TicketOut(**t, pending_proposals=sum(p.ticket_id == t["id"] for p in pending))
        for t in data["tickets"]
    ])


@app.post("/tickets/{ticket_id}/run", response_model=RunResponse)
async def run_ticket(ticket_id: int) -> RunResponse:
    """Run the agent team (Boss first) on one ticket. Agents may only propose financial actions."""
    if _ops_lock.locked():
        raise _busy()
    async with _ops_lock:
        t = await _get_ticket(ticket_id)
        if t["status"] != "open":
            raise HTTPException(409, {"code": "ticket_not_open",
                                      "message": f"Ticket {ticket_id} is {t['status']}. Reset to run it again."})
        run_id = uuid.uuid4().hex[:12]
        audit.record("run_start", run_id=run_id, agent="api", ticket_id=ticket_id, inputs={"route": "run"})
        result = await handle_ticket(run_id, Ticket(**t))
        decision = TicketDecision(**result["decision"]) if result["decision"] else None
        new = proposals.record_from_decision(run_id, decision) if decision else []
        if decision and not new:
            status = "resolved"
            await mcp_call("set_ticket_status", {"ticket_id": ticket_id, "status": status})
        else:
            status = t["status"]
        audit.record("run_end", run_id=run_id, agent="api", ticket_id=ticket_id,
                     outcome="decided" if decision else f"stopped: {result['error']}",
                     proposals=[p.id for p in new], ticket_status=status)
        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        (RUNS_DIR / f"{run_id}_ticket{ticket_id}.json").write_text(json.dumps(result, indent=2))
        return RunResponse(run_id=run_id, ticket_id=ticket_id, decision=decision, error=result["error"],
                           delegations=result["delegations"], proposals=new, ticket_status=status)


@app.get("/events", response_model=EventsResponse)
async def recent_events(limit: int = Query(50, ge=1, le=500), ticket_id: int | None = None,
                        agent: str | None = None) -> EventsResponse:
    """Most recent audit events, newest first: agent steps, delegations and MCP tool calls."""
    path = audit.AUDIT_PATH
    events = json.loads(path.read_text(encoding="utf-8")) if path.exists() and path.stat().st_size else []
    if ticket_id is not None:
        events = [e for e in events if e.get("ticket_id") == ticket_id]
    if agent:
        events = [e for e in events if e.get("agent") == agent]
    events = events[-limit:][::-1]
    return EventsResponse(count=len(events), events=events)


@app.get("/proposals", response_model=list[Proposal])
async def list_proposals(status: str | None = None, ticket_id: int | None = None) -> list[Proposal]:
    """Proposed payments and purchase orders, optionally filtered by status or ticket."""
    return proposals.list_all(ticket_id=ticket_id, status=status)


@app.post("/proposals/{proposal_id}/approve", response_model=DecisionResponse)
async def approve_proposal(proposal_id: str, body: ApproveRequest) -> DecisionResponse:
    """Human approval: the only place cash changes. The MCP tool re-checks everything against the DB."""
    if _ops_lock.locked():
        raise _busy()
    async with _ops_lock:
        p = proposals.get(proposal_id)
        if p is None:
            raise HTTPException(404, {"code": "proposal_not_found", "message": f"No proposal {proposal_id}."})
        if p.status != "pending":
            raise HTTPException(409, {"code": "duplicate" if p.status == "approved" else "not_pending",
                                      "message": f"Proposal {proposal_id} is already {p.status}."})
        if p.amount is None:
            raise HTTPException(422, {"code": "missing_amount", "message": "The proposal has no amount."})
        d = p.details
        try:
            if p.type == "payment":
                execution = await mcp_call("apply_approved_payment", {
                    "kind": d["kind"], "ref_id": d["ref_id"], "account": d["account"],
                    "approved_by": body.approved_by, "expected_amount": p.amount,
                    "for_due_date": d.get("for_due_date"),
                })
            else:
                execution = await mcp_call("apply_approved_purchase_order", {
                    "vendor_id": d["vendor_id"], "sku": d["sku"], "size": d["size"], "qty": d["qty"],
                    "account": d.get("account", "checking"), "approved_by": body.approved_by,
                    "expected_amount": p.amount,
                })
        except ToolError as exc:
            audit.record("approval", run_id=p.run_id, agent="human", ticket_id=p.ticket_id,
                         action=f"approve {proposal_id}", inputs={"by": body.approved_by},
                         outcome=f"refused: {exc}")
            raise _tool_error_to_http(exc) from exc
        p = proposals.decide(proposal_id, "approved", body.approved_by, execution=execution)
        audit.record("approval", run_id=p.run_id, agent="human", ticket_id=p.ticket_id,
                     action=f"approve {proposal_id}", inputs={"by": body.approved_by},
                     result={"payment_id": execution["payment_id"], "amount": execution["amount"],
                             "cash_after": execution["cash_after"]}, outcome="executed")
        status = await _refresh_ticket_status(p.ticket_id)
        return DecisionResponse(proposal=p, ticket_status=status, cash_after=execution["cash_after"])


@app.post("/proposals/{proposal_id}/reject", response_model=DecisionResponse)
async def reject_proposal(proposal_id: str, body: RejectRequest) -> DecisionResponse:
    """Human rejection. Cash is not touched and the ticket stays open."""
    if _ops_lock.locked():
        raise _busy()
    async with _ops_lock:
        p = proposals.get(proposal_id)
        if p is None:
            raise HTTPException(404, {"code": "proposal_not_found", "message": f"No proposal {proposal_id}."})
        if p.status != "pending":
            raise HTTPException(409, {"code": "not_pending", "message": f"Proposal {proposal_id} is already {p.status}."})
        p = proposals.decide(proposal_id, "rejected", body.rejected_by, note=body.reason)
        audit.record("approval", run_id=p.run_id, agent="human", ticket_id=p.ticket_id,
                     action=f"reject {proposal_id}", inputs={"by": body.rejected_by}, outcome="rejected")
        return DecisionResponse(proposal=p, ticket_status=await _refresh_ticket_status(p.ticket_id))


@app.get("/cash", response_model=CashResponse)
async def checking_balance() -> CashResponse:
    """The current checking balance from cash_accounts."""
    accounts = (await mcp_call("get_cash_accounts"))["cash_accounts"]
    checking = next((a for a in accounts if a["name"] == "checking"), None)
    if checking is None:
        raise HTTPException(404, {"code": "account_not_found", "message": "No 'checking' account in cash_accounts."})
    return CashResponse(account="checking", balance=checking["balance"], date=checking["date"])


@app.post("/reset", response_model=ResetResponse)
async def reset_database(body: ResetRequest) -> ResetResponse:
    """Copy the original database over the working copy and clear proposals. The original is read only."""
    if _ops_lock.locked():
        raise _busy()
    async with _ops_lock:
        if not ORIGINAL_DB.exists():
            raise HTTPException(500, {"code": "original_missing", "message": "data/campus_customs.db not found."})
        tmp = WORKING_DB.with_suffix(".db.tmp")
        shutil.copyfile(ORIGINAL_DB, tmp)
        tmp.replace(WORKING_DB)
        proposals.clear()
        audit.record("reset", run_id="reset", agent="human", action="reset working database",
                     outcome="working copy restored from data/campus_customs.db; proposals cleared")
        tickets = (await mcp_call("get_tickets"))["tickets"]
        return ResetResponse(reset=True, tickets=[{"id": t["id"], "status": t["status"]} for t in tickets],
                             cash=await checking_balance())
