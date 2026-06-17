# Roadmap v2 — Phase 3: Historical Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

> **§0 — READ FIRST (carry-forward rule):** Before executing ANY task, read `docs/PLAN-REVIEW-FINDINGS.md`. Every blocker found in a previous phase's review applies here too unless proven otherwise. Specifically for this plan: **(a)** any `vm.writeJson` / `vm.writeFile` needs BOTH a `fs_permissions` entry in `foundry.toml` AND the target directory created first (cheatcodes do not `mkdir`) — this exact blocker hit Phase 1 Task 6; **(b)** "fork connects" ≠ "archive node" — only a *state* query at an old block proves archive. Both are handled below; do not regress them.

**Goal:** Produce a credible "what would have happened" replay of the March 2023 USDC depeg by running real swaps on a forked Ethereum mainnet, fold the *manual* leg into a Monte Carlo band, render the *agentic* leg as a single honest deterministic value, and ship a static, no-RPC replay page.

**Architecture:** A Foundry fork test selects historical mainnet blocks around the depeg and executes real `USDC→WETH` swaps through the live Uniswap V3 router at several reaction delays. It serializes the ground-truth exits + provenance to JSON. A seeded TS step samples the *manual* reaction-delay distribution (real variance), interpolates between ground-truth points, and emits P5/P50/P95; the *agentic* leg is deterministic (first block after signal — sub-block "seconds" are meaningless). The browser only renders the static JSON.

**Tech Stack:** Foundry fork tests (WSL), Uniswap V3 mainnet router, Node/TS via the frontend Vitest binary, the existing frontend chart stack.

> **By design this forks ETHEREUM mainnet, not Base Sepolia** — Base launched Aug 2023; the depeg data only exists on Ethereum mainnet. This is correct, not a compromise.

**Depends on:** nothing in Phase 1/2 (isolated). Needs `MAINNET_RPC` (**archive**) **exported in the WSL shell** (not just present in `.env` — `cast` does not auto-load `.env` the way `forge script` does) + `foundry.toml`.

---

## File Structure

- Modify: `foundry.toml` — add `eth_mainnet` rpc endpoint AND `fs_permissions` for `./frontend/public/data`.
- Create: `test/simulation/_constants.sol` — verified signal block + mainnet addresses.
- Create: `test/simulation/TimelineReplay.t.sol` — fork + real swaps + JSON writer (with provenance).
- Create: `frontend/public/data/replay-usdc-depeg.json` — ground-truth output (written by the test).
- Create: `scripts/replay/monteCarlo.ts` — seeded sampling + interpolation → manual P5/P50/P95 + deterministic agentic value.
- Create: `frontend/public/data/replay-mc.json` — MC output.
- Create: `frontend/src/screens/replay.js` (+ wiring) — static render, "Assumptions" panel, "Historical replay — not a prediction" label.
- Remove: Aladdin / 6-variable concept references from `docs/`.

---

## Task 1: Fork config + fs permissions + signal-block constant

**Files:**
- Modify: `foundry.toml`
- Create: `test/simulation/_constants.sol`

- [ ] **Step 1: Add the mainnet fork endpoint AND the write permission**

In `foundry.toml`, under `[rpc_endpoints]`:

```toml
eth_mainnet = "${MAINNET_RPC}"
```

AND under `[profile.default]` (BLOCKER fix — without this `vm.writeJson` in Task 2 reverts with a permissions error):

```toml
fs_permissions = [{ access = "read-write", path = "./frontend/public/data" }]
```

- [ ] **Step 2: Create the output directory (cheatcodes do not mkdir)**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && mkdir -p frontend/public/data && touch frontend/public/data/.gitkeep"
```

- [ ] **Step 3: Record the verified depeg signal block as a constant**

```solidity
// test/simulation/_constants.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// [VERIFY] First Ethereum mainnet block on 10-11 Mar 2023 where USDC < $0.985 on the
// main Uniswap V3 USDC/WETH pool. ~16,800,000 is an approximation — confirm on Etherscan
// (timestamp 2023-03-11) and the pool's slot0 price, then replace + cite the tx here.
library DepegConstants {
    uint256 internal constant SIGNAL_BLOCK = 16_800_000; // [VERIFY] replace with confirmed block
    // Uniswap V3 SwapRouter02 (mainnet) — note: SwapRouter02 has NO `deadline` in the
    // exactInputSingle struct (SwapRouter01 does). Task 2's interface matches this.
    address internal constant SWAP_ROUTER = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    uint24  internal constant FEE_500 = 500; // 0.05% USDC/WETH pool [VERIFY pool exists at this fee at SIGNAL_BLOCK]
}
```

- [ ] **Step 4: Verify the RPC is a real ARCHIVE node (state query, not a block header)**

> `cast block <old>` succeeds on ANY full node — headers/bodies are kept by everyone; only OLD STATE needs archive. A block-header check gives false confidence, then the fork test fails later with a confusing error. Query *state* at the old block instead:

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && forge build test/simulation/_constants.sol && cast balance 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --block 16800000 --rpc-url \$MAINNET_RPC"
```

