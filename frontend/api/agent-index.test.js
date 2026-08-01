import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Keypair, Networks, StrKey } from '@stellar/stellar-sdk'

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
const AGENT = 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC'
const ROUTER = 'CBEI5VJKT2KZR6TU6NKHKJRIQORXTSTAH5RDUA7MBUNCPZDN6ZLQSYE4'
const ROUTER_V2 = 'CB675TTSFM6COTGHGB7K2I7IODPQ3HTHOTTTXU2LJHXXNGTS45NOTRSE'
const ROUTER_V1 = 'CCEWWRQVYKEIWTO7GTX2QVHQASC3GIQOZZTDMGTOHFQYKZIX5KJ6CYE5'
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
    intent: {
      token: 'USDC',
      units: '1000000',
      decimals: 6,
      poolAddress: `0x${'11'.repeat(20)}`,
      proxyTarget: 'aave-v3',
      runId: 'run-route-1',
      grantTxHash: 'grant-route-1',
      kernelAddress: `0x${'22'.repeat(20)}`,
      bindingHash: 'binding-hash-route-1',
      baseJobId: childId,
    },
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
      stores: { executionReceipts: true, baseChildIntents: true },
    })),
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
  it('uses a valid agent contract identity distinct from every router fixture', () => {
    expect(StrKey.isValidContract(AGENT)).toBe(true)
    expect([ROUTER, ROUTER_V2, ROUTER_V1]).not.toContain(AGENT)
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
    expect(mocked.readContract.mock.calls.filter(([arg]) => arg.method === 'signer')).toHaveLength(1)
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
      stores: { executionReceipts: true, baseChildIntents: true },
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
      if (action.startsWith('base-child-')) expect(out.body.acknowledged).toBe(true)
      else expect(out.body.ok).toBe(true)
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
