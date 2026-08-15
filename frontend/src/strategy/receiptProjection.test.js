import { describe, expect, it } from 'vitest'
import { RECOVERY_REASON_CODES } from '../../api/agent-index/recovery.js'
import { RECEIPT_CUSTODY_LOCATIONS } from '../../api/agent-index/models.js'
import { appendPhase, confirmCustody, createAllocationReceipt } from './allocationReceipt.js'
import { projectBaseRecoveryBundle, projectRecoveryReceipt } from './receiptProjection.js'

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

  it('does not turn an absent caller child into a Stellar recovery identity', () => {
    const projected = projectRecoveryReceipt({
      receipt: null,
      version: 0,
      identity: { ...IDENTITY, childId: 'caller-child' },
    })

    expect(projected.requestIdentity).toEqual({
      executionId: IDENTITY.executionId,
      allocationId: IDENTITY.allocationId,
      expectedReceiptVersion: 0,
    })
    expect(projected.route.childId).toBeNull()
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
  ])(
    'localizes defensive schema-only malformed custody (%s) to one allocation',
    (_label, custody) => {
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
    }
  )

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
      identity: { ...IDENTITY, childId: 'base-child-display-route' },
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
      route: {
        allocationId: baseResult.allocationId,
        childId: 'base-child-display-route',
        jobId: baseResult.jobId,
        source: 'base-child-result',
      },
    })
    expect(projected.requestIdentity).not.toHaveProperty('childId')
    expect(projected.reason).toMatch(/no durable Base execution receipt producer/i)
  })
})

const BASE_IDENTITY = Object.freeze({
  networkId: 'stellar-testnet',
  bindingId: '0123456789abcdef0123456789abcdef',
  executionId: 'run-42:exec:run-42:bridge:aave-v3',
  allocationId: 'run-42:bridge:aave-v3',
  childId: 'abcdef0123456789abcdef0123456789',
})
const BASE_OWNER = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57'
const BASE_AGENT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'
const BASE_KERNEL = '0x00000000000000000000000000000000000000aa'
const BASE_ROUTER = '0x00000000000000000000000000000000000000f1'
const BASE_POOL = '0x00000000000000000000000000000000000000b2'
const BASE_BURN = '66'.repeat(32)
const BASE_NONCE = `0x${'77'.repeat(32)}`
const BASE_MESSAGE = `0x${'88'.repeat(32)}`
const BASE_ATTESTATION = `0x${'99'.repeat(32)}`
const BASE_MINT = `0x${'aa'.repeat(32)}`
const BASE_USER_OP = `0x${'bb'.repeat(32)}`
const BASE_DEPOSIT = `0x${'cc'.repeat(32)}`

const baseEvidence = (phase, overrides = {}) => ({
  ...(phase === 'cctp_burn'
    ? {
        burnTxHash: BASE_BURN,
        expectationDigest: 'dd'.repeat(32),
        burnUnits7: '10000000',
        messageDigest: BASE_MESSAGE,
        nonce: BASE_NONCE,
      }
    : phase === 'cctp_attestation'
      ? {
          burnTxHash: BASE_BURN,
          expectationDigest: 'dd'.repeat(32),
          messageDigest: BASE_MESSAGE,
          attestationDigest: BASE_ATTESTATION,
          nonce: BASE_NONCE,
        }
      : phase === 'cctp_mint'
        ? {
            burnTxHash: BASE_BURN,
            expectationDigest: 'dd'.repeat(32),
            messageDigest: BASE_MESSAGE,
            attestationDigest: BASE_ATTESTATION,
            nonce: BASE_NONCE,
          }
        : {
            chainId: 84532,
            yieldRouterAddress: BASE_ROUTER,
            kernelAddress: BASE_KERNEL,
            caller: BASE_KERNEL,
            poolAddress: BASE_POOL,
            assets: '1000000',
            minShares: '900000',
          }),
  ...overrides,
})

function baseBundle(entries, overrides = {}) {
  const events = entries.map(([phase, state, evidence], index) => ({
    eventId: String(index + 1).padStart(64, '0'),
    identity: BASE_IDENTITY,
    owner: BASE_OWNER,
    agent: BASE_AGENT,
    recoveryVersion: index + 1,
    phase,
    state,
    evidence,
    observedAt: 2_000_000_000_000 + index,
  }))
  const phases = events.map(({ owner: _owner, agent: _agent, phase, ...event }) => ({
    ...event,
    phase,
  }))
  return {
    schemaVersion: 1,
    identity: BASE_IDENTITY,
    owner: BASE_OWNER,
    agent: BASE_AGENT,
    recoverable: true,
    recoveryVersion: events.length,
    intent: {
      runId: 'run-42',
      grantTxHash: BASE_BURN,
      bindingHash: 'dd'.repeat(32),
      baseJobId: BASE_IDENTITY.childId,
      kernelAddress: BASE_KERNEL,
      poolAddress: BASE_POOL,
      proxyTarget: 'aave-v3',
      token: 'USDC',
      units: '1000000',
      decimals: 6,
      minShares: '900000',
    },
    phases,
    events,
    ...overrides,
  }
}

