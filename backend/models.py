"""Shared data types for the Campus Customs agent team."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from pydantic import BaseModel, Field

AgentName = Literal["boss", "inventory", "accounting", "facilities", "customer_service"]


class Ticket(BaseModel):
    """One row of the tickets table, passed to the Boss as-is."""

    id: int
    type: str
    requester: str
    subject: str
    sku: str | None = None
    size: str | None = None
    qty: int | None = None
    lease_id: int | None = None
    invoice_id: int | None = None
    status: str
    notes: str | None = None
    created_at: str


class ProposedPayment(BaseModel):
    """A payment an agent recommends. It is never executed without human approval."""

    kind: Literal["invoice", "lease"] = Field(description='"invoice" for a vendor invoice, "lease" for rent.')
    ref_id: int = Field(description="The invoice id or lease id being paid.")
    for_due_date: str | None = Field(
        None, description="For rent only: the lease's next_due date that this payment covers."
    )
    amount: float
    account: str = Field(description="Cash account to pay from, as named in cash_accounts.")
    reason: str
    cash_before: float | None = Field(None, description="Account balance from the MCP tools, before this payment.")
    cash_after: float | None = Field(None, description="Balance after this payment. Must not be negative.")
    requires_human_approval: Literal[True] = True


class ProposedPurchaseOrder(BaseModel):
    """A restock or reprint an agent recommends. It is never placed without human approval."""

    vendor_id: int
    vendor_name: str
    sku: str
    size: str
    qty: int
    estimated_cost: float | None = Field(None, description="qty x pricing.unit_cost from the MCP tools.")
    account: str = Field("checking", description="Cash account it would be paid from, as named in cash_accounts.")
    vendor_lead_days: int | None = Field(None, description="Lead time from the vendors table.")
    blocked_by_unpaid_invoice_id: int | None = Field(
        None, description="Set if the vendor has an unpaid invoice and so will not ship."
    )
    requires_human_approval: Literal[True] = True


class DraftMessage(BaseModel):
    """A customer or vendor message. It is always a draft and is never sent by an agent."""

    to: str
    subject: str
    body: str
    status: Literal["draft"] = "draft"


class AgentReport(BaseModel):
    """What a specialist agent returns to whoever asked it to do the work."""

    agent: AgentName
    summary: str
    facts_used: list[str] = Field(
        default_factory=list, description="Facts used, each with the MCP tool it came from."
    )
    proposed_payments: list[ProposedPayment] = Field(default_factory=list)
    proposed_purchase_orders: list[ProposedPurchaseOrder] = Field(default_factory=list)
    drafts: list[DraftMessage] = Field(default_factory=list)
    needs_human_approval: bool = False
    open_questions: list[str] = Field(default_factory=list)


class TicketDecision(BaseModel):
    """The Boss's final decision for one ticket."""

    ticket_id: int
    agents_consulted: list[AgentName]
    decision: str
    next_steps: list[str] = Field(default_factory=list)
    proposed_payments: list[ProposedPayment] = Field(default_factory=list)
    proposed_purchase_orders: list[ProposedPurchaseOrder] = Field(default_factory=list)
    drafts: list[DraftMessage] = Field(default_factory=list)
    needs_human_approval: bool
    approval_reason: str | None = None


class DelegationRecord(BaseModel):
    """One delegation hop, kept so each ticket run can be audited."""

    from_agent: AgentName
    to_agent: AgentName
    task: str
    depth: int
    result: AgentReport | None = None
    error: str | None = None


@dataclass
class TeamDeps:
    """Run-time state shared by every agent working on one ticket."""

    run_id: str = ""
    ticket_id: int | None = None
    chain: list[AgentName] = field(default_factory=list)
    trace: list[DelegationRecord] = field(default_factory=list)  # shared by every agent on the ticket
