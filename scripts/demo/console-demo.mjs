// scripts/demo/console-demo.mjs — drive every /agent Operations Console feature with real
// testnet actions (lifeboat whale-attack drill, all-clear resume, keeper compound) plus a
// browser seed snippet for the localStorage-backed monitor/council zones.
//
// Run from repo root with the keeper env file:
//   node --env-file=keeper/.dev.vars scripts/demo/console-demo.mjs <command>
//
// Commands:
//   status                  read lifeboat chain state (mode, mandate, live signals)
//   whale-attack [reason]   submit vault.emergency_derisk under the keeper mandate
//                           reason: 1 utilization spike · 2 liquidity drop / whale drain
//                           (default) · 3 oracle divergence
//   all-clear               submit vault.resume (funds re-enter via the next compound)
//   compound                submit vault.compound with zero min-outs (testnet demo only)
//   seed-council [n]        print a browser-console snippet that seeds n cycles (default 12)
//                           into yv_cycle_journal + yv_decision_log — lights up the monitor
//                           EKG, council bench/stamp, and decision-log pagination
//
// What each command exercises on /agent:
//   whale-attack → lifeboat zone flips ENGAGED (danger border, runbook rows, radar blip),
//                  command-strip lifeboat chip goes danger. Picked up by the app's 15s poll.
//   all-clear    → lifeboat back to ARMED, "Resumed" runbook row.
//   compound     → keeper zone last-action row + price/share; swarm trace strip tick.
//   seed-council → monitor EKG beats + vitals, council verdict stamp, decision log pages.
//   positions / mandate / scopes are real chain state — use the normal grant flow (they
//   paginate at 3 scopes; grant 4+ agents to see the pager).
//
// Requirements for chain commands: keeper/.dev.vars with SOROBAN_RPC_URL,
// NETWORK_PASSPHRASE, VAULT_ADDRESS, POOL_1, USDC, STELLAR_KEEPER_SECRET (STRATEGY_1 too
// for compound). whale-attack needs an ACTIVE mandate — renew via the /agent lifeboat zone
// ("renew 24h mandate") if the board shows DISARMED.
import {
  readLifeboatChainState,
  readState,
  submit,
} from "../../keeper/src/chain.js";

const REASONS = {
  1: "Utilization spike",
  2: "Liquidity drop (whale drain)",
  3: "Oracle divergence",
};
const CHAIN_ENV = [
  "SOROBAN_RPC_URL",
  "NETWORK_PASSPHRASE",
  "VAULT_ADDRESS",
  "POOL_1",
  "USDC",
  "STELLAR_KEEPER_SECRET",
];

const [cmd, arg] = process.argv.slice(2);
const env = process.env;
const say = (...a) => console.log("[demo]", ...a);
const jsonSafe = (v) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

function requireChainEnv() {
  const missing = CHAIN_ENV.filter((k) => !env[k]);
  if (missing.length) {
    console.error(`[demo] missing env vars: ${missing.join(", ")}`);
    console.error(
      "[demo] run with: node --env-file=keeper/.dev.vars scripts/demo/console-demo.mjs",
    );
    process.exit(1);
  }
}

/** Deterministic verdict pattern — mostly keep, with visible discard/gated/crash beats. */
function cycleVerdict(i) {
  if (i % 11 === 10) return "crash";
  if (i % 7 === 3) return "discard";
  if (i % 5 === 4) return "gated";
  return "keep";
}

function seedSnippet(n) {
  const nowTs = Date.now();
  const journal = [];
  const decisions = [];
  for (let i = 0; i < n; i++) {
    const cycle = i + 1;
    const ts = nowTs - (n - i) * 10 * 60_000; // one cycle every 10 min, oldest first
    const verdict = cycleVerdict(i);
    journal.push({
      cycle,
      verdict,
      reason: verdict === "keep" ? "" : `demo ${verdict} beat`,
      ts,
    });
    const discard = verdict === "discard" || verdict === "crash";
    const majoritySignal = discard
      ? "WITHDRAW"
      : i % 3 === 2
        ? "HOLD"
        : "DEPOSIT";
    const confidences = [0.9 - (i % 4) * 0.05, 0.75 + (i % 3) * 0.05, 0.8];
    decisions.push({
      id: `c${cycle}-${ts}`,
      ts,
      cycle,
      action: { kind: "deposit", vault: "Autofarm USDC", apyGain: null },
      turbulence: discard ? "high" : "calm",
      verdicts: ["yield", "risk", "market"].map((role, r) => ({
        role,
        signal: r === 1 && !discard && i % 4 === 1 ? "HOLD" : majoritySignal,
        confidence: +confidences[r].toFixed(2),
        summary:
          role === "yield"
            ? "supply apr steady vs 7d baseline"
            : role === "risk"
              ? discard
                ? "utilization spiking — exit exposure"
                : "tvl flat, caps respected"
              : "no adverse market drift",
      })),
      majoritySignal,
      majorityCount: 2 + ((i + 1) % 2),
      avgConfidence: +(confidences.reduce((a, b) => a + b, 0) / 3).toFixed(3),
      finalDecision: discard ? "discard" : "keep",
      resolvedBy: i % 4 === 1 ? "tiebreak" : "majority",
      reason: discard ? "risk specialist veto — demo whale turbulence" : null,
      citedRules: [],
    });
  }
  return [
    "// paste into the browser devtools console on the /agent route, then Enter:",
    `localStorage.setItem('yv_cycle_journal', ${JSON.stringify(JSON.stringify(journal))})`,
    `localStorage.setItem('yv_decision_log', ${JSON.stringify(JSON.stringify(decisions))})`,
    "location.reload()",
  ].join("\n");
}

