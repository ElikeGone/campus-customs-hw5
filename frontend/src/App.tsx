import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { latestRunEvents, money, summarizeAgents } from './agents'
import { api, ApiError } from './api'
import { DecisionDialog, ProposalCard, describeProposal } from './components/Proposals'
import { TicketQueue } from './components/TicketQueue'
import { TicketWorkspace, type Banner } from './components/TicketWorkspace'
import { Toasts, type Toast } from './components/Toasts'
import { TopBar } from './components/TopBar'
import type { AuditEvent, Cash, DecisionResponse, Proposal, RunResponse, Ticket } from './types'

const RUNS_KEY = 'cc-last-runs'
const POLL_MS = 1200

interface Running { ticketId: number; startedAt: number; baseline: string }

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export default function App() {
  const [tickets, setTickets] = useState<Ticket[] | null>(null)
  const [today, setToday] = useState<string | null>(null)
  const [ticketsErr, setTicketsErr] = useState<string | null>(null)
  const [cash, setCash] = useState<Cash | null>(null)
  const [cashErr, setCashErr] = useState<string | null>(null)
  const [cashFlash, setCashFlash] = useState<'up' | 'down' | null>(null)
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [eventsLoading, setEventsLoading] = useState(false)
  const [running, setRunning] = useState<Running | null>(null)
  const [banners, setBanners] = useState<Record<number, Banner>>({})
  const [lastRuns, setLastRuns] = useState<Record<number, RunResponse>>(() => {
    try { return JSON.parse(localStorage.getItem(RUNS_KEY) ?? '{}') } catch { return {} }
  })
  const [dialog, setDialog] = useState<{ p: Proposal; mode: 'approve' | 'reject' } | null>(null)
  const [dialogBusy, setDialogBusy] = useState(false)
  const [dialogErr, setDialogErr] = useState<string | null>(null)
  const [resetting, setResetting] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [now, setNow] = useState(Date.now())
  const [resetAt, setResetAt] = useState('')
  const prevBalance = useRef<number | null>(null)
  const toastId = useRef(0)
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId

  const toast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = ++toastId.current
    setToasts((ts) => [...ts, { ...t, id }])
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), t.kind === 'error' ? 9000 : 5000)
  }, [])

  // ------------------------------------------------------------------ loading

  // Show a balance that came from the backend, flashing the card if it moved.
  const showBalance = useCallback((balance: number, date?: string) => {
    if (prevBalance.current != null && balance !== prevBalance.current) {
      setCashFlash(balance > prevBalance.current ? 'up' : 'down')
      setTimeout(() => setCashFlash(null), 1600)
    }
    prevBalance.current = balance
    setCash((c) => ({ account: 'checking', date: date ?? c?.date ?? '', balance }))
    setCashErr(null)
  }, [])

  const loadCash = useCallback(async () => {
    try {
      const c = await api.cash()
      showBalance(c.balance, c.date)
    } catch (e) { setCashErr(errText(e)) }
  }, [showBalance])

  // Apply what the backend just returned right away; the full refresh that follows confirms it.
  const setTicketStatus = useCallback((id: number, status: string, pending: (n: number) => number) => {
    setTickets((ts) => ts?.map((t) => (t.id === id ? { ...t, status, pending_proposals: pending(t.pending_proposals) } : t)) ?? ts)
  }, [])

  const applyRunResult = useCallback((res: RunResponse) => {
    // Like the backend, a new run supersedes the ticket's older pending proposals.
    setProposals((ps) => [
      ...ps.map((p) => (p.ticket_id === res.ticket_id && p.status === 'pending' ? { ...p, status: 'superseded' as const } : p)),
      ...res.proposals,
    ])
    setTicketStatus(res.ticket_id, res.ticket_status, () => res.proposals.filter((p) => p.status === 'pending').length)
  }, [setTicketStatus])

  const applyDecision = useCallback((r: DecisionResponse) => {
    setProposals((ps) => ps.map((p) => (p.id === r.proposal.id ? r.proposal : p)))
    setTicketStatus(r.proposal.ticket_id, r.ticket_status, (n) => Math.max(0, n - 1))
    if (r.cash_after != null) showBalance(r.cash_after)
  }, [setTicketStatus, showBalance])

  const loadTickets = useCallback(async () => {
    try {
      const r = await api.tickets()
      setTickets(r.tickets); setToday(r.today); setTicketsErr(null)
      // ?ticket=102 opens that ticket (handy for links and screenshots); otherwise the first open one.
      const wanted = Number(new URLSearchParams(window.location.search).get('ticket'))
      setSelectedId((cur) => cur
        ?? r.tickets.find((t) => t.id === wanted)?.id
        ?? (r.tickets.find((t) => t.status !== 'resolved') ?? r.tickets[0])?.id
        ?? null)
    } catch (e) { setTicketsErr(errText(e)) }
  }, [])

  const loadProposals = useCallback(async () => {
    try { setProposals(await api.proposals()) } catch (e) { toast({ kind: 'error', title: 'Could not load proposals', body: errText(e) }) }
  }, [toast])

  const loadEvents = useCallback(async (ticketId: number) => {
    setEventsLoading(true)
    try { setEvents((await api.events({ ticket_id: ticketId, limit: 400 })).events) }
    catch (e) { toast({ kind: 'error', title: 'Could not load agent events', body: errText(e) }) }
    finally { setEventsLoading(false) }
  }, [toast])

  // Runs from before the latest data reset no longer describe the working database.
  const loadResetAt = useCallback(async () => {
    try {
      const all = (await api.events({ limit: 500 })).events
      setResetAt(all.find((e) => e.event === 'reset')?.time ?? '')
    } catch { /* not critical: without it, older runs are still shown */ }
  }, [])

  const loadAll = useCallback(() => Promise.all([loadTickets(), loadCash(), loadProposals(), loadResetAt()]),
    [loadTickets, loadCash, loadProposals, loadResetAt])

  useEffect(() => { loadAll() }, [loadAll])
  useEffect(() => { if (selectedId != null) loadEvents(selectedId) }, [selectedId, loadEvents])
  useEffect(() => { localStorage.setItem(RUNS_KEY, JSON.stringify(lastRuns)) }, [lastRuns])

  // Tick the elapsed timer and poll the audit trail while a ticket is running.
  useEffect(() => {
    if (!running) return
    const tick = setInterval(() => setNow(Date.now()), 1000)
    const poll = setInterval(async () => {
      try {
        const r = await api.events({ ticket_id: running.ticketId, limit: 400 })
        if (running.ticketId === selectedIdRef.current) setEvents(r.events)
      } catch { /* keep polling; the run request reports real failures */ }
    }, POLL_MS)
    return () => { clearInterval(tick); clearInterval(poll) }
  }, [running])

  // ------------------------------------------------------------------ actions

  const runTicket = useCallback(async (id: number) => {
    if (running) return // one run at a time; the backend enforces this too
    const newest = (await api.events({ ticket_id: id, limit: 1 }).catch(() => null))?.events[0]?.time ?? ''
    const startedAt = Date.now()
    setRunning({ ticketId: id, startedAt, baseline: newest })
    setNow(startedAt)
    setBanners((b) => ({ ...b, [id]: { kind: 'running', startedAt } }))
    try {
      const res = await api.runTicket(id)
      if (res.error || !res.decision) {
        setBanners((b) => ({ ...b, [id]: { kind: 'error', title: 'The agent run stopped before a decision', message: res.error ?? 'No decision was returned.' } }))
        toast({ kind: 'error', title: `Ticket #${id}: run stopped`, body: res.error ?? undefined })
      } else {
        setLastRuns((r) => ({ ...r, [id]: res }))
        applyRunResult(res)
        const pending = res.proposals.filter((p) => p.status === 'pending').length
        setBanners((b) => ({ ...b, [id]: { kind: 'success', status: res.ticket_status, pending, agents: new Set(['boss', ...res.decision!.agents_consulted]).size } }))
        toast({
          kind: 'success',
          title: `Ticket #${id} run finished: ${res.ticket_status === 'resolved' ? 'Resolved' : 'Open'}`,
          body: pending ? `${pending} proposal${pending > 1 ? 's need' : ' needs'} your approval.` : undefined,
        })
      }
    } catch (e) {
      const err = e instanceof ApiError ? e : null
      const title = err?.code === 'busy' ? 'The desk is busy'
        : err?.code === 'ticket_not_open' ? 'Ticket already resolved'
        : err?.code === 'network' ? 'Backend unreachable' : 'Run failed'
      setBanners((b) => ({ ...b, [id]: { kind: 'error', title, message: errText(e) } }))
      toast({ kind: 'error', title, body: errText(e) })
    } finally {
      setRunning(null)
      if (selectedIdRef.current != null) await loadEvents(selectedIdRef.current)
      await loadAll()
    }
  }, [running, toast, loadAll, loadEvents, applyRunResult])

  const confirmDecision = useCallback(async (name: string, reason?: string) => {
    if (!dialog) return
    const { p, mode } = dialog
    setDialogBusy(true); setDialogErr(null)
    try {
      if (mode === 'approve') {
        const r = await api.approve(p.id, name)
        applyDecision(r)
        toast({ kind: 'success', title: `Paid ${money(p.amount)}: ${describeProposal(p).title}`, body: `Checking is now ${money(r.cash_after)}. Ticket #${p.ticket_id} is ${r.ticket_status}.` })
      } else {
        applyDecision(await api.reject(p.id, name, reason))
        toast({ kind: 'info', title: 'Proposal rejected', body: `Cash unchanged. Ticket #${p.ticket_id} stays open.` })
      }
      setDialog(null)
    } catch (e) {
      const code = e instanceof ApiError ? e.code : ''
      const title = code === 'insufficient_cash' ? 'Refused: not enough cash'
        : code === 'duplicate' || code === 'not_pending' ? 'Already decided'
        : code === 'vendor_has_unpaid_invoice' ? 'Refused: vendor has an unpaid invoice'
        : code === 'stale_proposal' ? 'Refused: amount no longer matches the database'
        : code === 'busy' ? 'The desk is busy' : 'Approval failed'
      setDialogErr(`${title}. ${errText(e)} No money moved.`)
      toast({ kind: 'error', title, body: 'No money moved.' })
    } finally {
      setDialogBusy(false)
      if (selectedIdRef.current != null) await loadEvents(selectedIdRef.current)
      await loadAll()
    }
  }, [dialog, toast, loadAll, loadEvents, applyDecision])

  const resetData = useCallback(async () => {
    if (!window.confirm('Reset the working database to the original data? This clears all payments, proposals and ticket progress. The audit trail is kept.')) return
    setResetting(true)
    try {
      await api.reset()
      setLastRuns({}); setBanners({})
      toast({ kind: 'info', title: 'Working data reset', body: 'Restored from data/campus_customs.db.' })
    } catch (e) {
      toast({ kind: 'error', title: 'Reset failed', body: errText(e) })
    } finally {
      setResetting(false)
      if (selectedIdRef.current != null) await loadEvents(selectedIdRef.current)
      await loadAll()
    }
  }, [toast, loadAll, loadEvents])

  // ------------------------------------------------------------------ derived

  const selected = tickets?.find((t) => t.id === selectedId) ?? null
  const isLive = !!running && running.ticketId === selectedId
  const shownEvents = useMemo(() => {
    if (selectedId == null) return []
    if (isLive) return events.filter((e) => e.ticket_id === selectedId && e.time > running!.baseline).reverse()
    return latestRunEvents(events, selectedId, resetAt)
  }, [events, selectedId, isLive, running, resetAt])

  const pending = proposals.filter((p) => p.status === 'pending')
  const pendingTotal = pending.reduce((s, p) => s + (p.amount ?? 0), 0)
  const recent = proposals.filter((p) => p.status === 'approved' || p.status === 'rejected')
    .sort((a, b) => (b.decided_at ?? '').localeCompare(a.decided_at ?? '')).slice(0, 4)
  const busy = !!running || resetting || dialogBusy
  const lastRun = selectedId != null ? lastRuns[selectedId] : undefined
  // Only use the cached run details if they belong to the run shown from the audit trail.
  const lastRunMatches = lastRun && shownEvents.some((e) => e.run_id === lastRun.run_id) ? lastRun : undefined

  return (
    <div className="app">
      <TopBar
        today={today} cash={cash} cashError={cashErr} cashFlash={cashFlash}
        pendingTotal={pendingTotal} pendingCount={pending.length} busy={busy}
        onRefresh={() => { loadAll(); if (selectedId != null) loadEvents(selectedId) }}
        onReset={resetData}
      />

      <div className="layout">
        <TicketQueue tickets={tickets} error={ticketsErr} selectedId={selectedId} runningId={running?.ticketId ?? null} onSelect={setSelectedId} />

        {selected ? (
          <TicketWorkspace
            ticket={selected}
            events={shownEvents}
            eventsLoading={eventsLoading}
            live={isLive}
            otherRunning={!!running && !isLive}
            now={now}
            banner={selectedId != null ? banners[selectedId] ?? null : null}
            lastRun={lastRunMatches}
            proposals={proposals.filter((p) => p.ticket_id === selected.id)}
            cash={cash}
            actionsDisabled={busy}
            onRun={() => runTicket(selected.id)}
            onApprove={(p) => { setDialogErr(null); setDialog({ p, mode: 'approve' }) }}
            onReject={(p) => { setDialogErr(null); setDialog({ p, mode: 'reject' }) }}
          />
        ) : (
          <main className="workspace"><div className="panel empty-state">{ticketsErr ? 'Tickets could not be loaded.' : 'Loading the ticket queue…'}</div></main>
        )}

        <aside className="panel approvals-rail">
          <div className="panel-head">
            <h2>Approval queue</h2>
            <span className={`count-pill ${pending.length ? 'warn' : ''}`}>{pending.length} pending</span>
          </div>
          <p className="rail-note">Agents can only <i>propose</i>. Cash changes only when you approve here.</p>
          {pending.length ? pending.map((p) => (
            <ProposalCard key={p.id} p={p} cash={cash} disabled={busy} showTicket
              onApprove={(x) => { setDialogErr(null); setDialog({ p: x, mode: 'approve' }) }}
              onReject={(x) => { setDialogErr(null); setDialog({ p: x, mode: 'reject' }) }} />
          )) : <div className="rail-empty">Nothing waiting for approval.</div>}

          {recent.length > 0 && (
            <>
              <div className="queue-section">Recent decisions</div>
              {recent.map((p) => (
                <div key={p.id} className={`recent recent-${p.status}`}>
                  <span>#{p.ticket_id} · {describeProposal(p).title}</span>
                  <b>{p.status === 'approved' ? `−${money(p.amount)}` : 'rejected'}</b>
                </div>
              ))}
            </>
          )}
          <AgentsLegend events={shownEvents} />
        </aside>
      </div>

      {dialog && (
        <DecisionDialog
          p={dialog.p} mode={dialog.mode} cash={cash} submitting={dialogBusy} error={dialogErr}
          onCancel={() => setDialog(null)} onConfirm={confirmDecision}
        />
      )}
      <Toasts toasts={toasts} dismiss={(id) => setToasts((ts) => ts.filter((t) => t.id !== id))} />
    </div>
  )
}

function AgentsLegend({ events }: { events: AuditEvent[] }) {
  const tools = events.filter((e) => e.event === 'mcp_tool_call').length
  const delegations = events.filter((e) => e.event === 'delegation').length
  const agents = summarizeAgents(events).size
  if (!events.length) return null
  return (
    <div className="run-stats">
      <div className="queue-section">This run</div>
      <div className="stat-row"><span>Agents involved</span><b>{agents}</b></div>
      <div className="stat-row"><span>Delegations</span><b>{delegations}</b></div>
      <div className="stat-row"><span>MCP tool calls</span><b>{tools}</b></div>
    </div>
  )
}
