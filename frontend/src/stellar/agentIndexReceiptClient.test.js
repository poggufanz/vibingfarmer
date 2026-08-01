// Tests for the authenticated receipt-evidence transport (challenge -> sign -> write) against the
// real server contract in frontend/api/agent-index/executionReceipts.js. Per house convention
// (agentIndexClient.test.js), the network is mocked at `fetch` via an injectable `fetchImpl` -- the
// tests below inspect the actual serialized requests postReceiptEvidence sends, never internal
// module seams. `receiptRequestDigest`/`receiptProofMessage` are imported directly from the server
// module so the digest/proof pinning tests assert agreement against the real implementation, not
// against this test file's own expectation of what they should produce.
import { describe, it, expect, vi } from 'vitest'
import { Keypair } from '@stellar/stellar-sdk'
import { postReceiptEvidence, ReceiptEvidenceError } from './agentIndexReceiptClient.js'
import { newSessionKey } from './sessionKey.js'
import {
  receiptProofMessage,
  receiptRequestDigest,
} from '../../api/agent-index/executionReceipts.js'

const NETWORK = 'stellar-testnet'
const OWNER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey()
const AGENT = 'CCEWWRQVYKEIWTO7GTX2QVHQASC3GIQOZZTDMGTOHFQYKZIX5KJ6CYE5'

function receiptFixture(overrides = {}) {
  return {
    version: 2,
    networkId: NETWORK,
    owner: OWNER,
    executionId: 'execution-1',
    runId: 'run-1',
    allocationId: 'run-1:deposit:0',
    parentAllocationId: null,
    childId: null,
    worker: 'worker-0',
    agent: AGENT,
    intent: {
      kind: 'stellar-deposit',
      token: 'USDC',
      units: '90071992547409931234567890',
      decimals: 7,
      target: 'vault-1',
    },
    phases: {
      pull: 'submitted',
      stellar_deposit: 'not_started',
      cctp_burn: 'not_started',
      cctp_mint: 'not_started',
      base_deposit: 'not_started',
    },
    custody: {
      location: 'stellar-agent',
      confirmed: true,
      amount: { token: 'USDC', units: '90071992547409931234567890', decimals: 7 },
      reason: null,
    },
    ...overrides,
  }
}

function mutationFixture(overrides = {}) {
  return {
    expectedVersion: 0,
    receipt: receiptFixture(),
    attempt: {
      attemptId: 'attempt-pull-1',
      kind: 'phase',
      phase: 'pull',
      status: 'submitted',
      evidence: { txHash: 'stellar-tx-1' },
      observedAt: 1_700_000_000_000,
    },
    ...overrides,
  }
}

function challengeFor(body, overrides = {}) {
  return {
    networkId: body.receipt.networkId,
    owner: body.receipt.owner,
    agent: body.receipt.agent,
    challengeId: 'challenge-1',
    expiresAt: 1_700_000_300_000,
    requestDigest: receiptRequestDigest(body),
    createdAt: 1_700_000_000_000,
    ...overrides,
  }
}

/** Injectable fetch double returning each queued response in call order, capturing (url, init)
 * via vi.fn's own mock.calls -- the tests below inspect the literal serialized request. */
function sequenceFetch(responses) {
  let callIndex = 0
  return vi.fn(async () => {
    const next = responses[callIndex++]
    if (!next) throw new Error('unexpected extra fetch call')
    if (next.networkError) throw new Error('simulated network failure')
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
    }
  })
}

const writeSuccess = { status: 200, body: { ok: true, written: 1, duplicates: 0, version: 1 } }

