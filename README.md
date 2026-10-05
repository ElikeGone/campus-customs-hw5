# Campus Customs: Multi-Agent Operations Desk (HW5)

A five-agent team (Boss, Inventory, Accounting, Facilities and Customer Service) that resolves Campus Customs desk tickets. The agents use **PydanticAI** with `gpt-6-luna` through **Portkey**. They get every shop fact through a **FastMCP** server backed by SQLite. A **FastAPI** backend and a **React** dashboard sit on top, and payments only happen after a person approves them.

```
frontend/ (React, :5173) ─▶ backend/main.py (FastAPI, :8000) ─▶ agent team (backend/team.py)
                                     └──────────── MCP stdio ────────────┘
                                                     ▼
                         mcp_server/server.py ─▶ data/campus_customs_new.db
```

## Layout

| Path | What it is |
|---|---|
| `AI_prompts.md` | Log of the prompts used for Problems 1–11 |
| `data/campus_customs.db` | Original database (never modified) |
| `data/campus_customs_new.db` | Working database (the state after the Problem 9 run: checking $160, all tickets resolved) |
| `data/proposals.json` | Payment and purchase-order proposals waiting for or past human approval |
| `mcp_server/` | FastMCP server (`server.py`, 10 tools), `README.md`, `smoke_test.py` |
| `.mcp.json` | MCP client config (starts `mcp_server/server.py` over stdio) |
| `backend/` | FastAPI app (`main.py`), agents (`team.py`, `llm.py`), shared types (`models.py`), ticket loop (`run_tickets.py`), audit (`audit.py`), proposals (`proposals.py`), prompts (`prompts/*.md`) |
| `frontend/` | React, Vite and TypeScript operations dashboard |
| `output/` | Harness, smoke test, desk tickets, design notes, resolved tickets and board, audit trail, run evidence |

## Setup (once)

You need Python 3.12+ (developed on 3.14) and Node 20+ (developed on 24).

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
npm --prefix frontend install
```

On macOS or Linux, use `.venv/bin/python` instead of `.venv/Scripts/python`.

Set your Portkey key. Copy `.env.example` to `.env` (it's git-ignored), or export it in your shell:

```bash
cp .env.example .env
```

Then put your key in `.env` as `PORTKEY_API_KEY=...`.

`backend/llm.py` loads it with `python-dotenv`, which searches upward from `backend/`, so the root `.env` is found when you start from `backend/`.

## Clean start: copy the original database to the working database

The working database in this repo holds the finished Problem 9 run. For a clean run, copy the original over it while the backend is stopped:

```bash
cp data/campus_customs.db data/campus_customs_new.db
```

If the backend is already running, use the reset route instead; see "Reset" below.

## 1. MCP server

The FastAPI backend and the agents start the MCP server themselves, using the stdio command in `.mcp.json`, so you don't need to run it separately. To run it on its own, or to test it:

```bash
.venv/Scripts/python mcp_server/server.py
```

To call each tool through a real MCP connection and save the evidence to `output/mcp_smoke.json`:

```bash
.venv/Scripts/python mcp_server/smoke_test.py
```

## 2. FastAPI backend (port 8000)

Activate `.venv`, then run from `backend/`:

```bash
cd backend
uvicorn main:app --reload --port 8000
```

| Route | Purpose |
|---|---|
| `GET /tickets` | Tickets with open or resolved status |
| `POST /tickets/{id}/run` | Run the agent team on one ticket (agents can only *propose* payments) |
| `GET /events` | Recent audit events (agent steps, delegations, MCP calls, approvals) |
| `GET /proposals` | Proposed payments and purchase orders |
| `POST /proposals/{id}/approve` | **Human approval**: the only route that changes cash |
| `POST /proposals/{id}/reject` | Human rejection (cash unchanged) |
| `GET /cash` | Checking balance |
| `POST /reset` | Restore the working database from the original |

## 3. React dashboard (port 5173)

```bash
cd frontend
npm run dev
```

Open http://localhost:5173. The dashboard calls the backend at `http://localhost:8000` (set in `frontend/.env.development`). The backend's CORS only allows this origin.

## Reset

Either click **Reset data** in the dashboard, or:

```bash
curl -X POST http://localhost:8000/reset -H "Content-Type: application/json" -d '{"confirm": true}'
```

This copies `data/campus_customs.db` over the working copy and clears `data/proposals.json`. The original database is only read, and `output/audit_trail.json` is kept, because it's append-only.

## Full three-ticket workflow

1. Start the backend and the dashboard, then **Reset data**. Checking should show **$3,400.00** and tickets 101, 102 and 103 should be **Open**.
2. **Ticket 101:** select it and click **Run agent team**. The agent cards and the activity feed update live. When it finishes, the $840 invoice-501 payment proposal appears. Click **Review & approve…**, enter your name, tick the confirmation box and approve. Checking drops to **$2,560.00** and #101 becomes **Resolved**.
3. **Ticket 102:** run it, then approve the $2,400 rent proposal. Checking drops to **$160.00** and #102 is resolved.
4. **Ticket 103:** run it. The agents propose no purchase order, because the ~$264 reprint is more than the $160 left. The ticket resolves with no cash change, a discount decision and a draft reply.

You can do the same without the dashboard: `POST /tickets/{id}/run`, `GET /proposals`, then `POST /proposals/{id}/approve` with `{"approved_by": "<name>", "confirm": true}`.

Results from our run are in `output/desk_tickets.html` (Expected vs Actual, the Cash ledger and the reflection), `output/resolved_tickets.json`, `output/resolved_board.html` and `output/audit_trail.json`. The full system reference is in `output/harness.md`.

## Safety model

- Agents can't write to the database. The write MCP tools are kept off every agent's allowlist, and `team.py` checks this at startup.
- Every payment needs a named human, `confirm: true`, and a fresh check of the amount against the database. Cash can never go negative.
- Customer and vendor messages are drafts only.
- Each ticket run is capped at 30 model requests, 40 tool calls, 300k tokens and 8 delegations, with a delegation depth of 3. These limits are in `backend/team.py`.
- `PORTKEY_API_KEY` is read from the environment and never logged or committed.
