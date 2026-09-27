// frontend/src/stellar/grantFeeEstimate.js
// P1 G10: display-only fallback fee estimate for the grant review screen ("what the grant
// costs if the relay is down and the owner pays it themselves").
//
// Method: build a fee-EQUIVALENT grant with `buildGrantTx` (same op counts, same fixed-size
// args — every AgentInit field is fixed-width, so only the agent/budget COUNTS move the
// resource footprint, never the values) and read the prepared transaction's fee. The signer
// and salts are fresh random placeholders: this transaction is simulated, never signed or
// submitted, and its only consumer is the displayed "~X XLM" line. Any failure (unfunded
// owner, unreachable RPC, invalid shape) resolves to `null` — the UI renders "unavailable",
// never a fabricated number. Relay/direct submission logic is untouched.
import { buildGrantTx, AGENT_KIND_DEPOSIT } from './grant.js'
import { SOROBAN_ACTIVE_VAULT_ADDRESS, SOROBAN_TOKEN_ADDRESS } from './config.js'

const STROOPS_PER_XLM = 10_000_000n
const ZERO32 = new Uint8Array(32)

/** Stroops bigint -> "~0.00123 XLM" display string (7-dp, trailing zeros kept). */
export function formatStroopsXlm(stroops) {
  const units = typeof stroops === 'bigint' ? stroops : BigInt(stroops)
  const negative = units < 0n
  const abs = negative ? -units : units
  const whole = abs / STROOPS_PER_XLM
  const frac = (abs % STROOPS_PER_XLM).toString().padStart(7, '0')
  return `~${negative ? '-' : ''}${whole.toString()}.${frac} XLM`
}

function random32() {
  return globalThis.crypto.getRandomValues(new Uint8Array(32))
}

function normalizeBudgets(budgets) {
  if (!Array.isArray(budgets) || budgets.length === 0) return null
  const out = []
  for (const b of budgets) {
    const token = b?.token
    const raw = b?.budget ?? b?.units
    let budget
    try {
      budget = BigInt(raw)
    } catch {
      return null
    }
    if (typeof token !== 'string' || token.length === 0 || budget <= 0n) return null
    out.push({ budget, token })
  }
  return out
}

/**
 * Simulate a grant-shaped transaction and report what the owner would pay without the
 * relay. Display-only estimate, never a quote and never submitted.
 * @param {{owner:string, agentCount:number, budgets:Array<{token:string, budget|units}>,
 *   durationSeconds?:number, token?:string, target?:string, server?:object,
 *   build?:Function}} p
 * @returns {Promise<{feeStroops:bigint, feeXlm:string, agentCount:number}|null>}
 */
export async function estimateGrantFallbackFee({
  owner,
  agentCount,
  budgets,
  durationSeconds = 86400,
  token = SOROBAN_TOKEN_ADDRESS,
  target = SOROBAN_ACTIVE_VAULT_ADDRESS,
  server,
  build = buildGrantTx,
} = {}) {
  try {
    if (typeof owner !== 'string' || owner.length === 0) return null
    if (!Number.isInteger(agentCount) || agentCount <= 0 || agentCount > 50) return null
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null
    const shapedBudgets = normalizeBudgets(budgets)
    if (!shapedBudgets) return null
    const initToken = shapedBudgets[0].token
    const nowSec = Math.floor(Date.now() / 1000)
    const agentInits = Array.from({ length: agentCount }, () => ({
      signer: random32(),
      cap: 10_0000000n,
      token: initToken,
      target,
      kind: AGENT_KIND_DEPOSIT,
      mintRecipient: ZERO32,
      destinationDomain: 0,
      periodDuration: 86400,
      expiry: nowSec + Math.max(1, Math.floor(durationSeconds)),
    }))
    const built = await build({
      owner,
      budgets: shapedBudgets,
      durationSeconds,
      agentInits,
      ...(server ? { server } : {}),
    })
    const feeStroops = BigInt(built?.tx?.fee)
    if (feeStroops < 0n) return null
    return { feeStroops, feeXlm: formatStroopsXlm(feeStroops), agentCount }
  } catch {
    return null
  }
}
