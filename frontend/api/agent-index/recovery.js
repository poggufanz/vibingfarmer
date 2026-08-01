// Browser-safe, pure recovery decision table. Server authentication and lease claiming live in
// handler.js so client code can import this module without Node builtins or polyfills.

const BASE_CUSTODY_LOCATIONS = new Set(['cctp-transit', 'base-kernel', 'base-vault'])
const BASE_ONLY_PHASES = ['cctp_burn', 'cctp_mint', 'base_deposit']
const V3_EXECUTION_ID = /^0x[0-9a-f]{64}$/

export const RECOVERY_REASON_CODES = Object.freeze({
  NO_RECEIPT: 'no-receipt',
  BASE_EVIDENCE_UNAVAILABLE: 'base-evidence-unavailable',
  CUSTODY_EVIDENCE_GAP: 'custody-evidence-gap',
  CONTRADICTORY_STELLAR_EVIDENCE: 'contradictory-stellar-evidence',
  PULL_NOT_STARTED: 'pull-not-started',
  PULL_FAILED: 'pull-failed',
  PULL_V3_UNCERTAIN: 'pull-v3-uncertain',
  PULL_V2_UNCERTAIN: 'pull-v2-uncertain',
  PULL_STATUS_UNRECOGNIZED: 'pull-status-unrecognized',
  DEPOSIT_CONFIRMED: 'deposit-confirmed',
  DEPOSIT_NOT_STARTED: 'deposit-not-started',
  DEPOSIT_FAILED: 'deposit-failed',
  DEPOSIT_UNCERTAIN: 'deposit-uncertain',
  DEPOSIT_STATUS_UNRECOGNIZED: 'deposit-status-unrecognized',
})

function lastAttemptForPhase(attempts, phase) {
  const list = Array.isArray(attempts) ? attempts : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.phase === phase) return list[i]
  }
  return null
}

/**
 * Pure and total: decides the one safe next action from durable receipt evidence alone.
 * @param {object|null} receipt parsed execution receipt, or null when none has been persisted
 * @returns {{action:string, phase:('pull'|'stellar_deposit'|null), reasonCode:string, reason:string}}
 */
