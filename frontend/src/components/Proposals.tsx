import { useEffect, useState } from 'react'
import { money } from '../agents'
import type { Cash, Proposal } from '../types'

const str = (v: unknown) => (v == null ? '' : String(v))

export function describeProposal(p: Proposal): { title: string; subtitle: string } {
  const d = p.details
  if (p.type === 'purchase_order') {
    return {
      title: `Purchase order · ${str(d.qty)} × ${str(d.sku)} (${str(d.size)})`,
      subtitle: `${str(d.vendor_name) || `Vendor #${str(d.vendor_id)}`}${d.vendor_lead_days != null ? ` · ${str(d.vendor_lead_days)}-day lead time` : ''}`,
    }
  }
  if (d.kind === 'lease') {
    return { title: `Rent payment · lease #${str(d.ref_id)}`, subtitle: d.for_due_date ? `Covers rent due ${str(d.for_due_date)}` : 'Rent' }
  }
  return { title: `Vendor invoice payment · invoice #${str(d.ref_id)}`, subtitle: 'Vendor invoice' }
}

const STATUS_TEXT: Record<Proposal['status'], string> = {
  pending: 'Awaiting human approval',
  approved: 'Approved & paid',
  rejected: 'Rejected',
  superseded: 'Superseded by a newer run',
}

interface CardProps {
  p: Proposal
  cash: Cash | null
  disabled: boolean
  showTicket?: boolean
  onApprove: (p: Proposal) => void
  onReject: (p: Proposal) => void
}

export function ProposalCard({ p, cash, disabled, showTicket = false, onApprove, onReject }: CardProps) {
  const { title, subtitle } = describeProposal(p)
  const reason = str(p.details.reason)
  const after = cash && p.amount != null ? cash.balance - p.amount : null
  const pending = p.status === 'pending'
  return (
    <article className={`proposal proposal-${p.status}`}>
      <div className="proposal-top">
        <div>
          {showTicket && <div className="proposal-ticket">Ticket #{p.ticket_id}</div>}
          <div className="proposal-title">{title}</div>
          <div className="proposal-sub">{subtitle} · from {str(p.details.account) || 'checking'}</div>
        </div>
        <div className="proposal-amount">{money(p.amount)}</div>
      </div>
      {reason && <p className="proposal-reason">“{reason}”</p>}
      {pending && after != null && (
        <div className={`proposal-impact ${after < 0 ? 'negative' : ''}`}>
          Checking {money(cash!.balance)} → <b>{money(after)}</b>
          {after < 0 && <span> · would go negative, so the backend will refuse it</span>}
        </div>
      )}
      {p.status === 'approved' && p.execution && (
        <div className="proposal-impact done">
          Paid by {p.decided_by} · payment #{str(p.execution.payment_id)} · checking now {money(Number(p.execution.cash_after))}
        </div>
      )}
      {p.status === 'rejected' && <div className="proposal-impact">Rejected by {p.decided_by}{p.note ? `: ${p.note}` : ''}</div>}
      <div className="proposal-foot">
        <span className={`proposal-status st-${p.status}`}>{STATUS_TEXT[p.status]}</span>
        {pending && (
          <div className="proposal-actions">
            <button className="btn btn-quiet" disabled={disabled} onClick={() => onReject(p)}>Reject</button>
            <button className="btn btn-approve" disabled={disabled} onClick={() => onApprove(p)}>Review & approve…</button>
          </div>
        )}
      </div>
    </article>
  )
}

interface DialogProps {
  p: Proposal
  mode: 'approve' | 'reject'
  cash: Cash | null
  submitting: boolean
  error: string | null
  onCancel: () => void
  onConfirm: (name: string, reason?: string) => void
}

export function DecisionDialog({ p, mode, cash, submitting, error, onCancel, onConfirm }: DialogProps) {
  const [name, setName] = useState(() => localStorage.getItem('cc-approver') ?? '')
  const [checked, setChecked] = useState(false)
  const [reason, setReason] = useState('')
  const { title, subtitle } = describeProposal(p)
  const after = cash && p.amount != null ? cash.balance - p.amount : null
  const approve = mode === 'approve'

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !submitting && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, submitting])

  const submit = () => {
    localStorage.setItem('cc-approver', name.trim())
    onConfirm(name.trim(), reason.trim() || undefined)
  }

  return (
    <div className="modal-backdrop" onClick={() => !submitting && onCancel()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="dlg-title" onClick={(e) => e.stopPropagation()}>
        <div className={`modal-head ${approve ? 'approve' : 'reject'}`}>
          <div className="modal-kicker">{approve ? 'Human approval required' : 'Reject proposal'}</div>
          <h3 id="dlg-title">{title}</h3>
          <div className="modal-sub">{subtitle} · Ticket #{p.ticket_id}</div>
        </div>

        <div className="modal-body">
          <div className="modal-amount-row">
            <div><div className="k">Amount</div><div className="v">{money(p.amount)}</div></div>
            <div><div className="k">Checking now</div><div className="v">{money(cash?.balance)}</div></div>
            {approve && <div><div className="k">After payment</div><div className={`v ${after != null && after < 0 ? 'neg' : ''}`}>{money(after)}</div></div>}
          </div>

          {approve && after != null && after < 0 && (
            <div className="inline-error">This would take checking below zero. The backend will refuse it, because cash can never go negative.</div>
          )}

          {approve ? (
            <p className="modal-note">
              The agents proposed this; they cannot pay it. Approving calls the backend's approval route.
              The backend re-checks the amount against the database, records the payment and updates the checking balance.
            </p>
          ) : (
            <p className="modal-note">Rejecting leaves cash untouched. The ticket stays open so it can be re-run.</p>
          )}

          <label className="field">
            <span>{approve ? 'Approved by' : 'Rejected by'}</span>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
          </label>

          {approve ? (
            <label className="check">
              <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
              <span>I approve paying {money(p.amount)} from {str(p.details.account) || 'checking'}.</span>
            </label>
          ) : (
            <label className="field">
              <span>Reason (optional)</span>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why not?" />
            </label>
          )}

          {error && <div className="inline-error">{error}</div>}
        </div>

        <div className="modal-foot">
          <button className="btn btn-quiet" onClick={onCancel} disabled={submitting}>Cancel</button>
          <button
            className={`btn ${approve ? 'btn-approve' : 'btn-danger'}`}
            disabled={submitting || !name.trim() || (approve && !checked)}
            onClick={submit}
          >
            {submitting ? <><span className="spinner light" /> Working…</> : approve ? `Approve & pay ${money(p.amount)}` : 'Reject proposal'}
          </button>
        </div>
      </div>
    </div>
  )
}
