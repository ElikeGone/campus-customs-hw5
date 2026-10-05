// Shapes returned by the Problem 7 backend (backend/main.py and backend/models.py).

export type AgentName = 'boss' | 'inventory' | 'accounting' | 'facilities' | 'customer_service'
export type TicketStatus = 'open' | 'resolved' | string

export interface Ticket {
  id: number
  type: string
  requester: string
  subject: string
  sku: string | null
  size: string | null
  qty: number | null
  lease_id: number | null
  invoice_id: number | null
  status: TicketStatus
  notes: string | null
  created_at: string
  pending_proposals: number
}

export interface TicketsResponse {
  today: string | null
  tickets: Ticket[]
}

export interface Cash {
  account: string
  balance: number
  date: string
}

export interface DraftMessage {
  to: string
  subject: string
  body: string
  status: 'draft'
}

export interface TicketDecision {
  ticket_id: number
  agents_consulted: AgentName[]
  decision: string
  next_steps: string[]
  drafts: DraftMessage[]
  needs_human_approval: boolean
  approval_reason: string | null
}

export interface Proposal {
  id: string
  ticket_id: number
  run_id: string
  type: 'payment' | 'purchase_order'
  amount: number | null
  details: Record<string, unknown>
  status: 'pending' | 'approved' | 'rejected' | 'superseded'
  created_at: string
  decided_at: string | null
  decided_by: string | null
  note: string | null
  execution: Record<string, unknown> | null
}

export interface RunResponse {
  run_id: string
  ticket_id: number
  decision: TicketDecision | null
  error: string | null
  delegations: unknown[]
  proposals: Proposal[]
  ticket_status: TicketStatus
}

export interface AuditEvent {
  time: string
  run_id: string
  event: string
  agent: string | null
  ticket_id: number | null
  action: string | null
  inputs: string | number | boolean | null
  result: string | number | boolean | null
  outcome: string | null
  [extra: string]: unknown
}

export interface EventsResponse {
  count: number
  events: AuditEvent[]
}

export interface DecisionResponse {
  proposal: Proposal
  ticket_status: TicketStatus
  cash_after: number | null
}