Expected: a balance prints → the endpoint truly serves historical state (archive). If it errors with "missing trie node" / "state not available", the RPC is NOT archival — STOP and ask the user for an archive endpoint. (If `$MAINNET_RPC` is empty inside WSL, `export MAINNET_RPC=...` in the WSL shell first — `cast` does not read `.env`.)

- [ ] **Step 5: Commit**

```bash
git add foundry.toml test/simulation/_constants.sol frontend/public/data/.gitkeep
git commit -m "feat(simulation): mainnet fork config, fs permissions, signal-block constants"
```

---

## Task 2: TimelineReplay fork test — real swaps at increasing delays

**Files:**
- Create: `test/simulation/TimelineReplay.t.sol`

- [ ] **Step 1: Write the fork test**

```solidity
// test/simulation/TimelineReplay.t.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DepegConstants as D} from "./_constants.sol";

interface ISwapRouter {
    // SwapRouter02 struct — NO `deadline` field. Matches D.SWAP_ROUTER (0x68b3...Fc45).
    struct ExactInputSingleParams {
        address tokenIn; address tokenOut; uint24 fee; address recipient;
        uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata) external payable returns (uint256);
}

contract TimelineReplayTest is Test {
    uint256 constant AMOUNT_IN = 1_000_000e6; // 1,000,000 USDC

    function test_replaySweep_writesGroundTruthJson() public {
        uint32[5] memory delays = [uint32(2), 15, 50, 150, 600];
        string memory json = "replay";
        for (uint256 i; i < delays.length; ++i) {
            // Use the foundry.toml alias so the endpoint is single-sourced.
            vm.createSelectFork(vm.rpcUrl("eth_mainnet"), D.SIGNAL_BLOCK + delays[i]);
            uint256 out = _swap(D.USDC, D.WETH, D.FEE_500, AMOUNT_IN);
            assertGt(out, 0, "swap returned zero");
            string memory key = string.concat("delay_", vm.toString(delays[i]));
            vm.serializeUint(json, key, out);
        }
        // Provenance — the Assumptions panel (Task 4) needs these to be auditable.
        vm.serializeUint(json, "signalBlock", D.SIGNAL_BLOCK);
        vm.serializeUint(json, "chainId", 1);
        vm.serializeString(json, "depegDate", "2023-03-11");
        string memory finalOut = vm.serializeUint(json, "amountInUsdc", AMOUNT_IN);
        vm.writeJson(finalOut, "frontend/public/data/replay-usdc-depeg.json");
    }

    function _swap(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn) internal returns (uint256) {
        deal(tokenIn, address(this), amountIn); // USDC has a simple balance slot — deal works
        IERC20(tokenIn).approve(D.SWAP_ROUTER, amountIn);
        return ISwapRouter(D.SWAP_ROUTER).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn, tokenOut: tokenOut, fee: fee, recipient: address(this),
                amountIn: amountIn, amountOutMinimum: 0, sqrtPriceLimitX96: 0
            })
        );
    }
}
```

- [ ] **Step 2: Run the fork test**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && forge test --match-contract TimelineReplayTest -vvv"`
Expected: PASS; `frontend/public/data/replay-usdc-depeg.json` written with 5 `delay_*` exits + provenance (`signalBlock`, `chainId`, `depegDate`, `amountInUsdc`). If `exactInputSingle` reverts, the pool/fee/router constant is wrong at that block — fix the `[VERIFY]` constants, do not hand-roll x*y=k. If `writeJson` reverts → §0 blocker (a): re-check `fs_permissions` + that `frontend/public/data/` exists.

- [ ] **Step 3: Sanity-check one exit against historical price**

Cross-check `delay_2` WETH out vs `AMOUNT_IN / historical_ETH_price` at the block. Record the comparison in the commit body. (Each exit must be explainable from the pool price — that is the AC.)

