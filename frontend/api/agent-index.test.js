import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Keypair, Networks } from '@stellar/stellar-sdk'

const mocked = vi.hoisted(() => ({
  store: null,
  readContract: vi.fn(),
}))

vi.mock('./agent-index/store.js', () => ({
  createAgentIndexStore: () => mocked.store,
}))
vi.mock('../src/stellar/client.js', async (importOriginal) => ({
  ...(await importOriginal()),
  readContract: mocked.readContract,
}))

import handler from './agent-index.js'
import { receiptProofMessage, receiptRequestDigest } from './agent-index/executionReceipts.js'
import { AgentIndexConflictError } from './agent-index/models.js'

const OWNER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 21)).publicKey()
const OTHER_OWNER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 22)).publicKey()
const SESSION = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 23))
const OTHER_SESSION = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 24))
const AGENT = 'CCEWWRQVYKEIWTO7GTX2QVHQASC3GIQOZZTDMGTOHFQYKZIX5KJ6CYE5'
const ROUTER = 'CBEI5VJKT2KZR6TU6NKHKJRIQORXTSTAH5RDUA7MBUNCPZDN6ZLQSYE4'
const NETWORK = 'stellar-testnet'

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[key] = value
    },
    end(body = '') {
      this.body = body
      return this
    },
  }
}

let ipOrdinal = 0
function env(overrides = {}) {
  return {
    VF_DB: { binding: 'test-d1' },
    SOROBAN_RPC_URL: 'https://rpc.example.test',
    SOROBAN_ROUTER_ADDRESS: ROUTER,
    STELLAR_NETWORK_ID: NETWORK,
    STELLAR_NETWORK_PASSPHRASE: Networks.TESTNET,
    AGENT_INDEX_REPORTER_SECRET: 'server-reporter-secret',
    ...overrides,
  }
}

function mockReq({ method = 'GET', url = '/api/agent-index', body, requestEnv = env(), ip } = {}) {
  return {
    method,
    url,
    body,
    env: requestEnv,
    headers: {
      'x-real-ip': ip ?? `198.51.100.${++ipOrdinal}`,
      authorization: 'Bearer server-reporter-secret',
    },
  }
}

function receiptMutation() {
  return {
    expectedVersion: 0,
    receipt: {
      version: 2,
      networkId: NETWORK,
      owner: OWNER,
      executionId: 'execution-route-1',
      runId: 'run-route-1',
      allocationId: 'allocation-route-1',
      parentAllocationId: null,
      childId: null,
      worker: 'worker-route-1',
      agent: AGENT,
      intent: { kind: 'stellar-deposit', token: 'USDC', units: '1000000', decimals: 7 },
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
        amount: { token: 'USDC', units: '1000000', decimals: 7 },
        reason: null,
      },
    },
    attempt: {
      attemptId: 'attempt-route-1',
      kind: 'phase',
      phase: 'pull',
      status: 'submitted',
      evidence: { txHash: 'tx-route-1' },
      observedAt: 2_000_000_000_000,
    },
  }
}

function childIntent(childId = 'child-route-1') {
  return {
    version: 1,
    networkId: NETWORK,
    owner: OWNER,
    agent: AGENT,
    bindingId: 'binding-route-1',
    allocationId: 'allocation-route-1',
    childId,
    intent: { token: 'USDC', units: '1000000', decimals: 6, pool: 'pool-route-1' },
    lifecycle: {
      sequence: 0,
      status: 'planned',
      evidence: { reviewed: true },
      observedAt: 2_000_000_000_000,
    },
  }
}

function fakeStore(overrides = {}) {
  const challenges = new Map()
  return {
    issueReceiptChallenge: vi.fn(async (challenge) =>
      challenges.set(challenge.challengeId, challenge)
    ),
    readReceiptChallenge: vi.fn(async ({ challengeId }) => challenges.get(challengeId) ?? null),
    commitAuthenticatedReceiptMutation: vi.fn(async ({ challenge, now }) => {
      challenges.set(challenge.challengeId, { ...challenge, consumedAt: now })
      return { written: 1, duplicates: 0, version: 1 }
    }),
    readExecutionReceipt: vi.fn(async (identity) => ({ ...identity, version: 1, attempts: [] })),
    acquireRecoveryLease: vi.fn(async () => ({
      acquired: true,
      leaseToken: 'lease-route-1',
      expiresAt: 2_000_000_060_000,
    })),
    releaseRecoveryLease: vi.fn(async () => ({ released: true })),
    createBaseChildIntent: vi.fn(async () => ({ written: 1, duplicates: 0, sequence: 0 })),
    advanceBaseChildLifecycle: vi.fn(async () => ({ written: 1, duplicates: 0, sequence: 1 })),
    ...overrides,
  }
}

