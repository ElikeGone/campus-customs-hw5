// Visual identity for each actor that can appear in the audit trail.
import type { AgentName, AuditEvent } from './types'

export interface AgentIdentity {
  key: AgentName
  name: string
  role: string
  monogram: string
  color: string // primary hue
  tint: string // soft background
}

export const AGENTS: Record<AgentName, AgentIdentity> = {
  boss: { key: 'boss', name: 'Boss', role: 'Coordinates & decides', monogram: 'BO', color: '#1e3a8a', tint: '#e8edfb' },
  inventory: { key: 'inventory', name: 'Inventory', role: 'Stock, sizes & restocks', monogram: 'IN', color: '#0f766e', tint: '#e0f4f1' },
  accounting: { key: 'accounting', name: 'Accounting', role: 'Cash, invoices & margins', monogram: 'AC', color: '#15803d', tint: '#e3f5e8' },
  facilities: { key: 'facilities', name: 'Facilities', role: 'Lease & rent', monogram: 'FA', color: '#b45309', tint: '#fbf0e1' },
  customer_service: { key: 'customer_service', name: 'Customer Service', role: 'Drafts replies (never sends)', monogram: 'CS', color: '#7e22ce', tint: '#f3e8fb' },
}

export const AGENT_ORDER: AgentName[] = ['boss', 'inventory', 'accounting', 'facilities', 'customer_service']

const SYSTEM: Record<string, { name: string; monogram: string; color: string; tint: string }> = {
  api: { name: 'Desk system', monogram: 'SY', color: '#475569', tint: '#eef1f5' },
  ticket_loop: { name: 'Desk system', monogram: 'SY', color: '#475569', tint: '#eef1f5' },
  human: { name: 'Human approver', monogram: 'HU', color: '#9f1239', tint: '#fbe7ec' },
}

export function identityOf(agent: string | null) {
  if (agent && agent in AGENTS) return AGENTS[agent as AgentName]
  return SYSTEM[agent ?? ''] ?? { name: agent ?? 'Unknown', monogram: '??', color: '#64748b', tint: '#f1f5f9' }
}

export function isAgent(agent: string | null): agent is AgentName {
  return !!agent && agent in AGENTS
}

// ---------------------------------------------------------------- event helpers

/** The events of the most recent agent run on a ticket, oldest first.
 *  Runs from before the last data reset are ignored: they no longer match the working database. */
export function latestRunEvents(eventsNewestFirst: AuditEvent[], ticketId: number, resetAt = ''): AuditEvent[] {
  const start = eventsNewestFirst.find((e) => e.ticket_id === ticketId && e.event === 'agent_step_start')
  if (!start || start.time < resetAt) return []
  return eventsNewestFirst.filter((e) => e.run_id === start.run_id && e.ticket_id === ticketId).reverse()
}

export type AgentState = 'idle' | 'working' | 'done' | 'stopped'

export interface AgentActivity {
  agent: AgentName
  state: AgentState
  summary: string | null
  tools: string[]
  delegatedTo: string[]
  refusedDelegations: number
  needsApproval: boolean
}

/** Per-agent activity for one run, built only from audit events. */
export function summarizeAgents(runEvents: AuditEvent[]): Map<AgentName, AgentActivity> {
  const map = new Map<AgentName, AgentActivity>()
  const get = (a: AgentName) => {
    let v = map.get(a)
    if (!v) {
      v = { agent: a, state: 'idle', summary: null, tools: [], delegatedTo: [], refusedDelegations: 0, needsApproval: false }
      map.set(a, v)
    }
    return v
  }
  const open = new Map<AgentName, number>() // nested runs of the same agent are possible
  for (const e of runEvents) {
    if (!isAgent(e.agent)) continue
    const a = get(e.agent)
    if (e.event === 'agent_step_start') {
      open.set(e.agent, (open.get(e.agent) ?? 0) + 1)
      a.state = 'working'
    } else if (e.event === 'agent_step_end') {
      const n = (open.get(e.agent) ?? 1) - 1
      open.set(e.agent, n)
      const stopped = (e.outcome ?? '').startsWith('stopped')
      a.state = n > 0 ? 'working' : stopped ? 'stopped' : 'done'
      if (stopped) a.summary = e.outcome
      else if (typeof e.result === 'string') a.summary = e.result
      if (e.needs_human_approval === true) a.needsApproval = true
    } else if (e.event === 'mcp_tool_call' && e.action) {
      a.tools.push(e.action)
    } else if (e.event === 'delegation') {
      const to = (e.action ?? '').replace('delegate -> ', '')
      if ((e.outcome ?? '').startsWith('refused')) a.refusedDelegations += 1
      else if (e.outcome === 'started') a.delegatedTo.push(to)
    }
  }
  return map
}

export function countBy(items: string[]): [string, number][] {
  const m = new Map<string, number>()
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1)
  return [...m.entries()]
}

export const money = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

export const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

export function prettyType(t: string) {
  return t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
