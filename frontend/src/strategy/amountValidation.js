// frontend/src/strategy/amountValidation.js
// Strategy Task 3 (Pocket Crew redesign, Wave 1). Validates a decimal amount the user typed --
// and the prospective StrategyPlan it expands into (Task 2's expandAgentSlots) -- BEFORE
// strategy generation starts, so a malformed amount, a risk level whose slot math would strand
// an agent below the vault's real on-chain minimum, or an unknown vault-state read never reaches
// a signed transaction. Every result is the structured `{ ok, code, field, message, units }`
// shape so a caller (screens.jsx's InputScreen submit) can focus the right field inline.
//
// Boundary-amount ruling (matches planModel.js): parse decimal strings directly into bigint via
// stellar/format.js's decimalToUnits -- never `Number * 10**decimals` -- for anything that
// becomes a grant/burn unit.
import { decimalToUnits } from '../stellar/format.js'
import { SOROBAN_DECIMALS } from '../stellar/config.js'
import { RISK_PROFILES } from './planModel.js'

const STELLAR_DECIMALS = SOROBAN_DECIMALS // 7dp

// On-chain truth (soroban/contracts/autofarm_vault/src/vault.rs, MIN_FIRST_DEPOSIT): 1 USDC at
// 7dp, enforced by the vault ONLY on the deposit call that observes total_shares() == 0 (the
// inflation-attack first-depositor guard). Every later deposit has no minimum beyond "greater
// than zero" -- there is no contract-level floor once the vault is seeded, so the old per-venue
// catalog `min_capital` (frontend/src/config.js: 50/100) never gates a real submit here.
export const FIRST_DEPOSIT_MIN_UNITS = 1_0000000n

const UNKNOWN_VAULT_MESSAGE = 'Could not verify the vault minimum. Try again.'

function toBigIntUnits(units) {
  if (typeof units === 'bigint') return units
  if (units == null || units === '') return 0n
  return BigInt(units)
}

const PARSE_ERROR_MESSAGES = {
  EMPTY: 'Enter an amount.',
  INVALID_FORMAT: 'Enter a plain decimal amount, like 100 or 12.5.',
  TOO_PRECISE: (decimals) => `Amount has more than ${decimals} decimal places.`,
}

/**
 * Parse a decimal string a user typed directly into bigint base units -- no Number multiply, so
 * no float rounding ever reaches a grant/burn amount. Rejects empty, negative, zero, exponent
 * notation, NaN-shaped, and over-precision input.
 * @param {string} value
 * @param {number} decimals
 * @returns {{ok:true, code:'OK', field:null, message:null, units:bigint}|{ok:false, code:string, field:null, message:string, units:null}}
 */
export function parseUsdcInput(value, decimals) {
  const r = decimalToUnits(value, decimals, { strict: true })
  if (!r.ok) {
    const msg = PARSE_ERROR_MESSAGES[r.code]
    return {
      ok: false,
      code: r.code,
      field: null,
      message: typeof msg === 'function' ? msg(decimals) : msg,
      units: null,
    }
  }
  if (r.units < 0n) {
    return {
      ok: false,
      code: 'NEGATIVE',
      field: null,
      message: 'Amount cannot be negative.',
      units: null,
    }
  }
  if (r.units === 0n) {
    return {
      ok: false,
      code: 'ZERO',
      field: null,
      message: 'Amount must be greater than zero.',
      units: null,
    }
  }
  return { ok: true, code: 'OK', field: null, message: null, units: r.units }
}

/**
 * Validate the raw amount + risk the InputScreen collects, against the authoritative vault
 * total-shares read (`stellar/vaultReads.readTotalShares`). `vaultTotalShares` must be `bigint`
 * (a real read) or `null` (unknown/failed read) -- never coerced to zero.
 * @param {{value:string, risk:'low'|'med'|'high', vaultTotalShares:bigint|null}} p
 * @returns {{ok:boolean, code:string, field:string|null, message:string|null, units:bigint|null, retryable?:boolean}}
 */
