// keeper/src/lifeboat.js — pure lifeboat decision. No I/O, no SDK imports, deterministic
// function of (state, config) — the decide.js pattern. Reason codes are shared VERBATIM with
// the vault contract (types.rs LifeboatEngaged.reason_code) and the frontend (REASON_LABELS).

export const REASON = { UTIL_SPIKE: 1, LIQ_DROP: 2, ORACLE_DIVERGENCE: 3 };

export function defaultConfig(env = {}) {
  const num = (key, fallback) => {
    const parsed = Number(env[key]);
    return env[key] !== undefined && Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    utilEngageBps: num('LIFEBOAT_UTIL_ENGAGE_BPS', 9500),
    utilResumeBps: num('LIFEBOAT_UTIL_RESUME_BPS', 8500),
    liqDropEngageBps: num('LIFEBOAT_LIQ_DROP_ENGAGE_BPS', 3000),
    oracleDivEngageBps: num('LIFEBOAT_ORACLE_DIV_ENGAGE_BPS', 2500),
    oracleDivResumeBps: num('LIFEBOAT_ORACLE_DIV_RESUME_BPS', 500),
    allClearLedgers: num('LIFEBOAT_ALL_CLEAR_LEDGERS', 100),
  };
}

// A ledger counts "normal" (feeds the all-clear streak) only when every LIVE signal is under
// its RESUME threshold (hysteresis: stricter than engage, prevents flapping). A failed
// utilization read is conservatively NOT normal — it blocks the resume streak. A null oracle
// divergence means the detector is off (no refs configured) and a null liqDrop means there is
// no previous ledger to compare — neither blocks resume.
export function isNormal(signals, config) {
  if (signals.utilizationBps === null || signals.utilizationBps >= config.utilResumeBps) return false;
  if (signals.liqDropBps !== null && signals.liqDropBps >= config.liqDropEngageBps) return false;
  if (signals.oracleDivergenceBps !== null && signals.oracleDivergenceBps >= config.oracleDivResumeBps) {
    return false;
  }
  return true;
}

// Highest severity wins: ORACLE_DIVERGENCE > LIQ_DROP > UTIL_SPIKE. null never fires.
function engageReason(state, config) {
  if (state.oracleDivergenceBps !== null && state.oracleDivergenceBps >= config.oracleDivEngageBps) {
    return REASON.ORACLE_DIVERGENCE;
  }
  if (state.liqDropBps !== null && state.liqDropBps >= config.liqDropEngageBps) {
    return REASON.LIQ_DROP;
  }
  if (state.utilizationBps !== null && state.utilizationBps >= config.utilEngageBps) {
    return REASON.UTIL_SPIKE;
  }
  return null;
}

export function decideLifeboat(state, config) {
  const mandateOk = state.mandateExpiry > 0 && state.nowTs < state.mandateExpiry;
  if (!state.derisked) {
    const reason = engageReason(state, config);
    if (reason === null) return null;
    // Fail-closed: danger without a live mandate cannot act — surface it loudly instead.
    return mandateOk ? { type: 'derisk', reason } : { type: 'alarm', reason };
  }
  if (mandateOk && state.normalStreak >= config.allClearLedgers) return { type: 'resume' };
  return null;
}