function authorityReads(passes) {
  let pass = -1
  mocked.readContract.mockImplementation(async ({ contract, method }) => {
    if (contract === ROUTER && method === 'owner_of') {
      pass += 1
      return passes[pass].routerOwner
    }
    if (contract === AGENT && method === 'scope_of') return passes[pass].scope
    if (contract === AGENT && method === 'signer') return passes[pass].signer
    throw new Error('unexpected authority read')
  })
}

async function call(request) {
  const res = mockRes()
  await handler(request, res)
  return { res, body: JSON.parse(res.body) }
}

beforeEach(() => {
  mocked.store = fakeStore()
  mocked.readContract.mockReset()
  authorityReads([
    { routerOwner: OWNER, scope: { owner: OWNER, revoked: false }, signer: SESSION.rawPublicKey() },
  ])
})

describe('/api/agent-index authenticated execution routes', () => {
  it('issues a reachable challenge without returning server configuration or secrets', async () => {
    const requestDigest = 'ab'.repeat(32)
    const { res, body } = await call(
      mockReq({
        method: 'POST',
        url: '/api/agent-index?action=receipt-challenge',
        body: { networkId: NETWORK, owner: OWNER, agent: AGENT, requestDigest },
      })
    )
    expect(res.statusCode).toBe(201)
    expect(body).toMatchObject({
      ok: true,
      challenge: { networkId: NETWORK, owner: OWNER, agent: AGENT, requestDigest },
    })
    expect(JSON.stringify(body)).not.toMatch(/router|passphrase|reporter|secret/i)
  })

  it('rejects a write when router ownership changes after challenge issuance', async () => {
    authorityReads([
      {
        routerOwner: OWNER,
        scope: { owner: OWNER, revoked: false },
        signer: SESSION.rawPublicKey(),
      },
      {
        routerOwner: OTHER_OWNER,
        scope: { owner: OWNER, revoked: false },
        signer: SESSION.rawPublicKey(),
      },
    ])
    const mutation = receiptMutation()
    const challengeResponse = await call(
      mockReq({
        method: 'POST',
        url: '/api/agent-index?action=receipt-challenge',
        body: {
          networkId: NETWORK,
          owner: OWNER,
          agent: AGENT,
          requestDigest: receiptRequestDigest(mutation),
        },
      })
    )
    expect(challengeResponse.res.statusCode).toBe(201)
    const challenge = challengeResponse.body.challenge
    const proof = {
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt,
      signature: SESSION.sign(Buffer.from(receiptProofMessage(challenge))).toString('base64url'),
    }
    const { res, body } = await call(
      mockReq({
        method: 'POST',
        url: '/api/agent-index?action=receipt-write',
        body: { mutation, proof },
      })
    )
    expect(res.statusCode).toBe(403)
    expect(body).toEqual({ error: 'Agent authority could not be verified' })
    expect(mocked.store.commitAuthenticatedReceiptMutation).not.toHaveBeenCalled()
    expect(
      mocked.readContract.mock.calls.filter(([arg]) => arg.method === 'owner_of')
    ).toHaveLength(2)
    expect(
      mocked.readContract.mock.calls.filter(([arg]) => arg.method === 'scope_of')
    ).toHaveLength(2)
    expect(mocked.readContract.mock.calls.filter(([arg]) => arg.method === 'signer')).toHaveLength(
      2
    )
  })

  it('rejects a write when scope ownership changes after challenge issuance', async () => {
    authorityReads([
      {
        routerOwner: OWNER,
        scope: { owner: OWNER, revoked: false },
        signer: SESSION.rawPublicKey(),
      },
      {
        routerOwner: OWNER,
        scope: { owner: OTHER_OWNER, revoked: false },
        signer: SESSION.rawPublicKey(),
      },
    ])
    const mutation = receiptMutation()
    const challengeResponse = await call(
      mockReq({
        method: 'POST',
        url: '/api/agent-index?action=receipt-challenge',
        body: {
          networkId: NETWORK,
          owner: OWNER,
          agent: AGENT,
          requestDigest: receiptRequestDigest(mutation),
        },
      })
    )
    expect(challengeResponse.res.statusCode).toBe(201)
    const challenge = challengeResponse.body.challenge
    const proof = {
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt,
      signature: SESSION.sign(Buffer.from(receiptProofMessage(challenge))).toString('base64url'),
    }
    const { res, body } = await call(
      mockReq({
        method: 'POST',
        url: '/api/agent-index?action=receipt-write',
        body: { mutation, proof },
      })
    )
    expect(res.statusCode).toBe(403)
    expect(body).toEqual({ error: 'Agent authority could not be verified' })
    expect(mocked.store.commitAuthenticatedReceiptMutation).not.toHaveBeenCalled()
    expect(
      mocked.readContract.mock.calls.filter(([arg]) => arg.method === 'owner_of')
    ).toHaveLength(2)
    expect(
      mocked.readContract.mock.calls.filter(([arg]) => arg.method === 'scope_of')
    ).toHaveLength(2)
    expect(mocked.readContract.mock.calls.filter(([arg]) => arg.method === 'signer')).toHaveLength(
      2
    )
  })

  it('rejects a write when the agent signer changes after challenge issuance', async () => {
    authorityReads([
      {
        routerOwner: OWNER,
        scope: { owner: OWNER, revoked: false },
        signer: SESSION.rawPublicKey(),
      },
      {
        routerOwner: OWNER,
        scope: { owner: OWNER, revoked: false },
        signer: OTHER_SESSION.rawPublicKey(),
      },
    ])
    const mutation = receiptMutation()
    const challengeResponse = await call(
      mockReq({
        method: 'POST',
        url: '/api/agent-index?action=receipt-challenge',
        body: {
          networkId: NETWORK,
          owner: OWNER,
          agent: AGENT,
          requestDigest: receiptRequestDigest(mutation),
        },
      })
    )
    expect(challengeResponse.res.statusCode).toBe(201)
    const challenge = challengeResponse.body.challenge
    const proof = {
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt,
      signature: SESSION.sign(Buffer.from(receiptProofMessage(challenge))).toString('base64url'),
    }
    const { res, body } = await call(
      mockReq({
        method: 'POST',
        url: '/api/agent-index?action=receipt-write',
        body: { mutation, proof },
      })
    )
    expect(res.statusCode).toBe(401)
    expect(body).toEqual({ error: 'Invalid or expired receipt proof' })
    expect(mocked.store.commitAuthenticatedReceiptMutation).not.toHaveBeenCalled()
    expect(
      mocked.readContract.mock.calls.filter(([arg]) => arg.method === 'owner_of')
    ).toHaveLength(2)
    expect(
      mocked.readContract.mock.calls.filter(([arg]) => arg.method === 'scope_of')
    ).toHaveLength(2)
    expect(mocked.readContract.mock.calls.filter(([arg]) => arg.method === 'signer')).toHaveLength(
      2
    )
  })

  it('reads one receipt through an exact network/owner-scoped route', async () => {
    const { res, body } = await call(
      mockReq({
        url:
          '/api/agent-index?action=receipt&network=stellar-testnet&owner=' +
          `${OWNER}&execution=execution-route-1&allocation=allocation-route-1`,
      })
    )
    expect(res.statusCode).toBe(200)
    expect(body.receipt).toMatchObject({ owner: OWNER, networkId: NETWORK })
    expect(mocked.store.readExecutionReceipt).toHaveBeenCalledWith({
      networkId: NETWORK,
      owner: OWNER,
      executionId: 'execution-route-1',
      allocationId: 'allocation-route-1',
    })
  })

  it('rejects a requested network that disagrees with the configured passphrase/id', async () => {
    const { res } = await call(
      mockReq({
        method: 'POST',
        url: '/api/agent-index?action=receipt-challenge',
        body: {
          networkId: 'stellar-mainnet',
          owner: OWNER,
          agent: AGENT,
          requestDigest: 'cd'.repeat(32),
        },
      })
    )
    expect(res.statusCode).toBe(400)
    expect(mocked.readContract).not.toHaveBeenCalled()
  })

  it('fails closed when the configured network id and passphrase disagree', async () => {
    const out = await call(
      mockReq({
        method: 'POST',
        url: '/api/agent-index?action=receipt-challenge',
        body: {
          networkId: NETWORK,
          owner: OWNER,
          agent: AGENT,
          requestDigest: '34'.repeat(32),
        },
        requestEnv: env({ STELLAR_NETWORK_ID: 'stellar-mainnet' }),
      })
    )
    expect(out.res.statusCode).toBe(503)
    expect(out.body).toEqual({ error: 'Receipt authority is not configured' })
    expect(mocked.readContract).not.toHaveBeenCalled()
  })

  it('returns 503 when D1 or authority configuration is missing', async () => {
    const noDb = await call(
      mockReq({
        url: `/api/agent-index?action=receipt&network=${NETWORK}&owner=${OWNER}&execution=e&allocation=a`,
        requestEnv: env({ VF_DB: null }),
      })
    )
    expect(noDb.res.statusCode).toBe(503)

    const noRouter = await call(
      mockReq({
        method: 'POST',
        url: '/api/agent-index?action=receipt-challenge',
        body: { networkId: NETWORK, owner: OWNER, agent: AGENT, requestDigest: 'ef'.repeat(32) },
        requestEnv: env({ SOROBAN_ROUTER_ADDRESS: '' }),
      })
    )
    expect(noRouter.res.statusCode).toBe(503)
    expect(noRouter.body).toEqual({ error: 'Receipt authority is not configured' })
  })

  it('maps a missing receipt-write authority dependency to a non-disclosing 503', async () => {
    const noWriteAuthority = await call(
      mockReq({
        method: 'POST',
        url: '/api/agent-index?action=receipt-write',
        body: {
          mutation: { secret: 'private-route-mutation' },
          proof: { signature: 'private-route-proof' },
        },
        requestEnv: env({ SOROBAN_ROUTER_ADDRESS: '' }),
      })
    )
    expect(noWriteAuthority.res.statusCode).toBe(503)
    expect(noWriteAuthority.body).toEqual({ error: 'Agent-index dependency unavailable' })
    expect(JSON.stringify(noWriteAuthority.body)).not.toMatch(/private|route|proof|signature/i)
  })

  it('maps an invalid secret-bearing receipt body to a non-disclosing 400', async () => {
    const { res, body } = await call(
      mockReq({
        method: 'POST',
        url: '/api/agent-index?action=receipt-write',
        body: { mutation: { secret: 'browser-session-secret' }, proof: {} },
      })
    )
    expect(res.statusCode).toBe(400)
    expect(body).toEqual({ error: 'Invalid receipt mutation' })
    expect(JSON.stringify(body)).not.toMatch(/browser|session|secret/i)
  })

  it('maps a replayed proof to 409 without performing a third authority read', async () => {
    const facts = {
      routerOwner: OWNER,
      scope: { owner: OWNER, revoked: false },
      signer: SESSION.rawPublicKey(),
    }
    authorityReads([facts, facts])
    const mutation = receiptMutation()
    const challengeOut = await call(
      mockReq({
        method: 'POST',
        url: '/api/agent-index?action=receipt-challenge',
        body: {
          networkId: NETWORK,
          owner: OWNER,
          agent: AGENT,
          requestDigest: receiptRequestDigest(mutation),
        },
      })
    )
    const challenge = challengeOut.body.challenge
    const proof = {
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt,
      signature: SESSION.sign(Buffer.from(receiptProofMessage(challenge))).toString('base64url'),
    }
    const request = () =>
      mockReq({
        method: 'POST',
        url: '/api/agent-index?action=receipt-write',
        body: { mutation, proof },
      })
    expect((await call(request())).res.statusCode).toBe(200)
    const replay = await call(request())
    expect(replay.res.statusCode).toBe(409)
    expect(replay.body).toEqual({ error: 'Receipt proof was already used' })
    expect(
      mocked.readContract.mock.calls.filter(([arg]) => arg.method === 'owner_of')
    ).toHaveLength(2)
  })

  it('maps a known receipt CAS conflict to a non-disclosing 409', async () => {
    mocked.store = fakeStore({
      commitAuthenticatedReceiptMutation: vi.fn(async () => {
        throw new AgentIndexConflictError('immutable intent contains database-secret')
      }),
    })
    const facts = {
      routerOwner: OWNER,
      scope: { owner: OWNER, revoked: false },
      signer: SESSION.rawPublicKey(),
    }
    authorityReads([facts, facts])
    const mutation = receiptMutation()
    const challengeOut = await call(
      mockReq({
        method: 'POST',
        url: '/api/agent-index?action=receipt-challenge',
        body: {
          networkId: NETWORK,
          owner: OWNER,
          agent: AGENT,
          requestDigest: receiptRequestDigest(mutation),
        },
      })
    )
    const challenge = challengeOut.body.challenge
    const proof = {
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt,
      signature: SESSION.sign(Buffer.from(receiptProofMessage(challenge))).toString('base64url'),
    }
    const conflict = await call(
      mockReq({
        method: 'POST',
        url: '/api/agent-index?action=receipt-write',
        body: { mutation, proof },
      })
    )
    expect(conflict.res.statusCode).toBe(409)
    expect(conflict.body).toEqual({ error: 'Receipt mutation conflict' })
    expect(JSON.stringify(conflict.body)).not.toMatch(/database|immutable|secret/i)
  })

  it('rate limits challenge issuance before invoking D1 or RPC dependencies', async () => {
    const ip = '203.0.113.240'
    let response
    for (let attempt = 0; attempt < 21; attempt += 1) {
      response = await call(
        mockReq({
          method: 'POST',
          url: '/api/agent-index?action=receipt-challenge',
          body: { networkId: NETWORK, owner: OWNER, agent: AGENT, requestDigest: '12'.repeat(32) },
          requestEnv: env({ VF_DB: null }),
          ip,
        })
      )
    }
    expect(response.res.statusCode).toBe(429)
    expect(response.body).toEqual({ error: 'Too many requests' })
    expect(mocked.readContract).not.toHaveBeenCalled()
  })
})

