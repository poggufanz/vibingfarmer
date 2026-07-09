// keeper/test/chain.test.js — pure-helper unit tests for chain.js's RPC-free math (T2 Fix 2:
// real pending-interest so the MIN_COMPOUND gate in decide.js's decideCompound stops being dead).
// No RPC, no @stellar/stellar-sdk network calls — computePendingInterest is a plain function of
// (positions, reserveIndex, bRate, principal).
import { describe, it, expect } from 'vitest';
import { computePendingInterest } from '../src/chain.js';

const SCALAR_12 = 1_000_000_000_000n;

describe('computePendingInterest', () => {
  it('computes live bToken valuation (bTokenAmount * bRate / SCALAR_12) minus book principal', () => {
    const positions = { supply: { 3: 100_0000000n } }; // reserve index 3 -> 100 bToken units
    const bRate = 1_050_000_000_000n; // 1.05x (SCALAR_12 scale) — 5% appreciation since supply
    const principal = 100_0000000n; // 100 units originally supplied (blend_strategy.rs balance())
    expect(computePendingInterest(positions, 3, bRate, principal)).toBe(5_0000000n);
  });

  it('clamps to 0n on a pool shortfall (live value below book principal)', () => {
    const positions = { supply: { 3: 100_0000000n } };
    const bRate = 950_000_000_000n; // 0.95x — live value dropped below principal
    const principal = 100_0000000n;
    expect(computePendingInterest(positions, 3, bRate, principal)).toBe(0n);
  });

  it('treats a missing reserve-index entry as zero bToken balance rather than throwing', () => {
    const positions = { supply: {} };
    expect(computePendingInterest(positions, 3, SCALAR_12, 0n)).toBe(0n);
  });

  it('tolerates a null positions object without throwing (best-effort caller already degrades to 0n on RPC failure — this proves the pure fn itself is equally safe)', () => {
    expect(computePendingInterest(null, 3, SCALAR_12, 0n)).toBe(0n);
  });

  it('indexes positions.supply by a plain-number reserveIndex against string-keyed entries, matching scValToNative\'s Object.fromEntries decoding of a Blend Map<u32, i128>', () => {
    const positions = { supply: { '7': 250_0000000n } };
    expect(computePendingInterest(positions, 7, SCALAR_12, 200_0000000n)).toBe(50_0000000n);
  });
});
