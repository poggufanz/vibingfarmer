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
// Imported only to DERIVE the real server-reported replay message for the pin below (fix round 1,
// finding 2) -- never to compute a test's expectation with the code under test. handleReceiptWrite
// is driven end to end with a stubbed store/authorityReader so the string this test compares
// against is what the server actually says today, not a literal typed independently on both sides.
import { handleReceiptWrite } from '../../api/agent-index/handler.js'

const NETWORK = 'stellar-testnet'
const OWNER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey()
const AGENT = 'CAUSSKJJFEUSSKJJFEUSSKJJFEUSSKJJFEUSSKJJFEUSSKJJFEUSS3Y4'

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

/** Drives the REAL server-side handleReceiptWrite (handler.js:145) into its replay path -- a
 * store whose readReceiptChallenge resolves an already-consumed challenge -- and returns the
 * exact `body.error` string the server reports for that outcome today. Used to pin
 * classifyFailure's 'challenge-consumed' discriminator against genuine server output instead of a
 * literal typed independently in both the client and this test (fix round 1, finding 2). */
async function deriveConsumedChallengeErrorMessage() {
  const body = mutationFixture()
  const consumedChallenge = {
    networkId: body.receipt.networkId,
    owner: body.receipt.owner,
    agent: body.receipt.agent,
    challengeId: 'already-consumed-challenge',
    expiresAt: Date.now() + 300_000,
    requestDigest: receiptRequestDigest(body),
    consumedAt: Date.now() - 1_000, // non-null -> the server's replay branch, not expiry/proof
  }
  const store = {
    readReceiptChallenge: async () => consumedChallenge,
    commitAuthenticatedReceiptMutation: async () => {
      throw new Error('must not be called: the challenge is already consumed')
    },
  }
  const authorityReader = async () => {
    throw new Error('must not be called: the replay check happens before any authority read')
  }
  const result = await handleReceiptWrite({
    body,
    proof: {
      challengeId: consumedChallenge.challengeId,
      expiresAt: consumedChallenge.expiresAt,
      signature: 'irrelevant-not-reached-before-the-replay-check',
    },
    store,
    authorityReader,
  })
  if (result.status !== 409 || typeof result.body?.error !== 'string') {
    throw new Error(
      `expected the real server to report a 409 replay, got ${JSON.stringify(result)}`
    )
  }
  return result.body.error
}

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

  it.each([
    ['lease expiry', () => new Error('Recovery lease expired before receipt write')],
    ['account switch', () => new Error('Active account changed before receipt write')],
  ])(
    'runs the optional beforeWrite guard after a delayed challenge and sends no receipt-write on %s',
    async (_label, guardError) => {
      const body = mutationFixture()
      const challenge = challengeFor(body)
      let releaseChallenge
      const challengeResponse = new Promise((resolve) => {
        releaseChallenge = () =>
          resolve({
            ok: true,
            status: 201,
            json: async () => ({ ok: true, challenge }),
          })
      })
      const fetchImpl = vi.fn(async (url) => {
        if (url.includes('receipt-challenge')) return challengeResponse
        throw new Error('receipt-write must not be requested after the guard fails')
      })
      let guardMayPass = true
      const beforeWrite = vi.fn(() => {
        if (!guardMayPass) throw guardError()
      })

      const request = postReceiptEvidence({
        activeAccount: OWNER,
        agentAddress: AGENT,
        sessionKey: newSessionKey(),
        body,
        fetchImpl,
        beforeWrite,
      })
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce())
      guardMayPass = false
      releaseChallenge()

      await expect(request).rejects.toThrow(guardError().message)
      expect(beforeWrite).toHaveBeenCalledOnce()
      expect(fetchImpl).toHaveBeenCalledOnce()
      expect(fetchImpl.mock.calls[0][0]).toContain('receipt-challenge')
    }
  )

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
      const fetchImpl = sequenceFetch([
        { status: 201, body: { ok: true, challenge } },
        writeSuccess,
      ])

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
      Keypair.fromPublicKey(sessionKey.publicKey).verify(
        Buffer.from(expectedMessage, 'utf8'),
        sigBytes
      )
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
      postReceiptEvidence({
        activeAccount: OWNER,
        agentAddress: AGENT,
        sessionKey,
        body,
        fetchImpl,
      })
    ).rejects.toThrow(ReceiptEvidenceError)
  })

  it('distinguishes a version conflict, a consumed challenge, and a rejected signature by error code', async () => {
    // The 'challenge-consumed' fixture is the server's OWN reported string (derived by actually
    // driving handleReceiptWrite into its replay path above), not a literal re-typed here -- if
    // the server's wording ever drifts, this fixture drifts with it and classifyFailure's
    // hardcoded comparison (agentIndexReceiptClient.js) would show up as a real mismatch instead
    // of two independently-typed literals staying in silent agreement with each other.
    const replayErrorText = await deriveConsumedChallengeErrorMessage()
    const cases = [
      { status: 409, error: 'Receipt mutation conflict', expectedCode: 'version-conflict' },
      { status: 409, error: replayErrorText, expectedCode: 'challenge-consumed' },
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
        await postReceiptEvidence({
          activeAccount: OWNER,
          agentAddress: AGENT,
          sessionKey,
          body,
          fetchImpl,
        })
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
      await postReceiptEvidence({
        activeAccount: OWNER,
        agentAddress: AGENT,
        sessionKey,
        body,
        fetchImpl,
      })
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
      await postReceiptEvidence({
        activeAccount: OWNER,
        agentAddress: AGENT,
        sessionKey,
        body,
        fetchImpl,
      })
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

  it('rejects a body carrying a nested secret/private/session-key-named field before ever calling fetch', async () => {
    // fix round 1, finding 1: the digest step must not merely produce the same bytes as the
    // server's canonicalJson for VALID input -- it must independently refuse to serialize and
    // transmit a body a caller mistakenly populated with key material, exactly like the server's
    // assertNoSensitiveProperties would, but BEFORE any network call, not only after a 400.
    const sessionKey = newSessionKey()
    const cases = [
      mutationFixture({
        attempt: {
          attemptId: 'attempt-pull-1',
          kind: 'phase',
          phase: 'pull',
          status: 'submitted',
          evidence: {
            txHash: 'stellar-tx-1',
            cachedAgent: { signerPub: 'G...', secret: 'S...LEAK' },
          },
          observedAt: 1_700_000_000_000,
        },
      }),
      mutationFixture({
        receipt: receiptFixture({
          custody: {
            location: 'stellar-agent',
            confirmed: true,
            amount: null,
            reason: null,
            sessionKeyBackup: 'S...LEAK',
          },
        }),
      }),
    ]

    for (const body of cases) {
      const fetchImpl = sequenceFetch([])
      await expect(
        postReceiptEvidence({
          activeAccount: OWNER,
          agentAddress: AGENT,
          sessionKey,
          body,
          fetchImpl,
        })
      ).rejects.toThrow(ReceiptEvidenceError)
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  })

  it('rejects circular body data with a clear error rather than a bare RangeError', async () => {
    const body = mutationFixture()
    body.attempt.evidence.circular = body.attempt.evidence // self-reference
    const sessionKey = newSessionKey()
    const fetchImpl = sequenceFetch([])

    let caught = null
    try {
      await postReceiptEvidence({
        activeAccount: OWNER,
        agentAddress: AGENT,
        sessionKey,
        body,
        fetchImpl,
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ReceiptEvidenceError)
    expect(caught).not.toBeInstanceOf(RangeError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('signs using its own request digest (not a tampered echo) when a challenge response disagrees, and fails closed', async () => {
    const body = mutationFixture()
    const sessionKey = newSessionKey()
    const correctDigest = receiptRequestDigest(body)
    // A tampered/buggy challenge response: its requestDigest field disagrees with what this
    // client actually sent and stored locally. The real server can never actually produce this
    // (issueReceiptChallenge stores and returns the identical object -- executionReceipts.js:
    // 134-144 -- so the two cannot diverge server-side); this simulates a compromised transport
    // between client and server to confirm the client is not fooled into signing over a digest
    // it never itself computed.
    const challenge = challengeFor(body, { requestDigest: 'f'.repeat(64) })
    // What the real server does if its own stored challenge ever disagreed with a freshly
    // recomputed digest: reject at the write step (executionReceipts.js:240-248, 'proof' -> 401).
    const fetchImpl = sequenceFetch([
      { status: 201, body: { ok: true, challenge } },
      { status: 401, body: { error: 'Invalid or expired receipt proof' } },
    ])

    let caught = null
    try {
      await postReceiptEvidence({
        activeAccount: OWNER,
        agentAddress: AGENT,
        sessionKey,
        body,
        fetchImpl,
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ReceiptEvidenceError)
    expect(caught.code).toBe('proof-rejected')

    const writeReq = JSON.parse(fetchImpl.mock.calls[1][1].body)
    const sigBytes = Buffer.from(writeReq.proof.signature, 'base64url')
    // Signs over its OWN digest, not the tampered echo.
    const messageOverOwnDigest = receiptProofMessage({ ...challenge, requestDigest: correctDigest })
    expect(
      Keypair.fromPublicKey(sessionKey.publicKey).verify(
        Buffer.from(messageOverOwnDigest, 'utf8'),
        sigBytes
      )
    ).toBe(true)
    // And does NOT verify against a message built from the tampered echo.
    const messageOverTamperedDigest = receiptProofMessage(challenge)
    expect(
      Keypair.fromPublicKey(sessionKey.publicKey).verify(
        Buffer.from(messageOverTamperedDigest, 'utf8'),
        sigBytes
      )
    ).toBe(false)
  })
})