describe('/api/agent-index operational evidence routes', () => {
  it.each([
    [
      'lease acquire',
      'lease-acquire',
      {
        networkId: NETWORK,
        owner: OWNER,
        executionId: 'execution-route-1',
        allocationId: 'allocation-route-1',
        childId: 'child-route-1',
        phase: 'cctp_mint',
        holder: 'worker-route-1',
        leaseToken: 'lease-route-1',
        now: 2_000_000_000_000,
      },
      200,
    ],
    [
      'lease release',
      'lease-release',
      {
        networkId: NETWORK,
        executionId: 'execution-route-1',
        allocationId: 'allocation-route-1',
        childId: 'child-route-1',
        phase: 'cctp_mint',
        leaseToken: 'lease-route-1',
      },
      200,
    ],
    ['Base child commit', 'base-child-intent', { child: childIntent() }, 201],
    [
      'Base child lifecycle advance',
      'base-child-lifecycle',
      {
        identity: {
          networkId: NETWORK,
          owner: OWNER,
          bindingId: 'binding-route-1',
          allocationId: 'allocation-route-1',
          childId: 'child-route-1',
        },
        expectedSequence: 0,
        lifecycle: {
          sequence: 1,
          status: 'submitted',
          evidence: { userOpHash: '0xroute' },
          observedAt: 2_000_000_000_001,
        },
      },
      200,
    ],
  ])(
    'makes the %s route reachable behind reporter authentication',
    async (_label, action, body, status) => {
      const out = await call(
        mockReq({ method: 'POST', url: `/api/agent-index?action=${action}`, body })
      )
      expect(out.res.statusCode).toBe(status)
      expect(out.body.ok).toBe(true)
      expect(JSON.stringify(out.body)).not.toMatch(/server-reporter-secret/)
    }
  )

  it.each([
    ['lease-acquire', { networkId: NETWORK }],
    [
      'base-child-intent',
      {
        child: {
          ...childIntent(),
          lifecycle: { sequence: 0, evidence: {}, observedAt: 2_000_000_000_000 },
        },
      },
    ],
    [
      'base-child-lifecycle',
      {
        identity: {
          networkId: NETWORK,
          owner: OWNER,
          bindingId: 'binding-route-1',
          allocationId: 'allocation-route-1',
          childId: 'child-route-1',
        },
        expectedSequence: 0,
        lifecycle: {
          sequence: 2,
          status: 'submitted',
          evidence: {},
          observedAt: 2_000_000_000_001,
        },
      },
    ],
  ])('maps an invalid %s body to a non-disclosing 400', async (action, body) => {
    const out = await call(
      mockReq({ method: 'POST', url: `/api/agent-index?action=${action}`, body })
    )
    expect(out.res.statusCode).toBe(400)
    expect(out.body).toEqual({ error: 'Invalid agent-index request' })
  })

  it('maps an unexpected store bug to a non-disclosing 500', async () => {
    mocked.store = fakeStore({
      readExecutionReceipt: vi.fn(async () => {
        throw new Error('sqlite internal password=database-secret')
      }),
    })
    const { res, body } = await call(
      mockReq({
        url: `/api/agent-index?action=receipt&network=${NETWORK}&owner=${OWNER}&execution=e&allocation=a`,
      })
    )
    expect(res.statusCode).toBe(500)
    expect(body).toEqual({ error: 'Internal agent-index error' })
    expect(JSON.stringify(body)).not.toMatch(/sqlite|password|secret/i)
  })
})
