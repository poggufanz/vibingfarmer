# Demo-Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Vibing Farmer demo-ready on Sepolia — zero dead buttons, every flow working end-to-end, more real vaults, no fake/hardcoded values, security reviewed — by 15 Jun 2026.

**Architecture:** Surgical fixes across the React/Vite frontend + Foundry contracts. Fix the landing crash first, then sweep dead/fake controls, deploy 2 more MockVaults (hybrid realism), harden error states, gate the dev panel, and finish with a contract test + security pass. No rewrites — follow existing patterns.

**Tech Stack:** React 18 + Vite, ethers v6, ESM CDN imports, Foundry (Solidity 0.8.24, runs in WSL only), localStorage persistence, vis/React-Flow graph.

**Spec:** `planning/2026-05-30-demo-polish-plan-design.md`

---

## Conventions

- **Foundry only in WSL.** Prefix: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer && <cmd>"`.
- **Frontend dev server:** `cd frontend && npm run dev` (Vite). Used for manual smoke verification.
- **`planning/` is gitignored.** This plan is not committed.
- **Verification reality:** the frontend has no unit-test harness wired. For pure functions we add a tiny check; for UI wiring, verification is a **manual browser smoke step** with an exact expected observation. Where a step says "smoke", open the dev server and follow the stated check.
- **Commits:** small, conventional (`fix:`, `feat:`, `refactor:`, `test:`, `chore:`). Commit after each task. End commit messages with the Co-Authored-By trailer per global git rule.
- **Branch:** work on `dev-iq` (current). Do not push unless asked.

---

## File map

| File | Responsibility | WS |
|------|----------------|----|
| `frontend/src/components/HomePage.jsx` | C1 TDZ landing crash | WS1 |
| `frontend/src/app.jsx` | dead edit-mode wire, mis-typed logs, fake countdown, panel extraction, dev-flag gating | WS2/4/5/6 |
| `frontend/src/components/SettingsPage.jsx` | dead model setting, fake countdown, About links, connection tests | WS2/4 |
| `frontend/src/venice.js` | `modelPreference` routing decision | WS4 |
| `frontend/src/config.js` | 4 real vault addresses, de-aliased catalog | WS3 |
| `frontend/src/devFlag.js` (new) | dev-mode flag helper | WS6 |
| `frontend/src/components/RightRail.jsx` (new) | extracted right-rail panels | WS6 |
| `script/Deploy.s.sol` | deploy MockVault C + D | WS3 |
| `test/MockVault.t.sol` | vault coverage (existing) | WS7 |
| `test/AgentVaultDepositor.t.sol` | depositor coverage + security tests | WS7 |
| `planning/security-checklist.md` (new) | recorded mainnet hardening checklist | WS7 |

---

## WS1 — Critical bug fixes

### Task 1: Fix HomePage landing-screen TDZ crash (C1)

**Files:**
- Modify: `frontend/src/components/HomePage.jsx` (State-1 early return ~line 92-109; `lang` declaration ~line 118)

**Problem:** `t(lang, 'connectWallet')` at line ~102 runs inside the `if (!userAddress)` early return, but `const { ..., language: lang } = loadSettings()` is at line ~118 — after the return. TDZ → `ReferenceError`, landing screen crashes.

- [ ] **Step 1: Reproduce the crash (smoke, RED)**

Run: `cd frontend && npm run dev`, open the app with no wallet connected (default `view='home'`, `userAddress=null`).
Expected: blank screen / React error overlay "Cannot access 'lang' before initialization".

- [ ] **Step 2: Hoist `loadSettings()` above the early return**

In `HomePage.jsx`, move the settings read to the top of the component body (right after `const posList = ...` or before the `if (!userAddress)` block). Replace the later in-body declaration so `lang` is defined once, early.

Find the State-1 return block and ensure `lang` is in scope. Concretely, near the top of `export default function HomePage(...)`:

```jsx
  const [withdrawVault, setWithdrawVault] = useState(null)
  const [dismissed, setDismissed] = useState(() => new Set())
  const [pulse, setPulse] = useState(() => pulseCache || { vaults: SEED, prev: [], fetchedAt: null, live: false })

  // Read settings once, before any early return (was declared after the no-wallet return → TDZ crash)
  const settings = loadSettings()
  const lang = settings.language

  const posList = Object.entries(positions)
```

Then update the later usage (the line that was `const { alertBanner, language: lang } = loadSettings()`) to reuse `settings`:

