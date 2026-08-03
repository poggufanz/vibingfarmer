import { describe, expect, it, vi } from 'vitest';
import { createAgentIndexReporter } from '../src/agentIndexReporter.mjs';

const SECRET = 'server-to-server-secret';

describe('durable Base child reporter protocol', () => {
  const child = {
    version: 1,
    networkId: 'stellar-testnet',
    owner: `G${'A'.repeat(55)}`,
    agent: `C${'B'.repeat(55)}`,
    bindingId: 'binding-42',
    allocationId: 'run-42:bridge:aave-v3',
    childId: 'job-42',
    intent: {
      token: 'USDC', units: '1000000', decimals: 6,
      poolAddress: `0x${'11'.repeat(20)}`, proxyTarget: 'aave-v3',
      runId: 'run-42', grantTxHash: 'grant-hash', kernelAddress: `0x${'22'.repeat(20)}`,
      bindingHash: 'binding-hash-42', baseJobId: 'job-42',
    },
    lifecycle: { sequence: 0, status: 'planned', evidence: {}, observedAt: 2_000_000_000_000 },
  };
  const identity = {
    networkId: child.networkId,
    owner: child.owner,
    bindingId: child.bindingId,
    allocationId: child.allocationId,
    childId: child.childId,
  };

  // Defect caught: the old reporter treated every response as optional analytics instead of a custody gate.
  it('accepts only a 201 acknowledgement matching schema and immutable child identity', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ acknowledged: true, identity, schemaVersion: 1 }),
    }));
    const reporter = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index', secret: SECRET, schemaVersion: 1, fetchImpl,
    });

    await expect(reporter.commitIntent(child)).resolves.toEqual({
      acknowledged: true, identity, schemaVersion: 1,
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://index.example/api/agent-index?action=base-child-intent');
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(init.body)).toEqual({ child });
  });

  // Defect caught: a caller mistake could forward a full approval/session payload to D1.
  it('rejects unexpected or sensitive child fields before making a network request', async () => {
    const fetchImpl = vi.fn();
    const reporter = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index', secret: SECRET, schemaVersion: 1, fetchImpl,
    });
    await expect(reporter.commitIntent({
      ...child,
      serializedApproval: 'full-mandate-payload',
      sessionPrivateKey: 'must-never-leave-relayer',
    })).rejects.toThrow(/unexpected|secret|private|approval/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Defect caught: 401, D1 failure, malformed JSON, false acknowledgement, or schema drift could be mistaken for durability.
  it.each([
    ['reporter 401', { ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) }, /401/],
    ['D1 failure', { ok: false, status: 503, json: async () => ({ error: 'unavailable' }) }, /503/],
    ['malformed acknowledgement', { ok: true, status: 201, json: async () => ({ ok: true }) }, /acknowledgement/i],
    ['schema mismatch', { ok: true, status: 201, json: async () => ({ acknowledged: true, identity, schemaVersion: 2 }) }, /schema/i],
    ['identity mismatch', { ok: true, status: 201, json: async () => ({ acknowledged: true, identity: { ...identity, childId: 'other' }, schemaVersion: 1 }) }, /identity/i],
  ])('fails closed on %s', async (_label, response, expected) => {
    const reporter = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index', secret: SECRET, schemaVersion: 1,
      fetchImpl: vi.fn(async () => response),
    });
    await expect(reporter.commitIntent(child)).rejects.toThrow(expected);
  });

  // Defect caught: an unbounded reporter request could leave burn eligibility ambiguous forever.
  it('aborts a timed-out intent request and reports explicit non-success', async () => {
    const fetchImpl = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const reporter = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index', secret: SECRET, schemaVersion: 1,
      timeoutMs: 5, fetchImpl,
    });
    await expect(reporter.commitIntent(child)).rejects.toThrow(/timed out/i);
  });

  // Defect caught: lifecycle delivery lacked an authenticated, acknowledgement-validated reporter method.
  it('posts one lifecycle request and validates the acknowledged sequence', async () => {
    const request = {
      identity,
      expectedSequence: 0,
      lifecycle: { sequence: 1, status: 'submitted', evidence: { executionStatus: 'accepted' }, observedAt: 2_000_000_000_100 },
    };
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ acknowledged: true, identity, sequence: 1, schemaVersion: 1 }),
    }));
    const reporter = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index', secret: SECRET, schemaVersion: 1, fetchImpl,
    });
    await expect(reporter.reportLifecycle(request)).resolves.toMatchObject({ sequence: 1 });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://index.example/api/agent-index?action=base-child-lifecycle'
    );
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual(request);
  });

  // Defect caught: startup treated configured strings as readiness without authenticating or
  // proving the remote D1 schema/store was writable.
  it('authenticates an exact schema/store readiness probe before workers can start', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ready: true,
        schemaVersion: 1,
        stores: { executionReceipts: true, baseChildIntents: true },
      }),
    }));
    const reporter = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index', secret: SECRET, schemaVersion: 1, fetchImpl,
    });

    await expect(reporter.probe()).resolves.toEqual({
      ready: true,
      schemaVersion: 1,
      stores: { executionReceipts: true, baseChildIntents: true },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://index.example/api/agent-index?action=base-child-ready',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: `Bearer ${SECRET}` }),
      }),
    );
  });

  it.each([
    ['unauthorized', { ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) }],
    ['schema mismatch', { ok: true, status: 200, json: async () => ({ ready: true, schemaVersion: 2, stores: { executionReceipts: true, baseChildIntents: true } }) }],
    ['store unavailable', { ok: true, status: 200, json: async () => ({ ready: false, schemaVersion: 1, stores: { executionReceipts: true, baseChildIntents: true } }) }],
    ['receipt store missing', { ok: true, status: 200, json: async () => ({ ready: true, schemaVersion: 1, stores: { baseChildIntents: true } }) }],
    ['Base-child store missing', { ok: true, status: 200, json: async () => ({ ready: true, schemaVersion: 1, stores: { executionReceipts: true } }) }],
  ])('fails the readiness probe on %s', async (_label, response) => {
    const reporter = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index', secret: SECRET, schemaVersion: 1,
      fetchImpl: vi.fn(async () => response),
    });
    await expect(reporter.probe()).rejects.toThrow(/reporter|schema|ready|HTTP/i);
  });
});
