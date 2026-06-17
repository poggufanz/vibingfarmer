// frontend/src/strategy/curator.js
// ACE Curator — the grow half. On a NOTABLE outcome (a failed cycle or an
// AI-conflict resolution) it asks Venice for ONE new playbook rule that would
// have prevented the failure or resolved the split, then ADDs it and runs the
// merge + prune passes over the role's rules. AI is injected as `ask`; store ops
// are injected so this stays pure and testable. Fire-and-forget by contract:
// any failure is swallowed (no-op) so the never-stop monitor loop is never blocked.
import { roleToCategory } from './seeds.js'
import { mergePass } from './merge.js'
import { prunePass } from './prune.js'

const VALID_ROLES = new Set(['yield', 'risk', 'market'])

function slug(text) {
  const base = String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return `grown-${base || 'rule'}-${Date.now().toString(36)}`
}

/**
 * @param {{role?:string, outcome:string, concerns?:string[], turbulence?:string, reason?:string}} ctx
 * @param {{ ask:(ctx)=>Promise<{role:string,text:string}|null>,
 *           store:{ getRules:Function, addRule:Function, replaceAll:Function } }} deps
 */
export async function proposeRule(ctx, { ask, store }) {
  try {
    if (typeof ask !== 'function' || !store) return
    const delta = await ask(ctx)
    if (!delta || typeof delta !== 'object') return
    const role = delta.role
    const text = typeof delta.text === 'string' ? delta.text.trim() : ''
    if (!VALID_ROLES.has(role) || text.length < 8) return

    store.addRule({ id: slug(text), role, category: roleToCategory(role), text, origin: 'grown', status: 'active', helpful: 0, harmful: 0, evals: 0 })

    // Refine: merge near-dups, then prune the role's rules. Write back atomically.
    const all = store.getRules()
    const refined = prunePass(mergePass(all))
    store.replaceAll(refined)
  } catch (err) {
    console.warn('[Curator] proposeRule skipped:', err.message)
  }
}
