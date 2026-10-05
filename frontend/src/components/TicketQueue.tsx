import { prettyType } from '../agents'
import type { Ticket } from '../types'

interface Props {
  tickets: Ticket[] | null
  error: string | null
  selectedId: number | null
  runningId: number | null
  onSelect: (id: number) => void
}

export function TicketQueue({ tickets, error, selectedId, runningId, onSelect }: Props) {
  const open = tickets?.filter((t) => t.status !== 'resolved') ?? []
  const done = tickets?.filter((t) => t.status === 'resolved') ?? []

  return (
    <aside className="panel queue">
      <div className="panel-head">
        <h2>Ticket queue</h2>
        {tickets && <span className="count-pill">{open.length} open · {done.length} resolved</span>}
      </div>

      {error && <div className="inline-error">{error}</div>}
      {!tickets && !error && [0, 1, 2].map((i) => <div key={i} className="ticket-card skeleton-card" />)}

      {open.length > 0 && <div className="queue-section">Open</div>}
      {open.map((t) => <TicketCard key={t.id} t={t} selected={t.id === selectedId} running={t.id === runningId} onSelect={onSelect} />)}

      {done.length > 0 && <div className="queue-section">Resolved</div>}
      {done.map((t) => <TicketCard key={t.id} t={t} selected={t.id === selectedId} running={false} onSelect={onSelect} />)}
    </aside>
  )
}

function TicketCard({ t, selected, running, onSelect }: { t: Ticket; selected: boolean; running: boolean; onSelect: (id: number) => void }) {
  const resolved = t.status === 'resolved'
  return (
    <button
      className={`ticket-card ${resolved ? 'is-resolved' : 'is-open'} ${selected ? 'is-selected' : ''}`}
      onClick={() => onSelect(t.id)}
      aria-pressed={selected}
    >
      <div className="ticket-card-top">
        <span className="ticket-id">#{t.id}</span>
        {running ? (
          <span className="status-pill status-running"><span className="dot" />Running</span>
        ) : (
          <span className={`status-pill ${resolved ? 'status-resolved' : 'status-open'}`}>{resolved ? '✓ Resolved' : 'Open'}</span>
        )}
      </div>
      <div className="ticket-subject">{t.subject}</div>
      <div className="ticket-meta">{prettyType(t.type)} · {t.requester}</div>
      {t.pending_proposals > 0 && (
        <div className="ticket-flag">⚑ {t.pending_proposals} awaiting approval</div>
      )}
    </button>
  )
}
