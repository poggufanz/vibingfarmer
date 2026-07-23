// keeper/test/radar.test.js — radar loop tests with injected deps (no network, no SDK).
import { describe, it, expect, vi } from 'vitest';
import { radarTick, divergenceBps, runRadar } from '../src/radar.js';
import { defaultConfig, REASON } from '../src/lifeboat.js';

const mkCtx = (read, submit = vi.fn(async () => 'txhash')) => ({
  env: {},
  deps: { read, submit, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
  config: { ...defaultConfig(), allClearLedgers: 3 },
  memo: { prevLiq: null, normalStreak: 0, inFlight: false },
});

const calm = {
  utilizationBps: 4000,
  availableLiquidity: 1_000_0000000n,
  poolPrice: null,
  derisked: false,
  mandateExpiry: 9_999_999_999,
  nowTs: 1,
};

describe('radarTick', () => {
  it('computes liqDropBps vs the previous ledger and fires derisk', async () => {
    const reads = [{ ...calm }, { ...calm, availableLiquidity: 500_0000000n }];
    const submit = vi.fn(async () => 'tx');
    const ctx = mkCtx(async () => reads.shift(), submit);
    await radarTick(ctx); // ledger 1: baseline only
    const { action } = await radarTick(ctx); // ledger 2: 50% drop
    expect(action).toEqual({ type: 'derisk', reason: REASON.LIQ_DROP });
    expect(submit).toHaveBeenCalledWith({}, { type: 'derisk', reason: REASON.LIQ_DROP });
  });

  it('first ledger has no liqDrop signal (no prev) and never fires from it', async () => {
    const ctx = mkCtx(async () => ({ ...calm, availableLiquidity: 1n }));
    const { action, signals } = await radarTick(ctx);
    expect(signals.liqDropBps).toBe(null);
    expect(action).toBeNull();
  });

  it('liquidity GROWTH clamps to 0, not a negative drop', async () => {
    const reads = [{ ...calm }, { ...calm, availableLiquidity: 2_000_0000000n }];
    const ctx = mkCtx(async () => reads.shift());
    await radarTick(ctx);
    const { signals } = await radarTick(ctx);
    expect(signals.liqDropBps).toBe(0);
  });

  it('alarm (danger + expired mandate) logs error and does NOT submit', async () => {
    const submit = vi.fn();
    const ctx = mkCtx(async () => ({ ...calm, utilizationBps: 9900, mandateExpiry: 0 }), submit);
    const { action } = await radarTick(ctx);
    expect(action.type).toBe('alarm');
    expect(submit).not.toHaveBeenCalled();
    expect(ctx.deps.log.error).toHaveBeenCalled();
  });

  it('builds the all-clear streak while derisked and resumes at the threshold', async () => {
    const submit = vi.fn(async () => 'tx');
    const ctx = mkCtx(async () => ({ ...calm, derisked: true }), submit);
    await radarTick(ctx); // streak 1
    await radarTick(ctx); // streak 2
    let r = await radarTick(ctx); // streak 3 == allClearLedgers -> resume
    expect(r.action).toEqual({ type: 'resume' });
    expect(submit).toHaveBeenCalledWith({}, { type: 'resume' });
  });

  it('an abnormal ledger resets the streak', async () => {
    const reads = [
      { ...calm, derisked: true }, // streak 1
      { ...calm, derisked: true, utilizationBps: 9000 }, // >= resume threshold 8500 -> reset
      { ...calm, derisked: true }, // streak 1 again
    ];
    const ctx = mkCtx(async () => reads.shift());
    await radarTick(ctx);
    await radarTick(ctx);
    expect(ctx.memo.normalStreak).toBe(0);
    await radarTick(ctx);
    expect(ctx.memo.normalStreak).toBe(1);
  });

  it('in-flight lock: no second submit while one is pending; lock releases after failure too', async () => {
    let release;
    const submit = vi.fn(() => new Promise((res) => { release = res; }));
    const ctx = mkCtx(async () => ({ ...calm, utilizationBps: 9900 }), submit);
    const first = radarTick(ctx); // starts submit, holds the lock
    await new Promise((r) => setTimeout(r, 0)); // let the first tick reach the submit await
    await radarTick(ctx); // lock held -> skip
    expect(submit).toHaveBeenCalledTimes(1);
    release('tx');
    await first;
    expect(ctx.memo.inFlight).toBe(false);
  });

  it('a submit failure logs error and releases the lock (retry next ledger)', async () => {
    const submit = vi.fn(async () => { throw new Error('boom'); });
    const ctx = mkCtx(async () => ({ ...calm, utilizationBps: 9900 }), submit);
    await radarTick(ctx);
    expect(ctx.deps.log.error).toHaveBeenCalled();
    expect(ctx.memo.inFlight).toBe(false);
  });

  it('a read failure logs warn and returns a null action (loop survives)', async () => {
    const ctx = mkCtx(async () => { throw new Error('rpc down'); });
    const { action } = await radarTick(ctx);
    expect(action).toBeNull();
    expect(ctx.deps.log.warn).toHaveBeenCalled();
  });

  it('oracle divergence flows through: pool 1.30 vs ref median 1.00 = 3000 bps -> derisk', async () => {
    const submit = vi.fn(async () => 'tx');
    const ctx = mkCtx(async () => ({ ...calm, poolPrice: 1.3 }), submit);
    ctx.refPrices = [1.0, 1.0, 1.01];
    const { action } = await radarTick(ctx);
    expect(action).toEqual({ type: 'derisk', reason: REASON.ORACLE_DIVERGENCE });
  });
});

describe('radarTick - pending vault upgrade (surface-only, dedupe log)', () => {
  it('logs a WARN once when an upgrade is first seen, not again on an unchanged repeat tick', async () => {
    const pendingUpgrade = { wasmHashHex: 'ab'.repeat(32), eta: 2_000_000_000 };
    const submit = vi.fn(async () => 'tx');
    const ctx = mkCtx(async () => ({ ...calm, pendingUpgrade }), submit);
    await radarTick(ctx);
    await radarTick(ctx);
    expect(ctx.deps.log.warn).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled(); // surface only — radar never acts on this signal
  });

  it('logs again when the scheduled hash/eta changes', async () => {
    const reads = [
      { ...calm, pendingUpgrade: { wasmHashHex: 'cd'.repeat(32), eta: 2_000_000_001 } },
      { ...calm, pendingUpgrade: { wasmHashHex: 'cd'.repeat(32), eta: 2_000_000_002 } },
    ];
    const ctx = mkCtx(async () => reads.shift());
    await radarTick(ctx);
    await radarTick(ctx);
    expect(ctx.deps.log.warn).toHaveBeenCalledTimes(2);
  });

  it('logs once (info) when a pending upgrade clears, and stays quiet after that', async () => {
    const reads = [
      { ...calm, pendingUpgrade: { wasmHashHex: 'ef'.repeat(32), eta: 2_000_000_003 } },
      { ...calm, pendingUpgrade: null },
      { ...calm, pendingUpgrade: null },
    ];
    const ctx = mkCtx(async () => reads.shift());
    await radarTick(ctx); // scheduled -> warn
    await radarTick(ctx); // cleared -> info
    await radarTick(ctx); // still clear -> no new log
    expect(ctx.deps.log.warn).toHaveBeenCalledTimes(1);
    expect(ctx.deps.log.info).toHaveBeenCalledTimes(1);
  });
});

describe('divergenceBps', () => {
  it('abs distance from the ref median in bps', () => {
    expect(divergenceBps(1.25, [1.0, 1.0, 1.02])).toBe(2500);
  });
  it('null when pool price or refs are missing', () => {
    expect(divergenceBps(null, [1.0])).toBe(null);
    expect(divergenceBps(1.0, [])).toBe(null);
    expect(divergenceBps(1.0, null)).toBe(null);
  });
});

describe('runRadar', () => {
  it('ticks once per NEW ledger sequence and stops on abort', async () => {
    let seq = 100;
    const read = vi.fn(async () => ({ ...calm }));
    const ac = new AbortController();
    const deps = {
      read,
      submit: vi.fn(),
      latestLedger: vi.fn(async () => seq),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    const p = runRadar({ env: {}, deps, config: defaultConfig(), pollMs: 5, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 30)); // several polls, same sequence
    seq = 101;
    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    await p;
    expect(read).toHaveBeenCalledTimes(2); // ledger 100 once, ledger 101 once
  });
});
