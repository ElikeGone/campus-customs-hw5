"""Campus Customs MCP server (FastMCP).

Works only against the working copy data/campus_customs_new.db.
The original data/campus_customs.db is never touched.
"""
import calendar
import sqlite3
from contextlib import contextmanager
from datetime import date
from pathlib import Path
from typing import Literal

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "campus_customs_new.db"

# Design convention, not a database fact: the payments table is empty and nothing
# in the database defines the allowed values of payments.kind. Any tool that
# records a payment must use these same constants, or these lookups won't find it.
PAYMENT_KIND_INVOICE = "invoice"
PAYMENT_KIND_LEASE = "lease"
PAYMENT_KIND_PURCHASE_ORDER = "purchase_order"  # ref_id = vendor id

# Ticket statuses: "open" is what the database ships with; "resolved" is our convention.
TICKET_STATUSES = ("open", "resolved")

mcp = FastMCP("campus-customs")


@contextmanager
def _connect():
    """Open the working database; commit on success, roll back on error, always close."""
    if not DB_PATH.exists():
        raise FileNotFoundError(f"Working database not found: {DB_PATH}")
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _row(row):
    return dict(row) if row is not None else None


@mcp.tool
def check_stock_and_price(sku: str, size: str) -> dict:
    """Look up stock for one product size, plus that product's pricing.

    Used for ticket 101 (tee in size S) and ticket 103 (20 hoodies in size M).
    Returns the requested size, stock in every size of the product, and the unit cost and list price.
    """
    with _connect() as conn:
        requested = conn.execute(
            "SELECT sku, name, size, qty, location FROM inventory WHERE sku = ? AND size = ?",
            (sku, size),
        ).fetchone()
        all_sizes = conn.execute(
            "SELECT size, qty, location FROM inventory WHERE sku = ?", (sku,)
        ).fetchall()
        pricing = conn.execute(
            "SELECT unit_cost, list_price FROM pricing WHERE sku = ?", (sku,)
        ).fetchone()
    if requested is None and not all_sizes:
        return {"found": False, "error": f"No inventory rows for sku {sku!r}."}
    return {
        "found": requested is not None,
        "requested": _row(requested),
        "all_sizes": [dict(r) for r in all_sizes],
        "pricing": _row(pricing),
    }


@mcp.tool
def get_invoice_details(invoice_id: int) -> dict:
    """Look up a vendor invoice, its vendor, any payments against it, and today's desk date.

    Used for ticket 101, which links to invoice 501 (a rush reprint of the tee).
    """
    with _connect() as conn:
        invoice = conn.execute(
            "SELECT id, vendor_id, amount, due_date, status, description FROM invoices WHERE id = ?",
            (invoice_id,),
        ).fetchone()
        if invoice is None:
            return {"found": False, "error": f"Invoice {invoice_id} not found."}
        vendor = conn.execute(
            "SELECT id, name, specialty, lead_days FROM vendors WHERE id = ?",
            (invoice["vendor_id"],),
        ).fetchone()
        payments = conn.execute(
            "SELECT * FROM payments WHERE kind = ? AND ref_id = ?",
            (PAYMENT_KIND_INVOICE, invoice_id),
        ).fetchall()
        desk = conn.execute("SELECT date_today FROM desk").fetchone()
    today = desk["date_today"] if desk else None
    return {
        "found": True,
        "invoice": dict(invoice),
        "vendor": _row(vendor),
        "payments": [dict(p) for p in payments],
        "today": today,
        "overdue": bool(today and invoice["status"] == "open" and invoice["due_date"] < today),
    }


@mcp.tool
def get_lease_and_cash(lease_id: int) -> dict:
    """Look up a lease, the shop's cash balances, any payments against the lease, and today's desk date.

    Used for ticket 102 (rent notice for lease 1).
    """
    with _connect() as conn:
        lease = conn.execute(
            "SELECT id, space_name, landlord, monthly_rent, next_due, notes FROM leases WHERE id = ?",
            (lease_id,),
        ).fetchone()
        if lease is None:
            return {"found": False, "error": f"Lease {lease_id} not found."}
        accounts = conn.execute("SELECT name, balance, date FROM cash_accounts").fetchall()
        payments = conn.execute(
            "SELECT * FROM payments WHERE kind = ? AND ref_id = ?",
            (PAYMENT_KIND_LEASE, lease_id),
        ).fetchall()
        desk = conn.execute("SELECT date_today FROM desk").fetchone()
    return {
        "found": True,
        "lease": dict(lease),
        "cash_accounts": [dict(a) for a in accounts],
        "payments": [dict(p) for p in payments],
        "today": desk["date_today"] if desk else None,
    }


