import { AGENTS, AGENT_ORDER, countBy, type AgentActivity } from '../agents'
import type { AgentName } from '../types'
import { AgentBadge } from './AgentBadge'

const STATE_LABEL = { idle: 'Standing by', working: 'Working…', done: 'Reported', stopped: 'Stopped' } as const

export function AgentRoster({ activity, live, hasRun }: { activity: Map<AgentName, AgentActivity>; live: boolean; hasRun: boolean }) {
  return (
    <section className="roster">
      {AGENT_ORDER.map((key) => {
        const id = AGENTS[key]
        const a = activity.get(key)
        const involved = !!a
        const state = a?.state ?? 'idle'
        return (
          <article
            key={key}
            className={`agent-card state-${state} ${involved ? 'involved' : hasRun && !live ? 'uninvolved' : ''}`}
            style={{ ['--agent' as string]: id.color, ['--agent-tint' as string]: id.tint }}
          >
            <header className="agent-card-head">
              <AgentBadge agent={key} size={36} pulse={state === 'working'} />
              <div className="agent-title">
                <div className="agent-name">{id.name}</div>
                <div className="agent-role">{id.role}</div>
              </div>
              <span className={`agent-state state-tag-${state}`}>
                {involved ? STATE_LABEL[state] : hasRun && !live ? 'Not involved' : 'Standing by'}
              </span>
            </header>

            {a && (
              <div className="agent-body">
                {a.summary ? (
                  <p className="agent-summary">{a.summary}</p>
                ) : (
                  <p className="agent-summary muted">{state === 'working' ? 'Gathering facts…' : 'No report yet.'}</p>
                )}
                <div className="agent-stats">
                  {countBy(a.tools).map(([tool, n]) => (
                    <span key={tool} className="tool-chip" title="MCP tool call">⌁ {tool}{n > 1 ? ` ×${n}` : ''}</span>
                  ))}
                  {a.delegatedTo.length > 0 && (
                    <span className="deleg-chip">→ {[...new Set(a.delegatedTo)].map((d) => AGENTS[d as AgentName]?.name ?? d).join(', ')}</span>
                  )}
                  {a.refusedDelegations > 0 && <span className="warn-chip">{a.refusedDelegations} delegation{a.refusedDelegations > 1 ? 's' : ''} refused</span>}
                  {a.needsApproval && <span className="money-chip">needs approval</span>}
                </div>
              </div>
            )}
          </article>
        )
      })}
    </section>
  )
}
