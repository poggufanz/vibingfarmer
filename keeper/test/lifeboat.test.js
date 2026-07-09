// keeper/test/lifeboat.test.js — pure decision tests for the lifeboat radar (no I/O, no SDK,
// mirroring decide.test.js's treatment of decide.js).
import { describe, it, expect } from 'vitest';
import { REASON, defaultConfig, isNormal, decideLifeboat } from '../src/lifeboat.js';

const cfg = defaultConfig();
const armed = (over = {}) => ({
  derisked: false,
  mandateExpiry: 2_000_000_000,
  nowTs: 1_000_000_000,
  utilizationBps: 5000,
  liqDropBps: 0,
  oracleDivergenceBps: 0,
  normalStreak: 0,
  ...over,
});

describe('decideLifeboat — engage (OR across signals)', () => {
  it('returns null when everything is normal', () => {
    expect(decideLifeboat(armed(), cfg)).toBeNull();
  });
  it('fires UTIL_SPIKE at >= 9500 bps and not below', () => {
    expect(decideLifeboat(armed({ utilizationBps: 9500 }), cfg)).toEqual({
      type: 'derisk',
      reason: REASON.UTIL_SPIKE,
    });
    expect(decideLifeboat(armed({ utilizationBps: 9499 }), cfg)).toBeNull();
  });
  it('fires LIQ_DROP at >= 3000 bps single-ledger drop', () => {
    expect(decideLifeboat(armed({ liqDropBps: 3000 }), cfg)).toEqual({
      type: 'derisk',
      reason: REASON.LIQ_DROP,
    });
  });
  it('fires ORACLE_DIVERGENCE at >= 2500 bps', () => {
    expect(decideLifeboat(armed({ oracleDivergenceBps: 2500 }), cfg)).toEqual({
      type: 'derisk',
      reason: REASON.ORACLE_DIVERGENCE,
    });
  });
  it('multi-signal ledger reports highest severity (oracle > liq > util)', () => {
    expect(
      decideLifeboat(armed({ utilizationBps: 9900, liqDropBps: 5000, oracleDivergenceBps: 9000 }), cfg)
    ).toEqual({ type: 'derisk', reason: REASON.ORACLE_DIVERGENCE });
    expect(decideLifeboat(armed({ utilizationBps: 9900, liqDropBps: 5000 }), cfg)).toEqual({
      type: 'derisk',
      reason: REASON.LIQ_DROP,
    });
  });
  it('null signals never fire (read failure is not danger)', () => {
    expect(
      decideLifeboat(armed({ utilizationBps: null, liqDropBps: null, oracleDivergenceBps: null }), cfg)
    ).toBeNull();
  });
});

describe('decideLifeboat — mandate fail-closed', () => {
  it('danger + expired mandate = alarm, never a derisk submit', () => {
    expect(decideLifeboat(armed({ utilizationBps: 9900, mandateExpiry: 999 }), cfg)).toEqual({
      type: 'alarm',
      reason: REASON.UTIL_SPIKE,
    });
  });
  it('mandateExpiry 0 (never granted) = alarm', () => {
    expect(decideLifeboat(armed({ oracleDivergenceBps: 9000, mandateExpiry: 0 }), cfg)).toEqual({
      type: 'alarm',
      reason: REASON.ORACLE_DIVERGENCE,
    });
  });
});

describe('decideLifeboat — resume (streak + mandate)', () => {
  const engaged = (over = {}) => armed({ derisked: true, utilizationBps: 4000, ...over });
  it('resumes only at allClearLedgers consecutive normal ledgers', () => {
    expect(decideLifeboat(engaged({ normalStreak: cfg.allClearLedgers }), cfg)).toEqual({
      type: 'resume',
    });
    expect(decideLifeboat(engaged({ normalStreak: cfg.allClearLedgers - 1 }), cfg)).toBeNull();
  });
  it('never resumes with an expired mandate (funds stay idle)', () => {
    expect(decideLifeboat(engaged({ normalStreak: 999, mandateExpiry: 1 }), cfg)).toBeNull();
  });
});

describe('isNormal — hysteresis (resume thresholds, stricter than engage)', () => {
  it('utilization must be under the RESUME threshold (8500), not just under engage (9500)', () => {
    expect(isNormal({ utilizationBps: 8600, liqDropBps: 0, oracleDivergenceBps: 0 }, cfg)).toBe(false);
    expect(isNormal({ utilizationBps: 8400, liqDropBps: 0, oracleDivergenceBps: 0 }, cfg)).toBe(true);
  });
  it('oracle divergence must be under 500 bps to count normal', () => {
    expect(isNormal({ utilizationBps: 4000, liqDropBps: 0, oracleDivergenceBps: 600 }, cfg)).toBe(false);
  });
  it('a failed utilization read is NOT normal (conservative — blocks the resume streak)', () => {
    expect(isNormal({ utilizationBps: null, liqDropBps: 0, oracleDivergenceBps: 0 }, cfg)).toBe(false);
  });
  it('null oracle divergence (detector off) and null liqDrop (no prev ledger) count normal', () => {
    expect(isNormal({ utilizationBps: 4000, liqDropBps: null, oracleDivergenceBps: null }, cfg)).toBe(true);
  });
});

describe('defaultConfig', () => {
  it('provides documented defaults', () => {
    expect(cfg).toEqual({
      utilEngageBps: 9500,
      utilResumeBps: 8500,
      liqDropEngageBps: 3000,
      oracleDivEngageBps: 2500,
      oracleDivResumeBps: 500,
      allClearLedgers: 100,
    });
  });
  it('reads env overrides and ignores garbage', () => {
    expect(defaultConfig({ LIFEBOAT_ALL_CLEAR_LEDGERS: '10' }).allClearLedgers).toBe(10);
    expect(defaultConfig({ LIFEBOAT_ALL_CLEAR_LEDGERS: 'nope' }).allClearLedgers).toBe(100);
  });
});
