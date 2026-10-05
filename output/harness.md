# Campus Customs Agent Harness

How the HW5 system fits together: the database, the MCP server, the five agents, the FastAPI backend, the React dashboard, the human-approval workflow, auditing, usage limits and safety rules. It was checked against the code at the end of Problem 9 (`mcp_server/server.py`, `backend/*.py`, `backend/prompts/*.md`, `frontend/src/*`).

```
React dashboard (frontend/, :5173) ──HTTP──▶ FastAPI (backend/main.py, :8000) ──▶ agent team (backend/team.py, PydanticAI, gpt-6-luna via Portkey)
                                                     │                                        │
                                                     └────────── MCP (stdio) ─────────────────┘
                                                                     ▼
                                              campus-customs MCP server (mcp_server/server.py)
                                                                     ▼
                                                   data/campus_customs_new.db (working copy)
```

## 1. Database

- **`data/campus_customs.db`** is the original. Nothing writes to it; `POST /reset` only copies it.
- **`data/campus_customs_new.db`** is the working copy, and the only database the system reads or writes. All access goes through the MCP server, and nothing in `backend/` queries it directly.
- **`data/proposals.json`** holds dashboard state, not shop data: the proposals waiting for a human. Reset clears it.

| Table | Fields | Why it matters for the agents |
|---|---|---|
| `desk` | date_today, notes | The shop's current date (2026-08-31). Every due date, overdue check and ready-by date uses it, not the real calendar. |
| `inventory` | sku, name, size, qty, location (key: sku + size) | Whether an order can be filled. Each size is its own stock line. |
| `pricing` | sku, unit_cost, list_price | The list price, and the cost floor for discounts and reprint estimates. |
| `vendors` | id, name, specialty, lead_days | Who can restock or reprint, and how long it takes. Lead times come only from here. |
| `leases` | id, space_name, landlord, monthly_rent, next_due, notes | The rent obligation behind rent notices. An approved rent payment moves `next_due` forward one month. |
| `cash_accounts` | name, balance, date | Available cash (`checking`). Changes only through an approved payment. |
| `payments` | id, kind, ref_id, amount, account, paid_at, approved_by | One row per human-approved payment. Empty in the original database. |
| `invoices` | id, vendor_id, amount, due_date, status, description | What the shop owes vendors. A vendor with an `open` invoice won't ship. Approval sets the status to `paid`. |
| `tickets` | id, type, requester, subject, sku, size, qty, lease_id, invoice_id, status, notes, created_at | The work queue. Status is `open`, or `resolved` once its work and approvals are done. |

**Conventions** (our own choices, not database facts):
- `payments.kind` is `invoice`, `lease` or `purchase_order`. `ref_id` is the invoice id, lease id or vendor id respectively.
- `tickets.status = 'resolved'`.
- A reprint costs qty × `pricing.unit_cost`.

## 2. MCP server (`mcp_server/server.py`, FastMCP, 10 tools)

Configured in `.mcp.json` (stdio). Every tool opens the working database, then commits or rolls back, and closes the connection.

| Tool | Reads / writes | Used by |
|---|---|---|
| `check_stock_and_price(sku, size)` | reads `inventory`, `pricing` | Boss, Inventory, Accounting, Customer Service |
| `get_invoice_details(invoice_id)` | reads `invoices`, `vendors`, `payments`, `desk` | Boss, Accounting |
| `get_lease_and_cash(lease_id)` | reads `leases`, `cash_accounts`, `payments`, `desk` | Boss, Accounting, Facilities |
| `get_open_tickets()` | reads `tickets`, `desk` | Boss; the ticket loop in `backend/run_tickets.py` |
| `get_vendors()` | reads `vendors`, `invoices`, `desk` (adds `has_unpaid_invoice`) | Boss, Inventory, Accounting |
| `get_tickets()` | reads `tickets`, `desk` | API: `GET /tickets`, run, reset |
| `get_cash_accounts()` | reads `cash_accounts` | API: `GET /cash`, reset |
| `apply_approved_payment(kind, ref_id, account, approved_by, expected_amount, for_due_date)` | **writes** `payments`, `cash_accounts`, plus `invoices.status` or `leases.next_due` | **Approval route only** |
| `apply_approved_purchase_order(vendor_id, sku, size, qty, account, approved_by, expected_amount)` | **writes** `payments`, `cash_accounts` (reads `vendors`, `invoices`, `inventory`, `pricing`) | **Approval route only** |
| `set_ticket_status(ticket_id, status)` | **writes** `tickets.status` | **Backend only** |

The three write tools are on **no** agent's allowlist. `backend/team.py` checks this when it starts and refuses to start otherwise.

## 3. The five agents (`backend/team.py`, prompts in `backend/prompts/`)

