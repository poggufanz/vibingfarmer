import { describe, it, expect, vi, beforeEach } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { toCallPolicy, toTimestampPolicy, CallPolicyVersion } from '@zerodev/permissions/policies';
import { createRelayerRouter } from '../src/httpRouter.mjs';
import { createMandateStoreV2 } from '../src/mandateStore.mjs';
import { MAX_CALL_CAP_UNITS } from '../src/base/session.mjs';
import { APPROVE_ABI, YIELD_ROUTER_ABI } from '../src/base/orchestrator.mjs';
import { buildFarmPermissions } from '../../frontend/src/base/policyEngine.js';

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
const STELLAR_OWNER = `G${'A'.repeat(55)}`;
const OTHER_STELLAR_OWNER = `G${'B'.repeat(55)}`;
const SESSION_PRIVATE_KEY = `0x${'22'.repeat(32)}`;
const SESSION_KEY_ADDRESS = privateKeyToAccount(SESSION_PRIVATE_KEY).address;
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

function buildFakeApproval({ accountAddress = KERNEL_ADDRESS, cap = MAX_CALL_CAP_UNITS, expiry = Math.floor(Date.now() / 1000) + 3600, extraPermissions = [] } = {}) {
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
    permissionParams: { policies: [callPolicy, timestampPolicy] },
  });
}

function wireAllocation({ allocationId = 'run-0', pool = POOL_ADDRESS, units = 100n, minShares = '90' } = {}) {
  return { allocationId, poolAddress: pool, amount: { token: 'USDC', units: units.toString(), decimals: 6 }, minShares };
}