```jsx
  // Alert banner: first unread high/medium risk alert (dismiss is per-session, local state).
  const { alertBanner } = settings
  const bannerEnabled = alertBanner !== false
```

Remove the now-duplicate `language: lang` destructure so `lang` is not redeclared.

- [ ] **Step 3: Verify the landing screen renders (smoke, GREEN)**

Run: refresh `npm run dev` with no wallet.
Expected: landing renders — brand, "Autonomous yield farming…" lede, "Connect Wallet" button visible, no console error.

- [ ] **Step 4: Sweep for the same use-before-declare class**

Run: `rg -n "language: lang|const lang" frontend/src` and visually confirm no other component references `lang` (or any `loadSettings()` destructure) before its declaration inside an early return. Note findings; fix any with the same hoist pattern.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/HomePage.jsx
git commit -m "fix: hoist loadSettings above no-wallet return to fix landing TDZ crash"
```

---

## WS2 — Dead-button & broken-flow audit

### Task 2: Remove dead edit-mode wire (D2)

**Files:**
- Modify: `frontend/src/app.jsx` (AgentDashboard usage ~line 1046-1062)

**Problem:** `onOpenSettings={() => window.postMessage({ type: '__activate_edit_mode' }, '*')}` is passed to `AgentDashboard`, which never renders an `onOpenSettings` control. Dead wire + dev hack.

- [ ] **Step 1: Confirm prop is unused in AgentDashboard**

Run: `rg -n "onOpenSettings" frontend/src/components/AgentDashboard.jsx`
Expected: appears only in the destructured props list, never called.

- [ ] **Step 2: Remove the prop from the call site**

In `app.jsx`, delete the `onOpenSettings={...}` line from the `<AgentDashboard ... />` usage.

- [ ] **Step 3: Remove the unused prop from AgentDashboard signature**

In `AgentDashboard.jsx`, remove `onOpenSettings` from the destructured props.

- [ ] **Step 4: Verify (smoke)**

Run: dev server → open Agent view. Expected: dashboard renders unchanged, no console error.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app.jsx frontend/src/components/AgentDashboard.jsx
git commit -m "fix: remove dead __activate_edit_mode wire from AgentDashboard"
```

### Task 3: Fix dead About links (D3)

**Files:**
- Modify: `frontend/src/components/SettingsPage.jsx` (~line 141-142, 322-325)
- Modify: `.env` / `.env.example` (add the two vars)

**Problem:** `ghUrl`/`hqUrl` fall back to `'#'` when env unset → dead "View on GitHub" / "HackQuest submission" links.

- [ ] **Step 1: Add env vars**

Append to `.env.example` (and your local `.env`):

```
VITE_GITHUB_URL=https://github.com/poggufanz/vibingfarmer
VITE_HACKQUEST_URL=https://www.hackquest.io/
```

(Use the real submission URL when available; placeholder is fine for now but must not be `#`.)

- [ ] **Step 2: Hide buttons when the URL is genuinely missing**

In `SettingsPage.jsx`, change the About link block so a button only renders when its URL is real:

```jsx
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            {ghUrl !== '#' && (
              <a href={ghUrl} target="_blank" rel="noopener noreferrer" style={{ ...miniBtn, textDecoration: 'none' }}>View on GitHub</a>
            )}
            {hqUrl !== '#' && (
              <a href={hqUrl} target="_blank" rel="noopener noreferrer" style={{ ...miniBtn, textDecoration: 'none' }}>HackQuest submission</a>
            )}
          </div>
```

- [ ] **Step 3: Verify (smoke)**