- **Model:** all five are PydanticAI agents on **`gpt-6-luna` through Portkey only** (`PORTKEY_API_KEY`, Responses API, no fallback model). They share one MCP connection, filtered per role.
- **Delegation:** any agent can delegate to any other with the `delegate(to_agent, task)` tool.
- **Outputs:** the specialists return an `AgentReport` and the Boss returns a `TicketDecision` (both defined in `backend/models.py`).

| Agent | Role | MCP tools allowed |
|---|---|---|
| **Boss** | Reads the ticket, picks and briefs specialists, coordinates their work, makes the final decision (including discounts), flags human approval | `get_open_tickets`, `check_stock_and_price`, `get_invoice_details`, `get_lease_and_cash`, `get_vendors` |
| **Inventory** | Stock by SKU and size, shortages, restock or reprint options, vendor lead times and blocks | `check_stock_and_price`, `get_vendors` |
| **Accounting** | Cash, invoices, cost and margin. Prepares `ProposedPayment` and `ProposedPurchaseOrder` and checks the combined total against cash | `check_stock_and_price`, `get_invoice_details`, `get_lease_and_cash`, `get_vendors` |
| **Facilities** | Shop-side obligations: the lease, rent, and checking a notice against the lease | `get_lease_and_cash` |
| **Customer Service** | Drafts messages to customers, landlords and vendors. **Never sends** | `check_stock_and_price` |

Each prompt covers the agent's responsibilities, what it must not do, when to use its MCP tools, when to delegate, and when human approval is needed. The prompts contain no shop facts.

## 4. FastAPI backend (`backend/main.py`)

Start it from `backend/` with `uvicorn main:app --reload --port 8000` (with `.venv` active). Only one operation that changes state (a run, approval, rejection or reset) runs at a time; a second one gets `409 busy`.

- `GET /tickets`: every ticket with its status (`open` or `resolved`) and the number of pending proposals.
- `POST /tickets/{ticket_id}/run`: runs the agent team, Boss first, on one open ticket. The decision's payments and purchase orders are saved as **pending** proposals; cash doesn't change.
- `GET /events?limit=&ticket_id=&agent=`: recent audit events, newest first.
- `GET /proposals?status=&ticket_id=`: lists the proposals.
- `POST /proposals/{proposal_id}/approve`: human approval with `approved_by` and `confirm: true`. **This is the only route that changes cash.**
- `POST /proposals/{proposal_id}/reject`: human rejection. Cash isn't touched and the ticket stays open.
- `GET /cash`: the checking balance from `cash_accounts`.
- `POST /reset`: with `confirm: true`, restores the working database from the original and clears proposals. The audit trail is kept.

**CORS:** only `http://localhost:5173` and `http://127.0.0.1:5173`, with GET and POST and the `Content-Type` header (can be overridden with `CORS_ORIGINS`).

**Error codes:**

| Code | Status | Meaning |
|---|---|---|
| `ticket_not_found` | 404 | No ticket with that id (the response lists the valid ids) |
| `proposal_not_found` | 404 | No proposal with that id |
| `ticket_not_open` | 409 | The ticket is already resolved |
| `duplicate` / `not_pending` | 409 | The proposal was already decided or superseded |
| `insufficient_cash` | 409 | The payment would make cash negative |
| `vendor_has_unpaid_invoice` | 409 | The vendor won't ship until its open invoice is paid |
| `stale_proposal` | 409 | The amount no longer matches the database |
| `busy` | 409 | Another operation is in progress |
| validation | 422 | `confirm` or `approved_by` is missing |

## 5. React dashboard (`frontend/`, React, Vite and TypeScript)

Start it from `frontend/` with `npm run dev` (port 5173, `strictPort`). It calls the backend at `VITE_API_URL` (default `http://localhost:8000`, set in `frontend/.env.development`) and has no shop data of its own. Opening `?ticket=102` selects that ticket. The design is described in `output/design.md`.

- **Ticket queue:** open and resolved tickets in separate sections, each with an orange or green edge and pill; a blue "Running" pill during a run.
- **Run agent team:** while a run is in progress, every Run button is locked. The dashboard polls `GET /events` every 1.2 seconds to show live agent cards (Standing by, Working…, Reported, Not involved) and the activity feed of delegations and MCP tool calls.
- **Boss decision:** the decision, next steps and drafts (labeled "DRAFT · not sent").
- **Financial actions and the approval queue:** proposals show their effect on cash. The **Review & approve…** dialog requires a name and a ticked confirmation before it calls the approve route.
- **Checking balance card:** pinned at the top. It updates from the approval response and flashes when it changes.
- **Error handling:** errors from the backend appear as banners, inline messages and toasts, with no silent failures.

