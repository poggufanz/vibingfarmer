import { describe, expect, it, vi } from 'vitest'
import { Keypair } from '@stellar/stellar-sdk'
import {
  receiptProofMessage,
  receiptRequestDigest,
} from '../../api/agent-index/executionReceipts.js'
import { selectRecoveryAction } from '../../api/agent-index/recovery.js'
import { saveCachedAgent } from '../stellar/agentCache.js'
import { newSessionKey } from '../stellar/sessionKey.js'
import { appendPhase, createAllocationReceipt } from './allocationReceipt.js'
import {
  RecoveryClientError,
  readRecoveryReceipt,
  requestRecoveryAction,
  resolveRecoveryCredential,
} from './recoveryClient.js'

const NETWORK = 'stellar-testnet'
const OWNER = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(1)).publicKey()
const AGENT = 'CAUSSKJJFEUSSKJJFEUSSKJJFEUSSKJJFEUSSKJJFEUSSKJJFEUSS3Y4'
const IDENTITY = {
  networkId: NETWORK,
  owner: OWNER,
  executionId: 'run-client:exec:run-client:deposit:0',
  allocationId: 'run-client:deposit:0',
}
const HUGE_UNITS = '123456789012345678901234567890123456789'

function receipt(overrides = {}) {
  const rowVersion = overrides.version ?? 7
  const childId = Object.prototype.hasOwnProperty.call(overrides, 'childId')
    ? overrides.childId
    : null
  const amount = { token: 'USDC', units: HUGE_UNITS, decimals: 7 }
  const produced = appendPhase(
    createAllocationReceipt({
      ...IDENTITY,
      childId,
      runId: 'run-client',
      worker: 'GWORKER',
      agent: AGENT,
      intent: { allocationId: IDENTITY.allocationId, kind: 'deposit', allocation: amount },
      amount,
    }),
    {
      attemptId: 'client-fixture-pull-submitted',
      phase: 'pull',
      status: 'submitted',
      evidence: {},
      observedAt: 1_899_999_000_000,
    }
  )
  return {
    ...produced,
    format: produced.version,
    version: rowVersion,
    runId: 'run-client',
    intentDigest: 'ab'.repeat(32),
    ...overrides,
  }
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function storage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
}

describe('readRecoveryReceipt', () => {
  it('GETs the exact public identity, returns the row version, and preserves exact unit strings', async () => {
    const row = receipt()
    const fetchImpl = vi.fn(async () => response(200, { receipt: row }))

    const result = await readRecoveryReceipt({ ...IDENTITY, fetchImpl, apiBase: 'https://vf.test' })

    expect(result).toEqual({ receipt: row, version: 7 })
    expect(result.receipt.custody.amount.units).toBe(HUGE_UNITS)
    expect(typeof result.receipt.custody.amount.units).toBe('string')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(
      'https://vf.test/api/agent-index?action=receipt&network=stellar-testnet&owner=' +
        encodeURIComponent(OWNER) +
        '&execution=run-client%3Aexec%3Arun-client%3Adeposit%3A0&allocation=run-client%3Adeposit%3A0'
    )
    expect(init).toEqual({ method: 'GET' })
  })

  it('returns genuine absence only for HTTP 404', async () => {
    const fetchImpl = vi.fn(async () => response(404, { error: 'wording is not a contract' }))
    await expect(readRecoveryReceipt({ ...IDENTITY, fetchImpl })).resolves.toEqual({
      receipt: null,
      version: 0,
    })
  })

  it.each(['networkId', 'owner', 'executionId', 'allocationId'])(
    'rejects a 200 receipt whose %s does not match the requested identity',
    async (field) => {
      const fetchImpl = vi.fn(async () =>
        response(200, { receipt: receipt({ [field]: `${receipt()[field]}-wrong` }) })
      )
      await expect(readRecoveryReceipt({ ...IDENTITY, fetchImpl })).rejects.toMatchObject({
        name: 'RecoveryClientError',
        step: 'read',
        code: 'identity-mismatch',
        status: 200,
      })
    }
  )
})

