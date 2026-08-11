import { hashStrategy } from '../attestation.js'
import { hash } from '@stellar/stellar-sdk'
import { canonicalizeStrategy } from './canonicalStrategy.js'

function hashReboundPlan(plan) {
  try {
    return hashStrategy(plan)
  } catch (error) {
    // The jsdom/browser Buffer shim can be a different Uint8Array realm from the SDK's hash
    // implementation. Re-run the same canonical payload with a native Uint8Array so rebinding
    // remains usable in that environment while preserving hashStrategy's exact digest.
    if (!/Uint8Array|Buffer/i.test(error?.message || '')) throw error
    const bytes = new TextEncoder().encode(JSON.stringify(canonicalizeStrategy(plan)))
    const digest = hash(new Uint8Array(bytes))
    return '0x' + Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
  }
}

export function bindPlanToPermissionWindow(plan, { checkedAt, durationSeconds } = {}) {
  if (!Number.isInteger(checkedAt) || checkedAt <= 0) {
    throw new Error('checkedAt must be a positive integer')
  }
  if (!Number.isInteger(durationSeconds) || durationSeconds <= 0) {
    throw new Error('durationSeconds must be a positive integer')
  }
  if (!plan || !Array.isArray(plan.agents)) throw new Error('plan.agents must be an array')
  const expiry = checkedAt + durationSeconds
  const rebound = {
    ...plan,
    agents: plan.agents.map((agent) => ({ ...agent, expiry })),
  }
  return { ...rebound, planFingerprint: hashReboundPlan(rebound) }
}
