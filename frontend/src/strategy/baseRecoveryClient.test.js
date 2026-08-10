import { describe, expect, it, vi } from 'vitest'
import { Keypair } from '@stellar/stellar-sdk'
import {
  receiptProofMessage,
  receiptRequestDigest,
} from '../../api/agent-index/executionReceipts.js'
import {
  createBaseRecoveryActionRunner,
  executeBaseRecovery,
  pollBaseRecoveryEvidence,
  readBaseRecoveryEvidence,
  requestBaseRecoveryClaim,
} from './baseRecoveryClient.js'

const IDENTITY = Object.freeze({
  networkId: 'stellar-testnet',
  bindingId: '0123456789abcdef0123456789abcdef',
  executionId: 'run-42:exec:run-42:bridge:aave-v3',
  allocationId: 'run-42:bridge:aave-v3',
  childId: 'abcdef0123456789abcdef0123456789',
})
const OWNER_KEYPAIR = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(3))
const OWNER = OWNER_KEYPAIR.publicKey()
const AGENT_KEYPAIR = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(4))
const AGENT = AGENT_KEYPAIR.publicKey()
const KERNEL = '0x00000000000000000000000000000000000000aa'
const POOL = '0x00000000000000000000000000000000000000b2'
const BURN = '66'.repeat(32)
const NONCE = `0x${'77'.repeat(32)}`
const MESSAGE = `0x${'88'.repeat(32)}`
const LEASE_TOKEN = '55'.repeat(32)
const MANDATE_ID = '22'.repeat(16)

function bundle(overrides = {}) {
  const event = {
    eventId: '1'.padStart(64, '0'),
    identity: IDENTITY,
    owner: OWNER,
    agent: AGENT,
    recoveryVersion: 1,
    phase: 'cctp_burn',
    state: 'confirmed',
    evidence: {
      burnTxHash: BURN,
      expectationDigest: 'dd'.repeat(32),
      burnUnits7: '10000000',
      messageDigest: MESSAGE,
      nonce: NONCE,
    },
    observedAt: 2_000_000_000_000,
  }
  return {
    schemaVersion: 1,
    identity: IDENTITY,
    owner: OWNER,
    agent: AGENT,
    recoverable: true,
    recoveryVersion: 1,
    intent: {
      runId: 'run-42',
      grantTxHash: BURN,
      bindingHash: 'dd'.repeat(32),
      baseJobId: IDENTITY.childId,
      kernelAddress: KERNEL,
      poolAddress: POOL,
      proxyTarget: 'aave-v3',
      token: 'USDC',
      units: '1000000',
      decimals: 6,
      minShares: '900000',
    },
    phases: [
      {
        eventId: event.eventId,
        identity: IDENTITY,
        recoveryVersion: 1,
        phase: event.phase,
        state: event.state,
        evidence: event.evidence,
        observedAt: event.observedAt,
      },
    ],
    events: [event],
    ...overrides,
  }
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

describe('readBaseRecoveryEvidence', () => {
  it('reads all five identity components from the public fixed endpoint and validates the echo', async () => {
    const evidence = bundle()
    const fetchImpl = vi.fn(async () => response(200, evidence))

    await expect(
      readBaseRecoveryEvidence({ identity: IDENTITY, fetchImpl, apiBase: 'https://vf.test' })
    ).resolves.toEqual(evidence)

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://vf.test/api/agent-index?action=base-child-evidence&network=stellar-testnet&binding=0123456789abcdef0123456789abcdef&execution=run-42%3Aexec%3Arun-42%3Abridge%3Aaave-v3&allocation=run-42%3Abridge%3Aaave-v3&child=abcdef0123456789abcdef0123456789',
      { method: 'GET', cache: 'no-store', signal: undefined }
    )
  })

  it.each(['networkId', 'bindingId', 'executionId', 'allocationId', 'childId'])(
    'rejects a public bundle whose %s differs from the query',
    async (field) => {
      const fetchImpl = vi.fn(async () =>
        response(200, bundle({ identity: { ...IDENTITY, [field]: `${IDENTITY[field]}-other` } }))
      )
      await expect(
        readBaseRecoveryEvidence({ identity: IDENTITY, fetchImpl })
      ).rejects.toMatchObject({ code: 'identity-mismatch', step: 'read' })
    }
  )

  it('rejects a non-JSON or recursively sensitive public response', async () => {
    const nonJson = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('bad')
      },
    }))
    await expect(
      readBaseRecoveryEvidence({ identity: IDENTITY, fetchImpl: nonJson })
    ).rejects.toMatchObject({ code: 'invalid-response' })
    const poisoned = vi.fn(async () =>
      response(200, bundle({ intent: { ...bundle().intent, capability: 'TOP_SECRET' } }))
    )
    await expect(
      readBaseRecoveryEvidence({ identity: IDENTITY, fetchImpl: poisoned })
    ).rejects.toMatchObject({ code: 'invalid-response' })
  })
})

