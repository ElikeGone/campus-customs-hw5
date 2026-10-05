# Campus Customs MCP Server

This is a FastMCP server that gives the homework's agents and the dashboard API their only way to read and change Campus Customs shop data. Nothing in `backend/` queries the database itself. The single exception is `POST /reset`, which copies the original database file over the working copy without reading its contents.

**Database:** `data/campus_customs_new.db`, the working copy. The original `data/campus_customs.db` is never touched. Seven tools only read data. Three tools write data, and only the backend's human-approval code may call them; no agent can.

## Read-only tools (7)

- **`get_open_tickets()`**: reads `tickets` and `desk`. Returns every ticket with status `open` (all fields) and today's date. The ticket loop in `backend/run_tickets.py` uses it to fetch the work queue, and the Boss can use it to see the whole queue.
- **`get_vendors()`**: reads `vendors`, `invoices` and `desk`. Returns every vendor with its specialty and lead time, its open invoices, a `has_unpaid_invoice` flag, and today's date. Used to pick a restock or reprint vendor for tickets 101 and 103, and to apply the rule that a vendor with an unpaid invoice won't ship.
- **`check_stock_and_price(sku, size)`**: reads `inventory` and `pricing`. Returns stock for the requested size, stock in every size of that product, and the product's unit cost and list price. Used for tickets 101 and 103.
- **`get_invoice_details(invoice_id)`**: reads `invoices`, `vendors`, `payments` and `desk`. Returns the invoice, its vendor (including lead time), any payments made against it, today's date, and an `overdue` flag. Used for ticket 101 (invoice 501).
- **`get_lease_and_cash(lease_id)`**: reads `leases`, `cash_accounts`, `payments` and `desk`. Returns the lease, all cash account balances, any rent payments made against it, and today's date. Used for ticket 102 (lease 1).
- **`get_tickets()`**: reads `tickets` and `desk`. Returns every ticket, whatever its status, and today's date. The dashboard API uses it to show which tickets are open or resolved.
- **`get_cash_accounts()`**: reads `cash_accounts`. Returns every account's balance and as-of date. The dashboard API uses it for the checking balance.

## Write tools (3): human-approval route only

None of these are on any agent's allowlist (`MCP_TOOLS_BY_AGENT` in `backend/team.py`), and `team.py` asserts that at import time. Only `backend/main.py` calls them, after a named human approves. Each one re-reads the amount from the database instead of trusting the proposal, and does all its updates in one transaction.

- **`apply_approved_payment(kind, ref_id, account, approved_by, expected_amount, for_due_date=None)`**: `kind` is `"invoice"` or `"lease"`.
  - It reads and updates `invoices` or `leases`, plus `cash_accounts`, `payments` and `desk`.
  - The amount is the invoice amount or the monthly rent from the database.
  - It refuses a missing approver, an invoice that isn't open, a rent `for_due_date` that isn't the lease's current `next_due`, an amount that doesn't match `expected_amount`, and anything that would make cash negative.
  - On success it inserts a `payments` row (`paid_at` = `desk.date_today`) and lowers the account balance. It also sets the invoice to `paid`, or moves the lease's `next_due` forward one month.
- **`apply_approved_purchase_order(vendor_id, sku, size, qty, account, approved_by, expected_amount)`**:
  - It reads `vendors`, `invoices`, `inventory` and `pricing`, and updates `cash_accounts` and `payments`.
  - The cost is qty × `pricing.unit_cost`, which is our own convention for reprint cost.
  - It refuses if the vendor has an open invoice (vendors with unpaid invoices won't ship), if the SKU and size don't exist, if the amount doesn't match, or if cash would go negative.
  - Stock isn't changed, because the goods haven't arrived.
- **`set_ticket_status(ticket_id, status)`**: writes `tickets.status`, which can be `"open"` or `"resolved"`. `"resolved"` is our own convention, since the original database only uses `"open"`.

If an ID doesn't match anything, the tool returns `{"found": false, "error": ...}` instead of making up data.

**Convention (not a database fact):** the `payments` table is empty, and nothing in the database defines the values of `payments.kind`. As our own design choice, the tools look up payments by `ref_id` plus `kind = "invoice"` or `kind = "lease"`. Purchase orders use `kind = "purchase_order"` with the vendor id as `ref_id`. These values are defined once in `server.py` as `PAYMENT_KIND_INVOICE`, `PAYMENT_KIND_LEASE` and `PAYMENT_KIND_PURCHASE_ORDER`, and any later tool that records payments must use the same constants.

## Setup

A project virtual environment at `.venv` has FastMCP installed (version 4.0.11 when this was written). The connection is set up in `.mcp.json` at the project root. That file starts the server over stdio with `.venv/Scripts/python.exe mcp_server/server.py`.

To recreate the environment:

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r mcp_server/requirements.txt
```