export function selectRecoveryAction(receipt) {
  if (receipt == null) {
    return {
      action: 'pull',
      phase: 'pull',
      reasonCode: RECOVERY_REASON_CODES.NO_RECEIPT,
      reason:
        'no execution receipt exists yet for this execution/allocation/owner; nothing has ever ' +
        'been submitted, so exactly one pull is permitted',
    }
  }

  const phases = receipt.phases || {}
  const custody = receipt.custody || {}
  const baseTouched =
    BASE_CUSTODY_LOCATIONS.has(custody.location) ||
    BASE_ONLY_PHASES.some((phase) => phases[phase] && phases[phase] !== 'not_started')

  if (baseTouched) {
    return {
      action: 'blocked-reconcile',
      phase: null,
      reasonCode: RECOVERY_REASON_CODES.BASE_EVIDENCE_UNAVAILABLE,
      reason:
        'Base leg evidence is present (custody past the Stellar bridge agent, or CCTP burn/mint ' +
        'or Base deposit phase activity) but no durable producer for the CCTP nonce, the ' +
        'attestation message, or the Base UserOperation/vault-event state exists anywhere in this ' +
        "codebase (operator ruling S2-D8); recovery must go through baseLeg.js's stranded-funds " +
        'path, not this selector',
    }
  }

  if (custody.confirmed !== true || custody.location === 'unknown') {
    return {
      action: 'manual-review',
      phase: null,
      reasonCode: RECOVERY_REASON_CODES.CUSTODY_EVIDENCE_GAP,
      reason:
        `custody evidence is unconfirmed or unknown (location=${custody.location ?? 'unknown'}` +
        `${custody.reason ? `, reason=${custody.reason}` : ''}); any evidence gap blocks ` +
        'automated recovery',
    }
  }

  // `pull:confirmed` is independently authoritative because the producer persists it before its
  // trailing stellar-agent custody update. This closes that crash window without another pull.
  const fundsLeftOwner = custody.location !== 'owner' || phases.pull === 'confirmed'

  // Later-phase activity contradicts evidence that funds never left the owner. Fail closed before
  // the pull branch: authorizing another pull could move money twice if the later phase is right.
  if (!fundsLeftOwner && phases.stellar_deposit !== 'not_started') {
    return {
      action: 'manual-review',
      phase: null,
      reasonCode: RECOVERY_REASON_CODES.CONTRADICTORY_STELLAR_EVIDENCE,
      reason:
        `stellar_deposit is ${phases.stellar_deposit ?? 'missing'} while pull is ` +
        `${phases.pull ?? 'missing'} and custody is still confirmed at owner; later-phase ` +
        'evidence contradicts the pre-movement state',
    }
  }

  if (!fundsLeftOwner) {
    switch (phases.pull) {
      case 'not_started':
        return {
          action: 'pull',
          phase: 'pull',
          reasonCode: RECOVERY_REASON_CODES.PULL_NOT_STARTED,
          reason:
            'receipt exists but no pull has ever been attempted; exactly one pull is permitted',
        }
      case 'failed':
        return {
          action: 'pull',
          phase: 'pull',
          reasonCode: RECOVERY_REASON_CODES.PULL_FAILED,
          reason:
            'the previous pull attempt failed before any money moved and custody is still ' +
            'confirmed at owner; a fresh pull is safe',
        }
      case 'submitted':
      case 'unknown': {
        const lastPull = lastAttemptForPhase(receipt.attempts, 'pull')
        if (V3_EXECUTION_ID.test(lastPull?.evidence?.v3ExecutionId)) {
          return {
            action: 'resubmit-identical-envelope',
            phase: 'pull',
            reasonCode: RECOVERY_REASON_CODES.PULL_V3_UNCERTAIN,
            reason:
              'the pending pull attempt carries a valid durable v3ExecutionId, proving it went ' +
              'through pull_v3; resending the identical envelope is safe',
          }
        }
        return {
          action: 'poll',
          phase: 'pull',
          reasonCode: RECOVERY_REASON_CODES.PULL_V2_UNCERTAIN,
          reason:
            'the pull outcome is unconfirmed and carries no valid v3ExecutionId; the deployed V2 ' +
            'router has no replay protection, so resending could move money twice',
        }
      }
      default:
        return {
          action: 'manual-review',
          phase: null,
          reasonCode: RECOVERY_REASON_CODES.PULL_STATUS_UNRECOGNIZED,
          reason: `unrecognized pull phase status "${phases.pull}"`,
        }
    }
  }

  // Deposit confirmation is authoritative even when the producer's final vault custody write has
  // not landed. Uncertain deposits only poll because deposit idempotency is not established.
  if (phases.stellar_deposit === 'confirmed') {
    return {
      action: 'complete',
      phase: null,
      reasonCode: RECOVERY_REASON_CODES.DEPOSIT_CONFIRMED,
      reason: 'the deposit phase is confirmed; execution is terminal',
    }
  }
  if (custody.location === 'stellar-vault') {
    return {
      action: 'manual-review',
      phase: null,
      reasonCode: RECOVERY_REASON_CODES.CONTRADICTORY_STELLAR_EVIDENCE,
      reason:
        'custody claims stellar-vault but the deposit phase is not confirmed; evidence is ' +
        'contradictory',
    }
  }

  switch (phases.stellar_deposit) {
    case 'not_started':
      return {
        action: 'deposit',
        phase: 'stellar_deposit',
        reasonCode: RECOVERY_REASON_CODES.DEPOSIT_NOT_STARTED,
        reason: 'the agent holds custody and no deposit has been attempted yet',
      }
    case 'failed':
      return {
        action: 'deposit',
        phase: 'stellar_deposit',
        reasonCode: RECOVERY_REASON_CODES.DEPOSIT_FAILED,
        reason:
          'the previous deposit attempt failed while funds remain with the agent; retrying the ' +
          'deposit does not re-move money',
      }
    case 'submitted':
    case 'unknown':
      return {
        action: 'poll',
        phase: 'stellar_deposit',
        reasonCode: RECOVERY_REASON_CODES.DEPOSIT_UNCERTAIN,
        reason:
          'the deposit outcome is unconfirmed and deposit idempotency is not established; fail ' +
          'closed to poll rather than resubmit',
      }
    default:
      return {
        action: 'manual-review',
        phase: null,
        reasonCode: RECOVERY_REASON_CODES.DEPOSIT_STATUS_UNRECOGNIZED,
        reason: `unrecognized stellar_deposit phase status "${phases.stellar_deposit}"`,
      }
  }
}