describe('requestBaseRecoveryClaim', () => {
  it('signs the exact request digest with the original bridge agent and validates the derived claim', async () => {
    const evidence = bundle()
    const leaseOwner = 'tab-0123456789abcdef'
    const exactRequest = {
      executionId: IDENTITY.executionId,
      bindingId: IDENTITY.bindingId,
      allocationId: IDENTITY.allocationId,
      childId: IDENTITY.childId,
      expectedRecoveryVersion: 1,
      leaseOwner,
    }
    const calls = []
    const fetchImpl = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body)
      calls.push({ url, init, body })
      if (url.endsWith('action=receipt-challenge')) {
        return response(201, {
          ok: true,
          challenge: {
            networkId: IDENTITY.networkId,
            owner: OWNER,
            agent: AGENT,
            challengeId: 'challenge-base-1',
            expiresAt: 4_000_000_000_000,
            requestDigest: body.requestDigest,
            createdAt: 2_000_000_000_000,
          },
        })
      }
      return response(200, {
        ok: true,
        identity: IDENTITY,
        action: 'poll-attestation',
        phase: 'cctp_attestation',
        reasonCode: 'base-attestation-pending',
        evidenceVersion: 1,
        lease: {
          holder: leaseOwner,
          leaseToken: LEASE_TOKEN,
          expiresAt: 4_000_000_030_000,
        },
      })
    })

    const claim = await requestBaseRecoveryClaim({
      identity: IDENTITY,
      owner: OWNER,
      agentAddress: AGENT,
      expectedRecoveryVersion: 1,
      leaseOwner,
      evidence,
      resolveCredential: async () => ({
        agentAddress: AGENT,
        sign: (bytes) => AGENT_KEYPAIR.sign(bytes),
      }),
      fetchImpl,
      apiBase: 'https://vf.test',
      now: 2_000_000_000_000,
    })

    expect(claim).toEqual({
      identity: IDENTITY,
      action: 'poll-attestation',
      phase: 'cctp_attestation',
      reasonCode: 'base-attestation-pending',
      evidenceVersion: 1,
      lease: {
        holder: leaseOwner,
        leaseToken: LEASE_TOKEN,
        expiresAt: 4_000_000_030_000,
      },
    })
    expect(calls).toHaveLength(2)
    expect(calls[0].url).toBe('https://vf.test/api/agent-index?action=receipt-challenge')
    expect(calls[0].body).toEqual({
      networkId: IDENTITY.networkId,
      owner: OWNER,
      agent: AGENT,
      requestDigest: receiptRequestDigest(exactRequest),
    })
    expect(calls[1].url).toBe('https://vf.test/api/agent-index?action=base-recovery-request')
    expect(calls[1].body.request).toEqual(exactRequest)
    expect(calls[1].body).not.toHaveProperty('action')
    const signature = Buffer.from(calls[1].body.proof.signature, 'base64url')
    expect(
      AGENT_KEYPAIR.verify(
        Buffer.from(
          receiptProofMessage({
            ...calls[0].body,
            challengeId: calls[1].body.proof.challengeId,
            expiresAt: calls[1].body.proof.expiresAt,
          })
        ),
        signature
      )
    ).toBe(true)
  })

  it('rejects a substituted server action/identity/token before returning a claim', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        response(201, {
          ok: true,
          challenge: {
            networkId: IDENTITY.networkId,
            owner: OWNER,
            agent: AGENT,
            challengeId: 'challenge-base-2',
            expiresAt: 4_000_000_000_000,
            requestDigest: receiptRequestDigest({
              executionId: IDENTITY.executionId,
              bindingId: IDENTITY.bindingId,
              allocationId: IDENTITY.allocationId,
              childId: IDENTITY.childId,
              expectedRecoveryVersion: 1,
              leaseOwner: 'tab-0123456789abcdef',
            }),
            createdAt: 2_000_000_000_000,
          },
        })
      )
      .mockResolvedValueOnce(
        response(200, {
          ok: true,
          identity: { ...IDENTITY, childId: '11'.repeat(16) },
          action: 'submit-mint',
          phase: 'cctp_mint',
          reasonCode: 'base-attestation-confirmed',
          evidenceVersion: 1,
          lease: {
            holder: 'tab-0123456789abcdef',
            leaseToken: 'UPPERCASE',
            expiresAt: 4_000_000_030_000,
          },
        })
      )
    await expect(
      requestBaseRecoveryClaim({
        identity: IDENTITY,
        owner: OWNER,
        agentAddress: AGENT,
        expectedRecoveryVersion: 1,
        leaseOwner: 'tab-0123456789abcdef',
        evidence: bundle(),
        resolveCredential: async () => ({
          agentAddress: AGENT,
          sign: (bytes) => AGENT_KEYPAIR.sign(bytes),
        }),
        fetchImpl,
        now: 2_000_000_000_000,
      })
    ).rejects.toMatchObject({ code: 'invalid-response', step: 'claim' })
  })
})

