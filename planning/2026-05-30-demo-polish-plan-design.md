# Demo-Polish Plan — Design Spec

> **Status:** approved structure, ready for implementation plan
> **Date:** 2026-05-30
> **Scope:** Testnet (Sepolia). Mainnet items recorded as checklist only — NOT executed.
> **Deadline:** 15 Jun 2026 (hackathon demo)
> **Location:** `planning/` — gitignored, never committed (per CLAUDE.md).

---

## 1. Goal

Polish the existing app so that, for the hackathon demo:

- **Zero dead buttons** — every interactive control maps to a real effect.
- **Every flow works end-to-end on Sepolia** — Home → Strategy → Connect → Skills → Permission → Execute → Done → Agent monitor → Withdraw/Harvest.
- **Looks production-real for judges** — more vaults, no fake/hardcoded values, honest states.
- **Mainnet-aware** — security hardening reviewed and recorded as a checklist; execution stays on testnet.

Non-goals (this cycle): real DEX integration, removing MockVault, real mainnet deploy, real fund custody.

---

## 2. Decisions (locked)

| Topic | Decision |
|-------|----------|
| Audience/timing | Hackathon demo (15 Jun). Demo-readiness > production completeness. |
| Polish scope | Dead buttons + broken flows, error handling/edge cases, UX/visual refinement, smart-contract polish, **more vaults**. |
| Mainnet-prep | **Skip execution.** Keep **security hardening** as a recorded checklist. |
| "More vaults" | **Hybrid** — deploy 2 more MockVaults (→ 4 real, 1:1 with core catalog), enrich catalog metadata, remove duplicate-address aliasing. |
| Dev TweaksPanel | **Gate behind a flag** (`?dev=1` / env). Clean for judges, available for practice. Remove fake-hash "Jump to step" from the judged path. |

---

## 3. Concrete findings (grounded audit)

These are confirmed by reading the code, not speculation. They seed the workstreams.

### Critical
- **C1 — Landing screen crash.** `frontend/src/components/HomePage.jsx:102` references `lang` inside the no-wallet early-return (State 1), but `const lang` is destructured from `loadSettings()` at line 118 — after the return. Temporal-dead-zone `ReferenceError` ("Cannot access 'lang' before initialization"). Default view is `home`, default `userAddress` is null → **the first screen a judge sees can crash.** Fix: move `loadSettings()` (and `lang`) above the State-1 return.

### Dead / non-functional controls
- **D1 — Dead AI-model setting.** `SettingsPage.jsx:198-201` offers radios "DeepSeek V4 Flash / Pro / Venice AI" bound to `modelPreference`. `venice.js resolveProvider()` (lines 43-66) never reads `modelPreference` — it branches only on `veniceAuth` vs `devApiKey`. Setting writes localStorage and changes nothing. `DEEPSEEK_MODEL` is a single constant; "Flash/Pro" map to nothing.
- **D2 — Dead edit-mode prop.** `app.jsx:1059` passes `onOpenSettings={() => window.postMessage({ type: '__activate_edit_mode' }, '*')}` to `AgentDashboard`, which never renders an `onOpenSettings` control. Dead wire + dev hack on the judged path.
- **D3 — Dead About links.** `SettingsPage.jsx:141-142` — `ghUrl`/`hqUrl` default to `'#'` when `VITE_GITHUB_URL`/`VITE_HACKQUEST_URL` are unset → "View on GitHub" / "HackQuest submission" are dead in demo.

### Fake / hardcoded values
- **F1 — Fake permission countdown.** `"23h 59m"` hardcoded in `app.jsx` PermissionPanel (line ~108) and `SettingsPage.jsx:256` ("23h 59m remaining"). Not derived from real `expiresAt`.
- **F2 — Vault duplicate aliasing.** `config.js VAULT_CATALOG` has 4 entries but only 2 real addresses: Pendle → `MOCK_VAULT_B_ADDRESS`, Fluid → `MOCK_VAULT_A_ADDRESS`. Execution collapses distinct "vaults" onto the same 2 contracts.
- **F3 — Connection-test honesty.** `SettingsPage testVenice/testTavily` (lines 110-123): no timeout; browser-side fetch with bearer key may always CORS-fail → misleading "✗ failed".

### Error-handling gaps
- **E1 — Mis-typed failure logs.** `app.jsx handleConnect` catch logs `event: "OrchestratorPlanned"` for a connect failure (line ~577). Several failures only `addLog` to the activity rail; no card-level user feedback (connect fail, permission denied, orchestrator dispatch error).
- **E2 — Errors invisible in primary UI.** Most async failures surface only in the right-rail Activity list, which a judge may not be looking at.

### Code quality
- **Q1 — `app.jsx` is 1212 lines** (> 800 limit). Right-rail panels (Wallet/Permission/Activity/Skill), PalettePicker, and TweaksPanel content are inline and extractable.
- **Q2 — i18n partial.** `t(lang, …)` covers some labels; many hardcoded English strings remain (HomePage State 2, AgentDashboard, WithdrawModal rows). Language toggle looks more complete than it is.
- **Q3 — `console.*` scattered** in client code (rules: none in prod). Minor.
- **Q4 — `cursor: default` on clickable buttons** (PalettePicker `app.jsx:245`, some Settings rows) — feels unresponsive.