describe('createRelayerRouter', () => {
  let jobs, mandatesV2, nextId, genId, buildFarm, farmFn, relayUnwindMint, agentIndexReporter, router;

  function makeRouter(overrides = {}) {
    return createRelayerRouter({
      buildFarm, relayUnwindMint, jobs, mandatesV2, genId,
      usdcAddress: USDC_ADDRESS, yieldRouterAddress: YIELD_ROUTER_ADDRESS,
      networkId: 'stellar-testnet',
      poolTargets: new Map([[POOL_ADDRESS.toLowerCase(), 'aave-v3']]),
      agentIndexReporter,
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
    agentIndexReporter = { report: vi.fn(async () => ({ ok: true, reported: 1, warnings: [] })) };
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
      const qs = `approval=${encodeURIComponent(body.serializedApproval)}&stellarOwner=${STELLAR_OWNER}&kernelAddress=${KERNEL_ADDRESS}`;
      const res = mockRes();
      await router(mk('GET', `/api/vf-cross/mandate/valid?${qs}`), res);
      expect(res.statusCode).toBe(200);
      expect(jsonOf(res)).toEqual({
        stellarOwner: STELLAR_OWNER,
        kernelAddress: KERNEL_ADDRESS,
        sessionKeyAddress: SESSION_KEY_ADDRESS,
        relayerOrigin: null,
        expiresAt: body.expiresAt * 1000,
        status: 'active',
        bindingId: respBody.bindingId,
        bindingHash: respBody.bindingHash,
      });
      expect(res.body).not.toContain(SESSION_PRIVATE_KEY);
    });

    it('reports "missing" for a never-registered triple', async () => {
      const res = mockRes();
      await router(mk('GET', `/api/vf-cross/mandate/valid?approval=never-registered&stellarOwner=${STELLAR_OWNER}&kernelAddress=${KERNEL_ADDRESS}`), res);
      expect(jsonOf(res)).toEqual({
        stellarOwner: null, kernelAddress: null, sessionKeyAddress: null, relayerOrigin: null,
        expiresAt: null, status: 'missing', bindingId: null, bindingHash: null,
      });
    });

    // Step 5 acceptance, pinned at the endpoint: owner A's approval cannot execute for owner B
    // or a second kernel — the composite-key lookup misses identically to "never registered".
    it('reports "missing" when queried under a different stellarOwner than it was registered for', async () => {
      const { body } = await registerMandate(router);
      const res = mockRes();
      await router(mk('GET', `/api/vf-cross/mandate/valid?approval=${encodeURIComponent(body.serializedApproval)}&stellarOwner=${OTHER_STELLAR_OWNER}&kernelAddress=${KERNEL_ADDRESS}`), res);
      expect(jsonOf(res).status).toBe('missing');
    });

    it('reports "missing" when queried under a different kernelAddress than it was registered for', async () => {
      // Register a SEPARATE mandate whose approval account really is OTHER_KERNEL_ADDRESS, so the
      // lookup below fails on the (stellarOwner, kernelAddress) mismatch, not a decode error.
      const { body } = await registerMandate(router, {
        kernelAddress: OTHER_KERNEL_ADDRESS,
        serializedApproval: buildFakeApproval({ accountAddress: OTHER_KERNEL_ADDRESS }),
      });
      const res = mockRes();
      await router(mk('GET', `/api/vf-cross/mandate/valid?approval=${encodeURIComponent(body.serializedApproval)}&stellarOwner=${STELLAR_OWNER}&kernelAddress=${KERNEL_ADDRESS}`), res);
      expect(jsonOf(res).status).toBe('missing');
    });

    it('reports "expired" once expiresAt has passed', async () => {
      const past = Date.now() - 1000;
      mandatesV2.set({
        serializedApproval: 'approval-x', sessionPrivateKey: SESSION_PRIVATE_KEY, sessionKeyAddress: SESSION_KEY_ADDRESS,
        stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS, relayerOrigin: null,
        expiresAt: past, status: 'active', bindingId: 'b1', bindingHash: 'h1', createdAt: Date.now() - 2000,
      });
      const res = mockRes();
      await router(mk('GET', `/api/vf-cross/mandate/valid?approval=approval-x&stellarOwner=${STELLAR_OWNER}&kernelAddress=${KERNEL_ADDRESS}`), res);
      expect(jsonOf(res).status).toBe('expired');
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
        burnTxHash: 'burn-1', serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS,
        allocations: [wireAllocation()],
      }), res);
      expect(res.statusCode).toBe(400);
      expect(jsonOf(res).error).toMatch(/unknown mandate/);
    });
  });

  describe('POST /farm', () => {
    it('400s when required fields are missing', async () => {
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', { burnTxHash: 'burn-1' }), res);
      expect(res.statusCode).toBe(400);
      expect(buildFarm).not.toHaveBeenCalled();
    });

    it('400s "unknown mandate" when the exact (approval, owner, kernel) triple was never registered', async () => {
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', {
        burnTxHash: 'burn-1', serializedApproval: 'never-registered',
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
        burnTxHash: 'burn-1', serializedApproval: body.serializedApproval,
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
        burnTxHash: 'burn-1', serializedApproval: body.serializedApproval,
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
        burnTxHash: 'burn-1', serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS,
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
          burnTxHash: `burn-${i}`, serializedApproval: body.serializedApproval,
          stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS,
          bridgeAgent: 'CBRIDGE', runId: `run-${i}`, grantTxHash: 'HGRANT',
          allocations: [wireAllocation({ units: MAX_CALL_CAP_UNITS })],
        }), res);
        expect(res.statusCode, `call ${i}`).toBe(200);
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
          burnTxHash: 'burn-1', serializedApproval: body.serializedApproval,
          stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS,
          allocations: [wireAllocation()],
          ...context,
        }), res);
        expect(res.statusCode).toBe(400);
        expect(jsonOf(res).error).toMatch(/bridgeAgent, runId and grantTxHash/)
      }
      expect(farmFn).not.toHaveBeenCalled();
      expect(agentIndexReporter.report).not.toHaveBeenCalled();
    });

    it('400s "unknown mandate" once the registered record\'s own expiresAt has passed — mandatesV2.get() itself evicts it, before touching buildFarm', async () => {
      mandatesV2.set({
        serializedApproval: 'approval-x', sessionPrivateKey: SESSION_PRIVATE_KEY, sessionKeyAddress: SESSION_KEY_ADDRESS,
        stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS, relayerOrigin: null,
        expiresAt: Date.now() - 1000, status: 'active', bindingId: 'b1', bindingHash: 'h1', createdAt: Date.now() - 2000,
      });
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', {
        burnTxHash: 'burn-1', serializedApproval: 'approval-x',
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
        burnTxHash: 'burn-1', serializedApproval: body.serializedApproval,
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
        burnTxHash: 'burn-1',
        sourceDomain: 999, // must be ignored — the flow hardcodes domains.stellar
        serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS,
        bridgeAgent: 'CBRIDGE', runId: 'run-42', grantTxHash: 'HGRANT',
        allocations: [wireAllocation({ units: 100n, minShares: '90' })],
      }), res);

      expect(res.statusCode).toBe(200);
      const { jobId } = jsonOf(res);
      expect(jobs.get(jobId)).toMatchObject({ status: 'pending', runId: 'run-42', bridgeAgent: 'CBRIDGE', grantTxHash: 'HGRANT' });
      expect(buildFarm).toHaveBeenCalledWith(SESSION_PRIVATE_KEY);
      expect(farmFn).toHaveBeenCalledWith({
        burnTxHash: 'burn-1', execId: 'burn-1', approval: body.serializedApproval,
        allocations: [{
          allocationId: 'run-0',
          pool: POOL_ADDRESS,
          amount: 100n,
          minShares: 90n,
          reportAmount: { token: 'USDC', units: '100', decimals: 6 },
          proxyTarget: 'aave-v3',
        }],
        runId: 'run-42', bridgeAgent: 'CBRIDGE', grantTxHash: 'HGRANT',
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

    it('reports exact binding and canonical pool identity at acceptance, then reports each terminal child result', async () => {
      const { body, respBody } = await registerMandate(router);
      let resolveFarm;
      farmFn.mockImplementationOnce(() => new Promise((resolve) => { resolveFarm = resolve; }));
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', {
        burnTxHash: 'burn-1', serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS,
        bridgeAgent: 'CBRIDGE', runId: 'run-42', grantTxHash: 'HGRANT',
        allocations: [wireAllocation({ allocationId: 'run-42:bridge:aave-v3' })],
      }), res);
      const { jobId } = jsonOf(res);

      await vi.waitFor(() => expect(agentIndexReporter.report).toHaveBeenCalledTimes(1));
      expect(agentIndexReporter.report.mock.calls[0]).toEqual([
        {
          version: 1,
          networkId: 'stellar-testnet',
          owner: STELLAR_OWNER,
          bridgeAgent: 'CBRIDGE',
          runId: 'run-42',
          grantTxHash: 'HGRANT',
          kernelAddress: KERNEL_ADDRESS,
          mandateBindingId: respBody.bindingId,
          mandateBindingHash: respBody.bindingHash,
          baseJobId: jobId,
          allocations: [{
            allocationId: 'run-42:bridge:aave-v3',
            poolAddress: POOL_ADDRESS,
            proxyTarget: 'aave-v3',
            amount: { token: 'USDC', units: '100', decimals: 6 },
            executionStatus: 'accepted',
            custody: { location: 'in-transit' },
            txHash: null,
          }],
        },
        { bindingId: respBody.bindingId, bindingHash: respBody.bindingHash },
      ]);

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
      await vi.waitFor(() => expect(agentIndexReporter.report).toHaveBeenCalledTimes(2));
      expect(agentIndexReporter.report.mock.calls[1][0].allocations).toEqual([{
        allocationId: 'run-42:bridge:aave-v3',
        poolAddress: POOL_ADDRESS,
        proxyTarget: 'aave-v3',
        amount: { token: 'USDC', units: '100', decimals: 6 },
        executionStatus: 'deposited',
        custody: { location: 'base-proxy' },
        txHash: '0xdeposit',
      }]);
      expect(JSON.stringify(agentIndexReporter.report.mock.calls)).not.toContain(SESSION_PRIVATE_KEY);
    });

    it('rejects an unallowlisted pool before accepting or reporting the job', async () => {
      const { body } = await registerMandate(router);
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', {
        burnTxHash: 'burn-1', serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS,
        bridgeAgent: 'CBRIDGE', runId: 'run-42', grantTxHash: 'HGRANT',
        allocations: [wireAllocation({ pool: `0x${'99'.repeat(20)}` })],
      }), res);
      expect(res.statusCode).toBe(400);
      expect(jsonOf(res).error).toMatch(/pool/i);
      expect(agentIndexReporter.report).not.toHaveBeenCalled();
    });

    it('keeps farm custody successful when non-custodial index reporting warns or rejects', async () => {
      agentIndexReporter.report.mockRejectedValue(new Error('index down'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { body } = await registerMandate(router);
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', {
        burnTxHash: 'burn-1', serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS,
        bridgeAgent: 'CBRIDGE', runId: 'run-42', grantTxHash: 'HGRANT',
        allocations: [wireAllocation()],
      }), res);
      const { jobId } = jsonOf(res);
      await vi.waitFor(() => expect(jobs.get(jobId).status).toBe('done'));
      expect(jobs.get(jobId).status).toBe('done');
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    // Re-review fix: a failed job used to drop runId/bridgeAgent/grantTxHash entirely (recordError
    // replaced the whole job object) — exactly where My Money's durable index needs the
    // association most (this project's known "relayer 'failed' != bridge failed" hazard).
    it('lands the job in error status (message only, never the key) when the farm flow rejects — runId/bridgeAgent/grantTxHash survive on the error record', async () => {
      const { body } = await registerMandate(router);
      farmFn.mockRejectedValueOnce(new Error(`deposit into ${POOL_ADDRESS} was mined but did not succeed`));
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', {
        burnTxHash: 'burn-1', serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS,
        bridgeAgent: 'CBRIDGE', runId: 'run-42', grantTxHash: 'HGRANT',
        allocations: [wireAllocation()],
      }), res);
      const { jobId } = jsonOf(res);
      await vi.waitFor(() => expect(jobs.get(jobId).status).toBe('error'));
      expect(JSON.stringify(jobs.get(jobId))).toMatch(/was mined but did not succeed/);
      expect(JSON.stringify(jobs.get(jobId))).not.toContain(SESSION_PRIVATE_KEY);
      expect(jobs.get(jobId)).toMatchObject({ runId: 'run-42', bridgeAgent: 'CBRIDGE', grantTxHash: 'HGRANT' });
    });
  });

  describe('GET /status/:jobId', () => {
    it('404s when the jobId is unknown', async () => {
      const res = mockRes();
      await router(mk('GET', '/api/vf-cross/status/nope'), res);
      expect(res.statusCode).toBe(404);
    });

    it('returns the stored job status verbatim', async () => {
      jobs.set('job-x', { status: 'done', steps: [{ step: 'mint', status: 'minted' }] });
      const res = mockRes();
      await router(mk('GET', '/api/vf-cross/status/job-x'), res);
      expect(res.statusCode).toBe(200);
      expect(jsonOf(res)).toEqual({ status: 'done', steps: [{ step: 'mint', status: 'minted' }] });
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
        burnTxHash: 'burn-1', serializedApproval: body.serializedApproval,
        stellarOwner: STELLAR_OWNER, kernelAddress: KERNEL_ADDRESS,
        bridgeAgent: 'CBRIDGE', runId: 'run-42', grantTxHash: 'HGRANT',
        allocations: [wireAllocation()],
      }), res);
      const { jobId } = jsonOf(res);
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
