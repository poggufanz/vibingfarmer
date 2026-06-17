// frontend/src/strategy/playbookRules.js
// ACE per-role playbook catalog — now READ FROM the living rule store. The AI
// wizard council (councilReview.js) shows each specialist ONLY its role's ACTIVE
// rules and must cite from them. Grown rules (Curator) appear automatically;
// pruned/retired rules drop out. The {id, description} shape is preserved for the
// existing councilReview prompt builder. Seed content lives in seeds.js.
import { getRules } from './ruleStore.js'

/** Active rules for a role, shaped {id, description} for the council prompt. */
export function rulesForRole(role) {
  return getRules({ role, status: 'active' }).map((r) => ({ id: r.id, description: r.text }))
}

export function ruleIdsForRole(role) {
  return rulesForRole(role).map((r) => r.id)
}

export function allRuleIds() {
  return getRules({ status: 'active' }).map((r) => r.id)
}

export function isValidRuleForRole(role, ruleId) {
  return ruleIdsForRole(role).includes(ruleId)
}

/** Back-compat: councilReview.js imports ROLE_RULES and indexes by role. */
export const ROLE_RULES = {
  get yield() { return rulesForRole('yield') },
  get risk() { return rulesForRole('risk') },
  get market() { return rulesForRole('market') },
}
