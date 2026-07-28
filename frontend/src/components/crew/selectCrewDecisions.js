// Pure view-selector over app.jsx's activity log ({ id, time, event, meta, detail, ... }
// entries produced by addLog, app.jsx:951). The crew route's decision log is a FILTERED
// READ of what already happened -- it never records anything itself, no app state, no I/O.
//
// Real event names enumerated from app.jsx (grep "event:" / "addLog({") and
// mergeFlowHelpers.js's mapBaseLegEvent, re-verified in Fix round 1 (see
// task-8-report.md): DepositExecuted, OrchestratorPlanned, AgentFailed, PermissionRevoked,
// Connected, VaultRejected, AgentCompleted, RedelegationCreated, ApproveExecuted,
// SwapExecuted.
//
// Fix round 1 / F1: lifeboat derisk/resume/mandate/upgrade_* events DO reach this log --
// the original comment here claiming otherwise was wrong. app.jsx:1150 forwards them into
// handleAgentEvent as `kind: vault_${ev.type}`, which lands in the generic alert-kind block
// (app.jsx:1296-1338). That block's event-name ternary (app.jsx:1327-1334) has no case for
// vault_*/rebalance_proposal/apy_drift/harvest_ready, so they fall through to the default,
// 'OrchestratorPlanned' -- rendering an emergency de-risk as a green "kept" proposal.
//
// OrchestratorPlanned and AgentFailed are both heavily overloaded (see app.jsx:1374, 1401,
// 1580, 1656, 1932, 1979, 2938, 3126, 3184 for the ~9 distinct OrchestratorPlanned shapes;
// only app.jsx:1401 and 1979-when-verdict-is-'keep' are genuine council proposals). Rather
// than blocklist every risky meta shape (fragile -- a future vault_* kind would silently
// default back to 'kept' unless someone remembers to list it), each is resolved by
// ALLOWLISTING the meta prefixes of the confirmed-genuine call sites and failing SAFE to a
// neutral tone for everything else -- an unrecognized producer can never render as 'kept'.
const KEPT_PROPOSAL_PREFIXES = [
  'Proposal: ', // app.jsx:1401-1404 -- the orchestrator's own idea, surfaced to the user
  'Monitor full debate, ', // app.jsx:1979-1982, reached only when the debate verdict is 'keep'
]
const REJECTED_DEBATE_PREFIXES = [
  'Monitor re-eval, ', // app.jsx:1937-1939 -- fast re-eval failed a safety rule
  'Monitor full debate, ', // app.jsx:1979-1982, reached only when the verdict is NOT 'keep'
]

function resolveOrchestratorPlanned(meta) {
  return KEPT_PROPOSAL_PREFIXES.some((p) => meta.startsWith(p))
    ? { tone: 'kept', title: 'Council proposal' }
    : { tone: 'watch', title: 'Crew update' }
}

function resolveAgentFailed(meta) {
  // Everything else on AgentFailed is plain infra failure (wallet connect/withdraw/run
  // failures, worker errors) with no field distinguishing it from a real council call --
  // stays skipped, same as Fix round 0.
  return REJECTED_DEBATE_PREFIXES.some((p) => meta.startsWith(p))
    ? { tone: 'rejected', title: 'Council rejected the plan' }
    : null
}

const STATIC_TONE = {
  VaultRejected: { tone: 'rejected', title: 'Rejected a candidate pool' },
  AgentCompleted: { tone: 'kept', title: 'Keeper action completed' },
  RedelegationCreated: { tone: 'watch', title: 'Keeper rebalance created' },
}

function resolveTone(entry) {
  const event = entry?.event
  if (event === 'OrchestratorPlanned') return resolveOrchestratorPlanned(entry.meta || '')
  if (event === 'AgentFailed') return resolveAgentFailed(entry.meta || '')
  // Object.hasOwn (not a plain lookup) so 'constructor'/'toString'/'__proto__' -- inherited
  // from Object.prototype, so a plain `STATIC_TONE[event]` lookup is truthy for them -- are
  // never mistaken for a mapped event.
  return Object.hasOwn(STATIC_TONE, event) ? STATIC_TONE[event] : null
}

export function selectCrewDecisions(logs, { limit = 8 } = {}) {
  const entries = Array.isArray(logs) ? logs : []
  return entries
    .map((entry) => ({ entry, tone: resolveTone(entry) }))
    .filter(({ tone }) => tone)
    .reverse() // logs append oldest-first; newest-first is the contract
    .slice(0, limit)
    .map(({ entry, tone }) => ({
      id: entry.id,
      tone: tone.tone,
      title: tone.title,
      detail: entry.detail || entry.meta || '',
      time: entry.time || '',
    }))
}