- [ ] **Step 4: Commit**

```bash
git add test/simulation/TimelineReplay.t.sol frontend/public/data/replay-usdc-depeg.json
git commit -m "feat(simulation): TimelineReplay fork test — real depeg swaps to JSON"
```

---

## Task 3: Fold → manual P5/P50/P95 (MC) + agentic deterministic value

> **Statistical honesty (do not regress):** the agentic leg is NOT Monte Carlo. A scoped agent's tx lands in the **first block after the signal** regardless of whether it reacted in 1 s or 5 s — sub-block "seconds" do not move the outcome. Sampling 1–5 s and dividing by 60 collapses every sample onto one ground-truth endpoint, so P5=P50=P95 — 1000 iterations producing a single constant dressed as a distribution. We show the agentic leg as ONE honest deterministic value ("first block after signal, ~12–24 s"). Only the **manual** leg has real variance, so only it gets MC. Output is also **seeded** (reproducible — the committed numbers must be re-derivable).

**Files:**
- Create: `scripts/replay/monteCarlo.ts`
- Create: `scripts/replay/monteCarlo.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// scripts/replay/monteCarlo.test.ts
import { describe, it, expect } from 'vitest';
import { interpolateExit, summarize, run } from './monteCarlo.js';

const ground = { delay_2: 600, delay_15: 580, delay_50: 540, delay_150: 480, delay_600: 300 };

describe('monteCarlo', () => {
  it('interpolates between two ground-truth delay points', () => {
    // halfway between delay 2 (600) and delay 15 (580) ≈ ~590
    const v = interpolateExit(ground, 8.5);
    expect(v).toBeGreaterThan(580);
    expect(v).toBeLessThan(600);
  });

  it('clamps below min / above max delay to the endpoints', () => {
    expect(interpolateExit(ground, 0)).toBe(600);
    expect(interpolateExit(ground, 10_000)).toBe(300);
  });

  it('summarize returns ordered P5 <= P50 <= P95', () => {
    const samples = [300, 350, 400, 450, 500, 550, 600];
    const s = summarize(samples);
    expect(s.p5).toBeLessThanOrEqual(s.p50);
    expect(s.p50).toBeLessThanOrEqual(s.p95);
  });

  it('manual leg is a real distribution (P5 < P95)', () => {
    const r = run(ground, 1000, 123);
    expect(r.manual.p5).toBeLessThan(r.manual.p95); // genuine spread, not a constant
  });

  it('agentic leg is a single deterministic value (no MC theater)', () => {
    const r = run(ground, 1000, 123);
    expect(typeof r.agentic.deterministic).toBe('number');
    expect(r.agentic.deterministic).toBe(600); // first block after signal → clamps to delay_2
  });

  it('is reproducible for a fixed seed', () => {
    const a = run(ground, 200, 7);
    const b = run(ground, 200, 7);
    expect(a.manual).toEqual(b.manual);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `rtk npm --prefix frontend exec -- vitest run ../scripts/replay/monteCarlo.test.ts`
Expected: FAIL — module not found.

> **[VERIFY] script test runner:** the test lives in `scripts/` (repo root) but Vitest is installed under `frontend/`. The command above runs the frontend Vitest binary with cwd=`frontend/`, so the test path is `../scripts/...`. If that resolution fails in the agent's environment, either add `vitest` at the repo root or move `scripts/replay/` under `frontend/scripts/`. Do not silently skip the test.

- [ ] **Step 3: Implement monteCarlo.ts**

```ts
// scripts/replay/monteCarlo.ts
// Folds ground-truth fork exits into outcomes. MANUAL exit delay ~ lognormal
// (median ~25 min, p95 ~2 h) → real variance → Monte Carlo band. AGENTIC exit is
// deterministic: the tx lands in the first block after the signal (~12-24s); sub-block
// timing is meaningless, so no MC theater. Output is seeded (reproducible) and carries
// its assumptions in metadata — never hidden.
type Ground = Record<string, number>;

const DELAY_KEYS = (g: Ground) =>
  Object.keys(g)
    .filter((k) => k.startsWith('delay_'))
    .map((k) => ({ delay: Number(k.slice('delay_'.length)), v: g[k] }))
    .sort((a, b) => a.delay - b.delay);