Run: restart dev server (env change needs restart) → Settings → About. Expected: links present and open the real URL in a new tab; no `#` dead link.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/SettingsPage.jsx .env.example
git commit -m "fix: real About links, hide when URL unset"
```

### Task 4: Full dead-button sweep + inventory

**Files:**
- Create: `planning/dead-button-audit.md`

- [ ] **Step 1: Enumerate every interactive control**

Run: `rg -n "onClick=|onChange=|href=" frontend/src/components frontend/src/app.jsx frontend/src/screens.jsx frontend/src/skills.jsx frontend/src/agents.jsx`

- [ ] **Step 2: Trace each to a real effect**

For each control, record in `planning/dead-button-audit.md`: file:line, control label, handler, and verdict (`live` / `no-op` / `fixed`). Flag any `onClick={() => {}}`, `onSuccess || (() => {})` swallow, or handler that only `console.*`.

- [ ] **Step 3: Fix flagged no-ops**

For each `no-op`, either wire the real effect or remove the control. (Most should already be `live` after Tasks 2-3.)

- [ ] **Step 4: Smoke the surfaces**

Click through Home, Agent, Settings, History, Skills drawer, Withdraw modal, and the step-flow. Confirm every button does something visible.

- [ ] **Step 5: Commit**

```bash
git add planning/dead-button-audit.md frontend/src
git commit -m "chore: dead-button audit inventory + no-op fixes"
```

---

## WS3 — Vaults: Hybrid realism

### Task 5: Add MockVault C + D to the deploy script (F2)

**Files:**
- Modify: `script/Deploy.s.sol`

**Problem:** Only 2 real vaults; catalog aliases Pendle→B, Fluid→A. Add 2 more so 4 catalog cores map 1:1 to 4 real contracts.

- [ ] **Step 1: Add two MockVault deploys**

In `Deploy.s.sol run()`, after `vaultB`:

```solidity
        // apyBps: C = 940 (9.4%, Pendle-like structured), D = 520 (5.2%, Fluid-like hybrid)
        MockVault vaultC = new MockVault("MockVault USDC-C", address(0), 940);
        MockVault vaultD = new MockVault("MockVault USDC-D", address(0), 520);
```

Add their addresses to the console output block:

```solidity
        console.log("VaultC (MockVault USDC-C):", address(vaultC));
        console.log("VaultD (MockVault USDC-D):", address(vaultD));
        console.log("MOCK_VAULT_C_ADDRESS=", address(vaultC));
        console.log("MOCK_VAULT_D_ADDRESS=", address(vaultD));
```

- [ ] **Step 2: Build (RED→GREEN compile)**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer && forge build"`
Expected: compiles clean.

- [ ] **Step 3: Run existing tests**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer && forge test"`
Expected: all pass (no behavior change to MockVault).

- [ ] **Step 4: Commit**

```bash
git add script/Deploy.s.sol
git commit -m "feat: deploy MockVault C and D for hybrid vault realism"
```

### Task 6: Deploy to Sepolia + capture addresses

**Files:**
- Modify: `.env` (local, not committed)

- [ ] **Step 1: Deploy**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer && forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC --broadcast --verify"`
Expected: 4 MockVault addresses + 1 depositor printed.

- [ ] **Step 2: Record the 4 vault addresses + depositor**

Copy `MOCK_VAULT_A/B/C/D_ADDRESS` and `AGENT_VAULT_DEPOSITOR_ADDRESS` into `.env`.

- [ ] **Step 3: Sanity-read one vault on-chain**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer && cast call <VAULT_C_ADDR> 'apyBps()(uint256)' --rpc-url $SEPOLIA_RPC"`
Expected: `940`.

- [ ] **Step 4: Commit** (only if any tracked file changed; `.env` is gitignored — likely nothing to commit. Skip if clean.)

### Task 7: De-alias the catalog in config.js (F2)

**Files:**
- Modify: `frontend/src/config.js`

- [ ] **Step 1: Add the two new address constants**

```js
export const MOCK_VAULT_C_ADDRESS = '0x...' // from deploy (Pendle-like, 9.4%)
export const MOCK_VAULT_D_ADDRESS = '0x...' // from deploy (Fluid-like, 5.2%)
```

Use the real deployed addresses from Task 6.

- [ ] **Step 2: Point each catalog core at its own address**

In `VAULT_CATALOG`, change Pendle's `address` to `MOCK_VAULT_C_ADDRESS` and Fluid's `address` to `MOCK_VAULT_D_ADDRESS`. Update the inline comment that says "All entries map to the two really-deployed MockVaults" → "Each core maps 1:1 to a deployed MockVault (A-D)."

- [ ] **Step 3: Verify no duplicate addresses remain**

Run: `rg -n "MOCK_VAULT_._ADDRESS" frontend/src/config.js` and confirm each catalog entry uses a distinct address.

- [ ] **Step 4: Smoke high-risk strategy (3 vaults)**

Run: dev server → Home → Start Strategy → amount 1000, risk **high** (numVaults=3) → generate → Connect → Permission → Execute. Expected: 3 workers, 3 **distinct** vault addresses in the Execute card / activity log.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/config.js
git commit -m "fix: map each vault catalog core to its own deployed MockVault (no duplicate aliasing)"
```

### Task 8: Update Settings About contract rows

**Files:**
- Modify: `frontend/src/components/SettingsPage.jsx` (~line 6-8 import, ~line 310-312)

- [ ] **Step 1: Import the new addresses**

Add `MOCK_VAULT_C_ADDRESS, MOCK_VAULT_D_ADDRESS` to the config import.

- [ ] **Step 2: Render rows C + D**

After the MockVault B row:

```jsx
          <ContractRow name="MockVault C" addr={MOCK_VAULT_C_ADDRESS} />
          <ContractRow name="MockVault D" addr={MOCK_VAULT_D_ADDRESS} />
