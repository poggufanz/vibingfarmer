import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@stellar/stellar-sdk';
import {
  concatHex,
  encodeAbiParameters,
  keccak256,
  pad,
  slice,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  toCallPolicy,
  toTimestampPolicy,
  CallPolicyVersion,
  ParamCondition,
} from '@zerodev/permissions/policies';
import { createRelayerRouter } from '../src/httpRouter.mjs';
import { createMandateStoreV2, createMandateStoresV3 } from '../src/mandateStore.mjs';
import { MAX_CALL_CAP_UNITS, validateMandateBinding } from '../src/base/session.mjs';
import { APPROVE_ABI, YIELD_ROUTER_ABI } from '../src/base/orchestrator.mjs';
import { buildFarmPermissions } from '../../frontend/src/base/policyEngine.js';
import { createSqliteStores } from '../src/sqliteStores.mjs';

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v; },
    end(s) { this.body = s ?? ''; return this; },
  };
}
const mk = (method, url, body) => ({ method, url, body });
const jsonOf = (res) => (res.body ? JSON.parse(res.body) : undefined);

// VF Wallet Task 7 fixtures — same real buildFarmPermissions/toCallPolicy/toTimestampPolicy
// roundtrip as relayer/test/base/session.test.mjs, so these exercise the real production wire
// shape end to end through the router, not a hand-rolled stand-in.
const YIELD_ROUTER_ADDRESS = `0x${'a1'.repeat(20)}`;
const USDC_ADDRESS = `0x${'b2'.repeat(20)}`;
const KERNEL_ADDRESS = `0x${'c3'.repeat(20)}`;
const OTHER_KERNEL_ADDRESS = `0x${'d4'.repeat(20)}`;
const POOL_ADDRESS = `0x${'e5'.repeat(20)}`;
const SECOND_POOL_ADDRESS = `0x${'f6'.repeat(20)}`;
const STELLAR_OWNER = `G${'A'.repeat(55)}`;
const OTHER_STELLAR_OWNER = `G${'B'.repeat(55)}`;
const SESSION_PRIVATE_KEY = `0x${'22'.repeat(32)}`;
const SESSION_KEY_ADDRESS = privateKeyToAccount(SESSION_PRIVATE_KEY).address;
const PERMISSION_ID = '0xa1b2c3d4';
const WITHDRAW_ABI = [{
  type: 'function', name: 'withdraw', stateMutability: 'nonpayable',
  inputs: [{ name: 'pool', type: 'address' }, { name: 'shares', type: 'uint256' }, { name: 'minAssets', type: 'uint256' }],
  outputs: [{ name: 'assets', type: 'uint256' }],
}];
const WITHDRAW_PERMISSION = { target: YIELD_ROUTER_ADDRESS, valueLimit: 0n, abi: WITHDRAW_ABI, functionName: 'withdraw', args: [null, null, null] };

function serializeParams(params) {
  const replacer = (_, v) => (typeof v === 'bigint' ? v.toString() : v);
  return Buffer.from(JSON.stringify(params, replacer), 'utf8').toString('base64');
}

function buildFakeApproval({
  accountAddress = KERNEL_ADDRESS,
  cap = MAX_CALL_CAP_UNITS,
  expiry = Math.floor(Date.now() / 1000) + 3600,
  extraPermissions = [],
  permissionId = PERMISSION_ID,
  includePermissionId = true,
} = {}) {
  const permissions = [
    ...buildFarmPermissions({
      pools: [{ pool: POOL_ADDRESS, cap }],
      yieldRouterAbi: YIELD_ROUTER_ABI, usdcAbi: APPROVE_ABI,
      yieldRouterAddress: YIELD_ROUTER_ADDRESS, usdcAddress: USDC_ADDRESS,
    }),
    ...extraPermissions,
  ];
  const callPolicy = toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, permissions });
  const timestampPolicy = toTimestampPolicy({ validAfter: 0, validUntil: expiry });
  return serializeParams({
    accountParams: { accountAddress, initCode: '0x' },
    permissionParams: {
      ...(includePermissionId ? { permissionId } : {}),
      policies: [callPolicy, timestampPolicy],
    },
  });
}

function wireAllocation({ allocationId = 'run-42:bridge:aave-v3', pool = POOL_ADDRESS, units = 100n, minShares = '90' } = {}) {
  return { allocationId, poolAddress: pool, amount: { token: 'USDC', units: units.toString(), decimals: 6 }, minShares };
}

// Fixed once at module load and reused by every call so two independent
// activeEvidence() calls (one building the mock response, one building the
// expectation) never race a Date.now() wall-clock tick against each other.
const FIXED_BLOCK_TIME = Date.now();

const activeEvidence = () => ({
  version: 2,
  status: 'active',
  reasonCodes: [],
  expected: { owner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS },
  observed: {
    blockNumber: '101', blockHash: `0x${'12'.repeat(32)}`, blockTime: FIXED_BLOCK_TIME,
    implementation: `0x${'34'.repeat(20)}`,
    permission: { digest: 'permission-digest' },
    preparedCallDigest: 'prepared-call-digest',
  },
  checks: { prepared: true },
});

function mandateUrl({ approval, owner = STELLAR_OWNER, kernel = KERNEL_ADDRESS, allocation = wireAllocation(), extra = '' }) {
  const qs = new URLSearchParams({
    approval,
    stellarOwner: owner,
    kernelAddress: kernel,
    allocation: JSON.stringify(allocation),
  });
  return `/api/vf-cross/mandate/valid?${qs}${extra}`;
}

