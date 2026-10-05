import { money } from '../agents'
import type { Cash } from '../types'

interface Props {
  today: string | null
  cash: Cash | null
  cashError: string | null
  cashFlash: 'up' | 'down' | null
  pendingTotal: number
  pendingCount: number
  busy: boolean
  onRefresh: () => void
  onReset: () => void
}

export function TopBar({ today, cash, cashError, cashFlash, pendingTotal, pendingCount, busy, onRefresh, onReset }: Props) {
  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark">CC</div>
        <div>
          <div className="brand-name">Campus Customs</div>
          <div className="brand-sub">Operations Desk · Chapel Street</div>
        </div>
      </div>

      <div className="topbar-meta">
        <div className="meta-chip">
          <span className="meta-label">Shop date</span>
          <span className="meta-value">{today ?? '—'}</span>
        </div>
        <div className={`meta-chip ${pendingCount ? 'meta-warn' : ''}`}>
          <span className="meta-label">Awaiting approval</span>
          <span className="meta-value">{pendingCount ? `${pendingCount} · ${money(pendingTotal)}` : 'None'}</span>
        </div>
      </div>

      <div className={`cash-card ${cashFlash ? `flash-${cashFlash}` : ''}`} aria-live="polite">
        <div className="cash-label">Checking balance</div>
        {cashError ? (
          <div className="cash-error">{cashError}</div>
        ) : (
          <div className="cash-value">{cash ? money(cash.balance) : <span className="skeleton w-120" />}</div>
        )}
        <div className="cash-sub">{cash ? `as of ${cash.date} · cash_accounts` : 'loading…'}</div>
      </div>

      <div className="topbar-actions">
        <button className="btn btn-ghost-light" onClick={onRefresh} disabled={busy} title="Reload tickets, cash and proposals">
          ↻ Refresh
        </button>
        <button className="btn btn-ghost-light" onClick={onReset} disabled={busy} title="Restore data/campus_customs_new.db from the original">
          Reset data
        </button>
      </div>
    </header>
  )
}
