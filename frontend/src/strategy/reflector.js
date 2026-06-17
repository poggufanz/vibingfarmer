// frontend/src/strategy/reflector.js
// ACE Reflector — closes the playbook loop. After a kept cycle executes, the
// rules the council cited earn a helpful (tx succeeded) or harmful (tx failed)
// counter. Over many cycles, rules that reliably lead to good outcomes gain
// council weight; harmful ones fade. Pure — playbook is injected.

/**
 * @param {{verdict:string, citedRules:string[], outcome:'success'|'failure'}} cycle
 * @param {{increment:(ruleId:string, kind:'helpful'|'harmful')=>void}} playbook
 */
export function reflect(cycle, playbook) {
  try {
    if (!cycle || cycle.verdict !== 'keep') return
    const rules = cycle.citedRules || []
    if (!rules.length) return
    const kind = cycle.outcome === 'success' ? 'helpful' : 'harmful'
    for (const id of rules) playbook.increment(id, kind)
  } catch (err) {
    console.warn('[Reflector] reflect failed:', err.message)
  }
}