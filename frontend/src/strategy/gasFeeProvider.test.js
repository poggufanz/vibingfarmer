import { describe, it, expect } from 'vitest';
import { createGasSnapshotProvider } from './gasFeeProvider.js';

describe('gasFeeProvider', () => {
  it('starts empty, then refreshes fee data and stamps a timestamp', async () => {
    let t = 1000;
    const provider = { getFeeData: async () => ({ maxFeePerGas: 7n }) };
    const gs = createGasSnapshotProvider({ provider, now: () => t });
    expect(gs.current()).toBeNull();
    const snap = await gs.refresh();
    expect(snap.maxFeePerGas).toBe(7n);
    expect(snap.at).toBe(1000);
    expect(gs.current()).toEqual(snap);
  });

  it('re-stamps `at` on each refresh', async () => {
    let t = 0;
    const provider = { getFeeData: async () => ({ maxFeePerGas: 1n }) };
    const gs = createGasSnapshotProvider({ provider, now: () => t });
    await gs.refresh();
    t = 5000;
    const snap = await gs.refresh();
    expect(snap.at).toBe(5000);
  });
});
