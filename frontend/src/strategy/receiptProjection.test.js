import { describe, expect, it } from 'vitest'
import { RECOVERY_REASON_CODES } from '../../api/agent-index/recovery.js'
import { RECEIPT_CUSTODY_LOCATIONS } from '../../api/agent-index/models.js'
import {
  appendPhase,
  confirmCustody,
  createAllocationReceipt,
} from './allocationReceipt.js'
import { projectRecoveryReceipt } from './receiptProjection.js'

const HUGE_UNITS = '123456789012345678901234567890123456789'
const IDENTITY = {
  networkId: 'stellar-testnet',
  owner: 'GOWNER',
  executionId: 'run-projection:exec:run-projection:deposit:0',
  allocationId: 'run-projection:deposit:0',
}
const AMOUNT = { token: 'USDC', units: HUGE_UNITS, decimals: 7 }

function producedReceipt() {
  return createAllocationReceipt({
    ...IDENTITY,
    runId: 'run-projection',
    worker: 'GWORKER',
    agent: 'CAGENT',
    intent: { allocationId: IDENTITY.allocationId, kind: 'deposit', allocation: AMOUNT },
    amount: AMOUNT,
  })
}

function persisted(receipt, version = 9) {
  return { ...receipt, format: 2, version }
}

describe('projectRecoveryReceipt', () => {
  it('projects genuine absence through the selector without fabricating a persisted receipt', () => {
    const projected = projectRecoveryReceipt({ receipt: null, version: 0, identity: IDENTITY })

    expect(projected).toMatchObject({
      action: 'pull',
      phase: 'pull',
      reasonCode: RECOVERY_REASON_CODES.NO_RECEIPT,
      version: 0,
      receipt: null,
      custody: null,
      requestIdentity: {
        executionId: IDENTITY.executionId,
        allocationId: IDENTITY.allocationId,
        expectedReceiptVersion: 0,
      },
    })
  })

  it('pins every server custody value to the existing UI vocabulary', () => {
    const expected = {
      owner: 'owner',
      'stellar-agent': 'agent',
      'stellar-vault': 'stellar-vault',
      'cctp-transit': 'in-transit',
      'base-kernel': 'agent',
      'base-vault': 'base-proxy',
      unknown: 'unknown',
    }
    expect(Object.keys(expected).sort()).toEqual([...RECEIPT_CUSTODY_LOCATIONS].sort())

    for (const [location, uiLocation] of Object.entries(expected)) {
      let receipt = producedReceipt()
      if (location === 'unknown') {
        receipt = createAllocationReceipt({
          ...IDENTITY,
          runId: 'run-projection',
          worker: 'GWORKER',
          agent: 'CAGENT',
          intent: { allocationId: IDENTITY.allocationId },
          amount: AMOUNT,
          initialCustody: { location: 'unknown', reason: 'reconstructed evidence gap' },
        })
      } else if (location !== 'owner') {
        receipt = confirmCustody(receipt, {
          location,
          amount: AMOUNT,
          txSuccess: true,
          matchingEvent: true,
        })
      }
      expect(projectRecoveryReceipt({ receipt: persisted(receipt), version: 9 }).custody).toEqual({
        location: uiLocation,
        confirmed: location !== 'unknown',
        amount: location === 'unknown' ? null : AMOUNT,
        reason: location === 'unknown' ? 'reconstructed evidence gap' : null,
        source: 'receipt',
      })
    }
  })

  it('preserves exact unit strings and the server identity/version needed for recovery', () => {
    let receipt = appendPhase(producedReceipt(), {
      attemptId: 'attempt-pull-submitted',
      phase: 'pull',
      status: 'submitted',
      evidence: {},
      observedAt: 100,
    })
    receipt = persisted(receipt, 11)

    const projected = projectRecoveryReceipt({ receipt, version: 11 })

    expect(projected.receipt).toBe(receipt)
    expect(projected.version).toBe(11)
    expect(projected.custody.amount.units).toBe(HUGE_UNITS)
    expect(typeof projected.custody.amount.units).toBe('string')
    expect(projected.requestIdentity).toEqual({
      executionId: IDENTITY.executionId,
      allocationId: IDENTITY.allocationId,
      expectedReceiptVersion: 11,
    })
  })

  it('keeps an existing receipt null child authoritative over caller identity', () => {
    const receipt = persisted(producedReceipt())
    const projected = projectRecoveryReceipt({
      receipt,
      version: 9,
      identity: { ...IDENTITY, childId: 'caller-replacement' },
    })

    expect(projected.requestIdentity).not.toHaveProperty('childId')
    expect(projected.route.childId).toBeNull()
  })

  it.each([
    ['future-location', { location: 'future-location', confirmed: true, amount: AMOUNT }],
    ['non-string units', { location: 'owner', confirmed: true, amount: { ...AMOUNT, units: 42 } }],
  ])('localizes defensive schema-only malformed custody (%s) to one allocation', (_label, custody) => {
    // Defensive schema-only fixture: createAllocationReceipt/confirmCustody cannot emit either
    // shape; this represents corrupt storage or future client/server schema drift only.
    const receipt = persisted({ ...producedReceipt(), custody })
    const projected = projectRecoveryReceipt({ receipt, version: 9 })

    expect(projected.custody).toMatchObject({
      location: 'unknown',
      confirmed: false,
      amount: null,
      source: 'unmapped',
    })
    expect(projected.custody.reason).toContain(IDENTITY.allocationId)
  })

  it('keeps every producer-capable Base touch fail closed and routes child display by allocationId/jobId', () => {
    let receipt = confirmCustody(producedReceipt(), {
      location: 'cctp-transit',
      amount: AMOUNT,
      txSuccess: true,
      matchingEvent: true,
    })
    receipt = persisted(receipt)
    const baseResult = {
      allocationId: 'run-projection:bridge:moonwell',
      jobId: 'relayer-job-1',
    }
    const strandedBridge = { pulled: true, bridgeAgentAddress: 'CBRIDGE' }

    const projected = projectRecoveryReceipt({
      receipt,
      version: 9,
      baseResult,
      strandedBridge,
    })

    expect(projected).toMatchObject({
      action: 'blocked-reconcile',
      phase: null,
      reasonCode: RECOVERY_REASON_CODES.BASE_EVIDENCE_UNAVAILABLE,
      baseDisplay: {
        allocationId: 'run-projection:bridge:moonwell',
        jobId: 'relayer-job-1',
        strandedFunds: { pulled: true, bridgeAgentAddress: 'CBRIDGE' },
        authorization: 'display-only',
      },
    })
    expect(projected.reason).toMatch(/nonce|attestation|UserOperation/i)
  })

  it('fails closed for the real receipt-null Base child result shape', () => {
    // Mirrors baseLeg.js's per-child result: Base currently has no execution-receipt producer.
    const baseResult = {
      allocationId: 'run-projection:bridge:moonwell',
      amount: { token: 'USDC', units: '1000000', decimals: 6 },
      burnHash: 'BURN-HASH',
      jobId: 'relayer-job-1',
      bridgeAgentAddress: 'CBRIDGE',
      kernelAddress: '0x0000000000000000000000000000000000000abc',
      attestation: null,
      recovery: { action: 'inspect-job', jobId: 'relayer-job-1' },
      finalStatus: 'pending',
      mintTxHash: null,
      depositTxHash: null,
      custody: { location: 'unknown', confirmed: false, checkedAt: null },
      success: false,
      error: 'Base settlement pending',
    }

    const projected = projectRecoveryReceipt({
      receipt: null,
      version: 0,
      identity: IDENTITY,
      baseResult,
    })

    expect(projected).toMatchObject({
      action: 'blocked-reconcile',
      phase: null,
      reasonCode: RECOVERY_REASON_CODES.BASE_EVIDENCE_UNAVAILABLE,
      receipt: null,
      baseDisplay: {
        allocationId: baseResult.allocationId,
        jobId: baseResult.jobId,
        authorization: 'display-only',
      },
    })
    expect(projected.reason).toMatch(/no durable Base execution receipt producer/i)
  })
})
