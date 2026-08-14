import { AgentMark } from './AgentMark.jsx'

const STATE_LABELS = {
  planned: 'Planned',
  active: 'Active',
  confirmed: 'Confirmed',
  existing: 'Existing',
  deployed: 'Deployed',
  reused: 'Reused',
  failed: 'Failed',
  idle: 'Idle',
}

export function AgentPersonaAvatar({ identity, persona, state = 'confirmed', className = '' }) {
  if (!identity?.identityAvailable || !persona) {
    return <AgentMark identity={identity} state={state} className={className} />
  }

  const stateLabel = STATE_LABELS[state] ?? 'Unknown'

  return (
    <img
      className={`pc-agent-mark pc-money-agent-avatar${className ? ` ${className}` : ''}`}
      src={persona.avatar}
      alt={`${persona.name} agent`}
      role="img"
      aria-label={`${persona.name} agent, ${stateLabel}`}
      data-persona-id={persona.id}
      data-state={state}
      data-identity-state="available"
      width="48"
      height="48"
    />
  )
}
