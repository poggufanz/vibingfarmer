# Credibility Fixes (Sub-project #1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app demo-honest — fix the 10× decimal drift (display + functional), purge the dead-EVM copy/code, and de-stale the frontend `rwa` naming — so sub-project #2 (real yield) isn't undermined by 10×-wrong balances and lying "how it works" copy.

**Architecture:** Three mechanical workstreams, no contract-logic change. (A) one display/convert helper replacing every `1e6` token-base-unit site with `1e7`. (B) delete inert MetaMask-Flask / ERC-7715 code paths, rewrite EVM user-facing copy to Stellar truth. (C) frontend/docs `rwa`→yield naming only — the Soroban crate rename is deferred to #2's redeploy.

**Tech Stack:** React 18 + Vite 5, Vitest. Chain client `frontend/src/stellar/`. Soroban untouched here.

## Global Constraints

- **Chain is 7-dp everywhere.** `SOROBAN_DECIMALS = 7` (`frontend/src/stellar/config.js`). `BASE_UNIT = 10 ** 7 = 1e7`. NEVER use `1e6` for a token base-unit (that is the dead EVM 6-dp scale).
- **Do NOT change real-USD math.** `defiLlama.js:68,134,135` and `backgroundAgent.worker.js:87` use `1_000_000` as USD TVL thresholds — leave them.
- **No EVM terms in user-facing copy:** none of `1Shot`, `EIP-7702`, `ERC-7715`, `EIP-7710`, `MetaMask Flask`, `Base Sepolia`, `basescan`, `AgentRegistry.sol`, `AgentVaultDepositor`.
- **Soroban crate rename is DEFERRED to #2** — do NOT rename the `rwa_vault` crate / `RwaVault` struct / `agent_account/vault_client.rs` here.
- **Do NOT touch** `docs/superpowers/**`, `planning/**`, `graphify-out/**` (gitignored / regenerated).
- **Tests stay green** — baseline `cd frontend && npx vitest run` = 308 passing. Update assertions that encode the old `1e6` scale; do not delete coverage.
- Commit after each task. No step numbers in commit messages.

---

### Task 1: Decimal format helper

**Files:**
- Create: `frontend/src/stellar/format.js`
- Test: `frontend/src/stellar/format.test.js`

**Interfaces:**
- Consumes: `SOROBAN_DECIMALS` from `./config.js`
- Produces: `toDisplay(units) -> number` (7-dp base units → human number), `toBaseUnits(amount) -> bigint` (human USDC → 7-dp base-unit bigint)

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/stellar/format.test.js
import { describe, it, expect } from 'vitest'
import { toDisplay, toBaseUnits } from './format.js'