### Smart contracts
- `MockVault.sol` constructor: `(string name, address asset, uint256 apyBps)`. Pure-accounting, no real ERC20 transfer. Clean, well-commented.
- `script/Deploy.s.sol` deploys A=480bps, B=610bps + depositor. Hybrid adds C/D here.
- `AgentVaultDepositor.sol` + tests not yet deep-reviewed — WS7 covers NatSpec, event/edge coverage, `forge test`, coverage ≥80%, security checklist.

---

## 4. Workstreams (ordered by demo risk)

### WS1 — Critical bug fixes (FIRST)
- Fix C1 (HomePage TDZ landing crash): hoist `loadSettings()` + `lang` above the State-1 early return.
- Sweep for the same use-before-declare / undefined-var class across all components.
- Smoke-test the full happy path once after the fix.

### WS2 — Dead-button & broken-flow audit
- Remove D2 (dead `onOpenSettings` edit-mode wire).
- Fix D3 (About links): set real env URLs or hide the buttons when unset.
- Systematic pass: trace every `onClick`/handler to a real effect; flag `() => {}` no-op fallbacks; confirm each control in Home, Dashboard, Settings, Skills, Withdraw, History, step-flow does something.

### WS3 — Vaults: Hybrid realism
- Add 2 `MockVault` deploys in `script/Deploy.s.sol` (distinct APY, e.g. C=940 "Pendle-like", D=520 "Fluid-like").
- `forge build` + `forge test` + deploy to Sepolia (WSL/forge only).
- Update `config.js`: 4 real addresses, each core catalog entry 1:1 to a real vault; remove duplicate aliasing.
- Update `SettingsPage` About contract rows (MockVault A–D).
- Verify strategy → orchestrator → execution maps each agent to its own real vault address.

### WS4 — Fake/hardcoded → real
- Fix F1: real permission countdown from `expiresAt` (PermissionPanel + Settings).
- Fix D1: either wire `modelPreference` into `resolveProvider()`, OR relabel/trim the radios to match what actually routes. (Decide in implementation; honesty over feature theater.)
- Fix F3: add timeout + honest pass/fail to connection tests; if browser CORS makes them unreliable, route through the existing `/api` proxy or drop the buttons.

### WS5 — Error handling & edge states
- Fix E1: correct mis-typed log events (connect failure ≠ `OrchestratorPlanned`).
- Fix E2: surface failures in the **card UI** for connect, permission, execution, withdraw, harvest — not only the activity rail.
- Audit loading / empty / error states for every async action (wallet, relay, venice, withdraw, harvest, DeFiLlama, Tavily).

### WS6 — Dev panel gating + UX refinement
- Gate `TweaksPanel` + "Jump to step" behind `?dev=1` / env flag. Remove fake-hash jump from the judged path.
- UX: `cursor: pointer` on clickable controls (Q4); audit hover/focus/active states.
- i18n (Q2): close the biggest hardcoded-string gaps so the language toggle is believable, or scope the toggle honestly.
- Extract `app.jsx` (Q1): pull right-rail panels + TweaksPanel into `components/` modules to get under 800 lines.
- Remove stray `console.*` from client code (Q3).

### WS7 — Smart-contract polish + security checklist
- Deep-review `AgentVaultDepositor.sol` + `MockVault.sol`: NatSpec completeness, event coverage, edge cases.
- `forge test` green; `forge coverage` ≥ 80%; add missing tests (success, scope violations, expiry, fuzz).
- **Security hardening checklist (recorded):** reentrancy guard / CEI ordering, amount ≤ maxAmount revert, vault == allowedVault revert, `block.timestamp < expiresAt` revert, no privileged admin backdoor post-deploy, secret/env handling (no keys in client). Mark mainnet-execution items as "pre-mainnet TODO".

---

## 5. Constraints & environment

- **Foundry runs in WSL only** — `forge`/`cast` via `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer && …"`. Never in PowerShell.
- **`planning/` is gitignored** — this spec and the implementation plan are not committed.
- Frontend: React 18 + Vite, ethers v6, vis/React-Flow graph. Dev: `npx serve frontend/` or vite dev.
- Mainnet target (future, for context): Base / Base Sepolia (1Shot relayer unsupported on Eth Sepolia per migration note) — out of scope this cycle.

---

## 6. Success criteria

- [ ] Landing screen renders without error (C1 fixed).
- [ ] Every button in Home, Dashboard, Settings, Skills, Withdraw, History, step-flow maps to a real effect (no dead controls).
- [ ] 4 real MockVaults on Sepolia; strategy executes to 4 distinct addresses; no duplicate aliasing.
- [ ] No fake/hardcoded demo values on the judged path (countdown real; model setting honest; links real or hidden).
- [ ] Async failures visible in primary card UI, not just the activity rail.
- [ ] Dev panel hidden by default; full happy path works without it.
- [ ] `forge test` green, coverage ≥ 80%, security checklist recorded.
- [ ] `app.jsx` under 800 lines.