@mcp.tool
def get_open_tickets() -> dict:
    """List every ticket whose status is 'open', plus today's desk date.

    This is how the team's ticket loop and the Boss read the work queue (tickets 101, 102 and 103).
    """
    with _connect() as conn:
        tickets = conn.execute(
            "SELECT id, type, requester, subject, sku, size, qty, lease_id, invoice_id,"
            " status, notes, created_at FROM tickets WHERE status = 'open' ORDER BY id"
        ).fetchall()
        desk = conn.execute("SELECT date_today FROM desk").fetchone()
    return {
        "today": desk["date_today"] if desk else None,
        "tickets": [dict(t) for t in tickets],
    }


@mcp.tool
def get_vendors() -> dict:
    """List every vendor with its specialty, lead time and any open (unpaid) invoices, plus today's desk date.

    Used to choose a vendor for a restock or reprint (tickets 101 and 103). A vendor with an open
    invoice will not ship, so the open invoices are returned with each vendor.
    """
    with _connect() as conn:
        vendors = conn.execute(
            "SELECT id, name, specialty, lead_days FROM vendors ORDER BY id"
        ).fetchall()
        open_invoices = conn.execute(
            "SELECT id, vendor_id, amount, due_date, status, description FROM invoices"
            " WHERE status = 'open' ORDER BY id"
        ).fetchall()
        desk = conn.execute("SELECT date_today FROM desk").fetchone()
    result = []
    for v in vendors:
        owed = [dict(i) for i in open_invoices if i["vendor_id"] == v["id"]]
        result.append({**dict(v), "open_invoices": owed, "has_unpaid_invoice": bool(owed)})
    return {"today": desk["date_today"] if desk else None, "vendors": result}


@mcp.tool
def get_tickets() -> dict:
    """List every ticket, whatever its status (open or resolved), plus today's desk date."""
    with _connect() as conn:
        tickets = conn.execute(
            "SELECT id, type, requester, subject, sku, size, qty, lease_id, invoice_id,"
            " status, notes, created_at FROM tickets ORDER BY id"
        ).fetchall()
        desk = conn.execute("SELECT date_today FROM desk").fetchone()
    return {"today": desk["date_today"] if desk else None, "tickets": [dict(t) for t in tickets]}


@mcp.tool
def get_cash_accounts() -> dict:
    """List every cash account with its balance and as-of date."""
    with _connect() as conn:
        accounts = conn.execute("SELECT name, balance, date FROM cash_accounts ORDER BY name").fetchall()
    return {"cash_accounts": [dict(a) for a in accounts]}


# ---------------------------------------------------------------------------
# Write tools: HUMAN-APPROVAL ROUTE ONLY.
# These are deliberately left out of every agent's MCP allowlist (backend/team.py),
# so agents can't execute them. Only the backend's /approve route calls them, after
# a person approves. Each one re-checks the amount against the database instead of
# trusting the proposal, and does all its updates in one transaction.
# ---------------------------------------------------------------------------

def _require_approver(approved_by: str) -> str:
    name = (approved_by or "").strip()
    if not name:
        raise ToolError("approved_by is required: a named human must approve every payment.")
    return name


def _check_amount(actual: float, expected: float) -> None:
    if abs(actual - expected) > 0.005:
        raise ToolError(
            f"Amount mismatch: the database says {actual:.2f} but {expected:.2f} was approved. "
            "Re-run the ticket to get a fresh proposal."
        )


def _debit(conn, account: str, amount: float, today: str) -> tuple[float, float]:
    row = conn.execute("SELECT balance FROM cash_accounts WHERE name = ?", (account,)).fetchone()
    if row is None:
        raise ToolError(f"Cash account {account!r} not found.")
    before = row["balance"]
    if amount <= 0:
        raise ToolError("Payment amount must be positive.")
    if before - amount < 0:
        raise ToolError(
            f"Insufficient cash: {account} has {before:.2f}, payment is {amount:.2f}. "
            "Cash can never go negative."
        )
    after = round(before - amount, 2)
    conn.execute("UPDATE cash_accounts SET balance = ?, date = ? WHERE name = ?", (after, today, account))
    return before, after


def _add_one_month(iso_day: str) -> str:
    d = date.fromisoformat(iso_day)
    y, m = (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1])).isoformat()


