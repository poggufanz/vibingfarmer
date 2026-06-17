import { describe, it, expect } from 'vitest';
import { createSubmitGate } from './submitGate.js';

const MAX_GAS_AGE_MS = 15_000;
const MAX_PER_MIN = 5;

describe('submitGate', () => {
  it('blocks when the gas snapshot is stale', () => {
    const gate = createSubmitGate({ now: () => 100_000, maxGasAgeMs: MAX_GAS_AGE_MS, maxPerMin: MAX_PER_MIN });
    const r = gate.check({ owner: '0xA', gasSnapshotAt: 100_000 - 20_000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('stale_gas');
  });

  it('blocks when gas cost exceeds expected benefit (economic gate)', () => {
    const gate = createSubmitGate({ now: () => 0, maxGasAgeMs: MAX_GAS_AGE_MS, maxPerMin: MAX_PER_MIN });
    const r = gate.check({ owner: '0xA', gasSnapshotAt: 0, estGasCostWei: 100n, expectedBenefitWei: 50n });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('uneconomic');
  });

  it('allows when gas cost is below expected benefit', () => {
    const gate = createSubmitGate({ now: () => 0, maxGasAgeMs: MAX_GAS_AGE_MS, maxPerMin: MAX_PER_MIN });
    const r = gate.check({ owner: '0xA', gasSnapshotAt: 0, estGasCostWei: 30n, expectedBenefitWei: 50n });
    expect(r.ok).toBe(true);
  });

  it('blocks when rate exceeds maxPerMin for an owner', () => {
    let t = 0;
    const gate = createSubmitGate({ now: () => t, maxGasAgeMs: MAX_GAS_AGE_MS, maxPerMin: 2 });
    const fresh = () => ({ owner: '0xA', gasSnapshotAt: t });
    expect(gate.check(fresh()).ok).toBe(true);
    expect(gate.check(fresh()).ok).toBe(true);
    const r = gate.check(fresh());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('rate_anomaly');
  });

  it('records every decision to the log', () => {
    const gate = createSubmitGate({ now: () => 0, maxGasAgeMs: MAX_GAS_AGE_MS, maxPerMin: MAX_PER_MIN });
    gate.check({ owner: '0xA', gasSnapshotAt: 0 });
    gate.check({ owner: '0xA', gasSnapshotAt: -99_999 });
    expect(gate.log()).toHaveLength(2);
    expect(gate.log()[1]).toMatchObject({ owner: '0xA', ok: false, reason: 'stale_gas' });
  });

  it('caps the decision log (ring buffer, no unbounded growth)', () => {
    const gate = createSubmitGate({ now: () => 0, maxGasAgeMs: MAX_GAS_AGE_MS, maxPerMin: MAX_PER_MIN, maxDecisions: 3 });
    for (let i = 0; i < 6; i++) gate.check({ owner: '0xA', gasSnapshotAt: 0 });
    expect(gate.log()).toHaveLength(3); // oldest evicted
  });
});