async function main() {
  switch (cmd) {
    case "status": {
      requireChainEnv();
      const s = await readLifeboatChainState(env);
      console.log(jsonSafe(s));
      break;
    }
    case "whale-attack": {
      requireChainEnv();
      const reason = Number(arg) || 2;
      if (!REASONS[reason]) {
        console.error(`[demo] unknown reason ${arg} — use 1, 2 or 3`);
        process.exit(1);
      }
      say(
        `whale attack drill — emergency_derisk reason ${reason} (${REASONS[reason]})`,
      );
      try {
        const hash = await submit(env, { type: "derisk", reason });
        say(`derisk confirmed · tx ${hash}`);
        say(
          "watch /agent: lifeboat flips ENGAGED within ~15s (danger border, runbook row,",
        );
        say("radar blip) and the command-strip lifeboat chip goes danger.");
        say(
          "undo with: node --env-file=keeper/.dev.vars scripts/demo/console-demo.mjs all-clear",
        );
      } catch (e) {
        console.error("[demo] derisk failed:", e.message);
        console.error(
          "[demo] common causes: mandate expired (renew 24h mandate in the /agent",
        );
        console.error(
          "[demo] lifeboat zone) or vault already derisked (run all-clear first).",
        );
        process.exit(1);
      }
      break;
    }
    case "all-clear": {
      requireChainEnv();
      say("all-clear — vault.resume");
      try {
        const hash = await submit(env, { type: "resume" });
        say(`resume confirmed · tx ${hash}`);
        say('watch /agent: lifeboat back to ARMED, "Resumed" runbook row.');
      } catch (e) {
        console.error("[demo] resume failed:", e.message);
        console.error(
          "[demo] common cause: vault is not derisked (nothing to resume).",
        );
        process.exit(1);
      }
      break;
    }
    case "compound": {
      requireChainEnv();
      if (!env.STRATEGY_1) {
        console.error("[demo] compound needs STRATEGY_1 in the env file");
        process.exit(1);
      }
      say("keeper compound — zero min-outs (testnet demo)");
      try {
        const state = await readState(env);
        const minOuts = state.strategies.map(() => 0n);
        const hash = await submit(env, { type: "compound", minOuts });
        say(`compound confirmed · tx ${hash}`);
        say(
          "watch /agent: keeper zone last-action row + price/share, swarm trace tick.",
        );
      } catch (e) {
        console.error("[demo] compound failed:", e.message);
        console.error(
          "[demo] common cause: nothing to harvest yet (Blend dust guard) — let",
        );
        console.error("[demo] interest accrue or deposit first, then retry.");
        process.exit(1);
      }
      break;
    }
    case "seed-council": {
      const n = Math.max(1, Math.min(60, Number(arg) || 12));
      console.log(seedSnippet(n));
      break;
    }
    default:
      console.log(`vibing-farmer console demo — make every /agent zone show live data

usage: node --env-file=keeper/.dev.vars scripts/demo/console-demo.mjs <command>

  status                  lifeboat chain state (mode, mandate, signals)
  whale-attack [1|2|3]    emergency_derisk drill (default 2 = liquidity drop / whale drain)
  all-clear               resume after a drill
  compound                trigger a keeper compound now
  seed-council [n]        print browser snippet seeding monitor EKG + council decisions

positions / scopes / mandate are real chain state — use the normal grant flow
(grant 4+ agents to see the mandate pager at 3 per page).`);
  }
}

main().catch((e) => {
  console.error("[demo] fatal:", e);
  process.exit(1);
});