```

- [ ] **Step 3: Verify (smoke)**

Run: Settings → About. Expected: 4 MockVault rows, each with a distinct address + Sourcify link.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/SettingsPage.jsx
git commit -m "feat: show MockVault C and D in Settings About"
```

---

## WS4 — Fake/hardcoded → real

### Task 9: Real permission countdown (F1)

**Files:**
- Modify: `frontend/src/app.jsx` (PermissionPanel ~line 99-109; store `expiresAt` in `handlePermConfirm` ~line 651)
- Modify: `frontend/src/components/SettingsPage.jsx` (~line 256)

**Problem:** `"23h 59m"` is hardcoded in two places.

- [ ] **Step 1: Capture the real expiry when permission is granted**

In `app.jsx`, add state: `const [permExpiresAt, setPermExpiresAt] = useS(null);` near the other permission state.

In `handlePermConfirm`, after `requestERC7715Permission(86400)` succeeds, set the expiry from now + the requested window:

```js
      const expiresAtMs = Date.now() + 86400 * 1000;
      setPermExpiresAt(expiresAtMs);
```

Clear it in `handleRevoke` and `handleAgain`: `setPermExpiresAt(null);`.

- [ ] **Step 2: Add a countdown formatter + live tick**

Near the top helpers in `app.jsx`:

```js
const fmtRemaining = (expiresAtMs) => {
  if (!expiresAtMs) return null;
  const ms = expiresAtMs - Date.now();
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m`;
};
```

In `App`, add a 30s tick so the label refreshes:

```js
  const [, setClock] = useS(0);
  useE(() => { const id = setInterval(() => setClock((c) => c + 1), 30000); return () => clearInterval(id); }, []);
```

- [ ] **Step 3: Use the real value in PermissionPanel**

Pass `expiresAt={permExpiresAt}` into `<PermissionPanel ... />`, accept it in the component signature, and replace the hardcoded string:

```jsx
      <div className={`perm-status ${active ? "active" : ""}`}>
        {active ? `${agents.length} permission · ${fmtRemaining(expiresAt) || "—"}` : "no active permission"}
      </div>
```

(Move `fmtRemaining` to module scope so PermissionPanel can use it.)

- [ ] **Step 4: Fix the Settings copy**

In `SettingsPage.jsx`, the Active Permissions row `desc` hardcodes "23h 59m remaining". Pass a real value down. Add a prop `permExpiresAt` to `SettingsPage`, thread it from `app.jsx`, and compute the label:

```jsx
            <Row label="Active Permissions" desc={permActive ? `${permissionCount} permission · ${fmtRemaining(permExpiresAt) || '—'} remaining · erc-7715 · batch` : 'no active permission'}>
```

Export `fmtRemaining` from a shared spot (e.g. add to `frontend/src/ui.js`) and import it in both files to stay DRY.

- [ ] **Step 5: Verify (smoke)**

Run: dev server → complete a strategy to the permission grant. Expected: countdown shows a real value near `24h 0m` and decreases over time; Settings shows the same.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app.jsx frontend/src/components/SettingsPage.jsx frontend/src/ui.js
git commit -m "fix: real ERC-7715 permission countdown (replace hardcoded 23h 59m)"
```

### Task 10: Make the AI-model setting honest (D1)

**Files:**
- Modify: `frontend/src/venice.js` (`resolveProvider` ~line 43-66) OR `frontend/src/components/SettingsPage.jsx` (~line 198-205)

**Problem:** `modelPreference` (flash/pro/venice) is never read by `resolveProvider`. The radios are decorative. "DeepSeek V4 Flash/Pro" don't map to any real model id.

**Decision rule:** Prefer honesty with minimal risk. If wiring the switch is low-risk, wire it; otherwise relabel to reflect the real routing (`veniceAuth` → Venice, else server proxy). For demo safety, **relabel** is the default; wire only if time allows.

- [ ] **Step 1: Confirm the gap**

Run: `rg -n "modelPreference" frontend/src` — expected: only written in `SettingsPage`/`settingsStore`, never read in `venice.js`.

