import { prettyType, summarizeAgents } from '../agents'
import type { AuditEvent, Cash, Proposal, RunResponse, Ticket } from '../types'
import { ActivityFeed } from './ActivityFeed'
import { AgentBadge } from './AgentBadge'
import { AgentRoster } from './AgentRoster'
import { ProposalCard } from './Proposals'

export type Banner =
  | { kind: 'running'; startedAt: number }
  | { kind: 'success'; status: string; pending: number; agents: number }
  | { kind: 'error'; title: string; message: string }

interface Props {
  ticket: Ticket
  events: AuditEvent[]
  eventsLoading: boolean
  live: boolean
  otherRunning: boolean
  now: number
  banner: Banner | null
  lastRun: RunResponse | undefined
  proposals: Proposal[]
  cash: Cash | null
  actionsDisabled: boolean
  onRun: () => void
  onApprove: (p: Proposal) => void
  onReject: (p: Proposal) => void
}

export function TicketWorkspace(props: Props) {
  const { ticket: t, events, eventsLoading, live, otherRunning, now, banner, lastRun, proposals, cash, actionsDisabled } = props
  const activity = summarizeAgents(events)
  const resolved = t.status === 'resolved'
  const bossReport = [...events].reverse().find((e) => e.agent === 'boss' && e.event === 'agent_step_end')
  const decision = lastRun?.decision ?? null
  const decisionText = decision?.decision ?? (typeof bossReport?.result === 'string' ? bossReport.result : null)
  const visibleProposals = proposals.filter((p) => p.status !== 'superseded')

  let runLabel = 'Run agent team'
  let runDisabledReason: string | null = null
  if (live) { runLabel = 'Agents working…'; runDisabledReason = 'This ticket is already running.' }
  else if (otherRunning) runDisabledReason = 'Another ticket is running. The desk runs one ticket at a time.'
  else if (resolved) runDisabledReason = 'Resolved tickets can’t be re-run. Use “Reset data” to start fresh.'

  return (
    <main className="workspace">
      <section className="panel ticket-head">
        <div className="ticket-head-main">
          <div className="ticket-head-kicker">
            <span className="ticket-id big">#{t.id}</span>
            <span className="type-chip">{prettyType(t.type)}</span>
            <span className={`status-pill ${live ? 'status-running' : resolved ? 'status-resolved' : 'status-open'}`}>
              {live ? <><span className="dot" />Running</> : resolved ? '✓ Resolved' : 'Open'}
            </span>
          </div>
          <h1>{t.subject}</h1>
          <p className="ticket-notes">{t.notes}</p>
          <dl className="facts">
            <div><dt>Requester</dt><dd>{t.requester}</dd></div>
            {t.sku && <div><dt>Item</dt><dd><code>{t.sku}</code> · size {t.size} · qty {t.qty}</dd></div>}
            {t.invoice_id != null && <div><dt>Linked invoice</dt><dd>#{t.invoice_id}</dd></div>}
            {t.lease_id != null && <div><dt>Linked lease</dt><dd>#{t.lease_id}</dd></div>}
            <div><dt>Received</dt><dd>{t.created_at.replace('T', ' ').slice(0, 16)}</dd></div>
          </dl>
        </div>
        <div className="run-box">
          <button className={`btn btn-run ${live ? 'is-running' : ''}`} onClick={props.onRun} disabled={!!runDisabledReason}>
            {live ? <span className="spinner light" /> : <span className="run-icon">▶</span>}
            {runLabel}
          </button>
          <div className="run-hint">{runDisabledReason ?? 'Starts with the Boss, who delegates to the specialists. Agents can only propose payments.'}</div>
        </div>
      </section>

      {banner && <RunBanner banner={banner} now={now} />}

      <section className="panel">
        <div className="panel-head">
          <h2>Agent team</h2>
          <span className="panel-hint">{live ? 'Live, from the audit trail' : events.length ? 'Latest run on this ticket' : 'No run yet'}</span>
        </div>
        <AgentRoster activity={activity} live={live} hasRun={events.length > 0} />
      </section>

      <div className="workspace-split">
        <section className="panel feed-panel">
          <div className="panel-head">
            <h2>Activity &amp; MCP tool calls</h2>
            <span className="panel-hint">{eventsLoading && !events.length ? 'Loading…' : `${events.length} events`}</span>
          </div>
          <ActivityFeed events={events} live={live} />
        </section>

        <div className="side-stack">
          <section className="panel decision-panel">
            <div className="panel-head">
              <h2><AgentBadge agent="boss" size={22} /> Boss decision</h2>
              {decision && <span className={`approval-tag ${decision.needs_human_approval ? 'yes' : 'no'}`}>{decision.needs_human_approval ? 'Needs human approval' : 'No approval needed'}</span>}
            </div>
            {decisionText ? (
              <>
                <p className="decision-text">{decisionText}</p>
                {decision?.approval_reason && <p className="decision-reason"><b>Why approval:</b> {decision.approval_reason}</p>}
                {!!decision?.next_steps.length && (
                  <>
                    <h3 className="mini-head">Next steps</h3>
                    <ol className="next-steps">{decision.next_steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
                  </>
                )}
                {!!decision?.drafts.length && (
                  <>
                    <h3 className="mini-head">Drafted messages <span className="draft-tag">DRAFT · not sent</span></h3>
                    {decision.drafts.map((d, i) => (
                      <div key={i} className="draft">
                        <div className="draft-head">To: <b>{d.to}</b> · {d.subject}</div>
                        <pre className="draft-body">{d.body}</pre>
                      </div>
                    ))}
                  </>
                )}
                {!decision && <p className="muted small">Full decision details (next steps, drafts) appear here right after a run from this browser.</p>}
              </>
            ) : (
              <p className="muted">{live ? 'The Boss will post a decision when the specialists report back.' : 'No decision yet.'}</p>
            )}
          </section>

          <section className="panel money-panel">
            <div className="panel-head">
              <h2>Financial actions</h2>
              <span className="panel-hint">Money moves only on human approval</span>
            </div>
            {visibleProposals.length ? (
              visibleProposals.map((p) => (
                <ProposalCard key={p.id} p={p} cash={cash} disabled={actionsDisabled} onApprove={props.onApprove} onReject={props.onReject} />
              ))
            ) : (
              <p className="muted">No payments or purchase orders proposed for this ticket.</p>
            )}
          </section>
        </div>
      </div>
    </main>
  )
}

function RunBanner({ banner, now }: { banner: Banner; now: number }) {
  if (banner.kind === 'running') {
    const s = Math.max(0, Math.floor((now - banner.startedAt) / 1000))
    return (
      <div className="banner banner-running" role="status">
        <span className="spinner" />
        <div>
          <b>Agents are working on this ticket</b> · {Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')} elapsed
          <div className="banner-sub">Runs usually take under a minute. Run buttons are locked until this one finishes.</div>
        </div>
      </div>
    )
  }
  if (banner.kind === 'success') {
    const resolved = banner.status === 'resolved'
    return (
      <div className={`banner ${resolved ? 'banner-success' : 'banner-pending'}`} role="status">
        <span className="banner-icon">{resolved ? '✓' : '⚑'}</span>
        <div>
          <b>Run finished.</b> Ticket is now <b>{resolved ? 'Resolved' : 'Open'}</b>. {banner.agents} agent{banner.agents === 1 ? '' : 's'} took part.
          <div className="banner-sub">
            {banner.pending
              ? `${banner.pending} financial action${banner.pending > 1 ? 's' : ''} waiting for your approval. The ticket resolves once they're approved.`
              : resolved ? 'Nothing needed human approval.' : 'Review the decision below.'}
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className="banner banner-error" role="alert">
      <span className="banner-icon">!</span>
      <div><b>{banner.title}</b><div className="banner-sub">{banner.message}</div></div>
    </div>
  )
}