describe('projectBaseRecoveryBundle', () => {
  it.each([
    ['poll-attestation', [['cctp_burn', 'confirmed', baseEvidence('cctp_burn')]]],
    [
      'submit-mint',
      [
        ['cctp_burn', 'confirmed', baseEvidence('cctp_burn')],
        ['cctp_attestation', 'confirmed', baseEvidence('cctp_attestation')],
      ],
    ],
    [
      'poll-mint',
      [
        ['cctp_burn', 'confirmed', baseEvidence('cctp_burn')],
        ['cctp_attestation', 'confirmed', baseEvidence('cctp_attestation')],
        ['cctp_mint', 'submitting', baseEvidence('cctp_mint')],
      ],
    ],
    [
      'submit-base-deposit',
      [
        ['cctp_burn', 'confirmed', baseEvidence('cctp_burn')],
        ['cctp_attestation', 'confirmed', baseEvidence('cctp_attestation')],
        ['cctp_mint', 'confirmed', baseEvidence('cctp_mint', { mintTxHash: BASE_MINT })],
      ],
    ],
    [
      'poll-base-deposit',
      [
        ['cctp_burn', 'confirmed', baseEvidence('cctp_burn')],
        ['cctp_attestation', 'confirmed', baseEvidence('cctp_attestation')],
        ['cctp_mint', 'confirmed', baseEvidence('cctp_mint', { mintTxHash: BASE_MINT })],
        [
          'base_deposit',
          'submitting',
          baseEvidence('base_deposit', {
            reconcileHandle: {
              entryPoint: '0x0000000071727de22e5e9d8baf0edac6f37da032',
              sender: BASE_KERNEL,
              nonce: '7',
              startBlock: '123',
            },
          }),
        ],
      ],
    ],
  ])('projects %s without changing the Base selector vocabulary', (action, entries) => {
    const projected = projectBaseRecoveryBundle(baseBundle(entries))

    expect(projected).toMatchObject({
      action,
      identity: BASE_IDENTITY,
      version: entries.length,
    })
    expect(projected).not.toHaveProperty('leaseToken')
    expect(JSON.stringify(projected)).not.toMatch(/private|capability|authorization|cookie/i)
  })

  it('retains exact confirmed deposit evidence and projects only Base vault custody', () => {
    const event = {
      address: BASE_ROUTER,
      topic0: `0x${'12'.repeat(32)}`,
      logIndex: '3',
      caller: BASE_KERNEL,
      poolAddress: BASE_POOL,
      assets: '1000000',
      shares: '950000',
    }
    const projected = projectBaseRecoveryBundle(
      baseBundle([
        ['cctp_burn', 'confirmed', baseEvidence('cctp_burn')],
        ['cctp_attestation', 'confirmed', baseEvidence('cctp_attestation')],
        ['cctp_mint', 'confirmed', baseEvidence('cctp_mint', { mintTxHash: BASE_MINT })],
        [
          'base_deposit',
          'confirmed',
          baseEvidence('base_deposit', {
            userOpHash: BASE_USER_OP,
            transactionHash: BASE_DEPOSIT,
            shares: '950000',
            event,
          }),
        ],
      ])
    )

    expect(projected).toMatchObject({
      action: 'complete',
      phase: null,
      identity: BASE_IDENTITY,
      version: 4,
      custody: {
        location: 'base-proxy',
        confirmed: true,
        userOpHash: BASE_USER_OP,
        transactionHash: BASE_DEPOSIT,
      },
    })
    expect(projected.phases.base_deposit.evidence.event).toEqual(event)
  })

  it('fails a poisoned or contradictory bundle closed without copying sensitive fields', () => {
    const projected = projectBaseRecoveryBundle(
      baseBundle([], { leaseToken: 'TOP_SECRET', capability: 'TOP_SECRET' })
    )

    expect(projected).toMatchObject({
      action: 'manual-review',
      phase: null,
      identity: BASE_IDENTITY,
      version: 0,
    })
    expect(JSON.stringify(projected)).not.toContain('TOP_SECRET')
  })
})