- [ ] **Step 2 (default — relabel honestly):** Replace the three radios with options that match real routing:

```jsx
          <SubLabel>AI Model · Strategy engine</SubLabel>
          <Radio sel={s.modelPreference === 'auto'} onClick={() => set('modelPreference', 'auto')} title="Auto (recommended)" desc="Venice AI when wallet-authorized, else server proxy." />
          <Radio sel={s.modelPreference === 'venice'} onClick={() => set('modelPreference', 'venice')} title="Venice AI" desc="x402 SIWE auth · requires connected wallet" />
```

Drop the fictional "DeepSeek V4 Flash/Pro" labels. Keep the Venice API key field.

- [ ] **Step 3 (optional — actually wire it):** If wiring, thread `modelPreference` into `generateStrategy` → `resolveProvider(veniceAuth, devApiKey, modelPreference)` and branch: `venice` forces the Venice path when auth exists; `auto` keeps current priority. Only do this if a quick smoke confirms strategy still generates.

- [ ] **Step 4: Verify (smoke)**

Run: Settings → AI Model. Expected: options describe what actually happens; generating a strategy still works.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/SettingsPage.jsx frontend/src/venice.js
git commit -m "fix: honest AI-model setting (relabel to real routing / wire modelPreference)"
```

### Task 11: Honest connection tests (F3)

**Files:**
- Modify: `frontend/src/components/SettingsPage.jsx` (`testVenice`/`testTavily` ~line 110-123)

**Problem:** No timeout; browser CORS may make `/models` and Tavily always fail → misleading "✗ failed".

- [ ] **Step 1: Add a timeout via AbortController**

```jsx
  const withTimeout = (ms) => { const c = new AbortController(); const id = setTimeout(() => c.abort(), ms); return { signal: c.signal, done: () => clearTimeout(id) }; }
```

- [ ] **Step 2: Use it + distinguish CORS/network from auth failure**

```jsx
  const testVenice = async () => {
    setTest((t) => ({ ...t, venice: 'testing' }))
    const to = withTimeout(8000)
    try {
      const res = await fetch(`${VENICE_BASE_URL}/models`, { headers: s.veniceApiKey ? { Authorization: `Bearer ${s.veniceApiKey}` } : {}, signal: to.signal })
      setTest((t) => ({ ...t, venice: res.ok ? 'ok' : 'fail' }))
    } catch (e) {
      // CORS/network/timeout — not necessarily a bad key
      setTest((t) => ({ ...t, venice: 'unreachable' }))
    } finally { to.done() }
  }
```

Apply the same pattern to `testTavily`.

- [ ] **Step 3: Render the third state**

```jsx
        {testState === 'ok' && <span style={{ fontSize: 11, color: 'var(--ok)' }}>✓ connected</span>}
        {testState === 'fail' && <span style={{ fontSize: 11, color: 'var(--danger)' }}>✗ rejected (check key)</span>}
        {testState === 'unreachable' && <span style={{ fontSize: 11, color: 'var(--warn)' }}>⚠ unreachable from browser (CORS/network)</span>}
```

- [ ] **Step 4: Verify (smoke)**

Run: Settings → Test connection with empty + a junk key. Expected: shows a timeout/unreachable warning instead of a hard "failed" within 8s.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/SettingsPage.jsx
git commit -m "fix: connection tests get timeout + honest unreachable state"
```

---

## WS5 — Error handling & edge states

### Task 12: Fix mis-typed failure logs (E1)

**Files:**
- Modify: `frontend/src/app.jsx` (`handleConnect` catch ~line 575-578)

- [ ] **Step 1: Use a failure event for connect errors**

Change the catch log from `event: "OrchestratorPlanned"` to `event: "AgentFailed"`:

```js
    } catch (err) {
      setConnectPhase("idle");
      addLog({ event: "AgentFailed", meta: `connect failed: ${err.message}` });
      setConnectError(err.message);
    }
```

- [ ] **Step 2: Scan for other mis-typed logs**