describe('executeBaseRecovery', () => {
  const claim = () => ({
    identity: IDENTITY,
    action: 'poll-attestation',
    phase: 'cctp_attestation',
    reasonCode: 'base-attestation-pending',
    evidenceVersion: 1,
    lease: {
      holder: 'tab-0123456789abcdef',
      leaseToken: LEASE_TOKEN,
      expiresAt: 4_000_000_030_000,
    },
  })

  it('uses only the fixed same-origin recovery route and returns no claim token', async () => {
    const accepted = {
      accepted: true,
      workId: '99'.repeat(32),
      identity: IDENTITY,
      action: 'poll-attestation',
      evidenceVersion: 1,
      status: 'pending',
    }
    const fetchImpl = vi.fn(async () => response(202, accepted))

    await expect(
      executeBaseRecovery({ mandateId: MANDATE_ID, claim: claim(), fetchImpl })
    ).resolves.toEqual(accepted)

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/vf-cross/farm/recover')
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(JSON.parse(init.body)).toEqual({
      mandateId: MANDATE_ID,
      identity: IDENTITY,
      action: 'poll-attestation',
      evidenceVersion: 1,
      leaseToken: LEASE_TOKEN,
    })
    expect(JSON.stringify(accepted)).not.toContain(LEASE_TOKEN)
  })

  it('accepts no caller capability or alternate URL before fetch', async () => {
    const fetchImpl = vi.fn()
    await expect(
      executeBaseRecovery({
        mandateId: MANDATE_ID,
        claim: claim(),
        fetchImpl,
        capability: 'TOP_SECRET',
      })
    ).rejects.toMatchObject({ code: 'invalid-request' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not retain a capability-bearing transport error as a public cause', async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      throw new Error(`transport echoed ${init.body}`)
    })

    let failure
    try {
      await executeBaseRecovery({ mandateId: MANDATE_ID, claim: claim(), fetchImpl })
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({ code: 'network-error', step: 'execute' })
    expect(failure?.cause).toBeUndefined()
    expect(String(failure?.message)).not.toContain(LEASE_TOKEN)
  })
})

describe('pollBaseRecoveryEvidence', () => {
  it('performs bounded public reads until the exact identity version advances', async () => {
    const reads = [bundle(), bundle({ recoveryVersion: 2 })]
    const readEvidence = vi.fn(async () => reads.shift())
    const wait = vi.fn(async () => {})

    await expect(
      pollBaseRecoveryEvidence({
        identity: IDENTITY,
        afterVersion: 1,
        limit: 2,
        intervalMs: 1,
        readEvidence,
        wait,
      })
    ).resolves.toEqual({
      status: 'advanced',
      bundle: expect.objectContaining({ recoveryVersion: 2 }),
    })
    expect(readEvidence).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenCalledTimes(1)
  })

  it('returns the last exact public bundle on timeout and never invokes an executor', async () => {
    const readEvidence = vi.fn(async () => bundle())
    await expect(
      pollBaseRecoveryEvidence({
        identity: IDENTITY,
        afterVersion: 1,
        limit: 2,
        intervalMs: 0,
        readEvidence,
      })
    ).resolves.toEqual({
      status: 'timeout',
      bundle: expect.objectContaining({ recoveryVersion: 1 }),
    })
    expect(readEvidence).toHaveBeenCalledTimes(2)
  })
})

describe('createBaseRecoveryActionRunner', () => {
  function harness(overrides = {}) {
    const active = { version: 1, address: OWNER, epoch: 1 }
    const currentProjection = {
      action: 'poll-attestation',
      phase: 'cctp_attestation',
      reasonCode: 'base-attestation-pending',
      identity: IDENTITY,
      version: 1,
      phases: {},
      custody: { location: 'cctp-transit', confirmed: true, burnTxHash: BURN },
    }
    const advanced = bundle({ recoveryVersion: 2 })
    const deps = {
      getActiveAccount: vi.fn(() => active),
      getMandateId: vi.fn(() => MANDATE_ID),
      readEvidence: vi.fn(async () => bundle()),
      projectEvidence: vi.fn(() => currentProjection),
      requestClaim: vi.fn(async () => ({
        identity: IDENTITY,
        action: 'poll-attestation',
        phase: 'cctp_attestation',
        reasonCode: 'base-attestation-pending',
        evidenceVersion: 1,
        lease: {
          holder: 'tab-0123456789abcdef',
          leaseToken: LEASE_TOKEN,
          expiresAt: 4_000_000_030_000,
        },
      })),
      executeRecovery: vi.fn(async () => ({
        accepted: true,
        workId: '99'.repeat(32),
        identity: IDENTITY,
        action: 'poll-attestation',
        evidenceVersion: 1,
        status: 'pending',
      })),
      pollEvidence: vi.fn(async () => ({ status: 'advanced', bundle: advanced })),
      resolveCredential: vi.fn(),
      onProjection: vi.fn(),
      onPending: vi.fn(),
      onError: vi.fn(),
      leaseOwner: 'tab-0123456789abcdef',
      pollLimit: 2,
      pollIntervalMs: 0,
      ...overrides,
    }
    return { active, currentProjection, advanced, deps }
  }

  it('runs one exact full-identity claim/execute/poll chain without publishing the lease token', async () => {
    const { deps } = harness()
    deps.projectEvidence
      .mockReturnValueOnce({
        action: 'poll-attestation',
        phase: 'cctp_attestation',
        reasonCode: 'base-attestation-pending',
        identity: IDENTITY,
        version: 1,
        phases: {},
        custody: { location: 'cctp-transit', confirmed: true },
      })
      .mockReturnValueOnce({
        action: 'submit-mint',
        phase: 'cctp_mint',
        reasonCode: 'base-attestation-confirmed',
        identity: IDENTITY,
        version: 2,
        phases: {},
        custody: { location: 'cctp-transit', confirmed: true },
      })
    const runner = createBaseRecoveryActionRunner(deps)

    const result = await runner.run(IDENTITY)

    expect(deps.requestClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: IDENTITY,
        owner: OWNER,
        agentAddress: AGENT,
        expectedRecoveryVersion: 1,
        leaseOwner: deps.leaseOwner,
        evidence: expect.objectContaining({ identity: IDENTITY }),
        resolveCredential: deps.resolveCredential,
      })
    )
    expect(deps.executeRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ mandateId: MANDATE_ID, claim: expect.any(Object) })
    )
    expect(deps.pollEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ identity: IDENTITY, afterVersion: 1, limit: 2, intervalMs: 0 })
    )
    expect(deps.onPending.mock.calls).toEqual([
      [expect.any(String), true],
      [expect.any(String), false],
    ])
    expect(JSON.stringify({ result, projections: deps.onProjection.mock.calls })).not.toContain(
      LEASE_TOKEN
    )
  })

  it('joins concurrent calls for one full identity while leaving a collision identity independent', async () => {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const { deps } = harness({
      requestClaim: vi.fn(async (args) => {
        await gate
        return {
          identity: args.identity,
          action: 'poll-attestation',
          phase: 'cctp_attestation',
          reasonCode: 'base-attestation-pending',
          evidenceVersion: 1,
          lease: {
            holder: 'tab-0123456789abcdef',
            leaseToken: LEASE_TOKEN,
            expiresAt: 4_000_000_030_000,
          },
        }
      }),
    })
    const other = {
      ...IDENTITY,
      bindingId: '11'.repeat(16),
      childId: '22'.repeat(16),
    }
    deps.readEvidence.mockImplementation(async ({ identity }) =>
      bundle({
        identity,
        events: bundle().events.map((event) => ({ ...event, identity })),
        phases: bundle().phases.map((phase) => ({ ...phase, identity })),
      })
    )
    deps.projectEvidence.mockImplementation((evidence) => ({
      action: 'poll-attestation',
      phase: 'cctp_attestation',
      reasonCode: 'base-attestation-pending',
      identity: evidence.identity,
      version: 1,
      phases: {},
      custody: { location: 'cctp-transit', confirmed: true },
    }))
    deps.executeRecovery.mockImplementation(async ({ claim }) => ({
      accepted: true,
      workId: '99'.repeat(32),
      identity: claim.identity,
      action: claim.action,
      evidenceVersion: 1,
      status: 'pending',
    }))
    deps.pollEvidence.mockImplementation(async ({ identity }) => ({
      status: 'timeout',
      bundle: await deps.readEvidence({ identity }),
    }))
    const runner = createBaseRecoveryActionRunner(deps)

    const first = runner.run(IDENTITY)
    const joined = runner.run(IDENTITY)
    const independent = runner.run(other)
    expect(joined).toBe(first)
    release()
    await Promise.all([first, independent])
    expect(deps.requestClaim).toHaveBeenCalledTimes(2)
  })

  it.each(['no-movement', 'manual-review', 'owner-action-required', 'complete'])(
    'never claims or executes the non-actionable %s projection',
    async (action) => {
      const { deps } = harness({
        projectEvidence: vi.fn(() => ({
          action,
          phase: null,
          reasonCode: 'base-manual-review',
          identity: IDENTITY,
          version: 1,
          phases: {},
          custody: { location: 'unknown', confirmed: false },
        })),
      })
      const runner = createBaseRecoveryActionRunner(deps)
      await expect(runner.run(IDENTITY)).resolves.toEqual({ skipped: action })
      expect(deps.requestClaim).not.toHaveBeenCalled()
      expect(deps.executeRecovery).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['version-conflict', 'poll-attestation'],
    ['lease-conflict', 'recovery-in-progress'],
  ])('reprojects %s without executing', async (code, expectedAction) => {
    const conflict = Object.assign(new Error('poisoned dependency detail TOP_SECRET'), { code })
    const { deps } = harness({
      requestClaim: vi.fn(async () => {
        throw conflict
      }),
    })
    const runner = createBaseRecoveryActionRunner(deps)

    await expect(runner.run(IDENTITY)).resolves.toMatchObject({ status: code })
    expect(deps.executeRecovery).not.toHaveBeenCalled()
    expect(deps.onProjection.mock.calls.at(-1)[1]).toMatchObject({ action: expectedAction })
    expect(JSON.stringify(deps.onProjection.mock.calls)).not.toMatch(/TOP_SECRET|leaseToken/i)
  })
})
