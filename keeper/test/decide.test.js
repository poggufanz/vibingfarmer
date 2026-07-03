import { describe, it, expect } from 'vitest';
import { decide } from '../src/decide.js';

const base = { idle: 0n, lastRebalanceTs: 0, nowTs: 100_000_000, blndQuote: null,
  strategies: [
    { address: 'S1', balance: 600_0000000n, supplyAprBps: 300, pendingInterest: 0n, blndClaimable: 0n },
    { address: 'S2', balance: 400_0000000n, supplyAprBps: 320, pendingInterest: 0n, blndClaimable: 0n }] };
const cfg = { minCompound: 1_0000000n, rebalanceBps: 50, cooldownS: 86400, slippageBps: 100 };

it('does nothing when below thresholds', () => expect(decide(base, cfg)).toEqual([]));
it('compounds when pending yield crosses minCompound', () => {
  const s = structuredClone(base); s.strategies[0].pendingInterest = 2_0000000n;
  expect(decide(s, cfg)).toEqual([{ type: 'compound', minOuts: [0n, 0n] }]);
});
it('compounds idle deposits even with zero pending yield', () => {
  const s = structuredClone(base); s.idle = 5_0000000n;
  expect(decide(s, cfg)[0].type).toBe('compound');
});
it('sets minOut from quote with slippage when BLND claimable and route exists', () => {
  const s = structuredClone(base); s.strategies[0].blndClaimable = 50_0000000n; s.strategies[0].pendingInterest = 2_0000000n;
  s.blndQuote = { usdcOutFor: () => 5_0000000n };
  expect(decide(s, cfg)[0].minOuts[0]).toBe(4_9500000n); // 1% slippage
});
it('minOut is 0 (hold) when no quote', () => {
  const s = structuredClone(base); s.strategies[0].blndClaimable = 50_0000000n; s.strategies[0].pendingInterest = 2_0000000n;
  expect(decide(s, cfg)[0].minOuts[0]).toBe(0n);
});
it('rebalances toward higher APR past threshold and cooldown', () => {
  const s = structuredClone(base); s.strategies[1].supplyAprBps = 400; // delta 100 > 50
  const a = decide(s, cfg).find(x => x.type === 'rebalance');
  expect(a).toEqual({ type: 'rebalance', from: 'S1', to: 'S2', amount: 100_0000000n }); // imbalance/2
});
it('respects cooldown', () => {
  const s = structuredClone(base); s.strategies[1].supplyAprBps = 400; s.lastRebalanceTs = s.nowTs - 100;
  expect(decide(s, cfg).some(x => x.type === 'rebalance')).toBe(false);
});
it('does not rebalance when the higher-APR strategy already holds more capital', () => {
  const s = structuredClone(base);
  s.strategies[0] = { address: 'S1', balance: 100_0000000n, supplyAprBps: 200, pendingInterest: 0n, blndClaimable: 0n };
  s.strategies[1] = { address: 'S2', balance: 900_0000000n, supplyAprBps: 500, pendingInterest: 0n, blndClaimable: 0n };
  // aprDelta = 300 > rebalanceBps (50); cooldown elapsed; but highest-APR (S2) already holds more
  // balance than lowest-APR (S1) -> imbalance is negative -> no rebalance action should be emitted.
  expect(decide(s, cfg).some(a => a.type === 'rebalance')).toBe(false);
});