## 6. Human-approval workflow

1. **Run:** `POST /tickets/{id}/run`. Agents can only put payments or purchase orders in their output, and `requires_human_approval` is fixed to `True` in `backend/models.py`. The backend stores them as **pending** proposals. **Cash is unchanged.**
2. **Review:** a person sees the proposal and its effect on cash on the dashboard.
3. **Approve:** `POST /proposals/{id}/approve` with `approved_by` and `confirm: true`. The backend calls the MCP write tool, which **re-reads the amount from the database** (invoice amount, monthly rent, or qty × unit cost) and refuses in these cases:
   - no approver is named
   - the invoice isn't open, or the rent `for_due_date` isn't the lease's current `next_due`
   - the amount doesn't match what was approved
   - the vendor has an unpaid invoice (purchase orders)
   - **cash would go negative**

   If none of these apply, then in **one transaction** it inserts a `payments` row (`paid_at = desk.date_today`), lowers `cash_accounts.balance`, and marks the invoice `paid` or moves the lease's `next_due` forward.
4. **Resolve:** the ticket becomes `resolved` when every proposal from its latest run is approved, or straight away if the run proposed nothing.
5. **Reject (optional):** `POST /proposals/{id}/reject` leaves cash unchanged and keeps the ticket open for a re-run.

**Problem 9 result:** $3,400.00 − $840.00 (invoice 501, payment #1) − $2,400.00 (rent, payment #2) = **$160.00**, which matches `cash_accounts` exactly. Ticket 103 proposed no purchase order, because the ~$264 reprint was more than the $160 left. The breakdown is in the Cash tab of `output/desk_tickets.html`.

## 7. Audit trail (`backend/audit.py` → `output/audit_trail.json`)

- **Append-only.** A single JSON array that is never cleared or rewritten. New events are added at the end, and the file is replaced atomically so a crash can't leave it half-written. Resets add a `reset` event and keep the history.
- **Event types:**
  - `run_start` and `run_end`
  - `agent_step_start` and `agent_step_end`, with the outcome or stop reason and `needs_human_approval`
  - `delegation`: started, or refused with the reason
  - `mcp_tool_call`: every agent and ticket-loop call
  - `ticket_end`
  - `approval`: executed, refused or rejected
  - `reset`
- **Fields:** time, run id, event, agent, ticket, action, short `inputs` and `result` (capped at 300 characters), and outcome. **No model reasoning, prompts, API keys or headers are ever stored.**
- **Per-run records:** each run's full response is also saved to `output/api_runs/{run_id}_ticket{id}.json`. At the end of Problem 9 the trail holds 356 events, 96 of them from the full run.

## 8. Usage limits (`backend/team.py`)

These apply per ticket, shared across every agent that works on it.

| Limit | Value | When it's reached |
|---|---|---|
| Model requests (`request_limit`) | 30 | Run stops with `UsageLimitExceeded`, logged as the stop reason |
| Tool calls, MCP and delegate (`tool_calls_limit`) | 40 | Same |
| Total tokens (`total_tokens_limit`) | 300,000 | Same |
| Delegation depth | 3 agents in a chain (e.g. Boss → Inventory → Accounting) | Delegation refused; the agent finishes with what it has |
| Delegations per ticket (refused ones included) | 8 | Delegation refused |
| Self or circular delegation | not allowed | Delegation refused with the reason |
| Output retries per agent | 2 | Run stops with an error |
| Concurrent operations (API) | 1 run, approval or reset at a time | `409 busy` |

## 9. Safety rules

- **Payments need human approval.** Agents have no tool that can write data. Money moves only through `POST /proposals/{id}/approve` with a named approver and `confirm: true`.
- **Cash can never go negative.** The approval tool checks the balance inside the payment transaction and refuses with `insufficient_cash`. Accounting is also told to check the *combined* proposed payments against cash.
- **Cash changes only through the approved payment workflow.** Agents never change balances, and approvals re-check every amount against the database.
- **Vendors with unpaid invoices won't ship.** `get_vendors` exposes `has_unpaid_invoice`, and purchase-order approval refuses while one is open.
- **Messages stay drafts.** `DraftMessage.status` can only be `"draft"`, and nothing can send a message. Customer Service doesn't share internal cash, invoice or margin details.
- **Facts come from the database.** The prompts contain no shop facts. Agents name the MCP tool behind each fact (`facts_used`), and dates and lead times come from `desk` and `vendors`.
- **No unauthorized actions.** Each role only sees the tools on its allowlist. The write tools are excluded and checked at startup. CORS allows only the dashboard origin, and resolved tickets can't be re-run without a reset.
- **Secrets.** The Portkey key is read from the environment and never logged or stored.