describe('format (7-dp)', () => {
  it('renders 1e7 base units as 1', () => {
    expect(toDisplay('10000000')).toBe(1)
  })
  it('handles 0 / null / undefined safely', () => {
    expect(toDisplay(0)).toBe(0)
    expect(toDisplay(null)).toBe(0)
    expect(toDisplay(undefined)).toBe(0)
  })
  it('converts a human USDC amount to 7-dp base units', () => {
    expect(toBaseUnits(1).toString()).toBe('10000000')
    expect(toBaseUnits(100).toString()).toBe('1000000000')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/stellar/format.test.js`
Expected: FAIL — cannot resolve `./format.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// frontend/src/stellar/format.js
import { SOROBAN_DECIMALS } from './config.js'

export const BASE_UNIT = 10 ** SOROBAN_DECIMALS // 1e7 — 7-dp token base unit

// 7-dp base units (string | number | bigint) -> human number for display
export function toDisplay(units) {
  return Number(units || 0) / BASE_UNIT
}

// human USDC amount -> 7-dp base-unit bigint (for on-chain writes / caps)
export function toBaseUnits(amount) {
  return BigInt(Math.round(Number(amount || 0) * BASE_UNIT))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/stellar/format.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/stellar/format.js frontend/src/stellar/format.test.js
git commit -m "feat: add 7-dp decimal format helper"
```

---

### Task 2: Apply helper to all display sites (GAP-1 render)

**Files (modify — exact `1e6` → helper):**
- `frontend/src/components/AgentDashboard.jsx:9,114,124`
- `frontend/src/components/WithdrawModal.jsx:53,54`
- `frontend/src/components/HomePage.jsx:16`
- `frontend/src/components/NotificationCenter.jsx:46`
- `frontend/src/components/VaultDetailPage.jsx:65`
- `frontend/src/components/ReplayPage.jsx:20`
- `frontend/src/strategy/mdp.js:91`
- `frontend/src/app.jsx:1937,1938`
- Test: update any existing test that asserts the old `1e6` scale (find in Step 1)

**Interfaces:**
- Consumes: `toDisplay` from `../stellar/format.js` (depth-adjust the relative path per file: components → `../stellar/format.js`, `app.jsx`/`mdp.js` → `./stellar/format.js` / `../stellar/format.js`)

- [ ] **Step 1: Find tests encoding the old scale**

Run: `cd frontend && npx grep -rn "1e6\|/ 1000000" src/**/*.test.* 2>/dev/null || rg -n "1e6|/ ?1000000" src --glob '*.test.*'`
Expected: a (possibly empty) list. Any hit asserting a balance render must be updated to the 7-dp value in Step 4.

- [ ] **Step 2: Replace each render site**

Apply these exact edits (add the `toDisplay` import at the top of each file):

```jsx
// AgentDashboard.jsx
import { toDisplay } from '../stellar/format.js'
// :9   const u = (units) => Number(units || 0) / 1e6
const u = toDisplay
// :114 {(totalUnits / 1e6).toFixed(2)}      -> {toDisplay(totalUnits).toFixed(2)}
// :124 +{(earnedUnits / 1e6).toFixed(4)}    -> +{toDisplay(earnedUnits).toFixed(4)}
```
```jsx
// WithdrawModal.jsx  (import { toDisplay } from '../stellar/format.js')
// :53 const balUsdc = Number(balance || 0) / 1e6           -> const balUsdc = toDisplay(balance)
// :54 const rewardsUsdc = Number(unclaimedRewards||0)/1e6  -> const rewardsUsdc = toDisplay(unclaimedRewards)
```
```jsx
// HomePage.jsx
import { toDisplay } from '../stellar/format.js'
// :16 const u = (x) => Number(x || 0) / 1e6   ->   const u = toDisplay
```
```jsx
// NotificationCenter.jsx  (import { toDisplay } from '../stellar/format.js')
// :46 amountUsdc: (amtUnits / 1e6).toFixed(2)  ->  amountUsdc: toDisplay(amtUnits).toFixed(2)
```
```jsx
// VaultDetailPage.jsx  (import { toDisplay } from '../stellar/format.js')
// :65 ... Number(posEntry[1].balance || 0) / 1e6 : null  ->  ... toDisplay(posEntry[1].balance) : null
```
```jsx
// ReplayPage.jsx  (import { toDisplay } from '../stellar/format.js')
// :20 const fmtUsdc = (raw) => `${(Number(raw) / 1e6).toLocaleString()} USDC`
//  -> const fmtUsdc = (raw) => `${toDisplay(raw).toLocaleString()} USDC`
```
```js
// mdp.js  (import { toDisplay } from '../stellar/format.js')
// :91 heldUsdc: heldUnits / 1e6   ->   heldUsdc: toDisplay(heldUnits)
```
```jsx
// app.jsx  (import { toDisplay } from './stellar/format.js')
// :1937 cap {(Number(s.capPerPeriod) / 1e6).toFixed(2)}  -> cap {toDisplay(s.capPerPeriod).toFixed(2)}
// :1938 {(Number(s.maxAtRisk) / 1e6).toFixed(2)} USDC     -> {toDisplay(s.maxAtRisk).toFixed(2)} USDC
```

- [ ] **Step 3: Update any old-scale test assertions** found in Step 1 to the 7-dp expected value (e.g. a `10000000`-unit balance now renders `1.00`, not `10.00`).

- [ ] **Step 4: Run the full suite**

Run: `cd frontend && npx vitest run`
Expected: PASS (308, minus any intentionally-updated assertions = still all green).

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "fix: render token balances at 7-dp via format helper"
```

---

### Task 3: Functional decimal fixes (seed writer + skill cap)

**Files:**
- Modify: `frontend/src/app.jsx:1465,1472`
- Modify: `frontend/src/venice.js:377,408`
- Modify: `frontend/src/components/WithdrawModal.jsx:79`
- Test: `frontend/src/venice.test.js` (add a case; create if absent)

**Interfaces:**
- Consumes: `toBaseUnits` from `./stellar/format.js` (`../stellar/format.js` from `components/`)

These are **functional** (data written / amount parsed / cap enforced), not display: a `*1e6` cap or withdraw amount is 10× too small on a 7-dp chain.

- [ ] **Step 1: Write the failing test** (generated skill `maxAmount` must be 7-dp)

```js
// frontend/src/venice.test.js  (add; mirror existing skill-gen test setup if present)
import { describe, it, expect } from 'vitest'
import { buildFallbackForParams } from './venice.js' // adjust to the actual skill-building export

describe('skill cap is 7-dp', () => {
  it('encodes maxAmount in 7-dp base units', () => {
    const skill = buildFallbackForParams({ amount: 100, vaults: 1 }) // adjust to real signature
    const maxAmount = skill.skills?.deposit?.maxAmount ?? skill.deposit?.maxAmount
    expect(String(maxAmount)).toBe('1000000000') // 100 * 1e7, not 100 * 1e6
  })
})
```
> If the exact export/shape differs, adjust the import + accessor to the real skill builder in `venice.js`; the assertion (`100 → 1000000000`) is the invariant.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/venice.test.js`
Expected: FAIL — current value is `100000000` (`100 * 1e6`).

- [ ] **Step 3: Apply the fixes**

```js
// venice.js  (import { toBaseUnits } from './stellar/format.js')
// :377 deposit: { maxAmount: String(Math.floor(amount * 1e6)), vaultAddress: vault, expiresAt }
//   -> deposit: { maxAmount: toBaseUnits(amount).toString(), vaultAddress: vault, expiresAt }
// :408 "maxAmount": "${Math.floor(amount * 1e6)}", ...
//   -> "maxAmount": "${toBaseUnits(amount)}", ...
```
```jsx
// app.jsx  (import { toBaseUnits } from './stellar/format.js')
// :1465 comment: "// units (allocation USDC * 1e6); the display layer divides by 1e6."
//   -> "// 7-dp base units (allocation USDC * 1e7); display divides by 1e7 (toDisplay)."
// :1472 const newBal = BigInt(Math.round(a.allocation * 1e6))
//   -> const newBal = toBaseUnits(a.allocation)
```
```jsx
// WithdrawModal.jsx  (import { toBaseUnits } from '../stellar/format.js')
// :79 const units = BigInt(Math.floor(parsed * 1e6)).toString()
//   -> const units = toBaseUnits(parsed).toString()
```

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/venice.test.js && npx vitest run`
Expected: PASS (target test green; full suite still green).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app.jsx frontend/src/venice.js frontend/src/venice.test.js
git commit -m "fix: encode seed balance and skill cap at 7-dp"
```

---

### Task 4: Delete dead MetaMask-Flask / ERC-7715 code

**Files:**
- Delete: `frontend/src/components/FlaskGate.jsx`
- Delete: `frontend/src/flaskDetect.js`
- Modify: `frontend/src/app.jsx` — remove the `flaskDetect`/`FlaskGate` import and the Flask-version-detect + ERC-7715 permission-prompt flow (per CURRENT-STATE §7: app.jsx ~L10 import, ~L337/L343/L345 Flask detect+gate, ~L811 "fresh ERC-7715 permission", ~L1137 stale comment). Confirm exact lines by grep in Step 1 (they shift as edits land).

**Interfaces:**
- Produces: nothing imports `FlaskGate` or `flaskDetect` after this task.

- [ ] **Step 1: Map live usages before deleting**

Run: `cd frontend && rg -n "flaskDetect|FlaskGate|requestExecutionPermissions|erc7715|ERC-7715" src`
Expected: a list. Every hit in live code (not a comment to be removed) must be excised in Step 2.

- [ ] **Step 2: Delete the dead files and remove their usages**

```bash
cd frontend
rm src/components/FlaskGate.jsx src/flaskDetect.js
```
Then in `app.jsx`: remove the `FlaskGate`/`flaskDetect` import line, delete the Flask-detect branch and the `<FlaskGate.../>` render, and delete the ERC-7715 permission-prompt path (Stellar uses `authorizeAndFundAgent`, no browser permission prompt). Replace any user-visible gate text with the standard wallet flow (Freighter/xBull/Albedo connect) already present.

- [ ] **Step 3: Verify nothing references the deleted modules**

Run: `cd frontend && rg -n "flaskDetect|FlaskGate" src; echo "exit: $?"`
Expected: no matches (`rg` exit 1 = clean).

- [ ] **Step 4: Build + test**

Run: `cd frontend && npx vitest run && npm run build`
Expected: PASS + build succeeds (no unresolved import).

- [ ] **Step 5: Commit**

```bash
git add -A frontend/src
git commit -m "refactor: remove dead MetaMask Flask and ERC-7715 code"
```

---

### Task 5: Purge EVM copy → Stellar truth + frontend `rwa` naming

**Files (modify — user-facing strings):**
- `README.md` — rewrite "How it works" / "Architecture" sections (CURRENT-STATE §6 GAP-3 lists hits `:21,:23,:25,:27,:31,:60,:73-80,:96,:112-114`). Remove dead Base Sepolia addresses + Solidity signatures.
- `frontend/src/components/EcosystemPage.jsx` — full rewrite to the Stellar stack (17 EVM hits).
- `frontend/src/screens.jsx` (25), `SettingsPage.jsx` (8), `TxDetailPage.jsx` (6), `RightRail.jsx` (6), `LandingHero.jsx` (5), `OnboardingFlow.jsx` (4), `history.js` (4), `AgentActionPreview.jsx` (3), `WithdrawModal.jsx` (3), `skills.jsx` (2), `SkillDetailModal.jsx` (2), `components.jsx` (2), `agents.jsx` (1), `HomePage.jsx` (1), `ExplorerPage.jsx` (1), `HistoryPanel.jsx` (1), `strategy/gasSnapshot.js` (1 comment), `skills/default/vault-advisor.md` (1).
- Frontend `rwa` naming: replace user-facing `rwa`/`RwaVault` references in frontend with "yield vault" wording (NOT the Soroban crate — deferred to #2).

**Replacement mapping (apply per file after reading it):**

| EVM term (dead) | Stellar replacement |
|---|---|
| `relayed via 1Shot` / `1Shot relayer` / `gas paid by 1Shot relayer` | `fee-bump relayer` / `gas 0 · fee-bump relayer` |
| `EIP-7702` / `Flask upgrade` / `MetaMask Flask` | standard wallet (Freighter/xBull/Albedo); drop the term |
| `ERC-7715 scoped permission` | `Soroban session-key scope` |
| `EIP-7710` / `1Shot Permissionless` | `ed25519 agent auth` |
| `Base Sepolia` / `network sepolia` / `84532` | `Stellar testnet` |
| `Basescan` / `View on Base Sepolia Basescan` | `Stellar Expert` (`https://stellar.expert/explorer/testnet`) |
| `AgentRegistry.sol` / `AgentVaultDepositor` | `registry` / `vault` (Soroban) |
| `24 active vaults on Base Sepolia` | the real single-vault Stellar testnet copy |

- [ ] **Step 1: Read and rewrite each listed file**, applying the mapping. For `EcosystemPage.jsx`, rewrite the page to describe the actual flow: AI strategist → user one-approve → registry `authorize` + `transfer` → worker ed25519 auth-entry → fee-bump relayer → Soroban vault. Remove the ASCII EVM diagram.

- [ ] **Step 2: Rewrite README "How it works" / "Architecture"** to the Stellar truth (single-chain Soroban, fee-bump relayer, ed25519 session keys, Blend real-yield as the in-progress direction). Delete the dead Base Sepolia address block and Solidity signatures.

- [ ] **Step 3: Grep-guard — no user-facing EVM terms remain**

Run:
```bash
cd frontend && rg -ni "1shot|eip-?7702|erc-?7715|eip-?7710|metamask flask|base sepolia|basescan" src; echo "frontend exit: $?"
cd .. && rg -ni "1shot|eip-?7702|erc-?7715|base sepolia|AgentVaultDepositor|AgentRegistry\.sol" README.md; echo "readme exit: $?"
```
Expected: no matches (exit 1) in both. (Any remaining hit must be a deliberate, clearly-labelled "migration history" note, otherwise fix it.)

- [ ] **Step 4: Build + test**

Run: `cd frontend && npx vitest run && npm run build`
Expected: PASS + build succeeds.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: replace dead EVM copy with Stellar truth across UI and README"
```

---

### Task 6: Final verification + graph refresh

**Files:** none (verification only).

- [ ] **Step 1: Decimal guard** — no stray token-base-unit `1e6` left

Run: `cd frontend && rg -n "1e6" src | rg -v "1_000_000|defiLlama|backgroundAgent|positionsStore"`
Expected: no matches (the only `1e6`/`1_000_000` left are the USD-TVL sites + the already-correct comment).

- [ ] **Step 2: Full suite + build**

Run: `cd frontend && npx vitest run && npm run build`
Expected: all green + build OK.

- [ ] **Step 3: Refresh the knowledge graph** (per CLAUDE.md)

Run: `graphify update .`
Expected: graph regenerated (AST-only, no API cost).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: regenerate knowledge graph after credibility fixes"
```

---

## Notes for the implementer

- Relative import depth for `format.js` differs by folder: files in `src/components/` use `../stellar/format.js`; `src/app.jsx` uses `./stellar/format.js`; `src/strategy/mdp.js` uses `../stellar/format.js`.
- If a test in Task 2/3 fails because it *correctly* now expects the 7-dp value, that is the fix working — update the expected value, don't revert the source.
- The Soroban `rwa_vault` crate rename is intentionally NOT here. It rides into sub-project #2's vault redeploy.