@mcp.tool
def apply_approved_payment(
    kind: Literal["invoice", "lease"],
    ref_id: int,
    account: str,
    approved_by: str,
    expected_amount: float,
    for_due_date: str | None = None,
) -> dict:
    """HUMAN-APPROVAL ROUTE ONLY: record a human-approved invoice or rent payment and debit cash.

    The amount is read from the database (invoice amount or monthly rent), not trusted from the
    proposal. Refuses unpaid-twice, amount mismatches and anything that would make cash negative.
    For rent, for_due_date must equal the lease's current next_due; on success next_due moves forward one month.
    """
    approver = _require_approver(approved_by)
    with _connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        today = conn.execute("SELECT date_today FROM desk").fetchone()["date_today"]
        if kind == PAYMENT_KIND_INVOICE:
            inv = conn.execute("SELECT * FROM invoices WHERE id = ?", (ref_id,)).fetchone()
            if inv is None:
                raise ToolError(f"Invoice {ref_id} not found.")
            if inv["status"] != "open":
                raise ToolError(f"Invoice {ref_id} is already {inv['status']}; it can't be paid again.")
            amount = inv["amount"]
            _check_amount(amount, expected_amount)
            before, after = _debit(conn, account, amount, today)
            conn.execute("UPDATE invoices SET status = 'paid' WHERE id = ?", (ref_id,))
            updated = {"invoice_id": ref_id, "invoice_status": "paid"}
        else:
            lease = conn.execute("SELECT * FROM leases WHERE id = ?", (ref_id,)).fetchone()
            if lease is None:
                raise ToolError(f"Lease {ref_id} not found.")
            if for_due_date != lease["next_due"]:
                raise ToolError(
                    f"Rent for lease {ref_id} is next due {lease['next_due']}, not {for_due_date}. "
                    "That rent may already have been paid."
                )
            amount = lease["monthly_rent"]
            _check_amount(amount, expected_amount)
            before, after = _debit(conn, account, amount, today)
            next_due = _add_one_month(lease["next_due"])
            conn.execute("UPDATE leases SET next_due = ? WHERE id = ?", (next_due, ref_id))
            updated = {"lease_id": ref_id, "paid_for_due_date": lease["next_due"], "new_next_due": next_due}
        cur = conn.execute(
            "INSERT INTO payments (kind, ref_id, amount, account, paid_at, approved_by) VALUES (?, ?, ?, ?, ?, ?)",
            (kind, ref_id, amount, account, today, approver),
        )
        payment_id = cur.lastrowid
    return {"payment_id": payment_id, "kind": kind, "ref_id": ref_id, "amount": amount, "account": account,
            "paid_at": today, "approved_by": approver, "cash_before": before, "cash_after": after, **updated}


@mcp.tool
def apply_approved_purchase_order(
    vendor_id: int,
    sku: str,
    size: str,
    qty: int,
    account: str,
    approved_by: str,
    expected_amount: float,
) -> dict:
    """HUMAN-APPROVAL ROUTE ONLY: pay for a human-approved purchase order and debit cash.

    Cost is qty x pricing.unit_cost, read from the database (our convention for what a reprint
    costs). Refuses if the vendor has an unpaid invoice (it won't ship), if the SKU and size don't
    exist, or if cash would go negative. Stock is not changed: the goods haven't arrived yet.
    """
    approver = _require_approver(approved_by)
    if qty <= 0:
        raise ToolError("qty must be positive.")
    with _connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        today = conn.execute("SELECT date_today FROM desk").fetchone()["date_today"]
        vendor = conn.execute("SELECT * FROM vendors WHERE id = ?", (vendor_id,)).fetchone()
        if vendor is None:
            raise ToolError(f"Vendor {vendor_id} not found.")
        unpaid = conn.execute(
            "SELECT id FROM invoices WHERE vendor_id = ? AND status = 'open'", (vendor_id,)
        ).fetchall()
        if unpaid:
            ids = ", ".join(str(r["id"]) for r in unpaid)
            raise ToolError(f"{vendor['name']} has unpaid invoice(s) {ids} and will not ship. Pay those first.")
        if conn.execute("SELECT 1 FROM inventory WHERE sku = ? AND size = ?", (sku, size)).fetchone() is None:
            raise ToolError(f"No inventory line for {sku} size {size}.")
        price = conn.execute("SELECT unit_cost FROM pricing WHERE sku = ?", (sku,)).fetchone()
        if price is None:
            raise ToolError(f"No pricing for {sku}.")
        amount = round(qty * price["unit_cost"], 2)
        _check_amount(amount, expected_amount)
        before, after = _debit(conn, account, amount, today)
        cur = conn.execute(
            "INSERT INTO payments (kind, ref_id, amount, account, paid_at, approved_by) VALUES (?, ?, ?, ?, ?, ?)",
            (PAYMENT_KIND_PURCHASE_ORDER, vendor_id, amount, account, today, approver),
        )
        payment_id = cur.lastrowid
    return {"payment_id": payment_id, "kind": PAYMENT_KIND_PURCHASE_ORDER, "vendor_id": vendor_id,
            "vendor": vendor["name"], "sku": sku, "size": size, "qty": qty, "amount": amount,
            "account": account, "paid_at": today, "approved_by": approver,
            "cash_before": before, "cash_after": after, "vendor_lead_days": vendor["lead_days"]}


@mcp.tool
def set_ticket_status(ticket_id: int, status: Literal["open", "resolved"]) -> dict:
    """BACKEND ONLY: mark a ticket open or resolved once its work and approvals are finished."""
    with _connect() as conn:
        cur = conn.execute("UPDATE tickets SET status = ? WHERE id = ?", (status, ticket_id))
        if cur.rowcount == 0:
            raise ToolError(f"Ticket {ticket_id} not found.")
    return {"ticket_id": ticket_id, "status": status}


if __name__ == "__main__":
    mcp.run()
