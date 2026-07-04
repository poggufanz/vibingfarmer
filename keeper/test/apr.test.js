// keeper/test/apr.test.js — extracted-module smoke test (T2 Fix 3 dedup). Fixtures mirror
// frontend/src/stellar/vaultReads.test.js's estimateSupplyAprBps cases (same math, now a single
// shared implementation) so the expected bps values are traceable back to an already-verified
// result, not numbers invented for this file.
import { describe, it, expect } from 'vitest';
import { estimateSupplyAprBps, utilizationBps } from '../src/apr.js';

describe('estimateSupplyAprBps', () => {
  const baseConfig = {
    util: 6_000_000n, // 60% target
    max_util: 9_500_000n, // 95% ceiling
    r_base: 0n,
    r_one: 1_000_000n,
    r_two: 5_000_000n,
    r_three: 15_000_000n,
  };

  it('estimates supply APR when utilization is below target', () => {
    const reserve = {
      config: baseConfig,
      data: {
        b_supply: 1000n,
        b_rate: 1_000_000_000_000n,
        d_supply: 500n,
        d_rate: 1_000_000_000_000n,
        ir_mod: 10_000_000n,
      },
    };
    expect(estimateSupplyAprBps(reserve, 0n)).toBe(416);
  });

  it('estimates a higher supply APR once utilization crosses target (kinked curve)', () => {
    const reserve = {
      config: baseConfig,
      data: {
        b_supply: 1000n,
        b_rate: 1_000_000_000_000n,
        d_supply: 800n,
        d_rate: 1_000_000_000_000n,
        ir_mod: 10_000_000n,
      },
    };
    expect(estimateSupplyAprBps(reserve, 0n)).toBe(3085);
  });

  it('returns 0 rather than dividing by zero when nothing is supplied', () => {
    const reserve = {
      config: baseConfig,
      data: {
        b_supply: 0n,
        b_rate: 1_000_000_000_000n,
        d_supply: 0n,
        d_rate: 1_000_000_000_000n,
        ir_mod: 10_000_000n,
      },
    };
    expect(estimateSupplyAprBps(reserve, 0n)).toBe(0);
  });
});

describe('utilizationBps', () => {
  // supplied = b_supply*b_rate/1e12, borrowed = d_supply*d_rate/1e12, util = borrowed/supplied
  it('computes borrowed/supplied in bps from reserve data', () => {
    const reserve = {
      data: {
        b_supply: 1_000_0000000n,
        b_rate: 1_000_000_000_000n,
        d_supply: 950_0000000n,
        d_rate: 1_000_000_000_000n,
      },
    };
    expect(utilizationBps(reserve)).toBe(9500);
  });
  it('returns null when nothing is supplied (no meaningful utilization)', () => {
    const reserve = {
      data: { b_supply: 0n, b_rate: 1_000_000_000_000n, d_supply: 0n, d_rate: 1_000_000_000_000n },
    };
    expect(utilizationBps(reserve)).toBe(null);
  });
  it('tolerates string/number field encodings like scValToNative sometimes yields', () => {
    const reserve = {
      data: { b_supply: '1000000000', b_rate: '1000000000000', d_supply: '500000000', d_rate: '1000000000000' },
    };
    expect(utilizationBps(reserve)).toBe(5000);
  });
});