export function interpolateExit(ground: Ground, delayBlocks: number): number {
  const pts = DELAY_KEYS(ground);
  if (delayBlocks <= pts[0].delay) return pts[0].v;
  if (delayBlocks >= pts[pts.length - 1].delay) return pts[pts.length - 1].v;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (delayBlocks >= a.delay && delayBlocks <= b.delay) {
      const t = (delayBlocks - a.delay) / (b.delay - a.delay);
      return a.v + t * (b.v - a.v);
    }
  }
  return pts[pts.length - 1].v;
}

/** Seedable PRNG so the committed JSON is reproducible. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lognormalSample(median: number, p95: number, rnd: () => number): number {
  const mu = Math.log(median);
  const sigma = (Math.log(p95) - mu) / 1.645;
  // Box-Muller
  const u1 = rnd() || 1e-9, u2 = rnd();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.exp(mu + sigma * z);
}

export function summarize(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { p5: q(0.05), p50: q(0.5), p95: q(0.95) };
}

export function run(ground: Ground, n = 1000, seed = 0xc0ffee) {
  const BLOCKS_PER_MIN = 5; // ~12s blocks
  const rnd = mulberry32(seed);
  const manual: number[] = [];
  for (let i = 0; i < n; i++) {
    const manualMin = lognormalSample(25, 120, rnd); // minutes
    manual.push(interpolateExit(ground, manualMin * BLOCKS_PER_MIN));
  }
  // Agentic: first available block after the signal. delayBlocks≈1 clamps to the
  // earliest ground-truth point — one honest number, not a fake distribution.
  const agenticValue = interpolateExit(ground, 1);
  return {
    label: 'Historical replay — not a prediction',
    seed,
    assumptions: {
      manualDelay: 'lognormal median 25min p95 2h (Monte Carlo)',
      agenticDelay: 'first block after signal (~12-24s) — deterministic, no MC',
      blocksPerMin: BLOCKS_PER_MIN,
      iterations: n,
      groundTruthSource: 'frontend/public/data/replay-usdc-depeg.json',
    },
    manual: summarize(manual),
    agentic: { deterministic: agenticValue, basis: 'first block after signal (~12-24s)' },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `rtk npm --prefix frontend exec -- vitest run ../scripts/replay/monteCarlo.test.ts`
Expected: PASS.

- [ ] **Step 5: Generate replay-mc.json from the ground truth (fixed seed)**

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && npm --prefix frontend exec -- tsx -e \"import {readFileSync,writeFileSync} from 'fs';import {run} from './scripts/replay/monteCarlo.ts';const g=JSON.parse(readFileSync('frontend/public/data/replay-usdc-depeg.json','utf8'));writeFileSync('frontend/public/data/replay-mc.json',JSON.stringify({...run(g,1000,0xC0FFEE), provenance:{signalBlock:g.signalBlock,chainId:g.chainId,depegDate:g.depegDate}},null,2));\""
```
Expected: `frontend/public/data/replay-mc.json` written with `manual` P5/P50/P95, `agentic.deterministic`, `seed`, `assumptions`, and `provenance` copied from the ground truth. (Re-running with the same seed must produce identical numbers — that is the reproducibility AC. **[VERIFY] `tsx` available via the frontend install**; if not, `npm --prefix frontend i -D tsx`.)

- [ ] **Step 6: Commit**

```bash
git add scripts/replay/monteCarlo.ts scripts/replay/monteCarlo.test.ts frontend/public/data/replay-mc.json
git commit -m "feat(simulation): seeded manual MC band + deterministic agentic value"
```

---

## Task 4: Static replay page + remove Aladdin concept

**Files:**
- Create: `frontend/src/screens/replay.js`
- Modify: frontend router/nav to add the route (find via `grep -rn "screens/" frontend/src/app.js frontend/src/ui.js`)
- Modify: `docs/` — remove Aladdin/6-variable references

- [ ] **Step 1: Render the static JSON (zero RPC, zero compute in browser)**

```js
// frontend/src/screens/replay.js
// Renders pre-computed replay JSON. No RPC, no math in the browser — the numbers
// come from the fork test + monte carlo step. "Assumptions" panel is mandatory.
// Manual leg = P5-P95 band; agentic leg = single deterministic line (honest framing).
export async function renderReplay(root) {
  const [ground, mc] = await Promise.all([
    fetch('/data/replay-usdc-depeg.json').then((r) => r.json()),
    fetch('/data/replay-mc.json').then((r) => r.json()),
  ]);
  const prov = mc.provenance ?? {};
  root.innerHTML = `
    <section aria-labelledby="replay-h">
      <h2 id="replay-h">USDC depeg — historical replay</h2>
      <p class="badge">${mc.label}</p>
      <div id="replay-chart"></div>
      <details open class="assumptions">
        <summary>Assumptions</summary>
        <ul>
          <li>Manual exit delay: ${mc.assumptions.manualDelay}</li>
          <li>Agentic exit delay: ${mc.assumptions.agenticDelay}</li>
          <li>Ground truth: real Uniswap V3 swaps on forked Ethereum mainnet</li>
          <li>Provenance: block ${prov.signalBlock ?? '—'}, chainId ${prov.chainId ?? '—'}, ${prov.depegDate ?? '—'}</li>
          <li>Seed: ${mc.seed} (numbers are reproducible)</li>
          <li>Amount in: ${(ground.amountInUsdc / 1e6).toLocaleString()} USDC</li>
        </ul>
      </details>
    </section>`;
  drawBand(root.querySelector('#replay-chart'), mc.manual, mc.agentic.deterministic);
}

function drawBand(el, manual, agenticValue) {
  // Manual P5-P95 band + manual P50 line + a single agentic deterministic line.
  const w = 640, h = 240, pad = 32;
  const all = [manual.p5, manual.p95, agenticValue];
  const min = Math.min(...all), max = Math.max(...all);
  const y = (v) => h - pad - ((v - min) / (max - min || 1)) * (h - 2 * pad);
  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Replay outcome band">
    <rect x="${pad}" y="${y(manual.p95)}" width="${w - 2 * pad}" height="${Math.abs(y(manual.p5) - y(manual.p95))}" fill="rgba(120,120,120,0.18)"/>
    <line x1="${pad}" x2="${w - pad}" y1="${y(manual.p50)}" y2="${y(manual.p50)}" stroke="#888" stroke-width="2"/>
    <line x1="${pad}" x2="${w - pad}" y1="${y(agenticValue)}" y2="${y(agenticValue)}" stroke="#3fb950" stroke-width="2"/>
  </svg>`;
}
```

- [ ] **Step 2: Register the route**

Add a `Replay` entry to the screen switch / nav in `frontend/src/app.js` (or wherever `renderX(root)` screens are dispatched). Minimal: `case 'replay': renderReplay(root); break;` plus a nav link.

- [ ] **Step 3: Remove the Aladdin / 6-variable concept from docs**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && grep -rinl 'Aladdin\|6-variable\|six-variable\|6 variabel' docs/"`
For each file, delete the Aladdin/6-variable paragraph and replace with a one-line pointer: `> Forward-looking scenarios are scoped to the Historical Replay (see frontend replay page) — not a predictive model.`

- [ ] **Step 4: Verify the page loads against the static files**

Run: `rtk npx serve frontend/` then load the replay route; confirm the chart + Assumptions panel render and the Network tab shows **no** RPC/API calls, only the two `/data/*.json` fetches.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/screens/replay.js frontend/src/app.js docs/
git commit -m "feat(replay): static historical-replay page; drop Aladdin concept"
```

---

## Self-Review checklist

- [ ] §0 carry-forward honored: `fs_permissions` present AND `frontend/public/data/` created before any `writeJson`; archive proven by a STATE query (`cast balance --block`), not a block header.
- [ ] Statistical honesty: agentic leg is a single deterministic value (no P5=P50=P95 theater); only the manual leg runs MC; output is seeded and reproducible.
- [ ] Provenance present in BOTH the ground-truth JSON (`signalBlock`, `chainId`, `depegDate`) and `replay-mc.json` — the Assumptions panel renders them.
- [ ] No dead code: `whale` constant removed (test uses `deal`); no `data-manual`/`data-agentic` attributes left on the chart div.
- [ ] Single-sourced RPC: the fork test uses `vm.rpcUrl("eth_mainnet")` (the `foundry.toml` alias), not a second `vm.envString`.
- [ ] 3.1→Task2, 3.2→Task3, 3.3→Task4, 3.4→Task4 Step3. 3.5 (Base-native variant) is optional and omitted — note for later.
- [ ] No placeholders except clearly-flagged `[VERIFY]` external facts (block number, router/pool addresses) which the roadmap explicitly forbids guessing.
- [ ] Type consistency: `interpolateExit(ground, delayBlocks)`, `summarize(samples)→{p5,p50,p95}`, `run(ground,n,seed)→{...,manual,agentic:{deterministic,basis}}` identical across test, impl, and the generation step.
- [ ] Browser does zero compute/RPC — only fetches the two static JSON files.
