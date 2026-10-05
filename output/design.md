# Campus Customs Operations Desk: Design Notes

The dashboard (`frontend/`, React, Vite and TypeScript) is the screen a shop manager keeps open behind the counter on Chapel Street. It has two jobs:
1. Show what the agent team is doing about each ticket, as it happens.
2. Make sure money only moves when a person says so.

Every design choice below serves one of those two jobs. All data comes from the FastAPI backend at `http://localhost:8000` (`GET /tickets`, `/cash`, `/proposals`, `/events`; `POST /tickets/{id}/run`, `/proposals/{id}/approve`, `/proposals/{id}/reject`, `/reset`). Nothing on screen is hard-coded.

## 1. Overall layout: three columns that follow the work

```
┌──────────────────────────── Top bar: brand · shop date · awaiting approval · CHECKING BALANCE ─┐
├─ Ticket queue ─┬──────────── Ticket workspace ─────────────────────────┬─ Approval queue ───┤
│ Open           │ Ticket header + [▶ Run agent team]                     │ Pending proposals  │
│  #101 ...      │ Status banner (running / finished / needs approval)    │ with cash impact   │
│  #102 ...      │ Agent team: five agent cards                           │ Recent decisions   │
│ Resolved       │ Activity & MCP tool calls │ Boss decision + drafts     │ This run: stats    │
│  #103 ...      │ (live feed)               │ Financial actions          │                    │
└────────────────┴────────────────────────────────────────────────────────┴────────────────────┘
```

- **Left, what's waiting:** the ticket queue, split into *Open* and *Resolved*, like an inbox and an outbox.
- **Center, what's happening:** the selected ticket. Reading top to bottom matches the order of the work: the request, the button to start the team, a status banner, who's working, what they're doing, what the Boss decided, and what money is involved.
- **Right, what needs me:** the approval queue across *all* tickets. A manager can clear approvals without opening each ticket, and an unapproved payment never disappears from view.
- **Top, the number that matters most:** the checking balance stays pinned at the top while you scroll.

The queue and approval columns are sticky. On narrower screens the approval queue drops below the workspace, and on a phone everything stacks into one column.

## 2. Five agents, five identities

Each agent has a fixed **color**, a **two-letter monogram** and a **short role line**. They're used the same way everywhere: on the agent cards, as avatars in the activity feed, and as names inside sentences ("**Inventory** delegated to **Accounting**").

| Agent | Monogram | Color | Role line | Why this color |
|---|---|---|---|---|
| Boss | BO | Deep navy `#1e3a8a` | Coordinates & decides | The shop's own navy, for the agent who speaks for the shop |
| Inventory | IN | Teal `#0f766e` | Stock, sizes & restocks | A cool "warehouse" color, distinct from money green |
| Accounting | AC | Ledger green `#15803d` | Cash, invoices & margins | Green reads as money and the books |
| Facilities | FA | Amber `#b45309` | Lease & rent | A warm "building" tone for the physical shop |
| Customer Service | CS | Purple `#7e22ce` | Drafts replies (never sends) | Stands apart from the operational colors; the same purple marks drafts |

Two non-agent actors are kept visually separate: **Desk system** (gray "SY") for run start and end, and **Human approver** (crimson "HU"), which shares the money color.

Each agent card shows the agent's **state**:
- *Standing by:* the agent hasn't been called yet.
- *Working…:* shown with a pulsing ring around the monogram.
- *Reported:* the agent has finished and sent back its report.
- *Not involved:* once a run ends, an agent that wasn't used is dimmed. A dimmed card shows at a glance that the Boss was selective rather than calling everyone.

Under the state, each card shows the agent's one-line summary, its MCP tool calls as monospace chips (`⌁ check_stock_and_price ×2`), who it delegated to, any refused delegations (amber), and a crimson "needs approval" tag when its report flags one.

## 3. Open and resolved tickets

Status is shown in three ways at once, so it isn't conveyed by color alone:

| | Open | Resolved |
|---|---|---|
| **Position** | Under the *Open* heading at the top of the queue | Under the *Resolved* heading below |
| **Edge** | 4px **orange** left edge | 4px **green** left edge on a slightly tinted card |
| **Pill** | Orange "OPEN" | Green "✓ RESOLVED" |

