import { useEffect, useRef, type ReactNode } from 'react'
import { AGENTS, clock, identityOf } from '../agents'
import type { AgentName, AuditEvent } from '../types'
import { AgentBadge, AgentName as Name } from './AgentBadge'

export function ActivityFeed({ events, live }: { events: AuditEvent[]; live: boolean }) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (live) end.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [events.length, live])

  if (!events.length) {
    return (
      <div className="feed-empty">
        {live ? <><span className="spinner" /> Waiting for the first agent step…</> : 'No agent activity recorded for this ticket yet. Run the agent team to see it here.'}
      </div>
    )
  }

  return (
    <ol className="feed">
      {events.map((e, i) => <FeedItem key={`${e.time}-${i}`} e={e} />)}
      {live && (
        <li className="feed-item feed-live">
          <span className="spinner" /> Agents are working…
        </li>
      )}
      <div ref={end} />
    </ol>
  )
}

function FeedItem({ e }: { e: AuditEvent }) {
  const id = identityOf(e.agent)
  const outcome = e.outcome ?? ''
  let kind = 'step'
  let body: ReactNode = null

  switch (e.event) {
    case 'run_start':
      if (e.agent !== 'api') return null
      kind = 'system'
      body = <>Run started. Ticket handed to the <Name agent="boss" />.</>
      break
    case 'agent_step_start':
      body = <><Name agent={e.agent} /> picked up the task{typeof e.inputs === 'string' && <Quote text={e.inputs} />}</>
      break
    case 'delegation': {
      const to = (e.action ?? '').replace('delegate -> ', '')
      const refused = outcome.startsWith('refused')
      kind = refused ? 'refused' : 'delegation'
      body = (
        <>
          <Name agent={e.agent} /> {refused ? 'tried to delegate to' : 'delegated to'}{' '}
          <span className="inline-agent" style={{ color: AGENTS[to as AgentName]?.color }}>{AGENTS[to as AgentName]?.name ?? to}</span>
          {refused ? <div className="feed-note">Refused by guardrail: {outcome.replace(/^refused:\s*/, '')}</div> : typeof e.inputs === 'string' && <Quote text={e.inputs} />}
        </>
      )
      break
    }
    case 'mcp_tool_call':
      kind = outcome === 'ok' ? 'tool' : 'refused'
      body = (
        <>
          <Name agent={e.agent} /> called MCP tool <code className="tool-name">{e.action}</code>
          {e.inputs && e.inputs !== '{}' && <code className="tool-args">{String(e.inputs)}</code>}
          {e.result != null && <div className="tool-result">{String(e.result)}</div>}
          {outcome !== 'ok' && <div className="feed-note">{outcome}</div>}
        </>
      )
      break
    case 'agent_step_end':
      kind = outcome.startsWith('stopped') ? 'refused' : 'report'
      body = outcome.startsWith('stopped')
        ? <><Name agent={e.agent} /> stopped<div className="feed-note">{outcome}</div></>
        : <><Name agent={e.agent} /> reported back{typeof e.result === 'string' && <Quote text={e.result} strong />}</>
      break
    case 'ticket_end':
      return null
    case 'run_end':
      if (e.agent !== 'api') return null
      kind = outcome === 'decided' ? 'success' : 'refused'
      body = outcome === 'decided'
        ? <>Run finished. Ticket is <b>{String(e.ticket_status ?? '')}</b>.</>
        : <>Run stopped<div className="feed-note">{outcome}</div></>
      break
    case 'approval':
      kind = outcome === 'executed' ? 'money' : 'refused'
      body = <><Name agent="human" /> {e.action}<div className="feed-note">{outcome}</div></>
      break
    default:
      body = <>{e.event} {e.action}</>
  }

  return (
    <li className={`feed-item feed-${kind}`} style={{ ['--agent' as string]: id.color }}>
      <AgentBadge agent={e.agent} size={26} />
      <div className="feed-content">
        <div className="feed-line">{body}</div>
      </div>
      <time className="feed-time">{clock(e.time)}</time>
    </li>
  )
}

function Quote({ text, strong = false }: { text: string; strong?: boolean }) {
  return <div className={`feed-quote ${strong ? 'strong' : ''}`}>{text}</div>
}