describe('createRelayerRouter', () => {
  let jobs, mandatesV2, nextId, genId, buildFarm, farmFn, relayUnwindMint, agentIndexReporter, associationOutbox, router;

  function makeRouter(overrides = {}) {
    return createRelayerRouter({
      buildFarm, relayUnwindMint, jobs, mandatesV2, genId,
      usdcAddress: USDC_ADDRESS, yieldRouterAddress: YIELD_ROUTER_ADDRESS,
      networkId: 'stellar-testnet',
      publicRuntime: {
        networkId: 'stellar-testnet',
        reporter: { url: 'https://app.example/api/agent-index', schema: 1, hasSecret: true },
        readiness: { ready: true },
        digests: { deployments: 'a'.repeat(64), baseMandatePolicy: 'b'.repeat(64) },
      },
      poolTargets: new Map([[POOL_ADDRESS.toLowerCase(), 'aave-v3']]),
      evaluateMandateStatusFn: vi.fn(async () => activeEvidence()),
      mandateStatusConfig: { publicOrigin: null, base: {} },
      agentIndexReporter,
      associationOutbox,
      ...overrides,
    });
  }

  // Returns the exact body used (callers reuse its fields verbatim for follow-up requests —
  // never re-derive an approval by calling this twice and hoping the clock didn't tick).
  function mandateBody(overrides = {}) {
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    return {
      serializedApproval: buildFakeApproval({ expiry }),
      sessionPrivateKey: SESSION_PRIVATE_KEY,
      sessionKeyAddress: SESSION_KEY_ADDRESS,
      expiresAt: expiry,
      stellarOwner: STELLAR_OWNER,
      kernelAddress: KERNEL_ADDRESS,
      ...overrides,
    };
  }

  async function registerMandate(activeRouter, overrides = {}) {
    const body = mandateBody(overrides);
    const res = mockRes();
    await activeRouter(mk('POST', '/api/vf-cross/mandate', body), res);
    return { res, body, respBody: jsonOf(res) };
  }

  async function attachJob(activeRouter, jobId, mandate, burnTxHash = 'burn-1') {
    const res = mockRes();
    await activeRouter(mk('POST', '/api/vf-cross/farm/attach', {
      jobId,
      burnTxHash,
      serializedApproval: mandate.serializedApproval,
      stellarOwner: STELLAR_OWNER,
      kernelAddress: KERNEL_ADDRESS,
    }), res);
    return res;
  }

  beforeEach(() => {
    jobs = new Map();
    mandatesV2 = createMandateStoreV2();
    nextId = 0;
    genId = () => `id-${++nextId}`;
    farmFn = vi.fn(async () => ({
      mintResult: { status: 'minted', mintTxHash: '0xmint' },
      depositResults: [{ status: 'fulfilled', pool: POOL_ADDRESS }],
      runId: null, bridgeAgent: null, grantTxHash: null,
    }));
    buildFarm = vi.fn(() => ({ farm: farmFn }));
    relayUnwindMint = vi.fn(async () => ({ status: 'minted', mintTxHash: '0xreverse' }));
    agentIndexReporter = {
      commitIntent: vi.fn(async (child) => ({
        acknowledged: true,
        identity: {
          networkId: child.networkId,
          owner: child.owner,
          bindingId: child.bindingId,
          allocationId: child.allocationId,
          childId: child.childId,
        },
        schemaVersion: 1,
      })),
    };
    associationOutbox = {
      enqueue: vi.fn((report) => ({ duplicate: false, status: 'pending', report })),
      status: vi.fn(() => []),
    };
    router = makeRouter();
  });

  it('OPTIONS preflight returns 204 with CORS headers and an empty body', async () => {
    const res = mockRes();
    await router(mk('OPTIONS', '/api/vf-cross/farm'), res);
    expect(res.statusCode).toBe(204);
    expect(res.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(res.body).toBe('');
  });

  it('404s on an unknown route', async () => {
    const res = mockRes();
    await router(mk('GET', '/api/vf-cross/nope'), res);
    expect(res.statusCode).toBe(404);
  });

  it('GET /config returns immutable public runtime facts without secrets', async () => {
    const res = mockRes();
    await router(mk('GET', '/api/vf-cross/config'), res);
    expect(res.statusCode).toBe(200);
    expect(jsonOf(res)).toEqual({
      networkId: 'stellar-testnet',
      reporter: { url: 'https://app.example/api/agent-index', schema: 1, hasSecret: true },
      readiness: { ready: true },
      digests: { deployments: 'a'.repeat(64), baseMandatePolicy: 'b'.repeat(64) },
    });
    expect(res.body).not.toMatch(/privateKey|proxyKey/i);
  });

  describe('POST /mandate', () => {
    it('400s when any required v2 field is missing', async () => {
      for (const missing of ['serializedApproval', 'sessionPrivateKey', 'sessionKeyAddress', 'stellarOwner', 'kernelAddress']) {
        const body = mandateBody();
        delete body[missing];
        const res = mockRes();
        await router(mk('POST', '/api/vf-cross/mandate', body), res);
        expect(res.statusCode, `missing ${missing}`).toBe(400);
      }
      expect(mandatesV2.size).toBe(0);
    });

    it('400s when expiresAt is missing, in the past, or more than 30 days out', async () => {
      const nowS = Math.floor(Date.now() / 1000);
      for (const expiresAt of [undefined, nowS - 100, nowS + 30 * 24 * 3600 + 60]) {
        const res = mockRes();
        await router(mk('POST', '/api/vf-cross/mandate', mandateBody({ expiresAt })), res);
        expect(res.statusCode).toBe(400);
      }
      expect(mandatesV2.size).toBe(0);
    });

    it('stores the full v2 record and responds {ok, relayerOrigin, bindingId, bindingHash} — never echoing the key back', async () => {
      const routerWithOrigin = makeRouter({ relayerOrigin: 'https://relayer.example' });
      const { res, body, respBody } = await registerMandate(routerWithOrigin);
      expect(res.statusCode).toBe(200);
      expect(respBody).toMatchObject({ ok: true, relayerOrigin: 'https://relayer.example' });
      expect(typeof respBody.bindingId).toBe('string');
      expect(typeof respBody.bindingHash).toBe('string');
      expect(res.body).not.toContain(SESSION_PRIVATE_KEY);

      const stored = mandatesV2.get({ serializedApproval: body.serializedApproval, stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS });
      expect(stored).toMatchObject({
        sessionPrivateKey: SESSION_PRIVATE_KEY,
        sessionKeyAddress: SESSION_KEY_ADDRESS,
        stellarOwner: STELLAR_OWNER,
        kernelAddress: KERNEL_ADDRESS,
        relayerOrigin: 'https://relayer.example',
        status: 'active',
        bindingId: respBody.bindingId,
        bindingHash: respBody.bindingHash,
      });
    });

    it('rejects when sessionKeyAddress does not match the address derived from sessionPrivateKey', async () => {
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/mandate', mandateBody({ sessionKeyAddress: `0x${'99'.repeat(20)}` })), res);
      expect(res.statusCode).toBe(400);
      expect(mandatesV2.size).toBe(0);
    });

    it('rejects when kernelAddress does not match the approval\'s own account address', async () => {
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/mandate', mandateBody({ kernelAddress: OTHER_KERNEL_ADDRESS })), res);
      expect(res.statusCode).toBe(400);
      expect(mandatesV2.size).toBe(0);
    });

    it('rejects a non-Stellar stellarOwner', async () => {
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/mandate', mandateBody({ stellarOwner: 'not-a-stellar-address' })), res);
      expect(res.statusCode).toBe(400);
    });

    it('rejects (policy regression) an approval whose embedded call policy includes a withdraw permission', async () => {
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/mandate', mandateBody({
        serializedApproval: buildFakeApproval({ extraPermissions: [WITHDRAW_PERMISSION] }),
      })), res);
      expect(res.statusCode).toBe(400);
      expect(mandatesV2.size).toBe(0);
    });

    it('rejects (policy regression) an approval whose per-call cap exceeds 10,000 USDC', async () => {
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/mandate', mandateBody({
        serializedApproval: buildFakeApproval({ cap: MAX_CALL_CAP_UNITS + 1n }),
      })), res);
      expect(res.statusCode).toBe(400);
      expect(mandatesV2.size).toBe(0);
    });

    it('rejects (policy regression) an approval whose own embedded timestamp policy has already expired', async () => {
      const nowS = Math.floor(Date.now() / 1000);
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/mandate', mandateBody({
        serializedApproval: buildFakeApproval({ expiry: nowS - 10 }),
      })), res);
      expect(res.statusCode).toBe(400);
      expect(mandatesV2.size).toBe(0);
    });
  });

  describe('GET /mandate/valid', () => {
    it('400s when approval, stellarOwner or kernelAddress query params are missing', async () => {
      const res = mockRes();
      await router(mk('GET', '/api/vf-cross/mandate/valid?approval=x&stellarOwner=y'), res);
      expect(res.statusCode).toBe(400);
    });

    it('returns the canonical BaseMandateStatusV2 shape for a freshly-registered mandate, never leaking the key', async () => {
      const { body, respBody } = await registerMandate(router);
      const res = mockRes();
      await router(mk('GET', mandateUrl({ approval: body.serializedApproval })), res);
      expect(res.statusCode).toBe(200);
      expect(jsonOf(res)).toEqual(activeEvidence());
      expect(res.headers['Cache-Control']).toBe('no-store');
      expect(res.body).not.toContain(SESSION_PRIVATE_KEY);
    });

    it('projects the normalized permission identity from a freshly registered SQLite record before evaluation', async () => {
      const path = join(mkdtempSync(join(tmpdir(), 'vf-router-mandate-')), 'relayer.db');
      const stores = createSqliteStores(path);
      const evaluateMandateStatusFn = vi.fn(async () => activeEvidence());
      const durableRouter = makeRouter({
        mandatesV2: stores.mandatesV2,
        evaluateMandateStatusFn,
      });
      const { body } = await registerMandate(durableRouter, {
        serializedApproval: buildFakeApproval({ permissionId: '0xA1B2C3D4' }),
      });
      const res = mockRes();

      await durableRouter(mk('GET', mandateUrl({ approval: body.serializedApproval })), res);

      expect(res.statusCode).toBe(200);
      expect(jsonOf(res).status).toBe('active');
      expect(evaluateMandateStatusFn).toHaveBeenCalledWith(expect.objectContaining({
        record: expect.objectContaining({
          serializedApproval: body.serializedApproval,
          permissionId: PERMISSION_ID,
        }),
      }));
      expect(stores.mandatesV2.get({
        serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER,
        kernelAddress: KERNEL_ADDRESS,
      })).not.toHaveProperty('permissionId');
    });

    it.each([
      ['missing', buildFakeApproval({ includePermissionId: false })],
      ['malformed', buildFakeApproval({ permissionId: 'not-a-permission-id' })],
    ])('fails closed before evaluation when the persisted serialized permission identity is %s', async (_label, serializedApproval) => {
      const evaluateMandateStatusFn = vi.fn(async () => activeEvidence());
      const exactRouter = makeRouter({ evaluateMandateStatusFn });
      const { res: registration } = await registerMandate(exactRouter, { serializedApproval });
      expect(registration.statusCode).toBe(200);
      const res = mockRes();

      await exactRouter(mk('GET', mandateUrl({ approval: serializedApproval })), res);

      expect(jsonOf(res)).toMatchObject({
        status: 'unknown',
        reasonCodes: ['APPROVAL_MALFORMED'],
      });
      expect(evaluateMandateStatusFn).not.toHaveBeenCalled();
      expect(res.body).not.toContain(SESSION_PRIVATE_KEY);
    });

    it('fails closed with v2 unknown for a never-registered triple', async () => {
      const res = mockRes();
      await router(mk('GET', mandateUrl({ approval: 'never-registered' })), res);
      expect(jsonOf(res)).toMatchObject({ version: 2, status: 'unknown', reasonCodes: ['MANDATE_MISSING'] });
      expect(res.headers['Cache-Control']).toBe('no-store');
    });

    // Step 5 acceptance, pinned at the endpoint: owner A's approval cannot execute for owner B
    // or a second kernel — the composite-key lookup misses identically to "never registered".
    it('reports "missing" when queried under a different stellarOwner than it was registered for', async () => {
      const { body } = await registerMandate(router);
      const res = mockRes();
      await router(mk('GET', mandateUrl({ approval: body.serializedApproval, owner: OTHER_STELLAR_OWNER })), res);
      expect(jsonOf(res).status).toBe('unknown');
    });

    it('reports "missing" when queried under a different kernelAddress than it was registered for', async () => {
      // Register a SEPARATE mandate whose approval account really is OTHER_KERNEL_ADDRESS, so the
      // lookup below fails on the (stellarOwner, kernelAddress) mismatch, not a decode error.
      const { body } = await registerMandate(router, {
        kernelAddress: OTHER_KERNEL_ADDRESS,
        serializedApproval: buildFakeApproval({ accountAddress: OTHER_KERNEL_ADDRESS }),
      });
      const res = mockRes();
      await router(mk('GET', mandateUrl({ approval: body.serializedApproval })), res);
      expect(jsonOf(res).status).toBe('unknown');
    });

    it('reports unknown once the store has evicted an expired mandate', async () => {
      const past = Date.now() - 1000;
      mandatesV2.set({
        serializedApproval: 'approval-x', sessionPrivateKey: SESSION_PRIVATE_KEY, sessionKeyAddress: SESSION_KEY_ADDRESS,
        stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS, relayerOrigin: null,
        expiresAt: past, status: 'active', bindingId: 'b1', bindingHash: 'h1', createdAt: Date.now() - 2000,
      });
      const evaluateMandateStatusFn = vi.fn(async () => ({ ...activeEvidence(), status: 'expired', reasonCodes: ['EXPIRED'] }));
      const res = mockRes();
      await makeRouter({ evaluateMandateStatusFn })(mk('GET', mandateUrl({ approval: 'approval-x' })), res);
      expect(jsonOf(res)).toMatchObject({ status: 'unknown', reasonCodes: ['MANDATE_MISSING'] });
    });

    it('uses only the stored record and canonical config, forwards the exact allocation, and ignores forged expected facts', async () => {
      const evaluateMandateStatusFn = vi.fn(async () => activeEvidence());
      const exact = wireAllocation({ units: 777n, minShares: '700' });
      const exactRouter = makeRouter({ evaluateMandateStatusFn });
      const { body } = await registerMandate(exactRouter);
      const res = mockRes();
      await exactRouter(mk('GET', mandateUrl({
        approval: body.serializedApproval,
        allocation: exact,
        extra: '&expectedOwner=GFORGED&expectedChainId=1',
      })), res);
      expect(evaluateMandateStatusFn).toHaveBeenCalledWith(expect.objectContaining({
        record: expect.objectContaining({
          stellarOwner: STELLAR_OWNER,
          kernelAddress: KERNEL_ADDRESS,
          sessionPrivateKey: SESSION_PRIVATE_KEY,
        }),
        allocation: exact,
        config: { publicOrigin: null, base: {} },
      }));
      expect(res.headers['Cache-Control']).toBe('no-store');
      expect(res.body).not.toContain(SESSION_PRIVATE_KEY);
      expect(res.body).not.toContain('GFORGED');
    });

    it('maps evaluator failures to no-store unknown without leaking the error', async () => {
      const exactRouter = makeRouter({
        evaluateMandateStatusFn: vi.fn(async () => { throw new Error('rpc secret https://internal'); }),
      });
      const { body } = await registerMandate(exactRouter);
      const res = mockRes();
      await exactRouter(mk('GET', mandateUrl({ approval: body.serializedApproval })), res);
      expect(jsonOf(res)).toMatchObject({ version: 2, status: 'unknown', reasonCodes: ['STATUS_ERROR'] });
      expect(res.headers['Cache-Control']).toBe('no-store');
      expect(res.body).not.toContain('internal');
    });
  });

  describe('POST /mandate/revoke', () => {
    it('400s when required fields are missing', async () => {
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/mandate/revoke', { serializedApproval: 'x' }), res);
      expect(res.statusCode).toBe(400);
    });

    it('deletes the exact binding and responds with the relayer-key-copy distinction, never the key', async () => {
      const { body } = await registerMandate(router);
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/mandate/revoke', {
        serializedApproval: body.serializedApproval, stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS,
      }), res);
      expect(res.statusCode).toBe(200);
      const parsed = jsonOf(res);
      expect(parsed).toMatchObject({ ok: true, deleted: true, scope: 'relayer-key-copy' });
      expect(typeof parsed.note).toBe('string');
      expect(parsed.note).toMatch(/timestamp policy/i); // Step 4's exact distinction, not "revoked everywhere"
      expect(res.body).not.toContain(SESSION_PRIVATE_KEY);

      expect(mandatesV2.get({ serializedApproval: body.serializedApproval, stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS })).toBeUndefined();
    });

    it('responds deleted:false (still ok:true) for a binding that was never registered — never leaks whether one exists for someone else', async () => {
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/mandate/revoke', {
        serializedApproval: 'never-registered', stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS,
      }), res);
      expect(res.statusCode).toBe(200);
      expect(jsonOf(res)).toMatchObject({ ok: true, deleted: false });
    });

    it('a revoked mandate becomes unusable for /farm — "unknown mandate", not a 500', async () => {
      const { body } = await registerMandate(router);
      await router(mk('POST', '/api/vf-cross/mandate/revoke', {
        serializedApproval: body.serializedApproval, stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS,
      }), mockRes());

      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', {
        serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS,
        allocations: [wireAllocation()],
      }), res);
      expect(res.statusCode).toBe(400);
      expect(jsonOf(res).error).toMatch(/unknown mandate/);
    });
  });

  describe('POST /farm', () => {
    it('blocks durable intent acknowledgement when exact mandate evidence is no longer active', async () => {
      const evaluateMandateStatusFn = vi.fn(async () => ({
        ...activeEvidence(), status: 'revoked', reasonCodes: ['PERMISSION_REVOKED'],
      }));
      const guardedRouter = makeRouter({ evaluateMandateStatusFn });
      const { body } = await registerMandate(guardedRouter);
      const res = mockRes();
      await guardedRouter(mk('POST', '/api/vf-cross/farm', {
        serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER,
        kernelAddress: KERNEL_ADDRESS,
        bridgeAgent: 'CBRIDGE',
        runId: 'run-42',
        grantTxHash: 'HGRANT',
        allocations: [wireAllocation()],
      }), res);

      expect(res.statusCode).toBe(409);
      expect(jsonOf(res)).toMatchObject({ evidence: { status: 'revoked' } });
      expect(agentIndexReporter.commitIntent).not.toHaveBeenCalled();
      expect(jobs.size).toBe(0);
      expect(buildFarm).not.toHaveBeenCalled();
    });

    it('400s when required fields are missing', async () => {
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', { burnTxHash: 'burn-1' }), res);
      expect(res.statusCode).toBe(400);
      expect(buildFarm).not.toHaveBeenCalled();
    });

    it('400s "unknown mandate" when the exact (approval, owner, kernel) triple was never registered', async () => {
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', {
        serializedApproval: 'never-registered',
        stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS,
        allocations: [wireAllocation()],
      }), res);
      expect(res.statusCode).toBe(400);
      expect(jsonOf(res).error).toMatch(/unknown mandate/);
      expect(buildFarm).not.toHaveBeenCalled();
    });

    // Step 5 acceptance: owner A's approval cannot execute for owner B or a second kernel.
    it('400s "unknown mandate" when a registered approval is dispatched under a different owner', async () => {
      const { body } = await registerMandate(router);
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', {
        serializedApproval: body.serializedApproval,
        stellarOwner: OTHER_STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS,
        allocations: [wireAllocation()],
      }), res);
      expect(res.statusCode).toBe(400);
      expect(jsonOf(res).error).toMatch(/unknown mandate/);
      expect(buildFarm).not.toHaveBeenCalled();
    });

    it('400s when an allocation amount is not a valid integer string', async () => {
      const { body } = await registerMandate(router);
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', {
        serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS,
        allocations: [{ allocationId: 'run-0', poolAddress: POOL_ADDRESS, amount: { token: 'USDC', units: 'not-a-number', decimals: 6 }, minShares: '90' }],
      }), res);
      expect(res.statusCode).toBe(400);
      expect(farmFn).not.toHaveBeenCalled();
    });

    it('400s when a single allocation exceeds the 10,000 USDC per-call cap', async () => {
      const { body } = await registerMandate(router);
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', {
        serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS,
        bridgeAgent: 'CBRIDGE', runId: 'run-42', grantTxHash: 'HGRANT',
        allocations: [wireAllocation({ units: MAX_CALL_CAP_UNITS + 1n })],
      }), res);
      expect(res.statusCode).toBe(400);
      expect(jsonOf(res).error).toMatch(/cap/i);
      expect(farmFn).not.toHaveBeenCalled();
    });

    it('the cap is per-call and non-cumulative: repeat calls at exactly the cap are each independently accepted', async () => {
      const { body } = await registerMandate(router);
      for (let i = 0; i < 2; i++) {
        const res = mockRes();
        await router(mk('POST', '/api/vf-cross/farm', {
          serializedApproval: body.serializedApproval,
          stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS,
          bridgeAgent: 'CBRIDGE', runId: `run-${i}`, grantTxHash: 'HGRANT',
          allocations: [wireAllocation({
            allocationId: `run-${i}:bridge:aave-v3`,
            units: MAX_CALL_CAP_UNITS,
          })],
        }), res);
        expect(res.statusCode, `call ${i}`).toBe(201);
      }
    });

    it('rejects a new farm job when exact bridge/run/grant association context is missing', async () => {
      const { body } = await registerMandate(router);
      for (const context of [
        { bridgeAgent: null, runId: 'run-42', grantTxHash: 'HGRANT' },
        { bridgeAgent: 'CBRIDGE', runId: null, grantTxHash: 'HGRANT' },
        { bridgeAgent: 'CBRIDGE', runId: 'run-42', grantTxHash: null },
      ]) {
        const res = mockRes();
        await router(mk('POST', '/api/vf-cross/farm', {
          serializedApproval: body.serializedApproval,
          stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS,
          allocations: [wireAllocation()],
          ...context,
        }), res);
        expect(res.statusCode).toBe(400);
        expect(jsonOf(res).error).toMatch(/bridgeAgent, runId and grantTxHash/)
      }
      expect(farmFn).not.toHaveBeenCalled();
      expect(agentIndexReporter.commitIntent).not.toHaveBeenCalled();
    });

    // Defect caught: /farm used to persist a job and return before D1 proved the child intent durable.
    it('persists the job only after every immutable child intent is synchronously acknowledged', async () => {
      const { body } = await registerMandate(router);
      let acknowledge;
      agentIndexReporter.commitIntent.mockImplementationOnce(
        (child) => new Promise((resolve) => {
          acknowledge = () => resolve({
            acknowledged: true,
            identity: {
              networkId: child.networkId,
              owner: child.owner,
              bindingId: child.bindingId,
              allocationId: child.allocationId,
              childId: child.childId,
            },
            schemaVersion: 1,
          });
        })
      );
      const res = mockRes();
      const pending = router(mk('POST', '/api/vf-cross/farm', {
        serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER,
        kernelAddress: KERNEL_ADDRESS,
        bridgeAgent: 'CBRIDGE',
        runId: 'run-42',
        grantTxHash: 'HGRANT',
        allocations: [wireAllocation()],
      }), res);
      await vi.waitFor(() => expect(agentIndexReporter.commitIntent).toHaveBeenCalledTimes(1));
      expect(jobs.size).toBe(0);
      expect(buildFarm).not.toHaveBeenCalled();
      acknowledge();
      await pending;
      expect(res.statusCode).toBe(201);
      expect(jobs.get(jsonOf(res).jobId)).toMatchObject({ status: 'queued' });
      expect(buildFarm).not.toHaveBeenCalled();
    });

    // Defect caught: reporter auth/timeout/schema/D1 ambiguity used to be swallowed after job acceptance.
    it.each(['HTTP 401', 'timed out', 'malformed acknowledgement', 'schema mismatch', 'HTTP 503'])(
      'does not persist or execute a job when durable intent fails with %s',
      async (reason) => {
        agentIndexReporter.commitIntent.mockRejectedValueOnce(new Error(reason));
        const { body } = await registerMandate(router);
        const res = mockRes();
        await router(mk('POST', '/api/vf-cross/farm', {
          serializedApproval: body.serializedApproval,
          stellarOwner: STELLAR_OWNER,
          kernelAddress: KERNEL_ADDRESS,
          bridgeAgent: 'CBRIDGE', runId: 'run-42', grantTxHash: 'HGRANT',
          allocations: [wireAllocation()],
        }), res);
        expect(res.statusCode).toBe(503);
        expect(jsonOf(res)).toEqual({ error: 'Base child intent is unavailable' });
        expect(jobs.size).toBe(0);
        expect(buildFarm).not.toHaveBeenCalled();
      }
    );

    // Defect caught: a caller could bypass intent-first custody by supplying a burn on /farm.
    it('rejects any burn hash on the intent-only route before reporter, job, or farm side effects', async () => {
      const { body } = await registerMandate(router);
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', {
        burnTxHash: 'already-burned',
        serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER,
        kernelAddress: KERNEL_ADDRESS,
        bridgeAgent: 'CBRIDGE', runId: 'run-42', grantTxHash: 'HGRANT',
        allocations: [wireAllocation()],
      }), res);
      expect(res.statusCode).toBe(400);
      expect(agentIndexReporter.commitIntent).not.toHaveBeenCalled();
      expect(jobs.size).toBe(0);
      expect(buildFarm).not.toHaveBeenCalled();
    });

    it('queues an acknowledged intent-only job and keeps attach context private', async () => {
      const { body, respBody } = await registerMandate(router);
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', {
        serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER,
        kernelAddress: KERNEL_ADDRESS,
        bridgeAgent: 'CBRIDGE',
        runId: 'run-42',
        grantTxHash: 'HGRANT',
        allocations: [wireAllocation()],
      }), res);

      expect(res.statusCode).toBe(201);
      const { jobId } = jsonOf(res);
      expect(jobs.get(jobId)).toMatchObject({
        status: 'queued',
        runId: 'run-42',
        bridgeAgent: 'CBRIDGE',
        grantTxHash: 'HGRANT',
      });
      expect(jobs.get(jobId)._attach).toMatchObject({
        serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER,
        kernelAddress: KERNEL_ADDRESS,
        bindingId: respBody.bindingId,
        bindingHash: respBody.bindingHash,
        attachedBurnTxHash: null,
        associations: [{
          allocationId: 'run-42:bridge:aave-v3',
          terminalSequence: null,
        }],
      });
      expect(JSON.stringify(jobs.get(jobId))).not.toContain(SESSION_PRIVATE_KEY);
      expect(buildFarm).not.toHaveBeenCalled();

      expect(agentIndexReporter.commitIntent).toHaveBeenCalledTimes(1);
      expect(agentIndexReporter.commitIntent.mock.calls[0][0]).toMatchObject({
        bindingId: respBody.bindingId,
        allocationId: 'run-42:bridge:aave-v3',
        childId: jobId,
        lifecycle: { sequence: 0, status: 'planned' },
      });

      const statusRes = mockRes();
      await router(mk('GET', `/api/vf-cross/status/${jobId}`), statusRes);
      expect(statusRes.statusCode).toBe(200);
      expect(statusRes.body).not.toContain('_attach');
      expect(statusRes.body).not.toContain(body.serializedApproval);
      expect(statusRes.body).not.toContain(SESSION_PRIVATE_KEY);
    });

    it('authenticates and idempotently attaches one burn, then reports only observed mint movement', async () => {
      const { body } = await registerMandate(router);
      let resolveFarm;
      farmFn.mockImplementationOnce(() => new Promise((resolve) => { resolveFarm = resolve; }));
      const queuedRes = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', {
        serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER,
        kernelAddress: KERNEL_ADDRESS,
        bridgeAgent: 'CBRIDGE',
        runId: 'run-42',
        grantTxHash: 'HGRANT',
        allocations: [wireAllocation()],
      }), queuedRes);
      const { jobId } = jsonOf(queuedRes);
      expect(agentIndexReporter.commitIntent).toHaveBeenCalledTimes(1);
      expect(associationOutbox.enqueue).not.toHaveBeenCalled();

      const attachBody = {
        jobId,
        burnTxHash: 'burn-observed',
        serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER,
        kernelAddress: KERNEL_ADDRESS,
      };
      const attachRes = mockRes();
      await router(mk('POST', '/api/vf-cross/farm/attach', attachBody), attachRes);
      expect(attachRes.statusCode).toBe(200);
      expect(jsonOf(attachRes)).toMatchObject({ jobId, attached: true });
      await vi.waitFor(() => expect(buildFarm).toHaveBeenCalledTimes(1));
      expect(buildFarm).toHaveBeenCalledTimes(1);
      expect(buildFarm).toHaveBeenCalledWith(SESSION_PRIVATE_KEY);
      expect(jobs.get(jobId)._attach.attachedBurnTxHash).toBe('burn-observed');
      expect(JSON.stringify(jobs.get(jobId))).not.toContain(SESSION_PRIVATE_KEY);

      expect(associationOutbox.enqueue).toHaveBeenCalledTimes(1);
      expect(associationOutbox.enqueue.mock.calls[0][0][0]).toMatchObject({
        expectedSequence: 0,
        lifecycle: {
          sequence: 1,
          status: 'submitted',
          evidence: { executionStatus: 'accepted', custodyLocation: 'in-transit', txHash: 'burn-observed' },
        },
      });

      const farmParams = farmFn.mock.calls[0][0];
      await farmParams.onMintConfirmed({
        status: 'minted',
        mintTxHash: '0xobserved-mint',
      });
      expect(associationOutbox.enqueue).toHaveBeenCalledTimes(2);
      expect(associationOutbox.enqueue.mock.calls[1][0][0]).toMatchObject({
        expectedSequence: 1,
        lifecycle: {
          sequence: 2,
          status: 'submitted',
          evidence: { executionStatus: 'minted', custodyLocation: 'agent', txHash: '0xobserved-mint' },
        },
      });

      const repeated = mockRes();
      await router(mk('POST', '/api/vf-cross/farm/attach', attachBody), repeated);
      expect(repeated.statusCode).toBe(200);
      expect(buildFarm).toHaveBeenCalledTimes(1);

      const conflicting = mockRes();
      await router(mk('POST', '/api/vf-cross/farm/attach', {
        ...attachBody,
        burnTxHash: 'different-burn',
      }), conflicting);
      expect(conflicting.statusCode).toBe(409);
      expect(buildFarm).toHaveBeenCalledTimes(1);

      resolveFarm({
        mintResult: { status: 'minted', mintTxHash: '0xobserved-mint' },
        depositResults: [],
        runId: 'run-42',
        bridgeAgent: 'CBRIDGE',
        grantTxHash: 'HGRANT',
      });
    });

    // Defect caught: after a crash persisted attachedBurnTxHash, an exact retry returned 200 but
    // never resumed the still-pending work. A second retry must not start another external flow.
    it('same-hash attach resumes pending persisted work exactly once', async () => {
      const { body, respBody } = await registerMandate(router);
      let resolveFarm;
      farmFn.mockImplementationOnce(() => new Promise((resolve) => { resolveFarm = resolve; }));
      jobs.set('job-retry', {
        status: 'pending',
        steps: [],
        runId: 'run-42',
        bridgeAgent: 'CBRIDGE',
        grantTxHash: 'HGRANT',
        _attach: {
          serializedApproval: body.serializedApproval,
          stellarOwner: STELLAR_OWNER,
          kernelAddress: KERNEL_ADDRESS,
          bindingId: respBody.bindingId,
          bindingHash: respBody.bindingHash,
          networkId: 'stellar-testnet',
          jobId: 'job-retry',
          allocations: [wireAllocation()],
          associations: [{ allocationId: 'run-42:bridge:aave-v3', terminalSequence: null }],
          attachedBurnTxHash: 'burn-retry',
        },
      });
      const attachBody = {
        jobId: 'job-retry',
        burnTxHash: 'burn-retry',
        serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER,
        kernelAddress: KERNEL_ADDRESS,
      };

      const first = mockRes();
      await router(mk('POST', '/api/vf-cross/farm/attach', attachBody), first);
      await vi.waitFor(() => expect(buildFarm).toHaveBeenCalledTimes(1));
      const second = mockRes();
      await router(mk('POST', '/api/vf-cross/farm/attach', attachBody), second);
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(buildFarm).toHaveBeenCalledTimes(1);

      resolveFarm({
        mintResult: { status: 'minted', mintTxHash: '0xmint' },
        depositResults: [],
        runId: 'run-42', bridgeAgent: 'CBRIDGE', grantTxHash: 'HGRANT',
      });
    });

    it('renews an active durable farm lease and an exact attach retry cannot reconcile it uncertain', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_900_000_000_000);
      const path = join(mkdtempSync(join(tmpdir(), 'vf-router-heartbeat-')), 'relayer.db');
      const stores = createSqliteStores(path, { now: () => Date.now() });
      let resolveFarm;
      farmFn.mockImplementationOnce(() => new Promise((resolve) => { resolveFarm = resolve; }));
      const durableRouter = makeRouter({
        jobs: stores.jobs,
        mandatesV2: stores.mandatesV2,
        associationOutbox: stores.associationOutbox,
        farmExecutions: stores.farmExecutions,
      });

      try {
        const { body } = await registerMandate(durableRouter);
        const queued = mockRes();
        await durableRouter(mk('POST', '/api/vf-cross/farm', {
          serializedApproval: body.serializedApproval,
          stellarOwner: STELLAR_OWNER,
          kernelAddress: KERNEL_ADDRESS,
          bridgeAgent: 'CBRIDGE',
          runId: 'run-heartbeat',
          grantTxHash: 'HGRANT',
          allocations: [wireAllocation({ allocationId: 'run-heartbeat:bridge:aave-v3' })],
        }), queued);
        const { jobId } = jsonOf(queued);

        const attached = await attachJob(durableRouter, jobId, body, 'burn-heartbeat');
        expect(attached.statusCode).toBe(200);
        expect(buildFarm).toHaveBeenCalledTimes(1);
        expect(stores.farmExecutions.get(jobId)).toMatchObject({
          status: 'running', attempts: 1,
        });

        await vi.advanceTimersByTimeAsync(30_001);
        expect(stores.farmExecutions.get(jobId).leaseExpiresAt).toBeGreaterThan(Date.now());

        const repeated = await attachJob(durableRouter, jobId, body, 'burn-heartbeat');
        expect(repeated.statusCode).toBe(200);
        expect(buildFarm).toHaveBeenCalledTimes(1);
        expect(stores.farmExecutions.get(jobId)).toMatchObject({
          status: 'running', attempts: 1,
        });

        resolveFarm({
          mintResult: { status: 'minted', mintTxHash: '0xmint-heartbeat' },
          depositResults: [{
            allocationId: 'run-heartbeat:bridge:aave-v3',
            executionStatus: 'deposited',
            custody: { location: 'base-proxy' },
            txHash: '0xdeposit-heartbeat',
          }],
          runId: 'run-heartbeat', bridgeAgent: 'CBRIDGE', grantTxHash: 'HGRANT',
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(stores.farmExecutions.get(jobId)).toMatchObject({
          status: 'done', attempts: 1, leaseToken: null, leaseExpiresAt: null,
        });
        const reports = stores.db.prepare(
          'SELECT report_json FROM association_outbox WHERE child_id = ? ORDER BY sequence ASC'
        ).all(jobId).map(({ report_json: reportJson }) => JSON.parse(reportJson));
        expect(reports).toHaveLength(3);
        expect(reports.at(-1)).toMatchObject({
          lifecycle: {
            sequence: 3,
            status: 'confirmed',
            evidence: {
              executionStatus: 'deposited',
              custodyLocation: 'base-proxy',
              txHash: '0xdeposit-heartbeat',
            },
          },
        });
        expect(reports.some((report) => report.lifecycle.evidence.executionStatus === 'unknown'))
          .toBe(false);
      } finally {
        stores.db.close();
        vi.useRealTimers();
      }
    });

    // Defect caught: server startup only restarted the association-delivery worker and never
    // dispatched durable farm work that crashed after attachment.
    it('exposes a startup reconciliation pass for persisted pending farm work', async () => {
      const { body, respBody } = await registerMandate(router);
      jobs.set('job-restart', {
        status: 'pending',
        steps: [],
        runId: 'run-42',
        bridgeAgent: 'CBRIDGE',
        grantTxHash: 'HGRANT',
        _attach: {
          serializedApproval: body.serializedApproval,
          stellarOwner: STELLAR_OWNER,
          kernelAddress: KERNEL_ADDRESS,
          bindingId: respBody.bindingId,
          bindingHash: respBody.bindingHash,
          networkId: 'stellar-testnet',
          jobId: 'job-restart',
          allocations: [wireAllocation()],
          associations: [{ allocationId: 'run-42:bridge:aave-v3', terminalSequence: null }],
          attachedBurnTxHash: 'burn-restart',
        },
      });
      farmFn.mockResolvedValueOnce({
        mintResult: { status: 'minted', mintTxHash: '0xmint' },
        depositResults: [],
        runId: 'run-42', bridgeAgent: 'CBRIDGE', grantTxHash: 'HGRANT',
      });

      expect(typeof router.resumeFarmJobs).toBe('function');
      await router.resumeFarmJobs();
      await vi.waitFor(() => expect(buildFarm).toHaveBeenCalledTimes(1));
    });

    // Defect caught: an expired running lease means the process may have completed a deposit
    // before crashing. Startup must make that evidence terminal-uncertain, never replay the farm.
    it('reconciles expired running work as terminal-uncertain without replaying a deposit', async () => {
      const path = join(mkdtempSync(join(tmpdir(), 'vf-router-recovery-')), 'relayer.db');
      const stores = createSqliteStores(path);
      const durableRouter = makeRouter({
        jobs: stores.jobs,
        mandatesV2: stores.mandatesV2,
        associationOutbox: stores.associationOutbox,
        farmExecutions: stores.farmExecutions,
      });
      const { body, respBody } = await registerMandate(durableRouter);
      const queued = {
        status: 'queued',
        steps: [],
        runId: 'run-42',
        bridgeAgent: 'CBRIDGE',
        grantTxHash: 'HGRANT',
        _attach: {
          serializedApproval: body.serializedApproval,
          stellarOwner: STELLAR_OWNER,
          kernelAddress: KERNEL_ADDRESS,
          bindingId: respBody.bindingId,
          bindingHash: respBody.bindingHash,
          networkId: 'stellar-testnet',
          jobId: 'job-ambiguous',
          allocations: [wireAllocation()],
          associations: [{ allocationId: 'run-42:bridge:aave-v3', terminalSequence: null }],
          attachedBurnTxHash: null,
        },
      };
      stores.jobs.set('job-ambiguous', queued);
      const attached = {
        ...queued,
        status: 'pending',
        _attach: { ...queued._attach, attachedBurnTxHash: 'burn-ambiguous' },
      };
      stores.farmExecutions.attach({
        jobId: 'job-ambiguous',
        burnTxHash: 'burn-ambiguous',
        job: attached,
        reports: [{
          identity: {
            networkId: 'stellar-testnet', owner: STELLAR_OWNER,
            bindingId: respBody.bindingId, allocationId: 'run-42:bridge:aave-v3',
            childId: 'job-ambiguous',
          },
          expectedSequence: 0,
          lifecycle: {
            sequence: 1, status: 'submitted',
            evidence: { executionStatus: 'accepted', custodyLocation: 'in-transit', txHash: 'burn-ambiguous' },
            observedAt: 2_000_000_000_001,
          },
        }],
      });
      stores.farmExecutions.claim({ jobId: 'job-ambiguous', now: 1, leaseMs: 1 });

      expect(typeof durableRouter.resumeFarmJobs).toBe('function');
      await durableRouter.resumeFarmJobs();

      expect(buildFarm).not.toHaveBeenCalled();
      expect(stores.farmExecutions.get('job-ambiguous')).toMatchObject({ status: 'uncertain' });
      expect(stores.jobs.get('job-ambiguous')).toMatchObject({
        status: 'uncertain',
        _attach: {
          associations: [{ allocationId: 'run-42:bridge:aave-v3', terminalSequence: 2 }],
        },
      });
      expect(stores.associationOutbox.status('job-ambiguous')).toEqual([
        expect.objectContaining({ allocationId: 'run-42:bridge:aave-v3', sequence: 1 }),
        expect.objectContaining({ allocationId: 'run-42:bridge:aave-v3', sequence: 2 }),
      ]);
      stores.db.close();
    });

    // Defect caught: a durable terminal transaction could fail after the external farm returned,
    // leaving the public job as nonterminal/complete-looking until a process restart reconciled it.
    it('exposes a durable finish failure as immediately uncertain without replaying the farm', async () => {
      const path = join(mkdtempSync(join(tmpdir(), 'vf-router-finish-')), 'relayer.db');
      const stores = createSqliteStores(path);
      const finish = vi.fn(() => { throw new Error('durable finish commit failed'); });
      const durableRouter = makeRouter({
        jobs: stores.jobs,
        mandatesV2: stores.mandatesV2,
        associationOutbox: stores.associationOutbox,
        farmExecutions: { ...stores.farmExecutions, finish },
      });
      const { body } = await registerMandate(durableRouter);
      const queued = mockRes();
      await durableRouter(mk('POST', '/api/vf-cross/farm', {
        serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER,
        kernelAddress: KERNEL_ADDRESS,
        bridgeAgent: 'CBRIDGE',
        runId: 'run-finish',
        grantTxHash: 'HGRANT',
        allocations: [wireAllocation({ allocationId: 'run-finish:bridge:aave-v3' })],
      }), queued);
      const { jobId } = jsonOf(queued);

      const attached = await attachJob(durableRouter, jobId, body, 'burn-finish');
      expect(attached.statusCode).toBe(200);
      await vi.waitFor(() => expect(finish).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(stores.jobs.get(jobId)).toMatchObject({
        status: 'error',
        associationUncertain: true,
        steps: expect.arrayContaining([
          expect.objectContaining({
            step: 'association-persistence',
            status: 'error',
            message: 'durable finish commit failed',
          }),
        ]),
      }));

      const status = mockRes();
      await durableRouter(mk('GET', `/api/vf-cross/status/${jobId}`), status);
      expect(jsonOf(status)).toMatchObject({
        status: 'error',
        associationDelivery: { complete: false, uncertain: true },
      });
      expect(jsonOf(status)).not.toHaveProperty('associationUncertain');
      expect(stores.farmExecutions.get(jobId)).toMatchObject({ status: 'running' });

      const repeated = await attachJob(durableRouter, jobId, body, 'burn-finish');
      expect(repeated.statusCode).toBe(200);
      expect(buildFarm).toHaveBeenCalledTimes(1);
      expect(stores.farmExecutions.get(jobId)).toMatchObject({ status: 'running' });
      stores.db.close();
    });

    // Defect caught: when a farm threw after its durable mint checkpoint and the terminal
    // transaction also failed, the fallback discarded the mint step. Expiry recovery then tried
    // to replace the immutable sequence-2 minted row with a sequence-2 failure forever.
    it('recovers a post-mint farm and finish failure at sequence 3 exactly once without replay', async () => {
      const path = join(mkdtempSync(join(tmpdir(), 'vf-router-post-mint-')), 'relayer.db');
      let clock = Date.now();
      const stores = createSqliteStores(path, { now: () => clock });
      const finish = vi.fn(() => { throw new Error('durable terminal commit failed'); });
      farmFn.mockImplementationOnce(async ({ onMintConfirmed }) => {
        await onMintConfirmed({ status: 'minted', mintTxHash: '0xmint-before-failure' });
        throw new Error('deposit failed after mint');
      });
      const durableRouter = makeRouter({
        jobs: stores.jobs,
        mandatesV2: stores.mandatesV2,
        associationOutbox: stores.associationOutbox,
        farmExecutions: { ...stores.farmExecutions, finish },
      });
      const { body } = await registerMandate(durableRouter);
      const queued = mockRes();
      await durableRouter(mk('POST', '/api/vf-cross/farm', {
        serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER,
        kernelAddress: KERNEL_ADDRESS,
        bridgeAgent: 'CBRIDGE',
        runId: 'run-post-mint',
        grantTxHash: 'HGRANT',
        allocations: [wireAllocation({ allocationId: 'run-post-mint:bridge:aave-v3' })],
      }), queued);
      const { jobId } = jsonOf(queued);

      const attached = await attachJob(durableRouter, jobId, body, 'burn-post-mint');
      expect(attached.statusCode).toBe(200);
      await vi.waitFor(() => expect(finish).toHaveBeenCalledTimes(1));
      const durableMint = JSON.parse(stores.db.prepare(
        'SELECT report_json FROM association_outbox WHERE child_id = ? AND sequence = 2'
      ).get(jobId).report_json);
      const immediate = mockRes();
      await durableRouter(mk('GET', `/api/vf-cross/status/${jobId}`), immediate);
      const immediateJob = jsonOf(immediate);

      clock += 30_001;
      let firstRecoveryError = null;
      try {
        await durableRouter.resumeFarmJobs();
      } catch (error) {
        firstRecoveryError = error;
      }
      const afterFirstRecovery = stores.associationOutbox.status(jobId);
      let secondRecoveryError = null;
      try {
        await durableRouter.resumeFarmJobs();
      } catch (error) {
        secondRecoveryError = error;
      }
      const afterSecondRecovery = stores.associationOutbox.status(jobId);

      expect({
        durableMint,
        immediateJob,
        firstRecoveryError,
        secondRecoveryError,
        workStatus: stores.farmExecutions.get(jobId)?.status,
        afterFirstRecovery: afterFirstRecovery.map(({ sequence }) => sequence),
        afterSecondRecovery: afterSecondRecovery.map(({ sequence }) => sequence),
        farmCalls: farmFn.mock.calls.length,
        buildCalls: buildFarm.mock.calls.length,
      }).toMatchObject({
        durableMint: {
          lifecycle: {
            sequence: 2,
            status: 'submitted',
            evidence: {
              executionStatus: 'minted',
              custodyLocation: 'agent',
              txHash: '0xmint-before-failure',
            },
          },
        },
        immediateJob: {
          status: 'error',
          steps: expect.arrayContaining([
            expect.objectContaining({
              step: 'mint', status: 'minted', mintTxHash: '0xmint-before-failure',
            }),
            expect.objectContaining({
              step: 'farm', status: 'error', message: 'deposit failed after mint',
            }),
            expect.objectContaining({
              step: 'association-persistence',
              status: 'error',
              message: 'durable terminal commit failed',
            }),
          ]),
          associationDelivery: { complete: false, uncertain: true },
        },
        firstRecoveryError: null,
        secondRecoveryError: null,
        workStatus: 'uncertain',
        afterFirstRecovery: [1, 2, 3],
        afterSecondRecovery: [1, 2, 3],
        farmCalls: 1,
        buildCalls: 1,
      });
      stores.db.close();
    });

    it('rejects attach when approval/owner/kernel or the stored mandate binding changed', async () => {
      const { body } = await registerMandate(router);
      const queuedRes = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', {
        serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER,
        kernelAddress: KERNEL_ADDRESS,
        bridgeAgent: 'CBRIDGE',
        runId: 'run-42',
        grantTxHash: 'HGRANT',
        allocations: [wireAllocation()],
      }), queuedRes);
      const { jobId } = jsonOf(queuedRes);

      for (const changed of [
        { serializedApproval: 'different-approval' },
        { stellarOwner: OTHER_STELLAR_OWNER },
        { kernelAddress: OTHER_KERNEL_ADDRESS },
      ]) {
        const res = mockRes();
        await router(mk('POST', '/api/vf-cross/farm/attach', {
          jobId,
          serializedApproval: body.serializedApproval,
          stellarOwner: STELLAR_OWNER,
          kernelAddress: KERNEL_ADDRESS,
          ...changed,
        }), res);
        expect(res.statusCode).toBe(400);
      }

      await registerMandate(router, body);
      const changedBinding = mockRes();
      await router(mk('POST', '/api/vf-cross/farm/attach', {
        jobId,
        burnTxHash: 'burn-1',
        serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER,
        kernelAddress: KERNEL_ADDRESS,
      }), changedBinding);
      expect(changedBinding.statusCode).toBe(400);
      expect(jsonOf(changedBinding).error).toMatch(/binding/i);
      expect(buildFarm).not.toHaveBeenCalled();
    });

    it('400s "unknown mandate" once the registered record\'s own expiresAt has passed — mandatesV2.get() itself evicts it, before touching buildFarm', async () => {
      mandatesV2.set({
        serializedApproval: 'approval-x', sessionPrivateKey: SESSION_PRIVATE_KEY, sessionKeyAddress: SESSION_KEY_ADDRESS,
        stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS, relayerOrigin: null,
        expiresAt: Date.now() - 1000, status: 'active', bindingId: 'b1', bindingHash: 'h1', createdAt: Date.now() - 2000,
      });
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', {
        serializedApproval: 'approval-x',
        stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS,
        allocations: [wireAllocation()],
      }), res);
      expect(res.statusCode).toBe(400);
      expect(jsonOf(res).error).toMatch(/unknown mandate/);
      expect(buildFarm).not.toHaveBeenCalled();
    });

    it('400s "relayer origin mismatch" when the stored record\'s relayerOrigin disagrees with this server\'s configured origin', async () => {
      const routerA = makeRouter({ relayerOrigin: 'https://relayer-a.example' });
      const { body } = await registerMandate(routerA);
      const routerB = makeRouter({ relayerOrigin: 'https://relayer-b.example' }); // same mandatesV2, different config
      const res = mockRes();
      await routerB(mk('POST', '/api/vf-cross/farm', {
        serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS,
        allocations: [wireAllocation()],
      }), res);
      expect(res.statusCode).toBe(400);
      expect(jsonOf(res).error).toMatch(/relayer origin/);
      expect(buildFarm).not.toHaveBeenCalled();
    });

    it('dispatches using the STORED session key, parses poolAddress/amount.units/minShares, carries runId/bridgeAgent/grantTxHash onto the job, and never leaks the key', async () => {
      const { body } = await registerMandate(router);
      let resolveFarm;
      farmFn.mockImplementationOnce(() => new Promise((resolve) => { resolveFarm = resolve; }));

      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', {
        sourceDomain: 999, // must be ignored — the flow hardcodes domains.stellar
        serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS,
        bridgeAgent: 'CBRIDGE', runId: 'run-42', grantTxHash: 'HGRANT',
        allocations: [wireAllocation({ units: 100n, minShares: '90' })],
      }), res);

      expect(res.statusCode).toBe(201);
      const { jobId } = jsonOf(res);
      expect(jobs.get(jobId)).toMatchObject({ status: 'queued', runId: 'run-42', bridgeAgent: 'CBRIDGE', grantTxHash: 'HGRANT' });
      const attachRes = await attachJob(router, jobId, body);
      expect(attachRes.statusCode).toBe(200);
      await vi.waitFor(() => expect(buildFarm).toHaveBeenCalledTimes(1));
      expect(buildFarm).toHaveBeenCalledWith(SESSION_PRIVATE_KEY);
      expect(farmFn).toHaveBeenCalledWith({
        burnTxHash: 'burn-1', execId: 'burn-1', approval: body.serializedApproval,
        allocations: [{
          allocationId: 'run-42:bridge:aave-v3',
          pool: POOL_ADDRESS,
          amount: 100n,
          minShares: 90n,
          reportAmount: { token: 'USDC', units: '100', decimals: 6 },
          proxyTarget: 'aave-v3',
        }],
        runId: 'run-42', bridgeAgent: 'CBRIDGE', grantTxHash: 'HGRANT',
        onMintConfirmed: expect.any(Function),
      });

      resolveFarm({
        mintResult: { status: 'minted', mintTxHash: '0xmint' },
        depositResults: [{ status: 'fulfilled', pool: POOL_ADDRESS }],
        runId: 'run-42', bridgeAgent: 'CBRIDGE', grantTxHash: 'HGRANT',
      });
      await vi.waitFor(() => expect(jobs.get(jobId).status).toBe('done'));
      expect(jobs.get(jobId)).toMatchObject({ runId: 'run-42', bridgeAgent: 'CBRIDGE', grantTxHash: 'HGRANT' });
      expect(JSON.stringify(jobs.get(jobId))).not.toContain(SESSION_PRIVATE_KEY);
    });

    it('rejects missing, cross-run, or noncanonical allocation IDs before accepting a job', async () => {
      const { body } = await registerMandate(router);
      for (const allocation of [
        { ...wireAllocation(), allocationId: undefined },
        wireAllocation({ allocationId: 'run-other:bridge:aave-v3' }),
        wireAllocation({ allocationId: 'run-42:bridge:moonwell' }),
      ]) {
        const res = mockRes();
        await router(mk('POST', '/api/vf-cross/farm', {
          serializedApproval: body.serializedApproval,
          stellarOwner: STELLAR_OWNER,
          kernelAddress: KERNEL_ADDRESS,
          bridgeAgent: 'CBRIDGE',
          runId: 'run-42',
          grantTxHash: 'HGRANT',
          allocations: [allocation],
        }), res);
        expect(res.statusCode).toBe(400);
        expect(jsonOf(res).error).toMatch(/allocationId|canonical|proxy/i);
      }
      expect(buildFarm).not.toHaveBeenCalled();
      expect(agentIndexReporter.commitIntent).not.toHaveBeenCalled();
    });

    it('preserves reordered canonical allocation IDs instead of reconstructing array positions', async () => {
      const reorderedRouter = makeRouter({
        poolTargets: new Map([
          [POOL_ADDRESS.toLowerCase(), 'aave-v3'],
          [SECOND_POOL_ADDRESS.toLowerCase(), 'moonwell'],
        ]),
      });
      const { body } = await registerMandate(reorderedRouter);
      let resolveFarm;
      farmFn.mockImplementationOnce(() => new Promise((resolve) => { resolveFarm = resolve; }));
      const res = mockRes();
      await reorderedRouter(mk('POST', '/api/vf-cross/farm', {
        serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER,
        kernelAddress: KERNEL_ADDRESS,
        bridgeAgent: 'CBRIDGE',
        runId: 'run-42',
        grantTxHash: 'HGRANT',
        allocations: [
          wireAllocation({
            allocationId: 'run-42:bridge:moonwell',
            pool: SECOND_POOL_ADDRESS,
          }),
          wireAllocation({
            allocationId: 'run-42:bridge:aave-v3',
            pool: POOL_ADDRESS,
          }),
        ],
      }), res);

      expect(res.statusCode).toBe(201);
      await attachJob(reorderedRouter, jsonOf(res).jobId, body);
      await vi.waitFor(() => expect(farmFn).toHaveBeenCalledTimes(1));
      expect(farmFn.mock.calls[0][0].allocations.map((a) => a.allocationId)).toEqual([
        'run-42:bridge:moonwell',
        'run-42:bridge:aave-v3',
      ]);
      resolveFarm({
        mintResult: { status: 'minted', mintTxHash: '0xmint' },
        depositResults: [],
        runId: 'run-42',
        bridgeAgent: 'CBRIDGE',
        grantTxHash: 'HGRANT',
      });
    });

    it('commits exact immutable child intent before burn, then enqueues each lifecycle transition', async () => {
      const { body, respBody } = await registerMandate(router);
      let resolveFarm;
      farmFn.mockImplementationOnce(() => new Promise((resolve) => { resolveFarm = resolve; }));
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', {
        serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS,
        bridgeAgent: 'CBRIDGE', runId: 'run-42', grantTxHash: 'HGRANT',
        allocations: [wireAllocation({ allocationId: 'run-42:bridge:aave-v3' })],
      }), res);
      const { jobId } = jsonOf(res);

      expect(res.statusCode).toBe(201);
      expect(agentIndexReporter.commitIntent).toHaveBeenCalledWith({
        version: 1,
        networkId: 'stellar-testnet',
        owner: STELLAR_OWNER,
        agent: 'CBRIDGE',
        bindingId: respBody.bindingId,
        allocationId: 'run-42:bridge:aave-v3',
        childId: jobId,
        intent: {
          token: 'USDC', units: '100', decimals: 6,
          poolAddress: POOL_ADDRESS, proxyTarget: 'aave-v3',
          runId: 'run-42', grantTxHash: 'HGRANT', kernelAddress: KERNEL_ADDRESS,
          bindingHash: respBody.bindingHash, baseJobId: jobId,
        },
        lifecycle: { sequence: 0, status: 'planned', evidence: {}, observedAt: expect.any(Number) },
      });
      expect(JSON.stringify(agentIndexReporter.commitIntent.mock.calls)).not.toContain(SESSION_PRIVATE_KEY);

      await attachJob(router, jobId, body);
      expect(associationOutbox.enqueue).toHaveBeenNthCalledWith(1, [{
        identity: {
          networkId: 'stellar-testnet', owner: STELLAR_OWNER,
          bindingId: respBody.bindingId, allocationId: 'run-42:bridge:aave-v3', childId: jobId,
        },
        expectedSequence: 0,
        lifecycle: {
          sequence: 1, status: 'submitted',
          evidence: { executionStatus: 'accepted', custodyLocation: 'in-transit', txHash: 'burn-1' },
          observedAt: expect.any(Number),
        },
      }]);

      await vi.waitFor(() => expect(farmFn).toHaveBeenCalledTimes(1));
      await farmFn.mock.calls[0][0].onMintConfirmed({
        status: 'minted',
        mintTxHash: '0xmint',
      });
      expect(associationOutbox.enqueue).toHaveBeenNthCalledWith(2, [expect.objectContaining({
        expectedSequence: 1,
        lifecycle: expect.objectContaining({
          sequence: 2, status: 'submitted',
          evidence: { executionStatus: 'minted', custodyLocation: 'agent', txHash: '0xmint' },
        }),
      })]);

      resolveFarm({
        mintResult: { status: 'minted', mintTxHash: '0xmint' },
        depositResults: [{
          allocationId: 'run-42:bridge:aave-v3',
          pool: POOL_ADDRESS,
          status: 'fulfilled',
          executionStatus: 'deposited',
          custody: { location: 'base-proxy' },
          txHash: '0xdeposit',
        }],
        runId: 'run-42', bridgeAgent: 'CBRIDGE', grantTxHash: 'HGRANT',
      });
      await vi.waitFor(() => expect(associationOutbox.enqueue).toHaveBeenCalledTimes(3));
      expect(associationOutbox.enqueue).toHaveBeenNthCalledWith(3, [expect.objectContaining({
        expectedSequence: 2,
        lifecycle: expect.objectContaining({
          sequence: 3, status: 'confirmed',
          evidence: { executionStatus: 'deposited', custodyLocation: 'base-proxy', txHash: '0xdeposit' },
        }),
      })]);
      expect(JSON.stringify(associationOutbox.enqueue.mock.calls)).not.toContain(SESSION_PRIVATE_KEY);
    });

    // Defect caught: incomplete/malformed orchestrator result arrays silently omitted terminal
    // lifecycle evidence for expected child allocations.
    it('creates one explicit terminal report for every expected allocation', async () => {
      const completeRouter = makeRouter({
        poolTargets: new Map([
          [POOL_ADDRESS.toLowerCase(), 'aave-v3'],
          [SECOND_POOL_ADDRESS.toLowerCase(), 'moonwell'],
        ]),
      });
      const { body } = await registerMandate(completeRouter);
      farmFn.mockImplementationOnce(async (params) => {
        await params.onMintConfirmed({ status: 'minted', mintTxHash: '0xmint' });
        return {
          mintResult: { status: 'minted', mintTxHash: '0xmint' },
          depositResults: [{
            allocationId: 'run-42:bridge:aave-v3',
            executionStatus: 'deposited',
            custody: { location: 'base-proxy' },
            txHash: '0xdeposit',
          }],
          runId: 'run-42', bridgeAgent: 'CBRIDGE', grantTxHash: 'HGRANT',
        };
      });
      const queued = mockRes();
      await completeRouter(mk('POST', '/api/vf-cross/farm', {
        serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER,
        kernelAddress: KERNEL_ADDRESS,
        bridgeAgent: 'CBRIDGE', runId: 'run-42', grantTxHash: 'HGRANT',
        allocations: [
          wireAllocation(),
          wireAllocation({ allocationId: 'run-42:bridge:moonwell', pool: SECOND_POOL_ADDRESS }),
        ],
      }), queued);
      await attachJob(completeRouter, jsonOf(queued).jobId, body);

      await vi.waitFor(() => expect(associationOutbox.enqueue).toHaveBeenCalledTimes(3));
      const terminalReports = associationOutbox.enqueue.mock.calls[2][0];
      expect(terminalReports).toHaveLength(2);
      expect(terminalReports.find((report) =>
        report.identity.allocationId === 'run-42:bridge:moonwell'
      )).toMatchObject({
        lifecycle: {
          sequence: 3,
          status: 'unknown',
          evidence: { executionStatus: 'unknown', custodyLocation: 'unknown', txHash: null },
        },
      });
    });

    // Defect caught: terminal enqueue exceptions were swallowed, leaving the public job looking
    // complete when association evidence was actually uncertain.
    it('surfaces terminal lifecycle enqueue uncertainty on the public job', async () => {
      const { body } = await registerMandate(router);
      associationOutbox.enqueue
        .mockImplementationOnce((reports) => ({ status: 'pending', reports }))
        .mockImplementationOnce((reports) => ({ status: 'pending', reports }))
        .mockImplementation(() => { throw new Error('sqlite write uncertain'); });
      farmFn.mockImplementationOnce(async (params) => {
        await params.onMintConfirmed({ status: 'minted', mintTxHash: '0xmint' });
        return {
          mintResult: { status: 'minted', mintTxHash: '0xmint' },
          depositResults: [{
            allocationId: 'run-42:bridge:aave-v3',
            executionStatus: 'deposited',
            custody: { location: 'base-proxy' },
            txHash: '0xdeposit',
          }],
          runId: 'run-42', bridgeAgent: 'CBRIDGE', grantTxHash: 'HGRANT',
        };
      });
      const queued = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', {
        serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER,
        kernelAddress: KERNEL_ADDRESS,
        bridgeAgent: 'CBRIDGE', runId: 'run-42', grantTxHash: 'HGRANT',
        allocations: [wireAllocation()],
      }), queued);
      const { jobId } = jsonOf(queued);
      await attachJob(router, jobId, body);
      await vi.waitFor(() => expect(jobs.get(jobId).status).toBe('error'));

      const status = mockRes();
      await router(mk('GET', `/api/vf-cross/status/${jobId}`), status);
      expect(jsonOf(status).associationDelivery).toMatchObject({ complete: false, uncertain: true });
    });

    it('keeps observed mint custody and hash when a deposit is held', async () => {
      const { body } = await registerMandate(router);
      let resolveFarm;
      farmFn.mockImplementationOnce(() => new Promise((resolve) => { resolveFarm = resolve; }));
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', {
        serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER,
        kernelAddress: KERNEL_ADDRESS,
        bridgeAgent: 'CBRIDGE',
        runId: 'run-42',
        grantTxHash: 'HGRANT',
        allocations: [wireAllocation()],
      }), res);
      await attachJob(router, jsonOf(res).jobId, body);
      await vi.waitFor(() => expect(farmFn).toHaveBeenCalledTimes(1));
      await farmFn.mock.calls[0][0].onMintConfirmed({
        status: 'minted',
        mintTxHash: '0xmint-held',
      });
      resolveFarm({
        mintResult: { status: 'minted', mintTxHash: '0xmint-held' },
        depositResults: [{
          allocationId: 'run-42:bridge:aave-v3',
          executionStatus: 'held',
          custody: { location: 'agent' },
          txHash: null,
        }],
        runId: 'run-42',
        bridgeAgent: 'CBRIDGE',
        grantTxHash: 'HGRANT',
      });

      await vi.waitFor(() => expect(associationOutbox.enqueue).toHaveBeenCalledTimes(3));
      expect(associationOutbox.enqueue.mock.calls[2][0][0]).toMatchObject({
        expectedSequence: 2,
        lifecycle: {
          sequence: 3, status: 'unknown', observedAt: expect.any(Number),
          evidence: { executionStatus: 'held', custodyLocation: 'agent', txHash: '0xmint-held' },
        },
      });
    });

    it('keeps observed mint custody and hash when the farm later throws', async () => {
      const { body } = await registerMandate(router);
      let rejectFarm;
      farmFn.mockImplementationOnce(
        () => new Promise((_resolve, reject) => { rejectFarm = reject; }),
      );
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', {
        serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER,
        kernelAddress: KERNEL_ADDRESS,
        bridgeAgent: 'CBRIDGE',
        runId: 'run-42',
        grantTxHash: 'HGRANT',
        allocations: [wireAllocation()],
      }), res);
      await attachJob(router, jsonOf(res).jobId, body);
      await vi.waitFor(() => expect(farmFn).toHaveBeenCalledTimes(1));
      await farmFn.mock.calls[0][0].onMintConfirmed({
        status: 'minted',
        mintTxHash: '0xmint-failed',
      });
      rejectFarm(new Error('deposit dispatch failed after mint'));

      await vi.waitFor(() => expect(associationOutbox.enqueue).toHaveBeenCalledTimes(3));
      expect(associationOutbox.enqueue.mock.calls[2][0][0]).toMatchObject({
        expectedSequence: 2,
        lifecycle: {
          sequence: 3, status: 'failed', observedAt: expect.any(Number),
          evidence: { executionStatus: 'failed', custodyLocation: 'agent', txHash: '0xmint-failed' },
        },
      });
    });

    it('rejects an unallowlisted pool before accepting or reporting the job', async () => {
      const { body } = await registerMandate(router);
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', {
        serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS,
        bridgeAgent: 'CBRIDGE', runId: 'run-42', grantTxHash: 'HGRANT',
        allocations: [wireAllocation({ pool: `0x${'99'.repeat(20)}` })],
      }), res);
      expect(res.statusCode).toBe(400);
      expect(jsonOf(res).error).toMatch(/pool/i);
      expect(agentIndexReporter.commitIntent).not.toHaveBeenCalled();
    });

    // Re-review fix: a failed job used to drop runId/bridgeAgent/grantTxHash entirely (recordError
    // replaced the whole job object) — exactly where My Money's durable index needs the
    // association most (this project's known "relayer 'failed' != bridge failed" hazard).
    it('lands the job in error status (message only, never the key) when the farm flow rejects — runId/bridgeAgent/grantTxHash survive on the error record', async () => {
      const { body } = await registerMandate(router);
      farmFn.mockRejectedValueOnce(new Error(`deposit into ${POOL_ADDRESS} was mined but did not succeed`));
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', {
        serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS,
        bridgeAgent: 'CBRIDGE', runId: 'run-42', grantTxHash: 'HGRANT',
        allocations: [wireAllocation()],
      }), res);
      const { jobId } = jsonOf(res);
      await attachJob(router, jobId, body);
      await vi.waitFor(() => expect(jobs.get(jobId).status).toBe('error'));
      expect(JSON.stringify(jobs.get(jobId))).toMatch(/was mined but did not succeed/);
      expect(JSON.stringify(jobs.get(jobId))).not.toContain(SESSION_PRIVATE_KEY);
      expect(jobs.get(jobId)).toMatchObject({ runId: 'run-42', bridgeAgent: 'CBRIDGE', grantTxHash: 'HGRANT' });
    });

    // Fix loop 2, Fix 1: /farm/attach guarded only truthiness (`!burnTxHash`), so a number,
    // object, array, or boolean passed straight through to attachContext.attachedBurnTxHash,
    // permanently consuming the job's single attach slot. /farm already rejects a non-string,
    // non-null burnTxHash (see the test above using a real 'burn-1' string) — this locks the same
    // rule at /farm/attach, via the shared isValidBurnTxHash guard.
    it('rejects a non-string burnTxHash at /farm/attach before any job mutation', async () => {
      const { body } = await registerMandate(router);
      const queuedRes = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', {
        serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER,
        kernelAddress: KERNEL_ADDRESS,
        bridgeAgent: 'CBRIDGE',
        runId: 'run-42',
        grantTxHash: 'HGRANT',
        allocations: [wireAllocation()],
      }), queuedRes);
      const { jobId } = jsonOf(queuedRes);

      for (const badBurnTxHash of [12345, { evil: true }, ['burn-1'], true, '']) {
        const res = mockRes();
        await router(mk('POST', '/api/vf-cross/farm/attach', {
          jobId,
          burnTxHash: badBurnTxHash,
          serializedApproval: body.serializedApproval,
          stellarOwner: STELLAR_OWNER,
          kernelAddress: KERNEL_ADDRESS,
        }), res);
        expect(res.statusCode, JSON.stringify(badBurnTxHash)).toBe(400);
        expect(jobs.get(jobId)._attach.attachedBurnTxHash).toBeNull();
        expect(jobs.get(jobId).status).toBe('queued');
      }
      expect(buildFarm).not.toHaveBeenCalled();

      // A genuine string burn still attaches normally afterward — the guard doesn't over-reject.
      const okRes = mockRes();
      await router(mk('POST', '/api/vf-cross/farm/attach', {
        jobId,
        burnTxHash: 'burn-observed',
        serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER,
        kernelAddress: KERNEL_ADDRESS,
      }), okRes);
      expect(okRes.statusCode).toBe(200);
    });

    // Fix loop 2, Fix 4: relayer/src/httpRouter.mjs:269-270 did BigInt(units)/BigInt(minShares)
    // behind only a `!= null` guard, and the cap check only bounds the top. '0', a negative
    // string, a number, a boolean, exponential notation, and padded whitespace all coerce
    // successfully via BigInt() yet the D1 index layer (associations.js's amount.units rule,
    // `/^\d+$/` and `> 0n`) always rejects them downstream — mirror that rule at the wire seam so
    // both layers agree instead of dispatching a report the index will only ever refuse.
    for (const badUnits of ['0', '-1', 1234, true, '1e6', ' 12 ']) {
      it(`rejects a non-canonical amount.units (${JSON.stringify(badUnits)}) at /farm before dispatch`, async () => {
        const { body } = await registerMandate(router);
        const res = mockRes();
        await router(mk('POST', '/api/vf-cross/farm', {
          serializedApproval: body.serializedApproval,
          stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS,
          bridgeAgent: 'CBRIDGE', runId: 'run-42', grantTxHash: 'HGRANT',
          allocations: [{
            allocationId: 'run-42:bridge:aave-v3',
            poolAddress: POOL_ADDRESS,
            amount: { token: 'USDC', units: badUnits, decimals: 6 },
            minShares: '90',
          }],
        }), res);
        expect(res.statusCode).toBe(400);
        expect(farmFn).not.toHaveBeenCalled();
      });
    }

    // minShares='0' is deliberately NOT in the rejection list above: unlike amount.units, a zero
    // minShares floor is a legitimate (if degenerate — "accept any share price") deposit, not
    // malformed input, so only its canonical-decimal-string shape is enforced, never a > 0n floor.
    for (const badMinShares of ['-1', 1234, true, '1e6', ' 12 ']) {
      it(`rejects a non-canonical minShares (${JSON.stringify(badMinShares)}) at /farm before dispatch`, async () => {
        const { body } = await registerMandate(router);
        const res = mockRes();
        await router(mk('POST', '/api/vf-cross/farm', {
          serializedApproval: body.serializedApproval,
          stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS,
          bridgeAgent: 'CBRIDGE', runId: 'run-42', grantTxHash: 'HGRANT',
          allocations: [wireAllocation({ minShares: badMinShares })],
        }), res);
        expect(res.statusCode).toBe(400);
        expect(farmFn).not.toHaveBeenCalled();
      });
    }

    it('accepts minShares "0" as a legitimate no-slippage-floor value, and a valid decimal amount still executes', async () => {
      const { body } = await registerMandate(router);
      let resolveFarm;
      farmFn.mockImplementationOnce(() => new Promise((resolve) => { resolveFarm = resolve; }));
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', {
        serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS,
        bridgeAgent: 'CBRIDGE', runId: 'run-42', grantTxHash: 'HGRANT',
        allocations: [wireAllocation({ minShares: '0' })],
      }), res);
      expect(res.statusCode).toBe(201);
      await attachJob(router, jsonOf(res).jobId, body);
      await vi.waitFor(() => expect(farmFn).toHaveBeenCalledTimes(1));
      expect(farmFn.mock.calls[0][0].allocations[0].minShares).toBe(0n);
      resolveFarm({
        mintResult: { status: 'minted', mintTxHash: '0xmint' },
        depositResults: [],
        runId: 'run-42', bridgeAgent: 'CBRIDGE', grantTxHash: 'HGRANT',
      });
    });
  });

  describe('GET /status/:jobId', () => {
    it('404s when the jobId is unknown', async () => {
      const res = mockRes();
      await router(mk('GET', '/api/vf-cross/status/nope'), res);
      expect(res.statusCode).toBe(404);
    });

    it('never treats an empty delivery set as complete', async () => {
      jobs.set('job-x', { status: 'done', steps: [{ step: 'mint', status: 'minted' }] });
      const res = mockRes();
      await router(mk('GET', '/api/vf-cross/status/job-x'), res);
      expect(res.statusCode).toBe(200);
      expect(jsonOf(res)).toEqual({
        status: 'done',
        steps: [{ step: 'mint', status: 'minted' }],
        associationDelivery: { complete: false, uncertain: false, events: [] },
      });
    });

    // Defect caught: delivered sequence 1 alone passed Array.every and hid missing terminal rows;
    // coverage must be contiguous through each persisted allocation's terminal sequence.
    it('requires contiguous delivered evidence through every expected allocation terminal', async () => {
      jobs.set('job-coverage', {
        status: 'done',
        steps: [],
        _attach: {
          associations: [
            { allocationId: 'allocation-a', terminalSequence: 3 },
            { allocationId: 'allocation-b', terminalSequence: 2 },
          ],
        },
      });
      associationOutbox.status.mockReturnValue([
        { allocationId: 'allocation-a', sequence: 1, status: 'delivered', attempts: 1 },
        { allocationId: 'allocation-b', sequence: 1, status: 'delivered', attempts: 1 },
      ]);
      const incomplete = mockRes();
      await router(mk('GET', '/api/vf-cross/status/job-coverage'), incomplete);
      expect(jsonOf(incomplete).associationDelivery).toMatchObject({
        complete: false,
        uncertain: true,
        events: [expect.objectContaining({ allocationId: 'allocation-a' })],
      });

      associationOutbox.status.mockReturnValue([
        { allocationId: 'allocation-a', sequence: 1, status: 'delivered', attempts: 1 },
        { allocationId: 'allocation-a', sequence: 2, status: 'delivered', attempts: 1 },
        { allocationId: 'allocation-a', sequence: 3, status: 'delivered', attempts: 1 },
        { allocationId: 'allocation-b', sequence: 1, status: 'delivered', attempts: 1 },
        { allocationId: 'allocation-b', sequence: 2, status: 'delivered', attempts: 1 },
      ]);
      const complete = mockRes();
      await router(mk('GET', '/api/vf-cross/status/job-coverage'), complete);
      expect(jsonOf(complete).associationDelivery).toMatchObject({ complete: true, uncertain: false });
    });
  });

  describe('POST /unwind', () => {
    it('400s when required fields are missing', async () => {
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/unwind', { unwindTxHash: 'unwind-1' }), res);
      expect(res.statusCode).toBe(400);
    });

    it('responds with a jobId and relays only the reverse mint — never dispatches a withdraw', async () => {
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/unwind', {
        unwindTxHash: 'unwind-1', stellarRecipient: 'GABCDEF',
      }), res);
      expect(res.statusCode).toBe(200);
      const { jobId } = jsonOf(res);
      await vi.waitFor(() => expect(jobs.get(jobId).status).toBe('done'));
      expect(relayUnwindMint).toHaveBeenCalledWith({ unwindTxHash: 'unwind-1', stellarRecipient: 'GABCDEF' });
      expect(buildFarm).not.toHaveBeenCalled();
    });

    it('lands the job in error status when relayUnwindMint rejects', async () => {
      relayUnwindMint.mockRejectedValueOnce(new Error('iris attestation timed out'));
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/unwind', {
        unwindTxHash: 'unwind-1', stellarRecipient: 'GABCDEF',
      }), res);
      const { jobId } = jsonOf(res);
      await vi.waitFor(() => expect(jobs.get(jobId).status).toBe('error'));
      expect(JSON.stringify(jobs.get(jobId))).toMatch(/iris attestation timed out/);
    });
  });

  describe('sanitizeErrors mode (public deploy)', () => {
    let sanitized;
    beforeEach(() => {
      sanitized = makeRouter({ sanitizeErrors: true });
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('replaces a farm error message with a generic one — the raw error never reaches GET /status', async () => {
      const { body } = await registerMandate(sanitized);
      farmFn.mockRejectedValueOnce(new Error('RPC https://secret-node.internal/xyz refused: pool reverted'));
      const res = mockRes();
      await sanitized(mk('POST', '/api/vf-cross/farm', {
        serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS,
        bridgeAgent: 'CBRIDGE', runId: 'run-42', grantTxHash: 'HGRANT',
        allocations: [wireAllocation()],
      }), res);
      const { jobId } = jsonOf(res);
      await attachJob(sanitized, jobId, body);
      await vi.waitFor(() => expect(jobs.get(jobId).status).toBe('error'));

      const statusRes = mockRes();
      await sanitized(mk('GET', `/api/vf-cross/status/${jobId}`), statusRes);
      expect(jsonOf(statusRes).steps[0].message).toBe('internal error');
      expect(statusRes.body).not.toContain('secret-node.internal');
      expect(console.error).toHaveBeenCalled(); // the real error is still logged server-side
    });

    it('sanitizes an unwind error too', async () => {
      relayUnwindMint.mockRejectedValueOnce(new Error('iris https://iris.internal timed out'));
      const res = mockRes();
      await sanitized(mk('POST', '/api/vf-cross/unwind', {
        unwindTxHash: 'unwind-1', stellarRecipient: 'GABCDEF',
      }), res);
      const { jobId } = jsonOf(res);
      await vi.waitFor(() => expect(jobs.get(jobId).status).toBe('error'));
      expect(JSON.stringify(jobs.get(jobId))).not.toContain('iris.internal');
      expect(jobs.get(jobId).steps[0].message).toBe('internal error');
    });
  });
});

