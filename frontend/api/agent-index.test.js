import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Keypair, Networks, StrKey, rpc } from '@stellar/stellar-sdk'

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
const AGENT = 'CAUSSKJJFEUSSKJJFEUSSKJJFEUSSKJJFEUSSKJJFEUSSKJJFEUSS3Y4'
const ROUTER = 'CBEI5VJKT2KZR6TU6NKHKJRIQORXTSTAH5RDUA7MBUNCPZDN6ZLQSYE4'
const ROUTER_V2 = 'CB675TTSFM6COTGHGB7K2I7IODPQ3HTHOTTTXU2LJHXXNGTS45NOTRSE'
const ROUTER_V1 = 'CCEWWRQVYKEIWTO7GTX2QVHQASC3GIQOZZTDMGTOHFQYKZIX5KJ6CYE5'
const OTHER_AGENT = 'CAVCUKRKFIVCUKRKFIVCUKRKFIVCUKRKFIVCUKRKFIVCUKRKFIVCVLQ3'
const TRACKED_LIVE_CONTRACTS = new Set([
  'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC',
  ROUTER,
  ROUTER_V2,
  ROUTER_V1,
])
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
    // Keep this fixture isolated from vite.config.js loading a developer's `.env.local` plural
    // router list into process.env. Individual plural-router tests override it explicitly.
    SOROBAN_ROUTER_ADDRESSES: '',
    SOROBAN_ROUTER_ADDRESS: ROUTER,
    STELLAR_NETWORK_ID: NETWORK,
    STELLAR_NETWORK_PASSPHRASE: Networks.TESTNET,
    AGENT_INDEX_REPORTER_SECRET: 'server-reporter-secret',
    AGENT_INDEX_CURSOR_SECRET: 'adapter-owner-cursor-secret-with-at-least-32-bytes',
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

function childBatch() {
  const poolAddress = '0x389250872044368759d3db5c09b2706a6628d4e0'
  const kernelAddress = `0x${'22'.repeat(20)}`
  const children = [1, 2].map((ordinal) => ({
    version: 1,
    networkId: NETWORK,
    owner: OWNER,
    agent: AGENT,
    bindingId: 'binding-route-batch',
    executionId: `run-route-1:exec:allocation-route-${ordinal}`,
    allocationId: `allocation-route-${ordinal}`,
    childId: 'job-route-batch',
    intent: {
      token: 'USDC',
      units: '1000000',
      decimals: 6,
      poolAddress,
      proxyTarget: 'aave-v3',
      minShares: '0',
      runId: 'run-route-1',
      grantTxHash: 'grant-route-1',
      kernelAddress,
      bindingHash: 'binding-hash-route-batch',
      baseJobId: 'job-route-batch',
    },
    lifecycle: { sequence: 0, status: 'planned', evidence: {}, observedAt: 2_000_000_000_000 },
  }))
  return { idempotencyKey: 'route-batch-key-1', burnUnits7: '20000000', children }
}