Run: `rg -n 'event: "OrchestratorPlanned"' frontend/src/app.jsx` and confirm each remaining use is genuinely informational (planning), not a failure. Fix any failure path using a non-failure event.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/app.jsx
git commit -m "fix: connect failures log as AgentFailed, not OrchestratorPlanned"
```

### Task 13: Surface failures in the card UI (E2)

**Files:**
- Modify: `frontend/src/app.jsx` (add error state + pass to cards)
- Modify: `frontend/src/screens.jsx` (`ConnectCard`, `PermissionCard` — render error)

**Problem:** connect / permission / orchestrator failures only `addLog` to the right rail; a judge watching the main card sees nothing.

- [ ] **Step 1: Add error state**

In `App`: `const [connectError, setConnectError] = useS(null);` and `const [permError, setPermError] = useS(null);`. Clear them when re-entering the relevant stage and in `handleAgain`.

- [ ] **Step 2: Set `permError` on permission failure**

In `handlePermConfirm` catch: `setPermError(err.message);` alongside the existing `addLog`.

- [ ] **Step 3: Render the error in the cards**

Pass `error={connectError}` to `<ConnectCard>` and `error={permError}` to `<PermissionCard>`. In `screens.jsx`, render a visible alert inside each card when `error` is set:

```jsx
        {error && <div role="alert" style={{ color: 'var(--danger)', fontSize: 11, marginTop: 10 }}>{error}</div>}
```

(Match the existing card markup; place it near the action buttons.)

- [ ] **Step 4: Verify (smoke)**

Run: dev server → reject the MetaMask connect prompt. Expected: the Connect card shows a red error message (not just the activity rail).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app.jsx frontend/src/screens.jsx
git commit -m "feat: surface connect/permission failures in the card UI"
```

### Task 14: Audit async loading/empty/error states

**Files:**
- Create: `planning/async-state-audit.md`

- [ ] **Step 1: List every async action**

Record in `planning/async-state-audit.md`: wallet connect/upgrade/switch, ERC-7715 grant, orchestrator dispatch, withdraw, harvest, emergency withdraw, Venice generate, DeFiLlama fetch, Tavily search. For each: does it have loading, empty, and error states?

- [ ] **Step 2: Fill the worst gaps**

Prioritize the judged happy path (connect → permission → execute → done → withdraw). Add missing loading/disabled states where a double-click or hang would confuse a judge. (WithdrawModal already has solid states — use it as the reference pattern.)

- [ ] **Step 3: Verify (smoke)** the happy path once end-to-end; confirm no button is clickable twice mid-flight.

- [ ] **Step 4: Commit**

```bash
git add planning/async-state-audit.md frontend/src
git commit -m "chore: async state audit + fill loading/error gaps on happy path"
```

---

## WS6 — Dev panel gating + UX refinement

### Task 15: Dev-mode flag helper

**Files:**
- Create: `frontend/src/devFlag.js`

- [ ] **Step 1: Write the helper**

```js
// devFlag.js — gate dev-only UI behind ?dev=1 or VITE_DEV_PANEL=1
export const isDevMode = () => {
  try {
    if (import.meta.env.VITE_DEV_PANEL === '1') return true;
    return new URLSearchParams(window.location.search).get('dev') === '1';
  } catch { return false; }
};
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/devFlag.js
git commit -m "feat: add isDevMode flag helper for dev-only UI"
```

### Task 16: Gate TweaksPanel + Jump-to-step (dev panel)

**Files:**
- Modify: `frontend/src/app.jsx` (TweaksPanel block ~line 1113-1207)

- [ ] **Step 1: Import the flag**

`import { isDevMode } from './devFlag.js';` and `const devMode = isDevMode();` in `App`.

- [ ] **Step 2: Gate the whole TweaksPanel**

Wrap the `<TweaksPanel ...> ... </TweaksPanel>` block: `{devMode && ( ... )}`.

- [ ] **Step 3: Remove the fake-hash jump from the judged path**

The "Jump to step" buttons use `fakeHash()` for the `done` state. Since the panel is now dev-gated, keep it for practice — but add a visible `[dev]` label to the section so it's never mistaken for a real result. Change `<TweakSection label="Jump to step" />` → `<TweakSection label="Jump to step · dev only" />`.

- [ ] **Step 4: Verify (smoke)**

