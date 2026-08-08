import { describe, it, expect, vi, beforeEach } from 'vitest';
import { confirmStellarTx } from '../../src/cctp/stellarTx.mjs';

const FAST = { intervalMs: 0, label: 'test_op', hash: 'HASH1' };

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {}); // swallow-and-retry logs its breadcrumb
});

describe('confirmStellarTx', () => {
  it('returns the hash once the tx reports SUCCESS', async () => {
    const server = { getTransaction: vi.fn().mockResolvedValue({ status: 'SUCCESS' }) };
    await expect(confirmStellarTx({ server, ...FAST })).resolves.toBe('HASH1');
  });

  it('keeps polling through NOT_FOUND', async () => {
    const server = {
      getTransaction: vi.fn()
        .mockResolvedValueOnce({ status: 'NOT_FOUND' })
        .mockResolvedValueOnce({ status: 'NOT_FOUND' })
        .mockResolvedValue({ status: 'SUCCESS' }),
    };
    await expect(confirmStellarTx({ server, ...FAST })).resolves.toBe('HASH1');
    expect(server.getTransaction).toHaveBeenCalledTimes(3);
  });

  // The regression this module exists for: a transient RPC error after a successful broadcast
  // used to propagate out and get the whole relay recorded as failed, even though the mint had
  // already landed (live incident: burn 0x69e0856a..., mint 2a93e14f... succeeded, job 'error').
  it('swallows transient getTransaction errors and keeps polling', async () => {
    const server = {
      getTransaction: vi.fn()
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValue({ status: 'SUCCESS' }),
    };
    await expect(confirmStellarTx({ server, ...FAST })).resolves.toBe('HASH1');
    expect(server.getTransaction).toHaveBeenCalledTimes(3);
    expect(console.warn).toHaveBeenCalledTimes(2); // each swallowed error leaves a breadcrumb
  });

  it('throws on a definitive on-chain failure, carrying the resultXdr', async () => {
    const server = { getTransaction: vi.fn().mockResolvedValue({ status: 'FAILED', resultXdr: 'XDR' }) };
    await expect(confirmStellarTx({ server, ...FAST })).rejects.toThrow('test_op FAILED: FAILED "XDR"');
  });

  it('formats a FAILED result sanely even without resultXdr', async () => {
    const server = { getTransaction: vi.fn().mockResolvedValue({ status: 'FAILED' }) };
    await expect(confirmStellarTx({ server, ...FAST })).rejects.toThrow('test_op FAILED: FAILED ""');
  });

  it('defaults to a 30-attempt window — the production confirm budget both callers rely on', async () => {
    const server = { getTransaction: vi.fn().mockResolvedValue({ status: 'NOT_FOUND' }) };
    await expect(confirmStellarTx({ server, intervalMs: 0, label: 'test_op', hash: 'HASH1' }))
      .rejects.toThrow('not confirmed');
    expect(server.getTransaction).toHaveBeenCalledTimes(30);
  });

  it('gives up after the attempt window, naming the hash so it can be reconciled', async () => {
    const server = { getTransaction: vi.fn().mockResolvedValue({ status: 'NOT_FOUND' }) };
    await expect(confirmStellarTx({ server, ...FAST, attempts: 4 })).rejects.toThrow('test_op not confirmed: HASH1');
    expect(server.getTransaction).toHaveBeenCalledTimes(4);
  });

  it('does not give up early when every attempt errors transiently, and names the last error as cause', async () => {
    const server = { getTransaction: vi.fn().mockRejectedValue(new Error('fetch failed')) };
    const err = await confirmStellarTx({ server, ...FAST, attempts: 5 }).catch((e) => e);
    expect(err.message).toContain('not confirmed');
    expect(err.cause).toBeInstanceOf(Error);
    expect(err.cause.message).toBe('fetch failed'); // 'RPC broken' stays distinguishable from 'still pending'
    expect(server.getTransaction).toHaveBeenCalledTimes(5);
  });
});

// Task 8 (plan mismatch #7): today the only difference between "definitively failed on-chain"
// and "not confirmed within the window" is error prose, and the watcher must NOT parse prose.
// These pin stable machine-readable codes on the rejection so the watcher can classify:
//   STELLAR_TX_FAILED  — definitive on-chain failure  -> blocked (never minted, never retried)
//   STELLAR_TX_TIMEOUT — window expired on a known hash -> retryable (stay mint_submitted)
describe('confirmStellarTx typed error codes', () => {
  const rejection = (p) => p.then(
    () => { throw new Error('expected confirmStellarTx to reject, but it resolved'); },
    (err) => err,
  );

  it('tags a definitive on-chain failure with STELLAR_TX_FAILED — regression: watcher keeping a provably-failed mint at mint_submitted forever (or marking it minted)', async () => {
    const server = { getTransaction: vi.fn().mockResolvedValue({ status: 'FAILED', resultXdr: 'XDR' }) };
    const err = await rejection(confirmStellarTx({ server, ...FAST }));
    expect(err.code).toBe('STELLAR_TX_FAILED');
  });

  it('tags an exhausted NOT_FOUND window with STELLAR_TX_TIMEOUT — regression: a slow-but-harmless pending hash classified as definitive failure and the mint rebroadcast', async () => {
    const server = { getTransaction: vi.fn().mockResolvedValue({ status: 'NOT_FOUND' }) };
    const err = await rejection(confirmStellarTx({ server, ...FAST, attempts: 4 }));
    expect(err.code).toBe('STELLAR_TX_TIMEOUT');
    expect(server.getTransaction).toHaveBeenCalledTimes(4);
  });

  it('tags an all-transient-error window with STELLAR_TX_TIMEOUT and keeps the last error as cause — regression: a broken RPC masquerading as definitive failure', async () => {
    const server = { getTransaction: vi.fn().mockRejectedValue(new Error('fetch failed')) };
    const err = await rejection(confirmStellarTx({ server, ...FAST, attempts: 5 }));
    expect(err.code).toBe('STELLAR_TX_TIMEOUT');
    expect(err.cause?.message).toBe('fetch failed'); // 'RPC broken' stays distinguishable from 'still pending'
    expect(server.getTransaction).toHaveBeenCalledTimes(5);
  });
});
