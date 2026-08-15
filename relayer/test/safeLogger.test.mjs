import { describe, expect, it, vi } from 'vitest';
import { createSafeLogger, safeSerialize } from '../src/safeLogger.mjs';

describe('safeLogger', () => {
  it('emits only stable codes and bounded public metadata for hostile values', () => {
    const sink = vi.fn();
    const circular = { count: 2 };
    circular.self = circular;
    const sentinel = 'T16-SAFE-LOGGER-SECRET';
    const request = {
      headers: { authorization: sentinel, cookie: `session=${sentinel}` },
      body: { plaintext: sentinel },
    };
    const logger = createSafeLogger({ sink });

    logger.info('QUEUE_DRAINED', { count: 2, pending: 0, sentinel });
    logger.error('WORK_FAILED', new Error(`${sentinel}: stack detail`));
    logger.warn('REQUEST_REJECTED', {
      request,
      headers: request.headers,
      body: request.body,
      key: sentinel,
      circular,
      huge: 'x'.repeat(20_000),
      bigint: 12n,
    });

    expect(sink).toHaveBeenCalledTimes(3);
    const output = JSON.stringify(sink.mock.calls);
    expect(output).not.toContain(sentinel);
    expect(output).not.toMatch(/stack detail|authorization|cookie|plaintext|session=/i);
    expect(sink.mock.calls[0][0]).toEqual({
      level: 'info',
      code: 'QUEUE_DRAINED',
      details: { count: 2, pending: 0 },
    });
    expect(sink.mock.calls[1][0]).toEqual({
      level: 'error',
      code: 'WORK_FAILED',
      details: {},
    });
  });

  it('serializes errors, BigInt, cycles, and unsupported input without throwing or echoing values', () => {
    const sentinel = 'T16-SAFE-SERIALIZE-SECRET';
    const value = { count: 1, error: new Error(sentinel), amount: 10n };
    value.self = value;

    const encoded = safeSerialize(value);

    expect(encoded).not.toContain(sentinel);
    expect(encoded).not.toContain('amount');
    expect(() => JSON.parse(encoded)).not.toThrow();
  });

  it('does not emit hostile strings through any public string metadata key', () => {
    const sink = vi.fn();
    const logger = createSafeLogger({ sink });
    logger.info('QUEUE_DRAINED', {
      action: 'T16-SECRET',
      component: 'T16-SECRET',
      code: 'T16-SECRET',
      cursor: 'T16-SECRET',
      id: 'T16-SECRET',
      jobId: 'T16-SECRET',
      mandateId: 'T16-SECRET',
      method: 'T16-SECRET',
      phase: 'T16-SECRET',
      reasonCode: 'provider-secret',
      state: 'T16-SECRET',
      status: 'T16-SECRET',
      worker: 'T16-SECRET',
    });

    const output = JSON.stringify(sink.mock.calls);
    expect(output).not.toContain('T16-SECRET');
    expect(output).not.toContain('provider-secret');
    expect(sink.mock.calls[0][0].details).toEqual({});
  });
});