A third state, **Running**, appears as a blue pill with a blinking dot. Open tickets with an unapproved payment get a crimson "⚑ 1 awaiting approval" flag. Selecting a ticket adds a navy ring around it but leaves the left edge alone, so the status color always stays visible.

## 4. Making cash and approvals hard to miss

- **Crimson is reserved for money.** It's used only where money is involved: proposal cards, amounts, the approve button, the approval dialog header, the "awaiting approval" chip and the ⚑ flags. When something is crimson, it involves cash.
- **The balance card** is the only white element in the navy top bar, set in the largest type on the page. When the balance changes it **flashes**: red when money goes out, green when it comes in. The change from an approval can't go unnoticed.
- **Proposal cards show the effect before you commit:** "Checking $3,400.00 → $2,560.00". If a proposal would take cash below zero, that line turns red and says the backend will refuse it.
- **The approval dialog is a deliberate pause.**
  - It shows the amount, the current balance and the balance after payment side by side.
  - It explains that the agents proposed the payment and can't make it themselves.
  - It requires an **"Approved by" name and a ticked confirmation box** before the button "Approve & pay $840.00" becomes clickable.
- **Money only moves after the backend confirms.** The balance changes only once `POST /proposals/{id}/approve` succeeds. A refusal (insufficient cash, duplicate approval, vendor with an unpaid invoice, or an amount that no longer matches the database) stays inside the dialog with "No money moved."
- **Drafts are clearly not sent.** Customer Service's messages appear in dashed purple boxes marked **"DRAFT · not sent"**.

## 5. A clear running state, and no double runs

- When a run starts, the Run button becomes **"Agents working…"** with a spinner and is disabled.
- **Every** ticket's Run button locks, because the backend runs one ticket at a time. The hint under the button says why.
- A blue banner shows an **elapsed timer**.
- Agent cards change from *Standing by* to *Working…* to *Reported* as the dashboard polls `GET /events` every 1.2 seconds. The feed adds each delegation, MCP tool call with its arguments and result, and report as it happens.
- When the run ends, the banner says plainly what happened:
  - Green "✓ Run finished. Ticket is now Resolved." when nothing needed approval.
  - Crimson "⚑ … 1 financial action waiting for your approval" when something did.
  - Red with the backend's reason if the run failed.
- Loading shows skeleton cards. Failures show inline errors and toasts with the backend's own message, never a blank panel. If the backend can't be reached, the message says how to start it and which origin it allows.

## 6. Why it feels like the Campus Customs desk, not a generic admin page

- **Shop identity:** a navy gradient top bar in Yale-style blues, a serif "CC" mark and wordmark, the subtitle "Operations Desk · Chapel Street" (the lease's actual space name), and ticket titles in a serif face like a shop ledger.
- **The shop's own clock:** the top bar shows the **shop date** (`desk.date_today`, 2026-08-31), not the computer's date, because that's the date the agents reason about.
- **The queue reads like a service desk:** customer and landlord names, ticket types ("Customer Order", "Rent Notice", "Price Override") and when each request came in.
- **The agents are shown as staff.** They have names, roles and monograms like name badges, and the feed is written as sentences ("**Accounting** called MCP tool `get_invoice_details`"), so it reads like a shift log rather than raw JSON.
- **MCP calls look technical on purpose:** monospace teal chips with the real tool names and arguments. An operator can see that every fact came from a database tool call rather than from the model's memory.
- **The human approver is an actor too.** Approvals appear in the same activity feed as the agents' work, under "Human approver". This shows that the person is part of the process and has the final say on money.

## 7. How this helps someone running the shop

- **Scan first, then dig in:** colors and positions answer "what's open?", "what's running?" and "what needs my signature?" within a second. The detail (summaries, tool results, drafts) is there when you need to check the agents' work.
- **Trust comes from seeing the work:** each decision sits next to the tool calls and delegations behind it, so a manager can see why the Boss proposed paying an invoice before approving it.
- **Mistakes are hard to make:**
  - Runs can't be started twice.
  - Payments need a name, a checkbox and a successful backend response.
  - The balance only changes once the backend confirms.
  - Drafts are clearly marked as unsent.
- **Nothing fails silently:** every loading, success and error state is visible, so the operator always knows whether an action happened.