describe('postReceiptEvidence', () => {
  it('runs challenge -> sign -> write in order and returns the committed version', async () => {
    const body = mutationFixture()
    const sessionKey = newSessionKey()
    const challenge = challengeFor(body)
    const fetchImpl = sequenceFetch([{ status: 201, body: { ok: true, challenge } }, writeSuccess])

    const result = await postReceiptEvidence({
      activeAccount: OWNER,
      agentAddress: AGENT,
      sessionKey,
      body,
      fetchImpl,
    })

    expect(result).toEqual({
      requestDigest: challenge.requestDigest,
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt,
      written: 1,
      duplicates: 0,
      version: 1,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    const [challengeUrl, challengeInit] = fetchImpl.mock.calls[0]
    expect(challengeUrl).toBe('/api/agent-index?action=receipt-challenge')
    expect(challengeInit.method).toBe('POST')
    expect(challengeInit.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(challengeInit.body)).toEqual({
      networkId: NETWORK,
      owner: OWNER,
      agent: AGENT,
      requestDigest: challenge.requestDigest,
    })

    const [writeUrl, writeInit] = fetchImpl.mock.calls[1]
    expect(writeUrl).toBe('/api/agent-index?action=receipt-write')
    const writeReq = JSON.parse(writeInit.body)
    // The literal top-level key the server dispatch reads is `mutation`, not `body`
    // (api/agent-index.js:270 `body: req.body?.mutation`) -- confirmed by reading the dispatch
    // source, not the task brief's own paraphrase of handleReceiptWrite's internal parameter name.
    expect(writeReq.mutation).toEqual(body)
    expect(writeReq.proof.challengeId).toBe(challenge.challengeId)
    expect(writeReq.proof.expiresAt).toBe(challenge.expiresAt)
  })

  it('computes a request digest matching the server’s own receiptRequestDigest, byte for byte', async () => {
    const fixtures = [
      mutationFixture(),
      mutationFixture({
        receipt: receiptFixture({
          intent: {
            kind: 'stellar-deposit',
            token: 'USDC',
            units: '1',
            decimals: 7,
            target: 'vault-1',
            note: 'unicode üñîçödé — em dash — done',
          },
        }),
      }),
      mutationFixture({
        expectedVersion: 5,
        attempt: {
          attemptId: 'attempt-2',
          kind: 'phase',
          phase: 'stellar_deposit',
          status: 'confirmed',
          evidence: { nested: { z: 1, a: [3, 2, 1], m: 2 } },
          observedAt: 42,
        },
      }),
    ]

    for (const body of fixtures) {
      const sessionKey = newSessionKey()
      const challenge = challengeFor(body)
      const fetchImpl = sequenceFetch([{ status: 201, body: { ok: true, challenge } }, writeSuccess])

      await postReceiptEvidence({
        activeAccount: body.receipt.owner,
        agentAddress: body.receipt.agent,
        sessionKey,
        body,
        fetchImpl,
      })

      const sent = JSON.parse(fetchImpl.mock.calls[0][1].body)
      expect(sent.requestDigest).toBe(receiptRequestDigest(body))
    }
  })

  it('signs exactly the server’s receiptProofMessage byte string, base64url-encoded', async () => {
    const body = mutationFixture()
    const sessionKey = newSessionKey()
    const challenge = challengeFor(body)
    const fetchImpl = sequenceFetch([{ status: 201, body: { ok: true, challenge } }, writeSuccess])

    await postReceiptEvidence({
      activeAccount: OWNER,
      agentAddress: AGENT,
      sessionKey,
      body,
      fetchImpl,
    })

    const writeReq = JSON.parse(fetchImpl.mock.calls[1][1].body)
    const sigBytes = Buffer.from(writeReq.proof.signature, 'base64url')
    expect(sigBytes.length).toBe(64)
    const expectedMessage = receiptProofMessage(challenge)
    expect(
      Keypair.fromPublicKey(sessionKey.publicKey).verify(Buffer.from(expectedMessage, 'utf8'), sigBytes)
    ).toBe(true)
  })

  it('never places sessionKey.secret anywhere in either request (body, URL, or headers)', async () => {
    const body = mutationFixture()
    const sessionKey = newSessionKey()
    const challenge = challengeFor(body)
    const fetchImpl = sequenceFetch([{ status: 201, body: { ok: true, challenge } }, writeSuccess])

    await postReceiptEvidence({
      activeAccount: OWNER,
      agentAddress: AGENT,
      sessionKey,
      body,
      fetchImpl,
    })

    expect(sessionKey.secret).toMatch(/^S[A-Z2-7]{55}$/) // sanity: there really is a secret to leak
    for (const [url, init] of fetchImpl.mock.calls) {
      const serialized = `${url} ${JSON.stringify(init.headers || {})} ${init.body || ''}`
      expect(serialized).not.toContain(sessionKey.secret)
      expect(serialized.toLowerCase()).not.toMatch(/secret|private|sessionkey/)
    }
  })

  it('always requests a fresh challenge before writing, using the challengeId the server returned', async () => {
    const body = mutationFixture()
    const sessionKey = newSessionKey()
    const challenge = challengeFor(body, { challengeId: 'server-issued-challenge-id' })
    const fetchImpl = sequenceFetch([{ status: 201, body: { ok: true, challenge } }, writeSuccess])

    await postReceiptEvidence({
      activeAccount: OWNER,
      agentAddress: AGENT,
      sessionKey,
      body,
      fetchImpl,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[0][0]).toContain('action=receipt-challenge')
    expect(fetchImpl.mock.calls[1][0]).toContain('action=receipt-write')
    const writeReq = JSON.parse(fetchImpl.mock.calls[1][1].body)
    expect(writeReq.proof.challengeId).toBe('server-issued-challenge-id')
  })

  it('does not report success when the write responds 200 without ok:true', async () => {
    const body = mutationFixture()
    const sessionKey = newSessionKey()
    const challenge = challengeFor(body)
    const fetchImpl = sequenceFetch([
      { status: 201, body: { ok: true, challenge } },
      { status: 200, body: { ok: false, error: 'partial failure without a matching HTTP status' } },
    ])

    await expect(
      postReceiptEvidence({ activeAccount: OWNER, agentAddress: AGENT, sessionKey, body, fetchImpl })
    ).rejects.toThrow(ReceiptEvidenceError)
  })

  it('distinguishes a version conflict, a consumed challenge, and a rejected signature by error code', async () => {
    const cases = [
      { status: 409, error: 'Receipt mutation conflict', expectedCode: 'version-conflict' },
      { status: 409, error: 'Receipt proof was already used', expectedCode: 'challenge-consumed' },
      { status: 401, error: 'Invalid or expired receipt proof', expectedCode: 'proof-rejected' },
    ]
    const seenCodes = []

    for (const [i, c] of cases.entries()) {
      const body = mutationFixture()
      const sessionKey = newSessionKey()
      const challenge = challengeFor(body, { challengeId: `challenge-distinct-${i}` })
      const fetchImpl = sequenceFetch([
        { status: 201, body: { ok: true, challenge } },
        { status: c.status, body: { error: c.error } },
      ])

      let caught = null
      try {
        await postReceiptEvidence({ activeAccount: OWNER, agentAddress: AGENT, sessionKey, body, fetchImpl })
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(ReceiptEvidenceError)
      expect(caught.status).toBe(c.status)
      expect(caught.code).toBe(c.expectedCode)
      seenCodes.push(caught.code)
    }

    expect(new Set(seenCodes).size).toBe(3) // three genuinely distinct outcomes, none collapsed
  })

  it('surfaces a challenge-step authority rejection distinctly from a write-step failure', async () => {
    const body = mutationFixture()
    const sessionKey = newSessionKey()
    const fetchImpl = sequenceFetch([
      { status: 403, body: { error: 'Agent authority could not be verified' } },
    ])

    let caught = null
    try {
      await postReceiptEvidence({ activeAccount: OWNER, agentAddress: AGENT, sessionKey, body, fetchImpl })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ReceiptEvidenceError)
    expect(caught.step).toBe('challenge')
    expect(caught.status).toBe(403)
    expect(caught.code).toBe('authority-mismatch')
    expect(fetchImpl).toHaveBeenCalledTimes(1) // never attempts the write after a failed challenge
  })

  it('surfaces a transport failure (fetch throws) as a distinct network-error code', async () => {
    const body = mutationFixture()
    const sessionKey = newSessionKey()
    const fetchImpl = sequenceFetch([{ networkError: true }])

    let caught = null
    try {
      await postReceiptEvidence({ activeAccount: OWNER, agentAddress: AGENT, sessionKey, body, fetchImpl })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ReceiptEvidenceError)
    expect(caught.code).toBe('network-error')
  })

  it('rejects up front when activeAccount does not match body.receipt.owner, before any network call', async () => {
    const body = mutationFixture()
    const sessionKey = newSessionKey()
    const fetchImpl = sequenceFetch([])

    await expect(
      postReceiptEvidence({
        activeAccount: 'GDIFFERENTOWNERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        agentAddress: AGENT,
        sessionKey,
        body,
        fetchImpl,
      })
    ).rejects.toThrow(ReceiptEvidenceError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
