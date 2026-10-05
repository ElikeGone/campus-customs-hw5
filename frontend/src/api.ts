// Thin client for the Problem 7 backend. The dashboard has no shop data of its own:
// every value it shows comes from these calls to FastAPI.
import type {
  Cash, DecisionResponse, EventsResponse, Proposal, RunResponse, TicketsResponse,
} from './types'

export const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:8000').replace(/\/$/, '')

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
  } catch {
    // fetch() rejects for both "server down" and "blocked by CORS"; the browser doesn't say which.
    throw new ApiError(0, 'network',
      `Cannot reach the backend at ${API_URL}. Start it from backend/ with \`uvicorn main:app --reload --port 8000\`, ` +
      `and open the dashboard at http://localhost:5173 (the origin the backend allows).`)
  }
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) throw toApiError(res.status, body)
  return body as T
}

function toApiError(status: number, body: unknown): ApiError {
  const detail = (body as { detail?: unknown } | null)?.detail
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const d = detail as { code?: string; message?: string }
    return new ApiError(status, d.code ?? 'error', d.message ?? `Request failed (${status})`)
  }
  if (Array.isArray(detail)) {
    const msg = detail.map((d: { msg?: string }) => d.msg).filter(Boolean).join('; ')
    return new ApiError(status, 'validation', msg || 'Invalid request')
  }
  return new ApiError(status, 'error', typeof detail === 'string' ? detail : `Request failed (${status})`)
}

export const api = {
  tickets: () => request<TicketsResponse>('/tickets'),
  cash: () => request<Cash>('/cash'),
  proposals: (params: { status?: string; ticket_id?: number } = {}) => {
    const q = new URLSearchParams()
    if (params.status) q.set('status', params.status)
    if (params.ticket_id != null) q.set('ticket_id', String(params.ticket_id))
    return request<Proposal[]>(`/proposals${q.size ? `?${q}` : ''}`)
  },
  events: (params: { ticket_id?: number; limit?: number } = {}) => {
    const q = new URLSearchParams({ limit: String(params.limit ?? 300) })
    if (params.ticket_id != null) q.set('ticket_id', String(params.ticket_id))
    return request<EventsResponse>(`/events?${q}`)
  },
  runTicket: (id: number) => request<RunResponse>(`/tickets/${id}/run`, { method: 'POST' }),
  approve: (id: string, approvedBy: string) =>
    request<DecisionResponse>(`/proposals/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ approved_by: approvedBy, confirm: true }),
    }),
  reject: (id: string, rejectedBy: string, reason?: string) =>
    request<DecisionResponse>(`/proposals/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ rejected_by: rejectedBy, reason }),
    }),
  reset: () => request<{ reset: boolean }>('/reset', { method: 'POST', body: JSON.stringify({ confirm: true }) }),
}