Run: open `http://localhost:5173/` (no `?dev=1`). Expected: no Tweaks panel in the corner.
Run: open `http://localhost:5173/?dev=1`. Expected: Tweaks panel visible.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app.jsx
git commit -m "feat: gate dev TweaksPanel + Jump-to-step behind ?dev=1 flag"
```

### Task 17: UX cursor + interaction states (Q4)

**Files:**
- Modify: `frontend/src/app.jsx` (PalettePicker ~line 245, jump buttons ~line 1196)
- Modify: `frontend/src/components/SettingsPage.jsx` (Radio rows with `cursor: 'default'`)

- [ ] **Step 1: Replace `cursor: default` with `pointer` on clickable controls**

Run: `rg -n "cursor: \"default\"|cursor: 'default'" frontend/src` to find them. For each that is a real button/clickable, change to `pointer`. (Leave genuinely non-interactive elements alone.)

- [ ] **Step 2: Verify (smoke)** hovering palette swatches + settings radios shows a pointer cursor.

- [ ] **Step 3: Commit**

```bash
git add frontend/src
git commit -m "fix: pointer cursor on clickable controls (palette, jump, settings radios)"
```

### Task 18: Extract right-rail panels from app.jsx (Q1)

**Files:**
- Create: `frontend/src/components/RightRail.jsx`
- Modify: `frontend/src/app.jsx`

**Problem:** `app.jsx` is 1212 lines (> 800 limit). Extract the four right-rail panels (`WalletPanel`, `PermissionPanel`, `ActivityPanel`, `SkillPanel`) + `EVENT_STYLES` + `PalettePicker`.

- [ ] **Step 1: Move the components**

Cut `WalletPanel`, `PermissionPanel`, `ActivityPanel`, `SkillPanel`, `EVENT_STYLES`, `PALETTES`, `PalettePicker` into `RightRail.jsx`. Export each. Keep imports they need (`Icon`, `shortAddr`, `fmtRemaining`).

- [ ] **Step 2: Import them back in app.jsx**

```jsx
import { WalletPanel, PermissionPanel, ActivityPanel, SkillPanel, PalettePicker } from './components/RightRail.jsx';
```

Remove the now-duplicated definitions from `app.jsx`.

- [ ] **Step 3: Verify line count + smoke**

Run: `wc -l frontend/src/app.jsx` — expected: < 800.
Run: dev server — right rail (Wallet/Permission/Activity/Skill) + palette picker render and behave identically.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app.jsx frontend/src/components/RightRail.jsx
git commit -m "refactor: extract right-rail panels into RightRail.jsx (app.jsx under 800 lines)"
```

### Task 19: Trim stray console.* on the happy path (Q3)

**Files:**
- Modify: frontend client files with `console.log`

- [ ] **Step 1: List them**

Run: `rg -n "console\\.(log|warn|error)" frontend/src --glob '!**/node_modules/**'`

- [ ] **Step 2: Remove informational `console.log`**

Drop pure-info logs (e.g. `[Venice] Market context injected`). Keep `console.warn/error` in catch blocks that aid debugging, or convert to the activity log where user-facing. Do not over-engineer — target noise on the demo path.

- [ ] **Step 3: Commit**

```bash
git add frontend/src
git commit -m "chore: trim informational console.log from client happy path"
```

---

## WS7 — Smart-contract polish + security checklist

### Task 20: Coverage baseline

- [ ] **Step 1: Measure**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer && forge coverage"`
Expected: a coverage table for `AgentVaultDepositor.sol` + `MockVault.sol`. Record the percentages.

- [ ] **Step 2: Identify gaps**

List uncovered lines/branches (especially scope-violation reverts in `AgentVaultDepositor`).

### Task 21: Add security/edge tests for AgentVaultDepositor

**Files:**
- Modify: `test/AgentVaultDepositor.t.sol`

- [ ] **Step 1: Read the contract surface**

Read `contracts/AgentVaultDepositor.sol` to confirm exact function signatures, custom errors, and modifiers before writing tests.

- [ ] **Step 2: Write failing tests for each security invariant**

