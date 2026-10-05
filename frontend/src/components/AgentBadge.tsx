import { identityOf } from '../agents'

export function AgentBadge({ agent, size = 32, pulse = false }: { agent: string | null; size?: number; pulse?: boolean }) {
  const id = identityOf(agent)
  return (
    <span
      className={`agent-badge${pulse ? ' pulse' : ''}`}
      title={id.name}
      style={{
        width: size, height: size, fontSize: size * 0.36,
        color: id.color, background: id.tint, borderColor: id.color,
        ['--ring' as string]: id.color,
      }}
    >
      {id.monogram}
    </span>
  )
}

export function AgentName({ agent }: { agent: string | null }) {
  const id = identityOf(agent)
  return <strong style={{ color: id.color }}>{id.name}</strong>
}
