"""Proposals waiting for a human: the payments and purchase orders the agents propose.

Proposals are dashboard state, not shop data, so they live in data/proposals.json next to
the working database and are cleared when the database is reset. Agents can only add
proposals (through their run output). Only the /approve and /reject routes change their status.
"""
from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel

from backend.models import ProposedPayment, ProposedPurchaseOrder, TicketDecision

STORE_PATH = Path(__file__).resolve().parent.parent / "data" / "proposals.json"
_lock = threading.Lock()

ProposalStatus = Literal["pending", "approved", "rejected", "superseded"]


class Proposal(BaseModel):
    id: str
    ticket_id: int
    run_id: str
    type: Literal["payment", "purchase_order"]
    amount: float | None
    details: dict[str, Any]
    status: ProposalStatus = "pending"
    created_at: str
    decided_at: str | None = None
    decided_by: str | None = None
    note: str | None = None
    execution: dict[str, Any] | None = None  # the MCP tool result once approved


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _load() -> list[Proposal]:
    if not STORE_PATH.exists():
        return []
    return [Proposal(**p) for p in json.loads(STORE_PATH.read_text(encoding="utf-8"))]


def _save(items: list[Proposal]) -> None:
    tmp = STORE_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps([p.model_dump() for p in items], indent=2), encoding="utf-8")
    os.replace(tmp, STORE_PATH)


def list_all(ticket_id: int | None = None, status: str | None = None) -> list[Proposal]:
    with _lock:
        items = _load()
    return [p for p in items if (ticket_id is None or p.ticket_id == ticket_id)
            and (status is None or p.status == status)]


def get(proposal_id: str) -> Proposal | None:
    return next((p for p in list_all() if p.id == proposal_id), None)


def record_from_decision(run_id: str, decision: TicketDecision) -> list[Proposal]:
    """Store the payments and purchase orders from a Boss decision as pending proposals.

    Any older pending proposals for the same ticket are marked superseded, so a re-run can't
    leave two live copies of the same payment.
    """
    new: list[Proposal] = []
    for pay in decision.proposed_payments:
        new.append(_make(run_id, decision.ticket_id, "payment", pay.amount, pay))
    for po in decision.proposed_purchase_orders:
        new.append(_make(run_id, decision.ticket_id, "purchase_order", po.estimated_cost, po))
    with _lock:
        items = _load()
        for p in items:
            if p.ticket_id == decision.ticket_id and p.status == "pending":
                p.status, p.decided_at, p.note = "superseded", _now(), f"Replaced by run {run_id}"
        items.extend(new)
        _save(items)
    return new


def _make(run_id: str, ticket_id: int, type_: str, amount: float | None,
          item: ProposedPayment | ProposedPurchaseOrder) -> Proposal:
    return Proposal(id=f"p-{uuid.uuid4().hex[:8]}", ticket_id=ticket_id, run_id=run_id, type=type_,
                    amount=amount, details=item.model_dump(), created_at=_now())


def decide(proposal_id: str, status: Literal["approved", "rejected"], by: str,
           note: str | None = None, execution: dict | None = None) -> Proposal:
    with _lock:
        items = _load()
        p = next(p for p in items if p.id == proposal_id)
        p.status, p.decided_at, p.decided_by, p.note, p.execution = status, _now(), by, note, execution
        _save(items)
    return p


def clear() -> None:
    with _lock:
        _save([])
