import { describe, it, expect, vi, afterEach } from 'vitest';
import { pollAttestation } from '../../src/cctp/iris.mjs';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('pollAttestation', () => {
  it('returns message+attestation once Iris reports status complete', async () => {
    const pending = { messages: [{ status: 'pending', attestation: 'PENDING' }] };
    const complete = { messages: [{ status: 'complete', message: '0xdead', attestation: '0xbeef' }] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ text: async () => JSON.stringify(pending) })
      .mockResolvedValueOnce({ text: async () => JSON.stringify(complete) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await pollAttestation({
      irisUrl: 'https://iris.example', sourceDomain: 27, txHash: 'abc123', intervalMs: 0,
    });

    expect(result).toEqual({ message: '0xdead', attestation: '0xbeef' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith('https://iris.example/v2/messages/27?transactionHash=abc123');
  });

  it('keeps polling through a non-JSON response body instead of throwing', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ text: async () => 'not json' })
      .mockResolvedValueOnce({ text: async () => JSON.stringify({ messages: [{ status: 'complete', message: '0x1', attestation: '0x2' }] }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await pollAttestation({ irisUrl: 'https://iris.example', sourceDomain: 6, txHash: 'x', intervalMs: 0 });
    expect(result).toEqual({ message: '0x1', attestation: '0x2' });
  });

  it('throws after maxAttempts if the attestation never completes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ text: async () => JSON.stringify({ messages: [{ status: 'pending', attestation: 'PENDING' }] }) }));

    await expect(pollAttestation({
      irisUrl: 'https://iris.example', sourceDomain: 27, txHash: 'stuck', maxAttempts: 3, intervalMs: 0,
    })).rejects.toThrow(/attestation not complete/);
  });
});
