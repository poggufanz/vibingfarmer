import { describe, expect, it, vi } from 'vitest';
import { createAgentIndexReporter, associationIdempotencyKey } from '../src/agentIndexReporter.mjs';

const SECRET = 'server-to-server-secret';
const SESSION_PRIVATE_KEY = `0x${'42'.repeat(32)}`;

function allocation(overrides = {}) {
  return {
    allocationId: 'run-42:bridge:aave',
    poolAddress: `0x${'11'.repeat(20)}`,
    proxyTarget: 'aave-v3',
    amount: { token: 'USDC', units: '1000000', decimals: 6 },
    executionStatus: 'accepted',
    custody: { location: 'in-transit' },
    txHash: null,
    ...overrides,
  };
}

function report(overrides = {}) {
  return {
    version: 1,
    networkId: 'stellar-testnet',
    owner: `G${'A'.repeat(55)}`,
    bridgeAgent: `C${'B'.repeat(55)}`,
    runId: 'run-42',
    grantTxHash: 'grant-hash',
    kernelAddress: `0x${'22'.repeat(20)}`,
    mandateBindingId: 'binding-42',
    mandateBindingHash: 'binding-hash-42',
    baseJobId: 'job-42',
    allocations: [allocation()],
    ...overrides,
  };
}

describe('associationIdempotencyKey', () => {
  it('is exactly the network/run/allocation/status/txHash tuple', () => {
    const first = associationIdempotencyKey(report(), allocation());
    expect(first).toEqual(
      JSON.stringify([
        'stellar-testnet',
        'run-42',
        'run-42:bridge:aave',
        'accepted',
        null,
      ])
    );

    expect(
      associationIdempotencyKey(
        report({ baseJobId: 'different-job', mandateBindingId: 'different-binding' }),
        allocation()
      )
    ).toBe(first);
    expect(associationIdempotencyKey(report(), allocation({ executionStatus: 'deposited' }))).not.toBe(first);
  });
});

describe('createAgentIndexReporter', () => {
  it('posts one exact allocation per idempotency key with server authentication', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    const reporter = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index?action=associate',
      secret: SECRET,
      fetchImpl,
    });

    const result = await reporter.report(report(), {
      bindingId: 'binding-42',
      bindingHash: 'binding-hash-42',
    });

    expect(result).toEqual({ ok: true, reported: 1, warnings: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://index.example/api/agent-index?action=associate');
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${SECRET}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': associationIdempotencyKey(report(), allocation()),
    });
    expect(JSON.parse(init.body)).toEqual({ ...report(), allocations: [allocation()] });
  });

  it('rejects a missing or changed binding before making a network request', async () => {
    const fetchImpl = vi.fn();
    const reporter = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index?action=associate',
      secret: SECRET,
      fetchImpl,
    });

    await expect(
      reporter.report(report({ mandateBindingHash: 'changed' }), {
        bindingId: 'binding-42',
        bindingHash: 'binding-hash-42',
      })
    ).rejects.toThrow(/binding/i);
    await expect(
      reporter.report(report({ mandateBindingId: null }), {
        bindingId: 'binding-42',
        bindingHash: 'binding-hash-42',
      })
    ).rejects.toThrow(/binding/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('retries the same key and returns a warning without throwing when analytics is down', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('index unavailable');
    });
    const logger = { warn: vi.fn() };
    const reporter = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index?action=associate',
      secret: SECRET,
      fetchImpl,
      logger,
      maxAttempts: 3,
    });

    const result = await reporter.report(report(), {
      bindingId: 'binding-42',
      bindingHash: 'binding-hash-42',
    });

    expect(result.ok).toBe(false);
    expect(result.reported).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const keys = fetchImpl.mock.calls.map(([, init]) => init.headers['Idempotency-Key']);
    expect(new Set(keys).size).toBe(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('serializes only the canonical report fields and never forwards or logs session key material', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }));
    const logger = { warn: vi.fn() };
    const reporter = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index?action=associate',
      secret: SECRET,
      fetchImpl,
      logger,
      maxAttempts: 1,
    });
    const unsafe = {
      ...report(),
      sessionPrivateKey: SESSION_PRIVATE_KEY,
      allocations: [{ ...allocation(), sessionPrivateKey: SESSION_PRIVATE_KEY }],
    };

    await reporter.report(unsafe, {
      bindingId: 'binding-42',
      bindingHash: 'binding-hash-42',
    });

    expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain(SESSION_PRIVATE_KEY);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(SESSION_PRIVATE_KEY);
  });
});