export function validateAmountInput({ value, risk, vaultTotalShares }) {
  const parsed = parseUsdcInput(value, STELLAR_DECIMALS)
  if (!parsed.ok) return { ...parsed, field: 'amount' }

  if (!RISK_PROFILES[risk]) {
    return {
      ok: false,
      code: 'INVALID_RISK',
      field: 'risk',
      message: 'Select a risk level.',
      units: parsed.units,
    }
  }

  if (vaultTotalShares == null) {
    return {
      ok: false,
      code: 'VAULT_STATE_UNKNOWN',
      field: 'amount',
      message: UNKNOWN_VAULT_MESSAGE,
      units: parsed.units,
      retryable: true,
    }
  }

  if (vaultTotalShares === 0n && parsed.units < FIRST_DEPOSIT_MIN_UNITS) {
    return {
      ok: false,
      code: 'BELOW_FIRST_DEPOSIT_MINIMUM',
      field: 'amount',
      message: 'The vault has no deposits yet. The first deposit must be at least 1 USDC.',
      units: parsed.units,
    }
  }

  return { ok: true, code: 'OK', field: null, message: null, units: parsed.units }
}

/**
 * Validate a prospective, already-expanded `StrategyPlan` (Task 2's `expandAgentSlots` shape)
 * is actually executable: every real agent (and every Base bridge child) carries positive
 * integer units, and -- only when the vault is genuinely empty -- every Stellar deposit slot
 * individually clears the on-chain first-deposit minimum (agents run in parallel, so whichever
 * one lands first must independently clear it; a total that only clears the minimum when summed
 * is not enough).
 * @param {{plan:{agents:Array}, vaultTotalShares:bigint|null}} p
 * @returns {{ok:boolean, code:string, field:string|null, message:string|null, units:bigint|null, retryable?:boolean}}
 */
export function validateExecutionAllocations({ plan, vaultTotalShares }) {
  if (vaultTotalShares == null) {
    return {
      ok: false,
      code: 'VAULT_STATE_UNKNOWN',
      field: 'vaultTotalShares',
      message: UNKNOWN_VAULT_MESSAGE,
      units: null,
      retryable: true,
    }
  }

  const agents = plan?.agents || []

  for (const agent of agents) {
    const units = toBigIntUnits(agent.allocation?.units)
    if (units <= 0n) {
      return {
        ok: false,
        code: 'NON_POSITIVE_AGENT_UNITS',
        field: agent.allocationId || 'agents',
        message: 'Every crew member needs a positive amount to execute.',
        units,
      }
    }
    if (agent.kind === 'bridge') {
      for (const child of agent.children || []) {
        const childUnits = toBigIntUnits(child.allocation?.units)
        if (childUnits <= 0n) {
          return {
            ok: false,
            code: 'NON_POSITIVE_BASE_UNITS',
            field: child.allocationId || agent.allocationId,
            message: 'Base amount is too small once converted to six decimals.',
            units: childUnits,
          }
        }
      }
    }
  }

  if (vaultTotalShares === 0n) {
    const shortAgent = agents.find(
      (a) => a.kind === 'deposit' && toBigIntUnits(a.allocation?.units) < FIRST_DEPOSIT_MIN_UNITS
    )
    if (shortAgent) {
      return {
        ok: false,
        code: 'BELOW_FIRST_DEPOSIT_MINIMUM',
        field: shortAgent.allocationId,
        message: 'The vault has no deposits yet. Every deposit slot must be at least 1 USDC.',
        units: toBigIntUnits(shortAgent.allocation.units),
      }
    }
  }

  const depositTotal = agents
    .filter((a) => a.kind === 'deposit')
    .reduce((s, a) => s + toBigIntUnits(a.allocation?.units), 0n)

  return { ok: true, code: 'OK', field: null, message: null, units: depositTotal }
}
