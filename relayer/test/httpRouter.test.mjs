import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRelayerRouter } from '../src/httpRouter.mjs';

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

describe('createRelayerRouter', () => {
  let jobs, mandates, nextId, genId, buildFarm, farmFn, relayUnwindMint, router;

  beforeEach(() => {
    jobs = new Map();
    mandates = new Map();
    nextId = 0;
    genId = () => `job-${++nextId}`;
    farmFn = vi.fn(async () => ({
      mintResult: { status: 'minted', mintTxHash: '0xmint' },
      depositResults: [{ status: 'fulfilled', pool: '0xPoolA' }],
    }));
    buildFarm = vi.fn(() => ({ farm: farmFn }));
    relayUnwindMint = vi.fn(async () => ({ status: 'minted', mintTxHash: '0xreverse' }));
    router = createRelayerRouter({ buildFarm, relayUnwindMint, jobs, mandates, genId });
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
    it('400s when serializedApproval or sessionPrivateKey is missing', async () => {
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/mandate', { serializedApproval: 'approval-1' }), res);
      expect(res.statusCode).toBe(400);
      expect(mandates.size).toBe(0);
    });

    it('stores the mandate and responds ok, never echoing the key back in the response', async () => {
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/mandate', {
        serializedApproval: 'approval-1', sessionPrivateKey: '0xsecret-session-key',
      }), res);
      expect(res.statusCode).toBe(200);
      expect(jsonOf(res)).toEqual({ ok: true });
      expect(res.body).not.toContain('0xsecret-session-key');
      expect(mandates.get('approval-1')).toBe('0xsecret-session-key');
    });
  });

  describe('POST /farm', () => {
    it('400s when required fields are missing', async () => {
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', { burnTxHash: 'burn-1' }), res);
      expect(res.statusCode).toBe(400);
      expect(buildFarm).not.toHaveBeenCalled();
    });

    it('400s "unknown mandate" when serializedApproval was never registered', async () => {
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', {
        burnTxHash: 'burn-1',
        serializedApproval: 'never-registered',
        allocations: [{ pool: '0xPoolA', amount: '100', minShares: '90' }],
      }), res);
      expect(res.statusCode).toBe(400);
      expect(jsonOf(res).error).toMatch(/unknown mandate/);
      expect(buildFarm).not.toHaveBeenCalled();
    });

    it('400s when an allocation amount is not a valid integer string', async () => {
      mandates.set('approval-1', '0xsecret-session-key');
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', {
        burnTxHash: 'burn-1',
        serializedApproval: 'approval-1',
        allocations: [{ pool: '0xPoolA', amount: 'not-a-number', minShares: '90' }],
      }), res);
      expect(res.statusCode).toBe(400);
      expect(farmFn).not.toHaveBeenCalled();
    });

    // Wire-boundary regression lock (see frontend/src/base/relayerClient.js serializeAllocations):
    // amount is a DISPLAY float upstream and must be converted to base units before it reaches
    // this router. A raw display float with a fractional remainder (e.g. from a 3-way split)
    // is exactly the shape that used to slip through unconverted and throw here.
    it('400s "invalid allocation" when amount is a raw display float string ("33.333"), same as a malformed amount', async () => {
      mandates.set('approval-1', '0xsecret-session-key');
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', {
        burnTxHash: 'burn-1',
        serializedApproval: 'approval-1',
        allocations: [{ pool: '0xPoolA', amount: '33.333', minShares: '90' }],
      }), res);
      expect(res.statusCode).toBe(400);
      expect(jsonOf(res).error).toMatch(/invalid allocation/);
      expect(farmFn).not.toHaveBeenCalled();
    });

    it('parses a fractional-derived base-unit string (what the fixed client now sends) cleanly to BigInt', async () => {
      mandates.set('approval-1', '0xsecret-session-key');
      let resolveFarm;
      farmFn.mockImplementationOnce(() => new Promise((resolve) => { resolveFarm = resolve; }));
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', {
        burnTxHash: 'burn-1',
        serializedApproval: 'approval-1',
        // 100/3 display float run through toBaseChainUnits (frontend/src/base/config.js) —
        // the fixed client sends this base-unit string, never the raw "33.333333..." float.
        allocations: [{ pool: '0xPoolA', amount: '33333333', minShares: '90' }],
      }), res);
      expect(res.statusCode).toBe(200);
      expect(farmFn).toHaveBeenCalledWith({
        burnTxHash: 'burn-1',
        execId: 'burn-1',
        approval: 'approval-1',
        allocations: [{ pool: '0xPoolA', amount: 33333333n, minShares: 90n }],
      });
      resolveFarm({
        mintResult: { status: 'minted', mintTxHash: '0xmint' },
        depositResults: [{ status: 'fulfilled', pool: '0xPoolA' }],
      });
      const { jobId } = jsonOf(res);
      await vi.waitFor(() => expect(jobs.get(jobId).status).toBe('done'));
    });

    it('responds with a jobId immediately (job still pending while the flow is in flight), ignores client sourceDomain, converts amounts to BigInt, and resolves to done', async () => {
      mandates.set('approval-1', '0xsecret-session-key');
      // Deferred promise instead of an immediately-resolving mock: proves the HTTP response
      // (and the 'pending' job state) really precedes the farm flow's completion, rather than
      // relying on a microtask-count coincidence.
      let resolveFarm;
      farmFn.mockImplementationOnce(() => new Promise((resolve) => { resolveFarm = resolve; }));

      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', {
        burnTxHash: 'burn-1',
        sourceDomain: 999, // must be ignored — the flow hardcodes domains.stellar
        serializedApproval: 'approval-1',
        allocations: [{ pool: '0xPoolA', amount: '100', minShares: '90' }],
      }), res);

      expect(res.statusCode).toBe(200);
      const { jobId } = jsonOf(res);
      expect(jobId).toBe('job-1');
      expect(jobs.get(jobId).status).toBe('pending');
      expect(jobs.get(jobId).steps).toEqual([]);
      expect(buildFarm).toHaveBeenCalledWith('0xsecret-session-key');
      expect(farmFn).toHaveBeenCalledWith({
        burnTxHash: 'burn-1',
        execId: 'burn-1',
        approval: 'approval-1',
        allocations: [{ pool: '0xPoolA', amount: 100n, minShares: 90n }],
      });

      resolveFarm({
        mintResult: { status: 'minted', mintTxHash: '0xmint' },
        depositResults: [{ status: 'fulfilled', pool: '0xPoolA' }],
      });
      await vi.waitFor(() => expect(jobs.get(jobId).status).toBe('done'));
      expect(JSON.stringify(jobs.get(jobId))).not.toContain('0xsecret-session-key');
    });

    it('lands the job in error status (message only, never the key) when the farm flow rejects', async () => {
      mandates.set('approval-1', '0xsecret-session-key');
      farmFn.mockRejectedValueOnce(new Error('deposit into 0xPoolA was mined but did not succeed'));
      const res = mockRes();
      await router(mk('POST', '/api/vf-cross/farm', {
        burnTxHash: 'burn-1',
        serializedApproval: 'approval-1',
        allocations: [{ pool: '0xPoolA', amount: '100', minShares: '90' }],
      }), res);
      const { jobId } = jsonOf(res);
      await vi.waitFor(() => expect(jobs.get(jobId).status).toBe('error'));
      expect(JSON.stringify(jobs.get(jobId))).toMatch(/deposit into 0xPoolA/);
      expect(JSON.stringify(jobs.get(jobId))).not.toContain('0xsecret-session-key');
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
      // Same wiring as the default router but with sanitizeErrors on.
      sanitized = createRelayerRouter({ buildFarm, relayUnwindMint, jobs, mandates, genId, sanitizeErrors: true });
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('replaces a farm error message with a generic one — the raw error never reaches GET /status', async () => {
      mandates.set('approval-1', '0xsecret-session-key');
      farmFn.mockRejectedValueOnce(new Error('RPC https://secret-node.internal/xyz refused: 0xPoolA reverted'));
      const res = mockRes();
      await sanitized(mk('POST', '/api/vf-cross/farm', {
        burnTxHash: 'burn-1',
        serializedApproval: 'approval-1',
        allocations: [{ pool: '0xPoolA', amount: '100', minShares: '90' }],
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