describe('v3 mandate registration and activation worker', () => {
  const NOW_SECONDS = 2_000_000_000;
  const VALID_UNTIL_SECONDS = NOW_SECONDS + 7_200;
  const MANDATE_ID = '0123456789abcdef0123456789abcdef';
  const CAPABILITY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const CAPABILITY_HASH = 'a8ae6e6ee929abea3afcfc5258c8ccd6f85273e0d4626d26c7279f3250f77c8e';
  const OWNER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey();
  const KERNEL = `0x${'11'.repeat(20)}`;
  const SESSION_KEY = `0x${'22'.repeat(32)}`;
  const SESSION = privateKeyToAccount(SESSION_KEY).address;
  const USER_OP_HASH = `0x${'33'.repeat(32)}`;
  const TX_HASH = `0x${'44'.repeat(32)}`;
  const CALL_POLICY = '0x9a52283276A0ec8740DF50bF01B28A80D880eaf2';
  const TIMESTAMP_POLICY = '0xB9f8f524bE6EcD8C945b1b87f9ae5C192FdCE20F';
  const ECDSA_SIGNER = '0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF';
  const CANONICAL_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
  const CANONICAL_ROUTER = '0xF80aa8F571E6d24Ea72F051Fc6F9A9C516727B6d';
  const DEFAULT_ACTION_SELECTOR = '0xe9ae5c53';
  const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;
  const POLICY = Object.freeze({
    chainId: 84532,
    kernelVersion: '0.3.1',
    kernelImplementation: '0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D',
    entryPointVersion: '0.7',
    entryPointAddress: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
    callPolicyVersion: '0.0.4',
    callPolicyAddress: CALL_POLICY,
    timestampPolicyAddress: TIMESTAMP_POLICY,
    ecdsaSignerAddress: ECDSA_SIGNER,
    usdcAddress: CANONICAL_USDC,
    yieldRouterAddress: CANONICAL_ROUTER,
    approveSelector: '0x095ea7b3',
    depositSelector: '0x0efe6a8b',
    callType: 'call',
    nativeValue: '0',
    executionHorizonSeconds: 2_700,
  });
  const CONFIG = Object.freeze({
    publicOrigin: 'https://relayer.example',
    base: { chain: { id: 84532 }, mandatePolicy: POLICY },
  });

  function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
  }

  function serializeCanonical(value) {
    return Buffer.from(JSON.stringify(value, (_, child) => (
      typeof child === 'bigint' ? child.toString() : child
    )), 'utf8').toString('base64');
  }

  function canonicalPermissions(cap = MAX_CALL_CAP_UNITS) {
    const encodedCap = pad(`0x${cap.toString(16)}`, { size: 32 });
    return [
      {
        target: CANONICAL_USDC,
        valueLimit: '0',
        functionName: 'approve',
        args: [
          { condition: ParamCondition.EQUAL, value: CANONICAL_ROUTER },
          { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: cap.toString() },
        ],
        callType: '0x00',
        selector: '0x095ea7b3',
        rules: [
          { params: [pad(CANONICAL_ROUTER, { size: 32 })], offset: 0, condition: ParamCondition.EQUAL },
          { params: [encodedCap], offset: 32, condition: ParamCondition.LESS_THAN_OR_EQUAL },
        ],
      },
      {
        target: CANONICAL_ROUTER,
        valueLimit: '0',
        functionName: 'deposit',
        args: [null, { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: cap.toString() }, null],
        callType: '0x00',
        selector: '0x0efe6a8b',
        rules: [
          { params: [encodedCap], offset: 32, condition: ParamCondition.LESS_THAN_OR_EQUAL },
        ],
      },
    ];
  }

  function canonicalPermissionId(entries) {
    const policiesData = encodeAbiParameters(
      [{ name: 'policiesData', type: 'bytes[]' }],
      [entries.map((entry) => concatHex([entry.getPolicyInfoInBytes(), entry.getPolicyData()]))],
    );
    const signerData = encodeAbiParameters(
      [{ name: 'signerData', type: 'bytes' }],
      [concatHex([ECDSA_SIGNER, SESSION])],
    );
    return slice(keccak256(encodeAbiParameters(
      [{ name: 'policyAndSignerData', type: 'bytes[]' }],
      [[policiesData, '0x0000', signerData]],
    )), 0, 4).toLowerCase();
  }

  function canonicalApproval(validUntilSeconds = VALID_UNTIL_SECONDS) {
    const call = toCallPolicy({
      policyVersion: '0.0.4',
      permissions: canonicalPermissions(),
    });
    const timestamp = toTimestampPolicy({ validAfter: 0, validUntil: validUntilSeconds });
    return serializeCanonical({
      permissionParams: {
        permissionId: canonicalPermissionId([call, timestamp]),
        policies: [call, timestamp],
      },
      action: { selector: DEFAULT_ACTION_SELECTOR, address: ZERO_ADDRESS },
      validityData: { validAfter: 0, validUntil: 0 },
      accountParams: { initCode: '0x', accountAddress: KERNEL },
      enableSignature: '0x1234',
      isPreInstalled: false,
    });
  }

  function mandateIdAt(index) {
    return index.toString(16).padStart(32, '0');
  }

  function capabilityAt(index) {
    return index.toString(16).padStart(64, '0');
  }

  function registrationBody(overrides = {}) {
    const expiresAt = overrides.expiresAt ?? VALID_UNTIL_SECONDS;
    return {
      mandateId: MANDATE_ID,
      capability: CAPABILITY,
      serializedApproval: canonicalApproval(expiresAt),
      sessionPrivateKey: SESSION_KEY,
      sessionKeyAddress: SESSION,
      expiresAt,
      stellarOwner: OWNER,
      kernelAddress: KERNEL,
      ...overrides,
    };
  }

  function identityOf(body) {
    return {
      mandateId: body.mandateId,
      stellarOwner: body.stellarOwner,
      kernelAddress: body.kernelAddress,
    };
  }

  function canonicalRecord(body, bindingId = 'binding-1') {
    const bindingHash = sha256(
      `${body.stellarOwner}|${body.kernelAddress}|${body.sessionKeyAddress}|${body.expiresAt}`,
    );
    const validation = validateMandateBinding({
      serializedApproval: body.serializedApproval,
      sessionPrivateKey: body.sessionPrivateKey,
      sessionKeyAddress: body.sessionKeyAddress,
      stellarOwner: body.stellarOwner,
      kernelAddress: body.kernelAddress,
      validUntilSeconds: body.expiresAt,
      expiresAt: body.expiresAt,
      relayerOrigin: CONFIG.publicOrigin,
      bindingId,
      bindingHash,
      config: CONFIG,
      now: NOW_SECONDS,
    });
    if (!validation.ok) throw new Error(`invalid Task-4 fixture: ${validation.reason}`);
    return {
      mandateId: body.mandateId,
      approvalDigest: sha256(body.serializedApproval),
      policyDigest: validation.mandate.policyDigest,
      serializedApproval: body.serializedApproval,
      sessionPrivateKey: body.sessionPrivateKey,
      sessionKeyAddress: body.sessionKeyAddress,
      capabilityHash: sha256(body.capability),
      stellarOwner: body.stellarOwner,
      kernelAddress: body.kernelAddress,
      relayerOrigin: CONFIG.publicOrigin,
      validUntilSeconds: body.expiresAt,
      bindingId,
      bindingHash,
      permissionId: validation.mandate.permissionId,
    };
  }

  function tracedStores(real, events, { transformMandateGet, enqueueError } = {}) {
    const mandatesV3 = {
      get(identity) {
        events.push('store:get');
        const record = real.mandatesV3.get(identity);
        return transformMandateGet?.(record, identity) ?? record;
      },
      status(identity) {
        events.push('store:status');
        return real.mandatesV3.status(identity);
      },
      revoke(identity) {
        events.push('store:revoke');
        return real.mandatesV3.revoke(identity);
      },
      get size() { return real.mandatesV3.size; },
    };
    const mandateActivations = {
      enqueue(input) {
        events.push('store:enqueue');
        if (enqueueError) throw enqueueError;
        return real.mandateActivations.enqueue(input);
      },
      get(identity) {
        events.push('store:work:get');
        return real.mandateActivations.get(identity);
      },
      claim(input) {
        events.push('store:claim');
        return real.mandateActivations.claim(input);
      },
      renew(input) {
        events.push('store:renew');
        return real.mandateActivations.renew(input);
      },
      checkpoint(input) {
        events.push(`store:checkpoint:${input.status}`);
        return real.mandateActivations.checkpoint(input);
      },
      finishActive(input) {
        events.push('store:finishActive');
        return real.mandateActivations.finishActive(input);
      },
      finishUncertain(input) {
        events.push('store:finishUncertain');
        return real.mandateActivations.finishUncertain(input);
      },
      finishRevoked(input) {
        events.push('store:finishRevoked');
        return real.mandateActivations.finishRevoked(input);
      },
      listRecoverable(input) {
        events.push('store:listRecoverable');
        return real.mandateActivations.listRecoverable(input);
      },
      reconcileExpired(input) {
        events.push('store:reconcileExpired');
        return real.mandateActivations.reconcileExpired(input);
      },
    };
    return { mandatesV3, mandateActivations };
  }

  function makeHarness({
    clock = { value: NOW_SECONDS },
    activateMandate,
    evaluateMandateStatusFn,
    transformMandateGet,
    enqueueError,
    realStores = null,
    bindingPrefix = 'binding',
  } = {}) {
    const events = [];
    const real = realStores ?? createMandateStoresV3({
      nowSeconds: () => clock.value,
      leaseToken: (() => {
        let value = 0;
        return () => `activation-lease-${++value}`;
      })(),
    });
    const traced = tracedStores(real, events, { transformMandateGet, enqueueError });
    const evaluatorCalls = [];
    const activatorCalls = [];
    const activator = activateMandate ?? (async (approval, { onSubmitted } = {}) => {
      activatorCalls.push(approval);
      events.push('activator:called');
      events.push('activator:onSubmitted');
      await onSubmitted(USER_OP_HASH);
      events.push('activator:receipt');
      return { userOpHash: USER_OP_HASH, txHash: TX_HASH };
    });
    const evaluator = evaluateMandateStatusFn ?? (async (args) => {
      evaluatorCalls.push(args);
      events.push('evaluator:called');
      return { status: 'active', reasonCodes: [] };
    });
    let nextId = 0;
    const router = createRelayerRouter({
      buildFarm: vi.fn(() => ({ farm: vi.fn() })),
      relayUnwindMint: vi.fn(),
      jobs: new Map(),
      mandatesV2: new Proxy({}, {
        get() { throw new Error('v2 mandate store must not be consulted by the v3 router'); },
      }),
      mandatesV3: traced.mandatesV3,
      mandateActivations: traced.mandateActivations,
      buildMandateActivator: (sessionPrivateKey) => ({
        activateMandate: async (...args) => {
          events.push(`activator:key:${sessionPrivateKey}`);
          return activator(...args);
        },
      }),
      genId: () => `${bindingPrefix}-${++nextId}`,
      usdcAddress: CANONICAL_USDC,
      yieldRouterAddress: CANONICAL_ROUTER,
      relayerOrigin: CONFIG.publicOrigin,
      mandateStatusConfig: CONFIG,
      evaluateMandateStatusFn: evaluator,
      nowSeconds: () => clock.value,
      publicRuntime: { networkId: 'stellar-testnet', mandateStatusConfig: CONFIG },
    });
    return {
      clock,
      events,
      real,
      mandatesV3: traced.mandatesV3,
      mandateActivations: traced.mandateActivations,
      evaluatorCalls,
      activatorCalls,
      router,
    };
  }

  function request(body, capability) {
    return {
      method: 'POST',
      url: '/api/vf-cross/mandate',
      body,
      headers: capability === undefined
        ? {}
        : { authorization: `Bearer ${capability}` },
    };
  }

  async function postMandate(harness, body, { response, bearer } = {}) {
    const res = response ?? mockRes();
    await harness.router(request(body, bearer), res);
    return { res, json: jsonOf(res) };
  }

  async function waitForStatus(harness, body, status) {
    await vi.waitFor(() => {
      expect(harness.real.mandatesV3.status(identityOf(body)).status).toBe(status);
    });
  }

  function expectOrdered(events, checkpoints) {
    let cursor = -1;
    for (const checkpoint of checkpoints) {
      const next = events.indexOf(checkpoint, cursor + 1);
      expect(next, `missing or out-of-order checkpoint ${checkpoint}`).toBeGreaterThan(cursor);
      cursor = next;
    }
  }

  it.each([
    ['short mandate ID', { mandateId: MANDATE_ID.slice(1) }],
    ['uppercase mandate ID', { mandateId: MANDATE_ID.toUpperCase() }],
    ['non-hex mandate ID', { mandateId: `${MANDATE_ID.slice(0, -1)}g` }],
    ['short capability', { capability: CAPABILITY.slice(1) }],
    ['uppercase capability', { capability: CAPABILITY.toUpperCase() }],
    ['non-hex capability', { capability: `${CAPABILITY.slice(0, -1)}g` }],
  ])('rejects a %s at the exact 32/64 lowercase-hex registration boundary', async (_label, change) => {
    const harness = makeHarness();
    const body = registrationBody(change);

    const { res } = await postMandate(harness, body);

    expect(res.statusCode).toBe(400);
    expect(harness.real.mandatesV3.size).toBe(0);
    expect(res.body).not.toContain(String(change.mandateId ?? change.capability));
    expect(res.body).not.toContain(body.serializedApproval);
    expect(res.body).not.toContain(CAPABILITY);
    expect(res.body).not.toContain(SESSION_KEY);
  });

  it('atomically enqueues before the exact private 202 response and stores only capability/key hashes publicly', async () => {
    const harness = makeHarness();
    const body = registrationBody();
    let endSnapshot;
    const res = {
      ...mockRes(),
      end(payload) {
        this.body = payload ?? '';
        endSnapshot = {
          mandate: harness.real.mandatesV3.status(identityOf(body)),
          work: harness.real.mandateActivations.get(identityOf(body)),
        };
        return this;
      },
    };

    await postMandate(harness, body, { response: res });

    const bindingHash = sha256(`${OWNER}|${KERNEL}|${SESSION}|${VALID_UNTIL_SECONDS}`);
    expect(res.statusCode).toBe(202);
    expect(jsonOf(res)).toEqual({
      ok: true,
      status: 'pending_activation',
      mandateId: MANDATE_ID,
      bindingId: 'binding-1',
      bindingHash,
      relayerOrigin: CONFIG.publicOrigin,
    });
    expect(res.headers['Set-Cookie']).toBe(
      `__Host-vf-mandate-${MANDATE_ID}=${CAPABILITY}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=7200`,
    );
    expect(endSnapshot).toMatchObject({
      mandate: { mandateId: MANDATE_ID, status: 'pending_activation' },
      work: { mandateId: MANDATE_ID, status: 'pending', attempts: 0 },
    });
    const internal = harness.real.mandatesV3.get(identityOf(body));
    expect(internal.capabilityHash).toBe(CAPABILITY_HASH);
    expect(internal.sessionPrivateKey).toBe(SESSION_KEY);
    expect(Object.keys(internal)).not.toContain('capabilityHash');
    expect(JSON.stringify(harness.real.mandatesV3.status(identityOf(body)))).not.toContain(CAPABILITY);
    expect(JSON.stringify(harness.real.mandatesV3.status(identityOf(body)))).not.toContain(SESSION_KEY);
    expect(res.body).not.toContain(CAPABILITY);
    expect(res.body).not.toContain(body.serializedApproval);
    expect(res.body).not.toContain(SESSION_KEY);
  });

  it('returns a generic failure without a cookie or partial row when atomic enqueue fails', async () => {
    const harness = makeHarness({
      enqueueError: new Error(`storage unavailable for ${CAPABILITY} ${SESSION_KEY}`),
    });
    const body = registrationBody();

    const { res } = await postMandate(harness, body);

    expect(res.statusCode).toBe(500);
    expect(res.headers['Set-Cookie']).toBeUndefined();
    expect(harness.real.mandatesV3.size).toBe(0);
    expect(harness.real.mandateActivations.get(identityOf(body))).toBeNull();
    expect(res.body).not.toContain(CAPABILITY);
    expect(res.body).not.toContain(SESSION_KEY);
    expect(res.body).not.toContain(body.serializedApproval);

    const duplicateFailure = makeHarness({
      enqueueError: new Error(`duplicate storage unavailable for ${CAPABILITY} ${SESSION_KEY}`),
    });
    duplicateFailure.real.mandateActivations.enqueue({ record: canonicalRecord(body) });
    const duplicate = await postMandate(duplicateFailure, { ...body });
    expect(duplicate.res.statusCode).toBe(500);
    expect(duplicate.res.headers['Set-Cookie']).toBeUndefined();
    expect(duplicate.res.body).not.toContain(CAPABILITY);
    expect(duplicate.res.body).not.toContain(SESSION_KEY);
    expect(duplicate.res.body).not.toContain(body.serializedApproval);
  });

  it('authenticates exact duplicates before comparison and never reactivates pending or active bindings', async () => {
    let releaseActivation;
    const activationGate = new Promise((resolve) => { releaseActivation = resolve; });
    let sends = 0;
    const harness = makeHarness({
      activateMandate: async (_approval, { onSubmitted }) => {
        sends += 1;
        await onSubmitted(USER_OP_HASH);
        await activationGate;
        return { userOpHash: USER_OP_HASH, txHash: TX_HASH };
      },
    });
    const body = registrationBody();
    const first = await postMandate(harness, body);
    await vi.waitFor(() => expect(sends).toBe(1));

    const secondBody = registrationBody({
      mandateId: mandateIdAt(2),
      capability: capabilityAt(2),
    });
    const second = await postMandate(harness, secondBody);
    expect(second.res.statusCode).toBe(202);
    await vi.waitFor(() => expect(sends).toBe(2));

    const pendingDuplicate = await postMandate(harness, { ...body });
    expect(pendingDuplicate.res.statusCode).toBe(202);
    expect(pendingDuplicate.json).toEqual(first.json);
    expect(pendingDuplicate.res.headers['Set-Cookie']).toBe(first.res.headers['Set-Cookie']);
    expect(sends).toBe(2);

    const crossMandateCapability = await postMandate(harness, {
      ...body,
      capability: secondBody.capability,
    });
    expect(crossMandateCapability.res.statusCode).toBe(401);
    expect(crossMandateCapability.res.body).not.toContain(secondBody.capability);
    expect(crossMandateCapability.res.body).not.toContain(body.serializedApproval);
    expect(sends).toBe(2);

    const wrong = capabilityAt(99);
    const wrongCapability = await postMandate(harness, { ...body, capability: wrong });
    expect(wrongCapability.res.statusCode).toBe(401);
    expect(wrongCapability.res.body).not.toContain(wrong);
    expect(wrongCapability.res.body).not.toContain(CAPABILITY);
    expect(sends).toBe(2);

    const missingCapability = await postMandate(harness, { ...body, capability: undefined });
    expect(missingCapability.res.statusCode).toBe(401);
    expect(sends).toBe(2);

    releaseActivation();
    await waitForStatus(harness, body, 'active');
    await waitForStatus(harness, secondBody, 'active');
    const activeDuplicate = await postMandate(harness, { ...body });
    expect(activeDuplicate.res.statusCode).toBe(202);
    expect(activeDuplicate.json).toEqual(first.json);
    expect(activeDuplicate.json.status).toBe('pending_activation');
    expect(sends).toBe(2);
  });

  it('returns 409 for exact duplicates whose durable state is uncertain, revoked, or expired', async () => {
    const uncertain = makeHarness({
      activateMandate: async () => { throw new Error(`bundler rejected ${SESSION_KEY}`); },
    });
    const uncertainBody = registrationBody();
    await postMandate(uncertain, uncertainBody);
    await waitForStatus(uncertain, uncertainBody, 'activation_uncertain');
    const uncertainRetry = await postMandate(uncertain, { ...uncertainBody });
    expect(uncertainRetry.res.statusCode).toBe(409);
    expect(uncertainRetry.res.body).not.toContain(SESSION_KEY);

    const revoked = makeHarness();
    const revokedBody = registrationBody();
    await postMandate(revoked, revokedBody);
    await waitForStatus(revoked, revokedBody, 'active');
    revoked.real.mandatesV3.revoke(identityOf(revokedBody));
    const revokedRetry = await postMandate(revoked, { ...revokedBody });
    expect(revokedRetry.res.statusCode).toBe(409);

    const clock = { value: NOW_SECONDS };
    const expired = makeHarness({ clock });
    const expiredBody = registrationBody();
    await postMandate(expired, expiredBody);
    await waitForStatus(expired, expiredBody, 'active');
    clock.value = VALID_UNTIL_SECONDS;
    expect(expired.real.mandatesV3.status(identityOf(expiredBody)).status).toBe('expired');
    const expiredRetry = await postMandate(expired, { ...expiredBody });
    expect(expiredRetry.res.statusCode).toBe(409);
  });

  it('fails closed without activating when the stored immutable binding is corrupted before worker use', async () => {
    let corruptNextRead = true;
    let sends = 0;
    const harness = makeHarness({
      transformMandateGet(record) {
        if (!record || !corruptNextRead) return record;
        corruptNextRead = false;
        const corrupted = { ...record, bindingHash: 'ff'.repeat(32) };
        Object.defineProperty(corrupted, 'sessionPrivateKey', {
          value: record.sessionPrivateKey,
          enumerable: false,
        });
        Object.defineProperty(corrupted, 'capabilityHash', {
          value: record.capabilityHash,
          enumerable: false,
        });
        return corrupted;
      },
      activateMandate: async () => {
        sends += 1;
        return { userOpHash: USER_OP_HASH, txHash: TX_HASH };
      },
    });
    const body = registrationBody();

    const { res } = await postMandate(harness, body);
    expect(res.statusCode).toBe(202);
    await vi.waitFor(() => {
      expect(['activation_uncertain', 'revoked'])
        .toContain(harness.real.mandatesV3.status(identityOf(body)).status);
    });

    expect(sends).toBe(0);
    expect(harness.events).not.toContain('store:checkpoint:submitted');
    expect(harness.events).not.toContain('evaluator:called');
    expect(harness.events).not.toContain('store:finishActive');
    await harness.router.resumeMandateActivations();
    expect(sends).toBe(0);
  });

  it('orders claim, submitting fence, activation submission, strict receipt, fresh evidence, and active finish', async () => {
    const harness = makeHarness();
    // Address comparisons are case-insensitive, so a lowercase equivalent accepted at the wire
    // boundary must not be tombstoned later when the store normalizes it or the parser derives a
    // checksummed spelling.
    const body = registrationBody({ sessionKeyAddress: SESSION.toLowerCase() });

    const { res } = await postMandate(harness, body);
    expect(res.statusCode).toBe(202);
    await waitForStatus(harness, body, 'active');

    expectOrdered(harness.events, [
      'store:claim',
      'store:get',
      'store:checkpoint:submitting',
      'activator:called',
      'activator:onSubmitted',
      'store:checkpoint:submitted',
      'activator:receipt',
      'evaluator:called',
      'store:finishActive',
    ]);
    const evaluatorIndex = harness.events.indexOf('evaluator:called');
    const recordReads = harness.events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event === 'store:get')
      .map(({ index }) => index);
    expect(recordReads.filter((index) => index < evaluatorIndex).length).toBeGreaterThanOrEqual(2);
    expect(recordReads.some((index) => index > evaluatorIndex)).toBe(true);
    expect(harness.events).toContain(`activator:key:${SESSION_KEY}`);
    expect(harness.evaluatorCalls).toHaveLength(1);
    expect(harness.evaluatorCalls[0]).toMatchObject({
      config: CONFIG,
      record: {
        mandateId: MANDATE_ID,
        activationUserOpHash: USER_OP_HASH,
        activationTxHash: TX_HASH,
        activatedAt: NOW_SECONDS,
        sessionPrivateKey: SESSION_KEY,
      },
    });
    // The real evaluator's canonical parser consumes a shallow copy of this trusted internal
    // record. The key must therefore remain visible to that parser even though no public/store
    // serialization may expose it.
    expect({ ...harness.evaluatorCalls[0].record }.sessionPrivateKey).toBe(SESSION_KEY);
    expect(harness.evaluatorCalls[0]).not.toHaveProperty('allocation');
    expect(harness.real.mandatesV3.status(identityOf(body))).toMatchObject({
      status: 'active',
      activationUserOpHash: USER_OP_HASH,
      activationTxHash: TX_HASH,
      activatedAt: NOW_SECONDS,
    });
  });

  it.each([
    ['before onSubmitted', false, null],
    ['after onSubmitted', true, USER_OP_HASH],
  ])('makes an activation failure %s uncertain without inventing evidence', async (_label, submitFirst, expectedHash) => {
    const harness = makeHarness({
      activateMandate: async (_approval, { onSubmitted }) => {
        if (submitFirst) await onSubmitted(USER_OP_HASH);
        throw new Error(`private activation failure ${SESSION_KEY}`);
      },
    });
    const body = registrationBody();

    const { res } = await postMandate(harness, body);
    expect(res.statusCode).toBe(202);
    expect(res.body).not.toContain(SESSION_KEY);
    await waitForStatus(harness, body, 'activation_uncertain');

    expect(harness.real.mandateActivations.get(identityOf(body))).toMatchObject({
      status: 'uncertain',
      userOpHash: expectedHash,
      txHash: null,
      leaseToken: null,
    });
    expect(harness.events).toContain('store:finishUncertain');
    expect(JSON.stringify(harness.real.mandatesV3.status(identityOf(body))))
      .not.toContain('private activation failure');
  });

  it('rejects a mismatched strict activator result without evaluation, active finish, or resend', async () => {
    const mismatchedHash = `0x${'55'.repeat(32)}`;
    let sends = 0;
    let evaluations = 0;
    const harness = makeHarness({
      activateMandate: async (_approval, { onSubmitted }) => {
        sends += 1;
        await onSubmitted(USER_OP_HASH);
        return { userOpHash: mismatchedHash, txHash: TX_HASH };
      },
      evaluateMandateStatusFn: async () => {
        evaluations += 1;
        return { status: 'active', reasonCodes: [] };
      },
    });
    const body = registrationBody();

    await postMandate(harness, body);
    await waitForStatus(harness, body, 'activation_uncertain');

    expect(harness.real.mandateActivations.get(identityOf(body))).toMatchObject({
      status: 'uncertain',
      userOpHash: USER_OP_HASH,
      txHash: null,
    });
    expect(evaluations).toBe(0);
    expect(harness.events).not.toContain('store:finishActive');
    await harness.router.resumeMandateActivations();
    expect(sends).toBe(1);
  });

  it('retains both receipt hashes as uncertain when fresh post-receipt evidence is nonactive', async () => {
    const harness = makeHarness({
      evaluateMandateStatusFn: async () => ({ status: 'unknown', reasonCodes: ['RPC_ERROR'] }),
    });
    const body = registrationBody();

    await postMandate(harness, body);
    await waitForStatus(harness, body, 'activation_uncertain');

    expect(harness.real.mandateActivations.get(identityOf(body))).toMatchObject({
      status: 'uncertain',
      userOpHash: USER_OP_HASH,
      txHash: TX_HASH,
    });
    expect(harness.events).not.toContain('store:finishActive');
  });

  it('atomically tombstones and erases the key when fresh receipt evidence says revoked', async () => {
    const harness = makeHarness({
      evaluateMandateStatusFn: async () => ({ status: 'revoked', reasonCodes: ['PERMISSION_REVOKED'] }),
    });
    const body = registrationBody();

    await postMandate(harness, body);
    await waitForStatus(harness, body, 'revoked');

    expect(harness.real.mandatesV3.status(identityOf(body))).toMatchObject({
      status: 'revoked',
      activationUserOpHash: USER_OP_HASH,
      activationTxHash: TX_HASH,
    });
    expect(harness.real.mandateActivations.get(identityOf(body))).toBeNull();
    const internal = harness.real.mandatesV3.get(identityOf(body));
    expect(internal.sessionPrivateKey).toBeUndefined();
    expect(internal.capabilityHash).toBe(CAPABILITY_HASH);
    expect(harness.events).toContain('store:finishRevoked');
  });

  it('reconciles restart leases and resumes only stale-running and untouched-pending work once', async () => {
    const clock = { value: NOW_SECONDS };
    const invalidCapabilityId = mandateIdAt(5);
    const harness = makeHarness({
      clock,
      transformMandateGet(record, identity) {
        if (!record || identity.mandateId !== invalidCapabilityId) return record;
        const descriptors = Object.getOwnPropertyDescriptors(record);
        descriptors.capabilityHash = {
          ...descriptors.capabilityHash,
          value: 'not-a-canonical-capability-hash',
        };
        return Object.create(Object.getPrototypeOf(record), descriptors);
      },
    });
    const bodies = [1, 2, 3, 4].map((index) => registrationBody({
      mandateId: mandateIdAt(index),
      capability: capabilityAt(index),
    }));
    for (const [index, body] of bodies.entries()) {
      harness.real.mandateActivations.enqueue({
        record: canonicalRecord(body, `resume-binding-${index + 1}`),
      });
    }
    const legacyBody = registrationBody({
      mandateId: 'legacy-uuid-mandate-id',
      capability: capabilityAt(5),
    });
    harness.real.mandateActivations.enqueue({
      record: canonicalRecord(legacyBody, 'legacy-binding'),
    });
    const invalidCapabilityBody = registrationBody({
      mandateId: invalidCapabilityId,
      capability: capabilityAt(5),
    });
    harness.real.mandateActivations.enqueue({
      record: canonicalRecord(invalidCapabilityBody, 'invalid-capability-binding'),
    });
    const [running, submitting, submitted, pending] = bodies;
    const runningLease = harness.real.mandateActivations.claim({
      ...identityOf(running), nowSeconds: NOW_SECONDS, leaseSeconds: 5,
    });
    const submittingLease = harness.real.mandateActivations.claim({
      ...identityOf(submitting), nowSeconds: NOW_SECONDS, leaseSeconds: 5,
    });
    harness.real.mandateActivations.checkpoint({
      ...identityOf(submitting), leaseToken: submittingLease.leaseToken,
      status: 'submitting', nowSeconds: NOW_SECONDS,
    });
    const submittedLease = harness.real.mandateActivations.claim({
      ...identityOf(submitted), nowSeconds: NOW_SECONDS, leaseSeconds: 5,
    });
    harness.real.mandateActivations.checkpoint({
      ...identityOf(submitted), leaseToken: submittedLease.leaseToken,
      status: 'submitting', nowSeconds: NOW_SECONDS,
    });
    harness.real.mandateActivations.checkpoint({
      ...identityOf(submitted), leaseToken: submittedLease.leaseToken,
      status: 'submitted', userOpHash: USER_OP_HASH, nowSeconds: NOW_SECONDS,
    });
    expect(runningLease.status).toBe('running');
    expect(harness.real.mandateActivations.get(identityOf(pending)).status).toBe('pending');
    clock.value = NOW_SECONDS + 6;

    await harness.router.resumeMandateActivations();
    await waitForStatus(harness, running, 'active');
    await waitForStatus(harness, pending, 'active');

    expect(harness.real.mandatesV3.status(identityOf(submitting)).status)
      .toBe('activation_uncertain');
    expect(harness.real.mandatesV3.status(identityOf(submitted)).status)
      .toBe('activation_uncertain');
    expect(harness.real.mandateActivations.get(identityOf(submitting))).toMatchObject({
      status: 'uncertain', userOpHash: null,
    });
    expect(harness.real.mandateActivations.get(identityOf(submitted))).toMatchObject({
      status: 'uncertain', userOpHash: USER_OP_HASH,
    });
    expect(harness.events.filter((event) => event === 'activator:called')).toHaveLength(2);
    expect(harness.events.filter((event) => event === 'store:reconcileExpired')).toHaveLength(1);
    expect(harness.real.mandatesV3.status(identityOf(legacyBody)).status).toBe('revoked');
    expect(harness.real.mandatesV3.status(identityOf(invalidCapabilityBody)).status).toBe('revoked');
  });

  it('deduplicates concurrent restart resumes and duplicate HTTP registration', async () => {
    let releaseActivation;
    const gate = new Promise((resolve) => { releaseActivation = resolve; });
    let sends = 0;
    const harness = makeHarness({
      activateMandate: async (_approval, { onSubmitted }) => {
        sends += 1;
        await onSubmitted(USER_OP_HASH);
        await gate;
        return { userOpHash: USER_OP_HASH, txHash: TX_HASH };
      },
    });
    const body = registrationBody();

    const firstResponse = mockRes();
    const retryResponse = mockRes();
    const work = [
      harness.router(request({ ...body }), firstResponse),
      harness.router(request({ ...body }), retryResponse),
      harness.router.resumeMandateActivations(),
      harness.router.resumeMandateActivations(),
    ];
    await vi.waitFor(() => expect(sends).toBe(1));
    expect(firstResponse.statusCode).toBe(202);
    expect(retryResponse.statusCode).toBe(202);
    expect(jsonOf(retryResponse)).toEqual(jsonOf(firstResponse));
    expect(retryResponse.headers['Set-Cookie']).toBe(firstResponse.headers['Set-Cookie']);
    releaseActivation();
    await Promise.all(work);
    await waitForStatus(harness, body, 'active');

    expect(sends).toBe(1);
    expect(harness.real.mandateActivations.get(identityOf(body)).attempts).toBe(1);

    const authorityRace = makeHarness();
    const correctResponse = mockRes();
    const wrongResponse = mockRes();
    const wrongCapability = capabilityAt(99);
    await Promise.all([
      authorityRace.router(request({ ...body }), correctResponse),
      authorityRace.router(request({ ...body, capability: wrongCapability }), wrongResponse),
    ]);
    await waitForStatus(authorityRace, body, 'active');
    expect(correctResponse.statusCode).toBe(202);
    expect(wrongResponse.statusCode).toBe(401);
    expect(wrongResponse.body).not.toContain(wrongCapability);
    expect(authorityRace.activatorCalls).toHaveLength(1);

    const sharedClock = { value: NOW_SECONDS };
    const sharedReal = createMandateStoresV3({
      nowSeconds: () => sharedClock.value,
      leaseToken: (() => {
        let value = 0;
        return () => `shared-activation-lease-${++value}`;
      })(),
    });
    const left = makeHarness({
      clock: sharedClock,
      realStores: sharedReal,
      bindingPrefix: 'left-binding',
    });
    const right = makeHarness({
      clock: sharedClock,
      realStores: sharedReal,
      bindingPrefix: 'right-binding',
    });
    const sharedLeftResponse = mockRes();
    const sharedRightResponse = mockRes();
    await Promise.all([
      left.router(request({ ...body }), sharedLeftResponse),
      right.router(request({ ...body }), sharedRightResponse),
    ]);
    await waitForStatus(left, body, 'active');
    expect(sharedLeftResponse.statusCode).toBe(202);
    expect(sharedRightResponse.statusCode).toBe(202);
    expect(jsonOf(sharedRightResponse)).toEqual(jsonOf(sharedLeftResponse));
    expect(sharedRightResponse.headers['Set-Cookie']).toBe(sharedLeftResponse.headers['Set-Cookie']);
    expect(left.activatorCalls.length + right.activatorCalls.length).toBe(1);

    const wrongSharedReal = createMandateStoresV3({
      nowSeconds: () => sharedClock.value,
    });
    const correctProcess = makeHarness({
      clock: sharedClock,
      realStores: wrongSharedReal,
      bindingPrefix: 'correct-binding',
    });
    const wrongProcess = makeHarness({
      clock: sharedClock,
      realStores: wrongSharedReal,
      bindingPrefix: 'wrong-binding',
    });
    const correctProcessResponse = mockRes();
    const wrongProcessResponse = mockRes();
    await Promise.all([
      correctProcess.router(request({ ...body }), correctProcessResponse),
      wrongProcess.router(
        request({ ...body, capability: wrongCapability }),
        wrongProcessResponse,
      ),
    ]);
    await waitForStatus(correctProcess, body, 'active');
    expect(correctProcessResponse.statusCode).toBe(202);
    expect(wrongProcessResponse.statusCode).toBe(401);
    expect(wrongProcessResponse.body).not.toContain(wrongCapability);
    expect(correctProcess.activatorCalls.length + wrongProcess.activatorCalls.length).toBe(1);
  });

  it('heartbeats a submitted activation lease while the external receipt wait exceeds 30 seconds', async () => {
    vi.useFakeTimers();
    let releaseReceipt;
    let enteredReceiptWait;
    const receiptGate = new Promise((resolve) => { releaseReceipt = resolve; });
    const entered = new Promise((resolve) => { enteredReceiptWait = resolve; });
    let harness;
    try {
      harness = makeHarness({
        activateMandate: async (_approval, { onSubmitted }) => {
          await onSubmitted(USER_OP_HASH);
          harness.events.push('activator:waiting-receipt');
          enteredReceiptWait();
          await receiptGate;
          harness.events.push('activator:receipt');
          return { userOpHash: USER_OP_HASH, txHash: TX_HASH };
        },
      });
      const body = registrationBody();

      const { res } = await postMandate(harness, body);
      expect(res.statusCode).toBe(202);
      await entered;
      for (let interval = 0; interval < 3; interval += 1) {
        harness.clock.value += 11;
        await vi.advanceTimersByTimeAsync(10_000);
      }
      expect(harness.clock.value).toBeGreaterThan(NOW_SECONDS + 30);
      expect(harness.real.mandateActivations.get(identityOf(body)).status).toBe('submitted');

      releaseReceipt();
      await vi.waitFor(() => {
        expect(harness.real.mandatesV3.status(identityOf(body)).status).toBe('active');
      });

      const waitingIndex = harness.events.indexOf('activator:waiting-receipt');
      const receiptIndex = harness.events.indexOf('activator:receipt');
      const waitRenewals = harness.events
        .map((event, index) => ({ event, index }))
        .filter(({ event, index }) => (
          event === 'store:renew' && index > waitingIndex && index < receiptIndex
        ));
      expect(waitRenewals.length).toBeGreaterThanOrEqual(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renews the real lease before and after fresh evaluation', async () => {
    let harness;
    harness = makeHarness({
      evaluateMandateStatusFn: async () => {
        harness.events.push('evaluator:begin');
        harness.clock.value += 1;
        harness.events.push('evaluator:end');
        return { status: 'active', reasonCodes: [] };
      },
    });
    const body = registrationBody();

    await postMandate(harness, body);
    await waitForStatus(harness, body, 'active');

    const begin = harness.events.indexOf('evaluator:begin');
    const end = harness.events.indexOf('evaluator:end');
    const renewals = harness.events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event === 'store:renew')
      .map(({ index }) => index);
    expect(renewals.some((index) => index < begin)).toBe(true);
    expect(renewals.some((index) => index > end)).toBe(true);
    expect(harness.events.indexOf('store:finishActive')).toBeGreaterThan(renewals.at(-1));
  });

  it('cannot finish active when authority is revoked during a stale-active evaluation race', async () => {
    let harness;
    const body = registrationBody();
    harness = makeHarness({
      evaluateMandateStatusFn: async () => {
        harness.real.mandatesV3.revoke(identityOf(body));
        return { status: 'active', reasonCodes: [] };
      },
    });

    await postMandate(harness, body);
    await waitForStatus(harness, body, 'revoked');

    expect(harness.real.mandatesV3.status(identityOf(body)).status).toBe('revoked');
    expect(harness.real.mandatesV3.get(identityOf(body)).sessionPrivateKey).toBeUndefined();
    expect(harness.events).not.toContain('store:finishActive');
  });
});
