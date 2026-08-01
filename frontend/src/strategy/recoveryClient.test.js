import { describe, expect, it, vi } from 'vitest'
import { Keypair } from '@stellar/stellar-sdk'
import {
  receiptProofMessage,
  receiptRequestDigest,
} from '../../api/agent-index/executionReceipts.js'
import { saveCachedAgent } from '../stellar/agentCache.js'
import { newSessionKey } from '../stellar/sessionKey.js'
import {
  RecoveryClientError,
  readRecoveryReceipt,
  requestRecoveryAction,
  resolveRecoveryCredential,
} from './recoveryClient.js'

const NETWORK = 'stellar-testnet'
const OWNER = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(1)).publicKey()
const AGENT = 'CCEWWRQVYKEIWTO7GTX2QVHQASC3GIQOZZTDMGTOHFQYKZIX5KJ6CYE5'
const IDENTITY = {
  networkId: NETWORK,
  owner: OWNER,
  executionId: 'run-client:exec:run-client:deposit:0',
  allocationId: 'run-client:deposit:0',
}
const HUGE_UNITS = '123456789012345678901234567890123456789'

function receipt(overrides = {}) {
  return {
    version: 7,
    format: 2,
    ...IDENTITY,
    runId: 'run-client',
    parentAllocationId: null,
    childId: null,
    worker: 'GWORKER',
    agent: AGENT,
    intentDigest: 'ab'.repeat(32),
    intent: {
      allocationId: IDENTITY.allocationId,
      allocation: { token: 'USDC', units: HUGE_UNITS, decimals: 7 },
    },
    phases: {
      pull: 'submitted',
      stellar_deposit: 'not_started',
      cctp_burn: 'not_started',
      cctp_mint: 'not_started',
      base_deposit: 'not_started',
    },
    custody: {
      location: 'owner',
      confirmed: true,
      amount: { token: 'USDC', units: HUGE_UNITS, decimals: 7 },
      reason: null,
    },
    attempts: [],
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
        action: 'poll',
        phase: 'pull',
        reasonCode: 'pull-v2-uncertain',
        reason: 'fail closed',
        version: 7,
        receipt: receipt(),
        lease: { holder: 'tab-a', leaseToken: 'server-uuid', expiresAt: 2, phase: 'pull' },
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

  it('requires the absent receipt caller mapping and rejects a mapping that disagrees with receipt evidence', async () => {
    const fetchImpl = vi.fn()
    const common = {
      ...IDENTITY,
      expectedReceiptVersion: 0,
      leaseOwner: 'tab-a',
      resolveCredential: () => ({ ...newSessionKey(), agentAddress: AGENT }),
      fetchImpl,
    }
    await expect(requestRecoveryAction({ ...common, receipt: null })).rejects.toMatchObject({
      code: 'missing-agent-mapping',
    })
    await expect(
      requestRecoveryAction({ ...common, receipt: receipt(), agentAddress: 'CDIFFERENT' })
    ).rejects.toMatchObject({ code: 'agent-mismatch' })
    expect(fetchImpl).not.toHaveBeenCalled()
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
        : response(200, {
            ok: true,
            action: 'complete',
            phase: null,
            reasonCode: 'deposit-confirmed',
            reason: 'done',
            version: 8,
            receipt: receipt({ version: 8 }),
            lease: null,
          })
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
    ).resolves.toMatchObject({ ok: true, lease: null })

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
})
