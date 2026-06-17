// Maps post-execution agent state to a single council outcome for the reflector.
// 'success' if any worker confirmed its deposit; 'failure' otherwise. Pure.

/**
 * @param {Object} execMap  { agentId: { status: 'idle'|'running'|'confirmed'|'failed' } }
 * @param {Array<{id:string}>} agents
 * @returns {'success'|'failure'}
 */
export function councilOutcome(execMap, agents) {
  const confirmed = (agents || []).some((a) => execMap?.[a.id]?.status === 'confirmed')
  return confirmed ? 'success' : 'failure'
}