describe('resolveRecoveryCredential', () => {
  it('restores only the exact original cached agent and never falls back to another entry', () => {
    const cacheStorage = storage()
    const wrong = newSessionKey()
    const exact = newSessionKey()
    const vault = 'CVAULT'
    for (const entry of [
      { agentAddress: 'CWRONG', secret: wrong.secret, signerPub: wrong.publicKey },
      { agentAddress: AGENT, secret: exact.secret, signerPub: exact.publicKey },
    ]) {
      saveCachedAgent({ owner: OWNER, vault, network: NETWORK, entry, storage: cacheStorage })
    }

    const credential = resolveRecoveryCredential({
      ...IDENTITY,
      vault,
      agentAddress: AGENT,
      storage: cacheStorage,
    })

    expect(credential.publicKey).toBe(exact.publicKey)
    expect(credential.publicKey).not.toBe(wrong.publicKey)
    expect(() =>
      resolveRecoveryCredential({
        ...IDENTITY,
        vault,
        agentAddress: 'CMISSING',
        storage: cacheStorage,
      })
    ).toThrow(RecoveryClientError)
  })
})

describe('requestRecoveryAction', () => {
  it('pins the browser digest/proof to server bytes and emits no agent or secret in the business request', async () => {
    const sessionKey = newSessionKey()
    const calls = []
    const persisted = receipt()
    const decision = selectRecoveryAction(persisted)
    const fetchImpl = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body)
      calls.push({ url, init, body })
      if (url.includes('action=receipt-challenge')) {
        return response(201, {
          ok: true,
          challenge: {
            networkId: NETWORK,
            owner: OWNER,
            agent: AGENT,
            challengeId: 'challenge-client-1',
            expiresAt: 1_900_000_000_000,
            requestDigest: body.requestDigest,
            createdAt: 1_899_999_000_000,
          },
        })
      }
      return response(200, {
        ok: true,
        ...decision,
        version: 7,
        receipt: persisted,
        lease: {
          holder: 'tab-a',
          leaseToken: 'server-uuid',
          expiresAt: 4_000_000_000_000,
          phase: decision.phase,
        },
      })
    })

    const result = await requestRecoveryAction({
      ...IDENTITY,
      receipt: receipt(),
      expectedReceiptVersion: 7,
      leaseOwner: 'tab-a',
      resolveCredential: () => ({ ...sessionKey, agentAddress: AGENT }),
      fetchImpl,
    })

    expect(result.reasonCode).toBe('pull-v2-uncertain')
    expect(calls).toHaveLength(2)
    const challengeBody = calls[0].body
    const recoveryBody = calls[1].body
    const exactRequest = {
      executionId: IDENTITY.executionId,
      allocationId: IDENTITY.allocationId,
      expectedReceiptVersion: 7,
      leaseOwner: 'tab-a',
    }
    expect(challengeBody).toEqual({
      networkId: NETWORK,
      owner: OWNER,
      agent: AGENT,
      requestDigest: receiptRequestDigest(exactRequest),
    })
    expect(recoveryBody.request).toEqual(exactRequest)
    expect(recoveryBody.request).not.toHaveProperty('agent')
    expect(recoveryBody.proof).toEqual({
      challengeId: 'challenge-client-1',
      expiresAt: 1_900_000_000_000,
      signature: expect.any(String),
    })
    const signature = Buffer.from(recoveryBody.proof.signature, 'base64url')
    expect(
      Keypair.fromPublicKey(sessionKey.publicKey).verify(
        Buffer.from(
          receiptProofMessage({
            ...challengeBody,
            challengeId: recoveryBody.proof.challengeId,
            expiresAt: recoveryBody.proof.expiresAt,
          })
        ),
        signature
      )
    ).toBe(true)
    for (const { url, init, body } of calls) {
      const wire = `${url} ${JSON.stringify(init.headers)} ${JSON.stringify(body)}`
      expect(wire).not.toContain(sessionKey.secret)
      expect(wire.toLowerCase()).not.toMatch(/secret|private|sessionkey/)
    }
  })

  it('requires an authoritative explicit no-child mapping and rejects child replacements', async () => {
    const fetchImpl = vi.fn()
    const common = {
      ...IDENTITY,
      expectedReceiptVersion: 0,
      leaseOwner: 'tab-a',
      resolveCredential: () => ({ ...newSessionKey(), agentAddress: AGENT }),
      fetchImpl,
    }
    await expect(
      requestRecoveryAction({ ...common, receipt: null, agentAddress: AGENT, childId: 'child-a' })
    ).rejects.toMatchObject({ code: 'missing-allocation-mapping' })
    await expect(
      requestRecoveryAction({
        ...common,
        receipt: null,
        allocationMapping: { ...IDENTITY, agentAddress: AGENT },
      })
    ).rejects.toMatchObject({ code: 'missing-allocation-mapping' })
    await expect(
      requestRecoveryAction({
        ...common,
        receipt: null,
        allocationMapping: { ...IDENTITY, childId: 'child-a', agentAddress: AGENT },
      })
    ).rejects.toMatchObject({ code: 'allocation-mapping-mismatch' })
    await expect(
      requestRecoveryAction({
        ...common,
        receipt: null,
        allocationMapping: { ...IDENTITY, childId: '', agentAddress: AGENT },
      })
    ).rejects.toMatchObject({ code: 'allocation-mapping-mismatch' })
    await expect(
      requestRecoveryAction({
        ...common,
        receipt: null,
        childId: 'child-a',
        allocationMapping: { ...IDENTITY, childId: null, agentAddress: AGENT },
      })
    ).rejects.toMatchObject({ code: 'child-mismatch' })
    await expect(
      requestRecoveryAction({ ...common, receipt: receipt(), agentAddress: 'CDIFFERENT' })
    ).rejects.toMatchObject({ code: 'agent-mismatch' })
    await expect(
      requestRecoveryAction({ ...common, receipt: receipt(), childId: 'replacement-child' })
    ).rejects.toMatchObject({ code: 'child-mismatch' })
    await expect(
      requestRecoveryAction({ ...common, receipt: receipt({ childId: 'child-a' }), childId: null })
    ).rejects.toMatchObject({ code: 'child-mismatch' })
    await expect(
      requestRecoveryAction({
        ...common,
        receipt: null,
        allocationMapping: {
          ...IDENTITY,
          allocationId: 'other-allocation',
          childId: 'child-a',
          agentAddress: AGENT,
        },
      })
    ).rejects.toMatchObject({ code: 'allocation-mapping-mismatch' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('uses an explicit no-child mapping and omits child from the signed absent-receipt request', async () => {
    const sessionKey = newSessionKey()
    const decision = selectRecoveryAction(null)
    const requests = []
    const fetchImpl = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body)
      if (url.includes('action=receipt-challenge')) {
        return response(201, {
          ok: true,
          challenge: {
            networkId: NETWORK,
            owner: OWNER,
            agent: AGENT,
            challengeId: 'absent-mapping',
            expiresAt: 4_000_000_000_000,
            requestDigest: body.requestDigest,
          },
        })
      }
      requests.push(body.request)
      return response(200, {
        ok: true,
        ...decision,
        version: 0,
        receipt: null,
        lease: {
          holder: 'tab-a',
          leaseToken: 'absent-lease',
          expiresAt: 4_000_000_000_000,
          phase: decision.phase,
        },
      })
    })

    await requestRecoveryAction({
      ...IDENTITY,
      receipt: null,
      allocationMapping: { ...IDENTITY, childId: null, agentAddress: AGENT },
      expectedReceiptVersion: 0,
      leaseOwner: 'tab-a',
      resolveCredential: () => ({ ...sessionKey, agentAddress: AGENT }),
      fetchImpl,
    })

    expect(requests).toEqual([
      {
        executionId: IDENTITY.executionId,
        allocationId: IDENTITY.allocationId,
        expectedReceiptVersion: 0,
        leaseOwner: 'tab-a',
      },
    ])
    expect(requests[0]).not.toHaveProperty('childId')
  })

  it('derives a persisted child identity into the signed business request', async () => {
    const sessionKey = newSessionKey()
    const persisted = receipt({ childId: 'child-a' })
    const decision = selectRecoveryAction(persisted)
    const requests = []
    const fetchImpl = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body)
      if (url.includes('action=receipt-challenge')) {
        return response(201, {
          ok: true,
          challenge: {
            networkId: NETWORK,
            owner: OWNER,
            agent: AGENT,
            challengeId: 'child-bound-challenge',
            expiresAt: 2_000,
            requestDigest: body.requestDigest,
          },
        })
      }
      requests.push(body.request)
      return response(200, {
        ok: true,
        ...decision,
        version: 7,
        receipt: persisted,
        lease: {
          holder: 'tab-a',
          leaseToken: 'lease-token',
          expiresAt: 4_000_000_000_000,
          phase: decision.phase,
        },
      })
    })

    await requestRecoveryAction({
      ...IDENTITY,
      receipt: persisted,
      expectedReceiptVersion: 7,
      leaseOwner: 'tab-a',
      resolveCredential: () => ({ ...sessionKey, agentAddress: AGENT }),
      fetchImpl,
    })

    expect(requests).toEqual([
      {
        executionId: IDENTITY.executionId,
        allocationId: IDENTITY.allocationId,
        childId: 'child-a',
        expectedReceiptVersion: 7,
        leaseOwner: 'tab-a',
      },
    ])
  })

  it('gets a fresh consumed challenge for every valid retry and trusts only structured 409 codes', async () => {
    const sessionKey = newSessionKey()
    let challenge = 0
    let recovery = 0
    const fetchImpl = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body)
      if (url.includes('action=receipt-challenge')) {
        challenge += 1
        return response(201, {
          ok: true,
          challenge: {
            networkId: NETWORK,
            owner: OWNER,
            agent: AGENT,
            challengeId: `fresh-${challenge}`,
            expiresAt: 2_000 + challenge,
            requestDigest: body.requestDigest,
          },
        })
      }
      recovery += 1
      return recovery === 1
        ? response(409, {
            error: 'arbitrary text must not drive classification',
            code: 'version-conflict',
            version: 8,
          })
        : (() => {
            const persisted = receipt({ version: 8 })
            const decision = selectRecoveryAction(persisted)
            return response(200, {
              ok: true,
              ...decision,
              version: 8,
              receipt: persisted,
              lease: {
                holder: 'tab-a',
                leaseToken: 'retry-lease',
                expiresAt: 4_000_000_000_000,
                phase: decision.phase,
              },
            })
          })()
    })
    const common = {
      ...IDENTITY,
      receipt: receipt(),
      leaseOwner: 'tab-a',
      resolveCredential: () => ({ ...sessionKey, agentAddress: AGENT }),
      fetchImpl,
    }

    await expect(
      requestRecoveryAction({ ...common, expectedReceiptVersion: 7 })
    ).rejects.toMatchObject({ code: 'version-conflict', status: 409, version: 8 })
    await expect(
      requestRecoveryAction({ ...common, expectedReceiptVersion: 8 })
    ).resolves.toMatchObject({ ok: true, lease: { holder: 'tab-a' } })

    expect(challenge).toBe(2)
    expect(
      fetchImpl.mock.calls
        .filter(([url]) => url.includes('action=recovery-request'))
        .map(([, init]) => JSON.parse(init.body).proof.challengeId)
    ).toEqual(['fresh-1', 'fresh-2'])
  })

  it.each(['Receipt proof was already used', 'Receipt mutation conflict'])(
    'does not classify an unstructured 409 by error text: %s',
    async (error) => {
      const sessionKey = newSessionKey()
      let call = 0
      const fetchImpl = vi.fn(async (_url, init) => {
        call += 1
        const body = JSON.parse(init.body)
        if (call === 1) {
          return response(201, {
            ok: true,
            challenge: {
              networkId: NETWORK,
              owner: OWNER,
              agent: AGENT,
              challengeId: 'fresh',
              expiresAt: 2_000,
              requestDigest: body.requestDigest,
            },
          })
        }
        return response(409, { error })
      })
      await expect(
        requestRecoveryAction({
          ...IDENTITY,
          receipt: receipt(),
          expectedReceiptVersion: 7,
          leaseOwner: 'tab-a',
          resolveCredential: () => ({ ...sessionKey, agentAddress: AGENT }),
          fetchImpl,
        })
      ).rejects.toMatchObject({ code: 'conflict', status: 409 })
    }
  )

  it.each([
    [
      'version differs from the requested compare-and-swap value',
      ({ persisted, success }) => ({ ...success, version: 8, receipt: { ...persisted, version: 8 } }),
    ],
    ['nonzero version has no receipt', ({ success }) => ({ ...success, receipt: null })],
    [
      'receipt child differs from the requested receipt',
      ({ persisted, success }) => ({
        ...success,
        receipt: { ...persisted, childId: 'replacement-child' },
      }),
    ],
    [
      'decision differs from the server selector',
      ({ success }) => ({ ...success, reasonCode: 'caller-invented-reason' }),
    ],
  ])('rejects malformed successful recovery when %s', async (_label, mutateSuccess) => {
    const sessionKey = newSessionKey()
    const persisted = receipt({ childId: 'child-a' })
    const decision = selectRecoveryAction(persisted)
    const success = {
      ok: true,
      ...decision,
      version: 7,
      receipt: persisted,
      lease: {
        holder: 'tab-a',
        leaseToken: 'valid-token',
        expiresAt: 4_000_000_000_000,
        phase: decision.phase,
      },
    }
    let call = 0
    const fetchImpl = vi.fn(async (_url, init) => {
      call += 1
      const body = JSON.parse(init.body)
      return call === 1
        ? response(201, {
            ok: true,
            challenge: {
              networkId: NETWORK,
              owner: OWNER,
              agent: AGENT,
              challengeId: `malformed-${call}`,
              expiresAt: 4_000_000_000_000,
              requestDigest: body.requestDigest,
            },
          })
        : response(200, mutateSuccess({ persisted, success }))
    })

    await expect(
      requestRecoveryAction({
        ...IDENTITY,
        receipt: persisted,
        expectedReceiptVersion: 7,
        leaseOwner: 'tab-a',
        resolveCredential: () => ({ ...sessionKey, agentAddress: AGENT }),
        fetchImpl,
      })
    ).rejects.toMatchObject({ code: 'invalid-response', step: 'recovery' })
  })

  it('rejects a zero-version absence response that fabricates a receipt', async () => {
    const sessionKey = newSessionKey()
    const fabricated = receipt({ version: 0 })
    const decision = selectRecoveryAction(fabricated)
    let call = 0
    const fetchImpl = vi.fn(async (_url, init) => {
      call += 1
      const body = JSON.parse(init.body)
      return call === 1
        ? response(201, {
            ok: true,
            challenge: {
              networkId: NETWORK,
              owner: OWNER,
              agent: AGENT,
              challengeId: 'fabricated-zero',
              expiresAt: 4_000_000_000_000,
              requestDigest: body.requestDigest,
            },
          })
        : response(200, {
            ok: true,
            ...decision,
            version: 0,
            receipt: fabricated,
            lease: {
              holder: 'tab-a',
              leaseToken: 'fabricated-token',
              expiresAt: 4_000_000_000_000,
              phase: decision.phase,
            },
          })
    })

    await expect(
      requestRecoveryAction({
        ...IDENTITY,
        receipt: null,
        allocationMapping: { ...IDENTITY, childId: null, agentAddress: AGENT },
        expectedReceiptVersion: 0,
        leaseOwner: 'tab-a',
        resolveCredential: () => ({ ...sessionKey, agentAddress: AGENT }),
        fetchImpl,
      })
    ).rejects.toMatchObject({ code: 'invalid-response', step: 'recovery' })
  })

  it.each([
    ['missing', null],
    [
      'wrong holder',
      { holder: 'other-tab', leaseToken: 'valid-token', expiresAt: 4_000_000_000_000, phase: 'pull' },
    ],
    [
      'wrong phase',
      {
        holder: 'tab-a',
        leaseToken: 'valid-token',
        expiresAt: 4_000_000_000_000,
        phase: 'stellar_deposit',
      },
    ],
    [
      'empty token',
      { holder: 'tab-a', leaseToken: '', expiresAt: 4_000_000_000_000, phase: 'pull' },
    ],
    [
      'expired',
      { holder: 'tab-a', leaseToken: 'valid-token', expiresAt: 1, phase: 'pull' },
    ],
  ])('rejects an actionable success with a %s lease', async (_label, lease) => {
    const sessionKey = newSessionKey()
    const persisted = receipt()
    const decision = selectRecoveryAction(persisted)
    let call = 0
    const fetchImpl = vi.fn(async (_url, init) => {
      call += 1
      const body = JSON.parse(init.body)
      return call === 1
        ? response(201, {
            ok: true,
            challenge: {
              networkId: NETWORK,
              owner: OWNER,
              agent: AGENT,
              challengeId: 'malformed-lease',
              expiresAt: 4_000_000_000_000,
              requestDigest: body.requestDigest,
            },
          })
        : response(200, {
            ok: true,
            ...decision,
            version: 7,
            receipt: persisted,
            lease,
          })
    })

    await expect(
      requestRecoveryAction({
        ...IDENTITY,
        receipt: persisted,
        expectedReceiptVersion: 7,
        leaseOwner: 'tab-a',
        resolveCredential: () => ({ ...sessionKey, agentAddress: AGENT }),
        fetchImpl,
      })
    ).rejects.toMatchObject({ code: 'invalid-response', step: 'recovery' })
  })
})
