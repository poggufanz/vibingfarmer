// keeper/src/radar.js — the lifeboat radar loop. All I/O arrives via ctx.deps (read/submit/
// latestLedger/log) so every branch is unit-testable and Task 10's smoke can drive the loop
// in-process against testnet. Cadence design: one evaluation per LEDGER (not per poll) — the
// first publicly observable signal on Stellar is the ledger close itself, so anything faster
// than one tick per ledger is wasted RPC.
import { decideLifeboat, isNormal } from './lifeboat.js';

/** Pool price vs the median of reference prices, in bps. null when either side is missing —
 * the oracle detector is simply OFF, never a trigger. */
export function divergenceBps(poolPrice, refPrices) {
  if (poolPrice === null || poolPrice === undefined) return null;
  const refs = (refPrices ?? []).filter((p) => Number.isFinite(p) && p > 0);
  if (refs.length === 0) return null;
  const sorted = [...refs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return Math.round((Math.abs(poolPrice - median) / median) * 10_000);
}

function liqDropBpsFrom(prevLiq, currentLiq) {
  if (prevLiq === null || prevLiq <= 0n || currentLiq === null) return null;
  const drop = ((prevLiq - currentLiq) * 10_000n) / prevLiq;
  return drop > 0n ? Number(drop) : 0;
}

export async function radarTick(ctx) {
  const { deps, config, memo, env } = ctx;
  let chain;
  try {
    chain = await deps.read(env);
  } catch (err) {
    deps.log.warn(`[radar] read failed, skipping tick: ${String(err?.message || err)}`);
    return { action: null, signals: null };
  }

  const signals = {
    utilizationBps: chain.utilizationBps,
    liqDropBps: liqDropBpsFrom(memo.prevLiq, chain.availableLiquidity),
    oracleDivergenceBps: divergenceBps(chain.poolPrice, ctx.refPrices ?? null),
  };
  memo.prevLiq = chain.availableLiquidity;
  memo.normalStreak = chain.derisked && isNormal(signals, config) ? memo.normalStreak + 1 : 0;

  const action = decideLifeboat(
    {
      derisked: chain.derisked,
      mandateExpiry: chain.mandateExpiry,
      nowTs: chain.nowTs,
      ...signals,
      normalStreak: memo.normalStreak,
    },
    config,
  );

  if (action?.type === 'alarm') {
    deps.log.error(
      `[radar] DANGER (reason ${action.reason}) but MANDATE EXPIRED — lifeboat disarmed, cannot act. Re-grant required.`,
    );
    return { action, signals };
  }

  if ((action?.type === 'derisk' || action?.type === 'resume') && !memo.inFlight) {
    memo.inFlight = true;
    try {
      const hash = await deps.submit(env, action);
      deps.log.info(`[radar] ${action.type} submitted: ${hash}`);
    } catch (err) {
      // Cross-ledger retry: the next tick re-decides from fresh state; the on-chain derisked
      // flag is idempotent, so a retry after an actually-landed tx is a harmless Ok(0).
      deps.log.error(`[radar] ${action.type} submit failed (retry next ledger): ${String(err?.message || err)}`);
    } finally {
      memo.inFlight = false;
    }
  }
  return { action, signals };
}

export async function runRadar({ env, deps, config, pollMs = 2000, signal }) {
  let lastSeq = 0;
  const ctx = { env, deps, config, memo: { prevLiq: null, normalStreak: 0, inFlight: false } };
  while (!signal?.aborted) {
    try {
      const seq = await deps.latestLedger(env);
      if (seq > lastSeq) {
        lastSeq = seq;
        ctx.refPrices = deps.refPrices ? await deps.refPrices(env) : null;
        await radarTick(ctx);
      }
    } catch (err) {
      deps.log.warn(`[radar] loop error: ${String(err?.message || err)}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