Add tests (use the contract's real error selectors/messages):

```solidity
function test_RevertWhen_AmountExceedsMax() public { /* grant max=100, execute 101 → revert */ }
function test_RevertWhen_VaultNotAllowed() public { /* execute against a non-granted vault → revert */ }
function test_RevertWhen_PermissionExpired() public { /* warp past expiresAt → revert */ }
function test_RevertWhen_PermissionRevoked() public { /* revoke then execute → revert */ }
function testFuzz_UsedAmountNeverExceedsMax(uint256 a, uint256 b) public { /* sequential deposits cap at maxAmount */ }
```

Fill each body using the existing test file's setup helpers and the real API (`grantAgentPermission`, `executeAgentDeposit`, etc.).

- [ ] **Step 3: Run — expect RED where a check is missing, GREEN where already enforced**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer && forge test --match-contract AgentVaultDepositor -vvv"`

- [ ] **Step 4: If any invariant test fails, fix the contract (CEI/revert), not the test.** Re-run until green.

- [ ] **Step 5: Re-measure coverage**

Run: `forge coverage` (WSL). Expected: ≥ 80% for `AgentVaultDepositor.sol`.

- [ ] **Step 6: Commit**

```bash
git add test/AgentVaultDepositor.t.sol contracts/AgentVaultDepositor.sol
git commit -m "test: security/edge coverage for AgentVaultDepositor (scope, expiry, revoke, fuzz)"
```

### Task 22: NatSpec + event-coverage pass

**Files:**
- Modify: `contracts/AgentVaultDepositor.sol`, `contracts/MockVault.sol`

- [ ] **Step 1: Add/complete NatSpec** (`@notice`, `@param`, `@return`) on every external/public function missing it. `MockVault.sol` is already well-documented; focus on `AgentVaultDepositor.sol`.

- [ ] **Step 2: Confirm every state-changing path emits an event** matching the `DEPOSITOR_ABI` in `config.js`. Note any mismatch between emitted events and the frontend's expected event list.

- [ ] **Step 3: Build + test**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer && forge build && forge test"`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add contracts/
git commit -m "docs: complete NatSpec + verify event coverage on AgentVaultDepositor"
```

### Task 23: Record the security hardening checklist

**Files:**
- Create: `planning/security-checklist.md`

- [ ] **Step 1: Write the checklist** — for each item, mark current status (`enforced` / `n-a-testnet` / `pre-mainnet TODO`) with the file:line proof where enforced:

```markdown
# Security Hardening Checklist (recorded — demo stays testnet)

## Contract (AgentVaultDepositor)
- [ ] Reentrancy guard / CEI ordering on executeAgentDeposit — <status, proof>
- [ ] amount <= maxAmount revert — <status, proof>
- [ ] vault == allowedVault revert — <status, proof>
- [ ] block.timestamp < expiresAt revert — <status, proof>
- [ ] usedAmount accounting cannot underflow/overflow — <status, proof>
- [ ] No privileged admin backdoor post-deploy — <status, proof>

## Frontend / secrets
- [ ] No API keys in client bundle (server proxy used) — <status, proof: api/ai.js>
- [ ] Venice key stored localStorage only, never sent to our servers — <status>
- [ ] Input validation on amount / addresses at boundaries — <status>

## Pre-mainnet TODO (out of scope this cycle)
- [ ] Real ERC20 transfers (replace MockVault pure-accounting)
- [ ] External audit of AgentVaultDepositor
- [ ] Move to Base / Base Sepolia (1Shot relayer support)
- [ ] Rate limiting on AI proxy endpoint
```

- [ ] **Step 2: Commit**

```bash
git add planning/security-checklist.md
git commit -m "docs: record mainnet security hardening checklist"
```

---

## WS8 — Final verification

### Task 24: Full happy-path smoke + demo-path checklist

- [ ] **Step 1: Clean run, no dev flag**

Run: `cd frontend && npm run build && npm run preview` (production build — catches build-only errors). Open without `?dev=1`.

- [ ] **Step 2: Walk the demo path**

Home (no wallet → renders, no crash) → Connect → Start Strategy (high risk, 3 vaults) → review skills → grant permission (real countdown) → execute (3 distinct vaults) → Done → Agent dashboard (positions, alerts) → Withdraw one position → History shows the tx. Confirm every screen, no dead button, no fake value, errors visible if you reject a prompt.

- [ ] **Step 3: Record results** in `planning/demo-smoke-results.md` (pass/fail per screen).

- [ ] **Step 4: Commit**

```bash
git add planning/demo-smoke-results.md
git commit -m "chore: final demo-path smoke results"
```

---

## Self-review notes

- **Spec coverage:** C1→T1, D2→T2, D3→T3, dead sweep→T4, F2→T5-8, F1→T9, D1→T10, F3→T11, E1→T12, E2→T13, async→T14, dev gate→T15-16, Q4→T17, Q1→T18, Q3→T19, contracts/security→T20-23, success criteria→T24. All spec items mapped.
- **Order:** WS1 first (landing crash blocks everything). WS3 vault deploy before WS4 model/countdown so the 4-vault path is testable. WS7 last (independent of UI).
- **Verification reality:** UI tasks verify by manual browser smoke (no vitest harness exists); contract tasks use `forge test`/`coverage` in WSL. This is honest given the current repo.
- **Risk:** Task 6 (Sepolia deploy) needs a funded deployer key + working `SEPOLIA_RPC`. If deploy is blocked, WS3 frontend tasks can still proceed against placeholder addresses but must not ship with `0x...` — gate Task 7 on real addresses from Task 6.
