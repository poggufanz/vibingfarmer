// keeper/src/index.js — scheduled Cloudflare Worker: read live state, decide, submit.
// decide() (./decide.js) is the pure brain; chain.js is all the I/O. This file only wires them
// together and never throws out of `scheduled` — every failure is logged (JSON, one line per
// event, readable via `wrangler tail` / `wrangler dev` console) and the tick ends gracefully so
// the next 15-min cron retries with fresh state. No retry loops within a tick.
import { readState, submit } from './chain.js';
import { decide } from './decide.js';

// Defaults match docs/superpowers/specs/2026-07-03-vf-autofarm-design.md §5.2/§7 and the
// on-chain vault's own `set_limits` defaults (86400s cooldown) — all overridable via env vars
// without a redeploy.
const DEFAULT_MIN_COMPOUND = 1_0000000n; // 1 USDC at 7dp
const DEFAULT_REBALANCE_BPS = 50; // APR-delta threshold to trigger a rebalance
const DEFAULT_COOLDOWN_S = 86400; // 24h — matches on-chain DEFAULT_COOLDOWN_S
const DEFAULT_SLIPPAGE_BPS = 100; // 1% — BLND→USDC swap min_out slippage

function buildConfig(env) {
  return {
    minCompound: env.MIN_COMPOUND ? BigInt(env.MIN_COMPOUND) : DEFAULT_MIN_COMPOUND,
    rebalanceBps: env.REBALANCE_BPS ? Number(env.REBALANCE_BPS) : DEFAULT_REBALANCE_BPS,
    cooldownS: env.COOLDOWN_S ? Number(env.COOLDOWN_S) : DEFAULT_COOLDOWN_S,
    slippageBps: env.SLIPPAGE_BPS ? Number(env.SLIPPAGE_BPS) : DEFAULT_SLIPPAGE_BPS,
  };
}

/** JSON.stringify replacer — chain reads return BigInt (i128 amounts), which JSON.stringify
 * cannot serialize natively. */
function jsonSafe(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

function logStateAndActions(state, actions) {
  console.log(
    JSON.stringify(
      {
        tick: 'state',
        idle: state.idle,
        lastRebalanceTs: state.lastRebalanceTs,
        nowTs: state.nowTs,
        hasBlndQuote: state.blndQuote != null,
        strategies: state.strategies,
        actions,
      },
      jsonSafe,
    ),
  );
}

export default {
  async scheduled(controller, env, ctx) {
    let state;
    try {
      state = await readState(env);
    } catch (err) {
      console.log(JSON.stringify({ tick: 'read-state-failed', error: String(err?.message || err) }));
      return; // never throw out of the handler — next cron tick retries with fresh state
    }

    let actions;
    try {
      actions = decide(state, buildConfig(env));
    } catch (err) {
      console.log(JSON.stringify({ tick: 'decide-failed', error: String(err?.message || err) }, jsonSafe));
      return;
    }

    logStateAndActions(state, actions);

    for (const action of actions) {
      try {
        const hash = await submit(env, action);
        console.log(JSON.stringify({ tick: 'submitted', action, hash }, jsonSafe));
      } catch (err) {
        // Simulation failure (e.g. a dust compound below Blend's supply minimum) or a
        // send/confirm error — log and skip this action. No retry loop.
        console.log(JSON.stringify({ tick: 'skipped', action, error: String(err?.message || err) }, jsonSafe));
      }
    }
  },
};
