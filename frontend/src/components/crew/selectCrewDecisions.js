// Pure view-selector over app.jsx's activity log ({ id, time, event, meta, ... } entries
// produced by addLog, app.jsx:951). The crew route's decision log is a FILTERED READ of
// what already happened -- it never records anything itself, no app state, no I/O.
//
// Real event names enumerated from app.jsx (grep "event:" / "addLog({"), 2026-07-28:
// DepositExecuted, OrchestratorPlanned, AgentFailed, PermissionRevoked, Connected,
// VaultRejected, AgentCompleted, RedelegationCreated, ApproveExecuted, SwapExecuted
// (the last two only via mergeFlowHelpers.js's mapBaseLegEvent, forwarded as upd.log at
// app.jsx:2911). Lifeboat derisk/resume/mandate events do NOT reach this log at all: My
// Money Task 13 Part B (app.jsx:881-885) routed them straight into the alert bell
// (handleAgentEvent) once the old lifeboatActivity log lost its only reader, so there is
// no dedicated Lifeboat*/Derisk* event string to map here -- the brief's "every
// lifeboat/derisk/keeper decision event found" resolves to AgentCompleted (keeper
// compound) and RedelegationCreated (keeper rebalance) below, both already covered.
//
// AgentFailed is deliberately NOT mapped: it's reused for plain infra failures (wallet
// connect/withdraw/run failures) as well as real council rejections, and the log entry
// carries no field to tell those apart -- mapping it in would mislabel ordinary errors as
// crew decisions. Same reasoning for DepositExecuted/PermissionRevoked/Connected/
// ApproveExecuted/SwapExecuted: plain lifecycle/execution events, not crew decisions.
// Extend EVENT_TONE if the app later adds an unambiguous decision event.
const EVENT_TONE = {
  OrchestratorPlanned: { tone: 'kept', title: 'Council proposal' },
  VaultRejected: { tone: 'rejected', title: 'Rejected a candidate pool' },
  AgentCompleted: { tone: 'kept', title: 'Keeper action completed' },
  RedelegationCreated: { tone: 'watch', title: 'Keeper rebalance created' },
}

export function selectCrewDecisions(logs = [], { limit = 8 } = {}) {
  return (logs || [])
    .filter((entry) => EVENT_TONE[entry?.event])
    .reverse() // logs append oldest-first; newest-first is the contract
    .slice(0, limit)
    .map((entry) => {
      const { tone, title } = EVENT_TONE[entry.event]
      return { id: entry.id, tone, title, detail: entry.meta || '', time: entry.time || '' }
    })
}