function fakeStore(overrides = {}) {
  const challenges = new Map()
  return {
    issueReceiptChallenge: vi.fn(async (challenge) =>
      challenges.set(challenge.challengeId, challenge)
    ),
    readReceiptChallenge: vi.fn(async ({ challengeId }) => challenges.get(challengeId) ?? null),
    consumeReceiptChallenge: vi.fn(async () => true),
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
    probeReadiness: vi.fn(async () => ({
      writable: true,
      schemaVersion: 1,
      stores: { executionReceipts: true, baseChildIntents: true, baseRecoveryEvidence: true },
    })),
    createBaseChildIntent: vi.fn(async () => ({ written: 1, duplicates: 0, sequence: 0 })),
    advanceBaseChildLifecycle: vi.fn(async () => ({ written: 1, duplicates: 0, sequence: 1 })),
    readMembershipsByAgentAddresses: vi.fn(async () => [
      {
        networkId: NETWORK,
        address: AGENT,
        owner: OWNER,
        creator: ROUTER_V2,
        schemaVersion: 1,
        kind: 'bridge',
        grantTxHash: 'grant-route-1',
        runId: 'run-route-1',
        provenance: { source: 'router-event', generation: 'agent-v3-bridge' },
      },
    ]),
    reserveBaseChildIntentBatch: vi.fn(async ({ batch }) => ({
      written: batch.children.length,
      duplicates: 0,
    })),
    advanceBaseChildPhase: vi.fn(async () => ({
      written: 1,
      duplicates: 0,
      recoveryVersion: 1,
    })),
    readPublicBaseChildEvidence: vi.fn(async (identity) => ({
      identity,
      recoverable: true,
      recoveryVersion: 1,
      phases: [],
      events: [],
    })),
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

function authorityCalls() {
  return mocked.readContract.mock.calls.map(([{ contract, method }]) => [contract, method])
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
  it('uses distinct generated agent contracts outside tracked live and router fixtures', () => {
    const agents = [AGENT, OTHER_AGENT]
    expect(agents.every((agent) => StrKey.isValidContract(agent))).toBe(true)
    expect(new Set(agents).size).toBe(2)
    expect(agents.filter((agent) => TRACKED_LIVE_CONTRACTS.has(agent))).toEqual([])
    expect(agents.filter((agent) => [ROUTER, ROUTER_V2, ROUTER_V1].includes(agent))).toEqual([])
  })

  it('issues a reachable challenge with singular router compatibility without disclosing configuration', async () => {
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
    expect(authorityCalls()).toEqual([
      [ROUTER, 'owner_of'],
      [AGENT, 'scope_of'],
      [AGENT, 'signer'],
    ])
  })

  it('authorizes a V2-created agent from the production-ordered router list without querying V1', async () => {
    mocked.readContract.mockImplementation(async ({ contract, method }) => {
      if (contract === ROUTER_V2 && method === 'owner_of') return OWNER
      if (contract === ROUTER_V1 && method === 'owner_of') return null
      if (contract === AGENT && method === 'scope_of') return { owner: OWNER, revoked: false }
      if (contract === AGENT && method === 'signer') return SESSION.rawPublicKey()
      throw new Error('unexpected authority read')
    })
    const { res } = await call(
      mockReq({
        method: 'POST',
        url: '/api/agent-index?action=receipt-challenge',
        body: { networkId: NETWORK, owner: OWNER, agent: AGENT, requestDigest: '56'.repeat(32) },
        requestEnv: env({
          SOROBAN_ROUTER_ADDRESSES: `${ROUTER_V2},${ROUTER_V1}`,
          SOROBAN_ROUTER_ADDRESS: ROUTER_V1,
        }),
      })
    )
    expect(res.statusCode).toBe(201)
    expect(authorityCalls()).toEqual([
      [ROUTER_V2, 'owner_of'],
      [AGENT, 'scope_of'],
      [AGENT, 'signer'],
    ])
  })

  it('trims and deduplicates routers before falling back from V2 undefined lineage to V1', async () => {
    mocked.readContract.mockImplementation(async ({ contract, method }) => {
      if (contract === ROUTER_V2 && method === 'owner_of') return undefined
      if (contract === ROUTER_V1 && method === 'owner_of') return OWNER
      if (contract === AGENT && method === 'scope_of') return { owner: OWNER, revoked: false }
      if (contract === AGENT && method === 'signer') return SESSION.rawPublicKey()
      throw new Error('unexpected authority read')
    })
    const { res } = await call(
      mockReq({
        method: 'POST',
        url: '/api/agent-index?action=receipt-challenge',
        body: { networkId: NETWORK, owner: OWNER, agent: AGENT, requestDigest: '57'.repeat(32) },
        requestEnv: env({
          SOROBAN_ROUTER_ADDRESSES: ` ${ROUTER_V2}, ${ROUTER_V2} , ${ROUTER_V1} `,
          SOROBAN_ROUTER_ADDRESS: ROUTER,
        }),
      })
    )
    expect(res.statusCode).toBe(201)
    expect(authorityCalls()).toEqual([
      [ROUTER_V2, 'owner_of'],
      [ROUTER_V1, 'owner_of'],
      [AGENT, 'scope_of'],
      [AGENT, 'signer'],
    ])
  })

  it('returns 403 for unknown lineage without reading agent scope or signer', async () => {
    mocked.readContract.mockImplementation(async ({ contract, method }) => {
      if ([ROUTER_V2, ROUTER_V1].includes(contract) && method === 'owner_of') return null
      throw new Error('agent authority must not be read without router lineage')
    })
    const { res, body } = await call(
      mockReq({
        method: 'POST',
        url: '/api/agent-index?action=receipt-challenge',
        body: { networkId: NETWORK, owner: OWNER, agent: AGENT, requestDigest: '58'.repeat(32) },
        requestEnv: env({
          SOROBAN_ROUTER_ADDRESSES: `${ROUTER_V2},${ROUTER_V1}`,
          SOROBAN_ROUTER_ADDRESS: ROUTER,
        }),
      })
    )
    expect(res.statusCode).toBe(403)
    expect(body).toEqual({ error: 'Agent authority could not be verified' })
    expect(authorityCalls()).toEqual([
      [ROUTER_V2, 'owner_of'],
      [ROUTER_V1, 'owner_of'],
    ])
  })

  it('binds the first non-null owner and does not fall through after an owner mismatch', async () => {
    mocked.readContract.mockImplementation(async ({ contract, method }) => {
      if (contract === ROUTER_V2 && method === 'owner_of') return OTHER_OWNER
      if (contract === ROUTER_V1 && method === 'owner_of') return OWNER
      if (contract === AGENT && ['scope_of', 'signer'].includes(method)) {
        throw new Error('agent authority must not be read after router owner mismatch')
      }
      throw new Error('unexpected authority read')
    })
    const { res, body } = await call(
      mockReq({
        method: 'POST',
        url: '/api/agent-index?action=receipt-challenge',
        body: { networkId: NETWORK, owner: OWNER, agent: AGENT, requestDigest: '59'.repeat(32) },
        requestEnv: env({
          SOROBAN_ROUTER_ADDRESSES: `${ROUTER_V2},${ROUTER_V1}`,
          SOROBAN_ROUTER_ADDRESS: ROUTER_V1,
        }),
      })
    )
    expect(res.statusCode).toBe(403)
    expect(body).toEqual({ error: 'Agent authority could not be verified' })
    expect(authorityCalls()).toEqual([[ROUTER_V2, 'owner_of']])
  })

  it('returns 503 immediately when a router owner read is indeterminate', async () => {
    mocked.readContract.mockImplementation(async ({ contract, method }) => {
      if (contract === ROUTER_V2 && method === 'owner_of') throw new Error('rpc unavailable')
      if (contract === ROUTER_V1 && method === 'owner_of') return OWNER
      throw new Error('later authorization must not run')
    })
    const { res, body } = await call(
      mockReq({
        method: 'POST',
        url: '/api/agent-index?action=receipt-challenge',
        body: { networkId: NETWORK, owner: OWNER, agent: AGENT, requestDigest: '5a'.repeat(32) },
        requestEnv: env({
          SOROBAN_ROUTER_ADDRESSES: `${ROUTER_V2},${ROUTER_V1}`,
          SOROBAN_ROUTER_ADDRESS: ROUTER_V1,
        }),
      })
    )
    expect(res.statusCode).toBe(503)
    expect(body).toEqual({ error: 'Receipt authority is unavailable' })
    expect(authorityCalls()).toEqual([[ROUTER_V2, 'owner_of']])
  })

  it('falls back to the singular router when the plural list is empty', async () => {
    const { res } = await call(
      mockReq({
        method: 'POST',
        url: '/api/agent-index?action=receipt-challenge',
        body: { networkId: NETWORK, owner: OWNER, agent: AGENT, requestDigest: '5b'.repeat(32) },
        requestEnv: env({ SOROBAN_ROUTER_ADDRESSES: ' , ', SOROBAN_ROUTER_ADDRESS: ROUTER }),
      })
    )
    expect(res.statusCode).toBe(201)
    expect(authorityCalls()).toEqual([
      [ROUTER, 'owner_of'],
      [AGENT, 'scope_of'],
      [AGENT, 'signer'],
    ])
  })

  it('rejects a write when router ownership changes after challenge issuance', async () => {
    let ownerRead = 0
    mocked.readContract.mockImplementation(async ({ contract, method }) => {
      if (contract === ROUTER_V2 && method === 'owner_of') {
        ownerRead += 1
        return ownerRead === 1 ? OWNER : OTHER_OWNER
      }
      if (contract === ROUTER_V1 && method === 'owner_of') return OWNER
      if (contract === AGENT && ['scope_of', 'signer'].includes(method)) {
        if (ownerRead > 1) {
          throw new Error('agent authority must not be re-read after router owner mismatch')
        }
        if (method === 'scope_of') return { owner: OWNER, revoked: false }
        return SESSION.rawPublicKey()
      }
      throw new Error('unexpected authority read')
    })
    const routerEnv = env({
      SOROBAN_ROUTER_ADDRESSES: `${ROUTER_V2},${ROUTER_V1}`,
      SOROBAN_ROUTER_ADDRESS: ROUTER_V1,
    })
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
        requestEnv: routerEnv,
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
        requestEnv: routerEnv,
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
    ).toHaveLength(1)
    expect(mocked.readContract.mock.calls.filter(([arg]) => arg.method === 'signer')).toHaveLength(
      1
    )
    expect(authorityCalls()).toEqual([
      [ROUTER_V2, 'owner_of'],
      [AGENT, 'scope_of'],
      [AGENT, 'signer'],
      [ROUTER_V2, 'owner_of'],
    ])
  })

  it('re-reads the plural router lineage before an authenticated recovery request', async () => {
    const mutation = receiptMutation()
    mocked.store = fakeStore({
      readExecutionReceipt: vi.fn(async () => ({
        ...mutation.receipt,
        format: 2,
        version: 1,
        attempts: [mutation.attempt],
      })),
    })
    mocked.readContract.mockImplementation(async ({ contract, method }) => {
      if (contract === ROUTER_V2 && method === 'owner_of') return OWNER
      if (contract === ROUTER_V1 && method === 'owner_of') return null
      if (contract === AGENT && method === 'scope_of') return { owner: OWNER, revoked: false }
      if (contract === AGENT && method === 'signer') return SESSION.rawPublicKey()
      throw new Error('unexpected authority read')
    })
    const routerEnv = env({
      SOROBAN_ROUTER_ADDRESSES: `${ROUTER_V2},${ROUTER_V1}`,
      SOROBAN_ROUTER_ADDRESS: ROUTER_V1,
    })
    const request = {
      executionId: mutation.receipt.executionId,
      allocationId: mutation.receipt.allocationId,
      expectedReceiptVersion: 1,
      leaseOwner: 'recovery-route-worker',
    }
    const challengeResponse = await call(
      mockReq({
        method: 'POST',
        url: '/api/agent-index?action=receipt-challenge',
        body: {
          networkId: NETWORK,
          owner: OWNER,
          agent: AGENT,
          requestDigest: receiptRequestDigest(request),
        },
        requestEnv: routerEnv,
      })
    )
    expect(challengeResponse.res.statusCode).toBe(201)
    const challenge = challengeResponse.body.challenge
    const proof = {
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt,
      signature: SESSION.sign(Buffer.from(receiptProofMessage(challenge))).toString('base64url'),
    }
    const recovery = await call(
      mockReq({
        method: 'POST',
        url: '/api/agent-index?action=recovery-request',
        body: { request, proof },
        requestEnv: routerEnv,
      })
    )
    expect(recovery.res.statusCode).toBe(200)
    expect(recovery.body).toMatchObject({ ok: true, action: 'deposit', version: 1 })
    expect(authorityCalls()).toEqual([
      [ROUTER_V2, 'owner_of'],
      [AGENT, 'scope_of'],
      [AGENT, 'signer'],
      [ROUTER_V2, 'owner_of'],
      [AGENT, 'scope_of'],
      [AGENT, 'signer'],
    ])
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
  it('routes one authoritative Base child batch with request-scoped authority facts', async () => {
    const messenger = `C${'D'.repeat(55)}`
    const token = `C${'E'.repeat(55)}`
    const batch = childBatch()
    const kernel = batch.children[0].intent.kernelAddress
    const latest = vi.spyOn(rpc.Server.prototype, 'getLatestLedger').mockResolvedValue({
      sequence: 123456,
      closeTime: 2_000_000_001,
    })
    mocked.readContract.mockImplementation(async ({ contract, method }) => {
      if (contract === AGENT && method === 'scope_of') {
        return {
          owner: OWNER,
          kind: 1,
          target: messenger,
          token,
          destination_domain: 6,
          mint_recipient: kernel.slice(2).padStart(64, '0'),
          expiry: 2_100_000_000,
          revoked: false,
          cap_per_period: '30000000',
          spent_in_period: '0',
          period_start: 2_000_000_000,
          period_duration: 3600,
        }
      }
      throw new Error('unexpected authority read')
    })
    const wrongGlobalMessenger = process.env.SOROBAN_CCTP_TOKEN_MESSENGER
    process.env.SOROBAN_CCTP_TOKEN_MESSENGER = `C${'F'.repeat(55)}`
    try {
      const out = await call(
        mockReq({
          method: 'POST',
          url: '/api/agent-index?action=base-child-intent-batch',
          body: batch,
          requestEnv: env({
            SOROBAN_CCTP_TOKEN_MESSENGER: messenger,
            SOROBAN_CCTP_USDC_ADDRESS: token,
          }),
        })
      )
      expect(out.res.statusCode).toBe(201)
      expect(out.body).toMatchObject({
        acknowledged: true,
        idempotencyKey: 'route-batch-key-1',
        identities: batch.children.map(
          ({ networkId, bindingId, executionId, allocationId, childId }) => ({
            networkId,
            bindingId,
            executionId,
            allocationId,
            childId,
          })
        ),
      })
      expect(mocked.store.reserveBaseChildIntentBatch).toHaveBeenCalledTimes(1)
      expect(latest).toHaveBeenCalledTimes(1)
    } finally {
      if (wrongGlobalMessenger === undefined) delete process.env.SOROBAN_CCTP_TOKEN_MESSENGER
      else process.env.SOROBAN_CCTP_TOKEN_MESSENGER = wrongGlobalMessenger
      latest.mockRestore()
    }
  })

  it('routes reporter evidence writes and exact public evidence reads before owner lookup', async () => {
    const identity = {
      networkId: NETWORK,
      bindingId: 'binding-route-batch',
      executionId: 'run-route-1:exec:allocation-route-1',
      allocationId: 'allocation-route-1',
      childId: 'job-route-batch',
    }
    const write = await call(
      mockReq({
        method: 'POST',
        url: '/api/agent-index?action=base-child-evidence',
        body: {
          schemaVersion: 1,
          identity,
          expectedRecoveryVersion: 0,
          event: {
            eventId: 'a'.repeat(64),
            phase: 'cctp_burn',
            state: 'submitting',
            evidence: {},
            observedAt: 2_000_000_000_100,
          },
        },
      })
    )
    expect(write.res.statusCode).toBe(201)
    const query = new URLSearchParams({
      action: 'base-child-evidence',
      network: identity.networkId,
      binding: identity.bindingId,
      execution: identity.executionId,
      allocation: identity.allocationId,
      child: identity.childId,
    })
    const readReq = mockReq({ url: `/api/agent-index?${query}` })
    delete readReq.headers.authorization
    const read = await call(readReq)
    expect(read.res.statusCode).toBe(200)
    expect(read.body).toMatchObject({ identity, recoverable: true, recoveryVersion: 1 })
    expect(mocked.store.readPublicBaseChildEvidence).toHaveBeenCalledWith(identity)
    expect(read.res.headers['Access-Control-Allow-Origin']).toBe('*')
  })

  it('fails public evidence reads closed when the configured network/passphrase is invalid', async () => {
    const query = new URLSearchParams({
      action: 'base-child-evidence',
      network: NETWORK,
      binding: 'binding-route-batch',
      execution: 'run-route-1:exec:allocation-route-1',
      allocation: 'allocation-route-1',
      child: 'job-route-batch',
    })
    const req = mockReq({
      url: `/api/agent-index?${query}`,
      requestEnv: env({ STELLAR_NETWORK_PASSPHRASE: 'invalid-passphrase' }),
    })
    delete req.headers.authorization
    const out = await call(req)
    expect(out.res.statusCode).toBe(503)
    expect(mocked.store.readPublicBaseChildEvidence).not.toHaveBeenCalled()
  })

  it('rate limits public evidence reads in their tighter bucket before store access', async () => {
    const query = new URLSearchParams({
      action: 'base-child-evidence',
      network: NETWORK,
      binding: 'binding-route-batch',
      execution: 'run-route-1:exec:allocation-route-1',
      allocation: 'allocation-route-1',
      child: 'job-route-batch',
    })
    let out
    for (let attempt = 0; attempt < 21; attempt += 1) {
      const req = mockReq({
        url: `/api/agent-index?${query}`,
        ip: '203.0.113.249',
      })
      delete req.headers.authorization
      out = await call(req)
    }
    expect(out.res.statusCode).toBe(429)
    expect(mocked.store.readPublicBaseChildEvidence).toHaveBeenCalledTimes(20)
  })

  it('rejects a batch bearer before RPC authority reads', async () => {
    const latest = vi.spyOn(rpc.Server.prototype, 'getLatestLedger')
    const req = mockReq({
      method: 'POST',
      url: '/api/agent-index?action=base-child-intent-batch',
      body: childBatch(),
    })
    req.headers.authorization = 'Bearer wrong-secret'
    const out = await call(req)
    expect(out.res.statusCode).toBe(401)
    expect(mocked.readContract).not.toHaveBeenCalled()
    expect(latest).not.toHaveBeenCalled()
    latest.mockRestore()
  })

  it('accepts idempotency only in the exact batch body, never from a header fallback', async () => {
    const body = childBatch()
    delete body.idempotencyKey
    const req = mockReq({
      method: 'POST',
      url: '/api/agent-index?action=base-child-intent-batch',
      body,
    })
    req.headers['idempotency-key'] = 'header-key-must-not-be-used'
    const out = await call(req)
    expect(out.res.statusCode).toBe(400)
    expect(mocked.store.reserveBaseChildIntentBatch).not.toHaveBeenCalled()
  })

  it.each(['base-child-intent', 'base-child-lifecycle'])(
    'retires the unauthoritative %s writer',
    async (action) => {
      const out = await call(
        mockReq({ method: 'POST', url: `/api/agent-index?action=${action}`, body: {} })
      )
      expect(out.res.statusCode).toBe(404)
      expect(mocked.store.createBaseChildIntent).not.toHaveBeenCalled()
      expect(mocked.store.advanceBaseChildLifecycle).not.toHaveBeenCalled()
    }
  )

  // Defect caught: the relayer had no authenticated, schema-pinned way to prove that the D1
  // binding was present and writable before consuming durable outbox rows.
  it('exposes authenticated Base child schema/store readiness', async () => {
    const accepted = await call(
      mockReq({
        method: 'POST',
        url: '/api/agent-index?action=base-child-ready',
        body: {},
      })
    )
    expect(accepted.res.statusCode).toBe(200)
    expect(accepted.body).toEqual({
      ready: true,
      schemaVersion: 1,
      stores: { executionReceipts: true, baseChildIntents: true, baseRecoveryEvidence: true },
    })
    expect(mocked.store.probeReadiness).toHaveBeenCalledTimes(1)

    const deniedReq = mockReq({
      method: 'POST',
      url: '/api/agent-index?action=base-child-ready',
      body: {},
    })
    deniedReq.headers.authorization = 'Bearer wrong-secret'
    const denied = await call(deniedReq)
    expect(denied.res.statusCode).toBe(401)
    expect(mocked.store.probeReadiness).toHaveBeenCalledTimes(1)
  })

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
  ])(
    'makes the %s route reachable behind reporter authentication',
    async (_label, action, body, status) => {
      const out = await call(
        mockReq({ method: 'POST', url: `/api/agent-index?action=${action}`, body })
      )
      expect(out.res.statusCode).toBe(status)
      if (action.startsWith('base-child-')) expect(out.body.acknowledged).toBe(true)
      else expect(out.body.ok).toBe(true)
      expect(JSON.stringify(out.body)).not.toMatch(/server-reporter-secret/)
    }
  )

  it.each([['lease-acquire', { networkId: NETWORK }]])(
    'maps an invalid %s body to a non-disclosing 400',
    async (action, body) => {
      const out = await call(
        mockReq({ method: 'POST', url: `/api/agent-index?action=${action}`, body })
      )
      expect(out.res.statusCode).toBe(400)
      expect(out.body).toEqual({ error: 'Invalid agent-index request' })
    }
  )

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

describe('/api/agent-index owner pagination adapter', () => {
  function membershipRow(address, createdLedger) {
    return {
      address,
      owner: OWNER,
      kind: 'deposit',
      creator: ROUTER_V1,
      schemaVersion: 1,
      createdLedger,
      createdTxHash: `tx-${createdLedger}`,
      grantTxHash: `grant-${createdLedger}`,
      runId: `run-${createdLedger}`,
      runOrdinal: 0,
      provenance: { source: 'adapter-test' },
    }
  }

  function pagedStore() {
    return fakeStore({
      readCoverage: vi.fn(async () => ({ sources: [], gaps: [], backfillAudits: [] })),
      readOwnerMaximumCreationLedger: vi.fn(async () => 20),
      readOwnerMembershipsPage: vi.fn(async ({ afterLedger }) =>
        afterLedger < 0
          ? { rows: [membershipRow(AGENT, 10)], hasMore: true }
          : { rows: [membershipRow(OTHER_AGENT, 20)], hasMore: false }
      ),
      readMembershipsByAgentAddresses: vi.fn(async () => []),
      readOwnerBaseChildIntents: vi.fn(async () => []),
      readOwnerRunAllocations: vi.fn(async () => []),
    })
  }

  it('parses and authenticates the cursor query parameter across owner pages', async () => {
    mocked.store = pagedStore()
    const first = await call(
      mockReq({ url: `/api/agent-index?network=${NETWORK}&owner=${OWNER}&limit=1` })
    )
    expect(first.res.statusCode).toBe(200)
    expect(first.body).toMatchObject({
      status: 'partial',
      agents: [{ address: AGENT }],
      pagination: { hasMore: true, snapshotThroughLedger: 20, coverageStatus: 'partial' },
    })
    expect(first.body.pagination.nextCursor).toEqual(expect.any(String))

    const second = await call(
      mockReq({
        url:
          `/api/agent-index?network=${NETWORK}&owner=${OWNER}&limit=1&cursor=` +
          encodeURIComponent(first.body.pagination.nextCursor),
      })
    )
    expect(second.res.statusCode).toBe(200)
    expect(second.body).toMatchObject({
      status: 'partial',
      agents: [{ address: OTHER_AGENT }],
      pagination: {
        hasMore: false,
        nextCursor: null,
        snapshotThroughLedger: 20,
        coverageStatus: 'partial',
      },
    })
  })

  it('returns structured unavailable when a required continuation cannot be signed', async () => {
    mocked.store = pagedStore()
    const out = await call(
      mockReq({
        url: `/api/agent-index?network=${NETWORK}&owner=${OWNER}&limit=1`,
        requestEnv: env({ AGENT_INDEX_CURSOR_SECRET: '' }),
      })
    )
    expect(out.res.statusCode).toBe(200)
    expect(out.body).toMatchObject({ status: 'unavailable', agents: [] })
  })

  it.each(['1e2', '0x10', '+2', ' 2 '])('rejects non-decimal limit spelling %j', async (limit) => {
    mocked.store = pagedStore()
    const out = await call(
      mockReq({
        url:
          `/api/agent-index?network=${NETWORK}&owner=${OWNER}&limit=` + encodeURIComponent(limit),
      })
    )
    expect(out.res.statusCode).toBe(400)
    expect(out.body).toEqual({ error: 'Invalid limit' })
  })
})
