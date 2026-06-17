# Roadmap v2 — Phase 5: Refactor & UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Split pure decision logic from chain execution, force every fund path through the depositor, re-wire the frontend to the new `executeAgentDeposit` signature, and render permission summary + max-at-risk from the *same* object serialized on-chain (single source of truth).

**Architecture:** Decision functions become pure and unit-testable without a chain. The skill-JSON generator may only target `AgentVaultDepositor`. The frontend's relay/encode layer is updated to the Phase 1 signature, and a single `permissionSummary` module derives both the human-readable summary and the on-chain `authorizeSessionKey` args from one object — UI numbers that differ from on-chain numbers are a security-class bug.

**Tech Stack:** JS/ESM, Vitest, viem, the existing strategy/ modules. The Nuxt/Vue migration is sequenced LAST and gated by a smoke test.

**Depends on:** Phase 1 (new signature + `AgentRegistry`). Do this AFTER Phase 1 lands or the frontend stays broken.

---

## File Structure

- Create: `frontend/src/strategy/permissionScope.js` — single source: one scope object → both `authorizeSessionKey` args and the human summary.
- Modify: `frontend/src/relay.js` — `encodeExecuteAgentDeposit` to `(amount, minAmount, execId)`; route through depositor only.
- Modify: `frontend/src/worker.js`, `frontend/src/orchestrator.js` — derive `execId` deterministically; no worker→vault direct calls.
- Modify: `frontend/src/skills.js` — generator targets depositor only; assert no worker recipient.
- Create: `frontend/src/skills.test.js` — does NOT exist yet ([VERIFY]ed via `ls frontend/src/`).
- Modify: `frontend/src/app.jsx` — Revoke button + Max-at-Risk per agent + subscribe `AgentRevoked`. (`app.jsx` confirmed to exist — edit it, do not create a new file.)
- Create: `frontend/src/strategy/decision.js` — extract pure decision functions (split from execution). (`strategy/` is the real dir; `monitorLoop.js` lives there.)
- Tests: `*.test.js` alongside each.
- Tooling note: steps use `rtk npm` / `rtk npx` — **[VERIFY] `rtk` is on the agent PATH** (open item carried from Phase 2). If not, drop the `rtk` prefix.

---

## Task 1: Extract pure decision logic from execution

**Files:**
- Create: `frontend/src/strategy/decision.js`
- Create: `frontend/src/strategy/decision.test.js`

- [ ] **Step 1: Write the failing test for the pure decision function**

```js
// frontend/src/strategy/decision.test.js
import { describe, it, expect } from 'vitest';
import { decideAction } from './decision.js';

describe('decideAction', () => {
  it('keeps when apy stays above floor and turbulence is low', () => {
    const d = decideAction({ apyNow: 0.08, apyFloor: 0.05, turbulence: 0.1, turbulenceMax: 0.5 });
    expect(d.action).toBe('keep');
  });
  it('exits when apy drops below floor', () => {
    const d = decideAction({ apyNow: 0.03, apyFloor: 0.05, turbulence: 0.1, turbulenceMax: 0.5 });
    expect(d.action).toBe('exit');
    expect(d.reason).toBe('apy_below_floor');
  });
  it('exits when turbulence exceeds max even if apy is fine', () => {
    const d = decideAction({ apyNow: 0.08, apyFloor: 0.05, turbulence: 0.9, turbulenceMax: 0.5 });
    expect(d.action).toBe('exit');
    expect(d.reason).toBe('turbulence');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `rtk npm --prefix frontend run test -- decision`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure decision function**

```js
// frontend/src/strategy/decision.js
// Pure decision layer — no chain, no I/O, fully unit-testable. Execution lives in
// worker.js/relay.js and consumes these decisions.
export function decideAction({ apyNow, apyFloor, turbulence, turbulenceMax }) {
  if (turbulence > turbulenceMax) return { action: 'exit', reason: 'turbulence' };
  if (apyNow < apyFloor) return { action: 'exit', reason: 'apy_below_floor' };
  return { action: 'keep', reason: 'within_bounds' };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `rtk npm --prefix frontend run test -- decision`
Expected: PASS.

- [ ] **Step 5: Point the monitor loop at the pure function**

In `frontend/src/app.jsx` (monitor `execute`, around the keep/exit branch found via `grep -n "keep\|exit\|rebalance" frontend/src/app.jsx`), replace the inline condition with `decideAction(...)` and branch on `.action`. Keep behavior identical — this is an extraction, not a logic change.

> **Prove the parity, don't assert it.** Before swapping, capture the OLD inline branch order in one
> snapshot test (esp. whether it checked apy-below-floor or turbulence first). If the legacy order differs
> from `decideAction` (turbulence-before-apy), the emitted `reason` changes silently for cases where both
> trip. Add a test feeding an input where both conditions fire and pin the expected `reason` to the legacy
> value, so "extraction, not logic change" is verified, not just claimed.

- [ ] **Step 6: Run the app/monitor tests**

Run: `rtk npm --prefix frontend run test -- monitorLoop`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/strategy/decision.js frontend/src/strategy/decision.test.js frontend/src/app.jsx
git commit -m "refactor: extract pure decision layer from execution"
```

---

## Task 2: Re-wire relay to the Phase 1 signature + single fund path

**Files:**
- Modify: `frontend/src/relay.js`
- Modify: `frontend/src/relay.test.js`
- Modify: `frontend/src/worker.js`, `frontend/src/orchestrator.js`

- [ ] **Step 1: Update the encode test to the new signature**

In `frontend/src/relay.test.js`, replace the `encodeExecuteAgentDeposit` expectation:

```js
import { encodeExecuteAgentDeposit, computeExecId } from './relay.js';

it('encodes executeAgentDeposit(amount,minAmount,execId,sig)', () => {
  // Use all-lowercase 20-byte addresses: viem encodeAbiParameters validates EIP-55
  // checksum on mixed-case input and throws InvalidAddressError. Lowercase = no checksum
  // check, so the fixture exercises encoding, not address validation.
  const owner = '0x' + 'a1'.repeat(20);
  const vault = '0x' + 'b2'.repeat(20);
  const execId = computeExecId({ owner, vault, planId: 1, step: 0 });
  const sig = '0x' + '11'.repeat(65); // 65-byte placeholder signature
  const data = encodeExecuteAgentDeposit({ amount: 50_000000n, minAmount: 49_000000n, execId, sig });
  expect(data.startsWith('0x')).toBe(true);
  expect(execId).toMatch(/^0x[0-9a-f]{64}$/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `rtk npm --prefix frontend run test -- relay`
Expected: FAIL — old signature / no `computeExecId`.

- [ ] **Step 3: Update encode + add deterministic execId**

In `frontend/src/relay.js`, replace `encodeExecuteAgentDeposit` and add `computeExecId` (use the project's existing viem import style):

```js
import { encodeFunctionData, keccak256, encodeAbiParameters, parseAbiParameters } from 'viem';

const DEPOSITOR_ABI = [{
  type: 'function', name: 'executeAgentDeposit', stateMutability: 'nonpayable',
  inputs: [
    { name: 'amount', type: 'uint256' },
    { name: 'minAmount', type: 'uint256' },
    { name: 'execId', type: 'bytes32' },
    { name: 'sig', type: 'bytes' },
  ],
  outputs: [{ name: 'shares', type: 'uint256' }],
}];

/**
 * Deterministic execId per (owner, vault, planId, step).
 * NOTE: the contract does NOT recompute this — it only stores `executed[execId]` as given.
 * So this is an OFF-CHAIN contract among agent components (worker/orchestrator/retry) to
 * produce a stable id; the on-chain guard just dedupes whatever id it receives. Do not try
 * to "verify" this formula in Solidity — there is nothing on-chain to match it against.
 * Encoding parity with `abi.encode(address,address,uint256,uint256)` is what matters: viem's
 * encodeAbiParameters yields the identical 32-byte-padded layout, so retries hash the same.
 */
export function computeExecId({ owner, vault, planId, step }) {
  return keccak256(encodeAbiParameters(
    parseAbiParameters('address, address, uint256, uint256'),
    [owner, vault, BigInt(planId), BigInt(step)],
  ));
}

/** EIP-712 type + domain MUST match AgentVaultDepositor (name "VibingFarmer", version "1"). */
export const DEPOSIT_DOMAIN = (chainId, verifyingContract) => ({
  name: 'VibingFarmer', version: '1', chainId, verifyingContract,
});
export const DEPOSIT_TYPES = {
  AgentDeposit: [
    { name: 'amount', type: 'uint256' },
    { name: 'minAmount', type: 'uint256' },
    { name: 'execId', type: 'bytes32' },
  ],
};

/** Worker key signs the deposit. Returns the 0x signature for the 4th arg. */
export async function signDeposit(workerWalletClient, { chainId, depositor, amount, minAmount, execId }) {
  return workerWalletClient.signTypedData({
    domain: DEPOSIT_DOMAIN(chainId, depositor),
    types: DEPOSIT_TYPES,
    primaryType: 'AgentDeposit',
    message: { amount: BigInt(amount), minAmount: BigInt(minAmount), execId },
  });
}

export function encodeExecuteAgentDeposit({ amount, minAmount, execId, sig }) {
  return encodeFunctionData({
    abi: DEPOSITOR_ABI, functionName: 'executeAgentDeposit',
    args: [BigInt(amount), BigInt(minAmount), execId, sig],
  });
}
```

- [ ] **Step 4: Update worker/orchestrator call sites to pass amount/minAmount/execId**

In `frontend/src/worker.js` and `frontend/src/orchestrator.js`, at each `encodeExecuteAgentDeposit(...)` / `executeAgentDepositOnChain(...)` call (find via `grep -rn "executeAgentDeposit" frontend/src`): build `execId = computeExecId({ owner, vault, planId, step })`, then `sig = await signDeposit(workerWalletClient, { chainId, depositor, amount, minAmount, execId })` with the **worker key's** wallet client (not the user's), then pass `{ amount, minAmount, execId, sig }`. The 1Shot relayer submits the encoded calldata. `minAmount` comes from the user-reviewed skill JSON slippage (Task 4), never recomputed silently.

- [ ] **Step 5: Run the relay/worker suites**

Run: `rtk npm --prefix frontend run test -- relay worker orchestrator`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/relay.js frontend/src/relay.test.js frontend/src/worker.js frontend/src/orchestrator.js
git commit -m "refactor(frontend): wire relay to new executeAgentDeposit signature + deterministic execId"
```

---

## Task 3: Single fund path — generator targets depositor only

**Files:**
- Modify: `frontend/src/skills.js`
- Modify: `frontend/src/skills.test.js`

- [ ] **Step 1: Write the failing test asserting the only target is the depositor**

```js
// frontend/src/skills.test.js (Create — does not exist yet)
// NOTE: skills.js throws at module load if VITE_DEPOSITOR_ADDRESS is unset/invalid.
// Set a valid test address before import, e.g. in vitest setup or via vi.stubEnv:
//   import { vi } from 'vitest';
//   vi.stubEnv('VITE_DEPOSITOR_ADDRESS', '0x' + 'de'.repeat(20));
import { buildSkill, DEPOSITOR_TARGET } from './skills.js';

it('generated skill only targets the depositor', () => {
  const skill = buildSkill({ vault: '0x' + 'a1'.repeat(20), token: '0x' + 'b2'.repeat(20), amount: '100000000' });
  const targets = skill.steps.map((s) => s.target.toLowerCase());
  expect(new Set(targets)).toEqual(new Set([DEPOSITOR_TARGET.toLowerCase()]));
});

it('throws if a caller tries to pass a worker target', () => {
  expect(() => buildSkill({ vault: '0x' + 'a1'.repeat(20), token: '0x' + 'b2'.repeat(20), amount: '1', worker: '0x' + 'cc'.repeat(20) })).toThrow();
});
```

> Also add a module-load negative test (separate file or `vi.resetModules` + unset env) asserting
> `import('./skills.js')` rejects when `VITE_DEPOSITOR_ADDRESS` is missing — proves the placeholder can't leak to runtime.

- [ ] **Step 2: Run to verify it fails**

Run: `rtk npm --prefix frontend run test -- skills`
Expected: FAIL — `DEPOSITOR_TARGET`/single-target guarantee not present.

- [ ] **Step 3: Constrain the generator**

In `frontend/src/skills.js`, export a single configured `DEPOSITOR_TARGET` (read from `deployments/base-sepolia.json` or env) and make every generated step's `target` equal it. Add an assertion in `buildSkill` that throws if any step would target a non-depositor address.

```js
// frontend/src/skills.js (excerpt)
// NO placeholder fallback. A non-address string would pass the self-consistent target test
// in Step 1 (Set===Set) yet be garbage at runtime — exactly the silent-pass §0 rule 1 forbids.
// Resolve loudly at module load instead.
// [VERIFY] this frontend builds with Vite (import.meta.env present). If there is NO bundler,
// import.meta.env is undefined → drop env and read DEPOSITOR_TARGET from deployments/base-sepolia.json
// via fetch at init. Either way the address MUST be validated, never defaulted.
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
export const DEPOSITOR_TARGET = import.meta.env?.VITE_DEPOSITOR_ADDRESS;
if (!DEPOSITOR_TARGET || !ADDR_RE.test(DEPOSITOR_TARGET)) {
  throw new Error('VITE_DEPOSITOR_ADDRESS missing or not a 20-byte address — set it from deployments/base-sepolia.json');
}

export function buildSkill({ vault, token, amount, worker }) {
  // A caller must never be able to slip the worker EOA in as a fund target.
  if (worker !== undefined) {
    throw new Error('buildSkill does not accept a worker target — funds route through the depositor only');
  }
  const steps = [{ kind: 'deposit', target: DEPOSITOR_TARGET, vault, token, amount }];
  for (const s of steps) {
    if (s.target.toLowerCase() !== DEPOSITOR_TARGET.toLowerCase()) {
      throw new Error(`illegal skill target ${s.target} — only the depositor is allowed`);
    }
  }
  return { steps, generatedBy: 'venice-ai', approvedByUser: false };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `rtk npm --prefix frontend run test -- skills`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/skills.js frontend/src/skills.test.js
git commit -m "refactor(frontend): skill generator may only target the depositor"
```

---

## Task 4: Single-source permission summary + max-at-risk

**Files:**
- Create: `frontend/src/strategy/permissionScope.js`
- Create: `frontend/src/strategy/permissionScope.test.js`

- [ ] **Step 1: Write the failing test — same object → on-chain args AND human summary**

```js
// frontend/src/strategy/permissionScope.test.js
import { describe, it, expect } from 'vitest';
import { toAuthorizeArgs, toSummary, maxAtRisk } from './permissionScope.js';

const scope = {
  agent: '0xBEEF', vault: '0xVault', token: '0xToken',
  capPerPeriod: 100_000000n, periodDuration: 86400, expiry: 1_900_000_000,
  nowSec: 1_899_827_200, // ~2 days before expiry
};

describe('permissionScope single source', () => {
  it('serializes the SAME numbers the UI shows', () => {
    const args = toAuthorizeArgs(scope);
    const summary = toSummary(scope);
    expect(args[3]).toBe(scope.capPerPeriod);          // capPerPeriod arg
    expect(summary.capPerPeriod).toBe(scope.capPerPeriod);
    expect(args[2]).toBe(scope.token);                 // token arg
  });

  it('max-at-risk = cap × ceil((expiry-now)/period) — boundary (exact 2 periods)', () => {
    // (1_900_000_000 - 1_899_827_200) = 172800s = exactly 2 days → ceil(2) = 2 periods
    expect(maxAtRisk(scope)).toBe(200_000000n);
  });

  it('max-at-risk rounds UP a partial period (proves ceil, not floor)', () => {
    // 172801s = 2 days + 1s → ceil(2.0000…) = 3 periods. floor would give 2 and pass the
    // boundary test above — this case is the one that actually distinguishes ceil from floor.
    const partial = { ...scope, expiry: scope.nowSec + 172_801 };
    expect(maxAtRisk(partial)).toBe(300_000000n);
  });

  it('throws if capPerPeriod is not a bigint (single-source means single-TYPE)', () => {
    expect(() => maxAtRisk({ ...scope, capPerPeriod: 100_000000 })).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `rtk npm --prefix frontend run test -- permissionScope`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement permissionScope.js**

```js
// frontend/src/strategy/permissionScope.js
// SINGLE SOURCE OF TRUTH for a grant. Both the on-chain authorizeSessionKey args
// and the human-readable summary derive from ONE object. UI value != on-chain value
// is a security-class bug — they cannot diverge because they share this module.

// Single-source is only meaningful if the TYPE is single too. Enforce BigInt for the value
// that hits both the UI and the chain, so the UI cannot show a Number while the tx sends a
// BigInt (toBe identity comparisons in tests would silently mislead otherwise).
function assertScope(scope) {
  if (typeof scope.capPerPeriod !== 'bigint') {
    throw new TypeError('scope.capPerPeriod must be a bigint (single source = single type)');
  }
  if (scope.approvedByUser === false) {
    throw new Error('refusing to derive grant args from an unapproved scope');
  }
}

/** Returns the exact positional args for AgentRegistry.authorizeSessionKey. */
export function toAuthorizeArgs(scope) {
  assertScope(scope);
  return [
    scope.agent, scope.vault, scope.token,
    scope.capPerPeriod,                  // already bigint (asserted) — no re-wrap, preserves identity
    Number(scope.periodDuration),
    Number(scope.expiry),                // uint40 — Number is correct (safe past year 2106); do NOT
                                         // "fix" to BigInt: it would encode fine but diverge from periodDuration's type
  ];
}

export function maxAtRisk(scope) {
  assertScope(scope);
  const periods = Math.ceil((Number(scope.expiry) - Number(scope.nowSec)) / Number(scope.periodDuration));
  return scope.capPerPeriod * BigInt(Math.max(periods, 1));
}

export function toSummary(scope) {
  assertScope(scope);
  return {
    agent: scope.agent,
    vault: scope.vault,
    token: scope.token,
    capPerPeriod: scope.capPerPeriod,    // bigint — same value, same type as the on-chain arg
    periodDuration: Number(scope.periodDuration),
    expiry: Number(scope.expiry),
    maxAtRisk: maxAtRisk(scope),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `rtk npm --prefix frontend run test -- permissionScope`
Expected: PASS.

- [ ] **Step 5: Render the summary + max-at-risk from this module in the review UI**

In the strategy-review screen (find via `grep -rn "permission\|review" frontend/src/app.jsx`), render `toSummary(scope)` for each agent and call `toAuthorizeArgs(scope)` for the actual grant tx — both from the same `scope` object. Never format the on-chain args separately.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/strategy/permissionScope.js frontend/src/strategy/permissionScope.test.js frontend/src/app.jsx
git commit -m "feat(ux): single-source permission summary + max-at-risk"
```

---

## Task 5: Revoke UI + AgentRevoked subscription

**Files:**
- Modify: `frontend/src/app.jsx`
- Modify: `frontend/src/wallet.js`

- [ ] **Step 1: Add a direct (wallet-signed) revoke that bypasses the relayer**

In `frontend/src/wallet.js`, add `revokeAgentDirect(agent)` and `revokeManyDirect(agents)` that build a user-signed tx to `AgentRegistry.revokeAgent` / `revokeMany` (so revoke works even if the server/relayer is down). Encode with:

```js
const REGISTRY_REVOKE_ABI = [
  { type: 'function', name: 'revokeAgent', stateMutability: 'nonpayable', inputs: [{ name: 'agent', type: 'address' }], outputs: [] },
  { type: 'function', name: 'revokeMany', stateMutability: 'nonpayable', inputs: [{ name: 'agents', type: 'address[]' }], outputs: [] },
];
```

- [ ] **Step 2: Add the Revoke button + live AgentRevoked badge in the dashboard**

In `frontend/src/app.jsx`, for each agent node add a "Revoke" button calling `revokeAgentDirect(agent)`, and subscribe to the `AgentRevoked(owner, agent)` event to flip the node's status to "revoked" in real time. Show `maxAtRisk` (from Task 4) next to each agent.

> **Gas escape-hatch (security-relevant).** `revokeAgentDirect` is a USER-signed tx — it needs native
> ETH for gas. But the whole UX is gasless via the relayer, so a user's wallet may be empty exactly when
> they panic-revoke (server down). Mitigation in this step: read the user's native balance and, if ~0,
> show a warning + Base Sepolia faucet link, disabling nothing (let them try). Document in
> `docs/technical-threat-model.md` §3 that "user can revoke any time" carries a *native-gas asterisk*, and
> record the chosen production answer: either (a) require users to hold a little native gas as the escape
> hatch, or (b) generate a pre-signed revoke tx at onboarding, stored user-side, broadcastable by anyone
> (safe — revoke is purely protective). Pick one and write it down; the headline claim depends on it.

- [ ] **Step 3: Smoke-test the revoke path manually**

Run: `rtk npx serve frontend/`, grant an agent, click Revoke, confirm: wallet pops one tx, the node flips to "revoked", and a subsequent deposit attempt is rejected (`ScopeInactive`). Capture a screenshot for the demo.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app.jsx frontend/src/wallet.js
git commit -m "feat(ux): user-signed revoke button + live AgentRevoked status"
```

---

## Task 6: Nuxt/viem migration — LAST, gated by a smoke test

**Files:**
- Create: `frontend-next/` (or the chosen Nuxt scaffold) — only if the smoke test passes.

- [ ] **Step 1: Smoke-test the toolkit on Base Sepolia BEFORE migrating**

Write a one-off script:

```js
import { baseSepolia } from 'viem/chains';
import { getSmartAccountsEnvironment } from '@metamask/smart-accounts-kit';
try {
  const env = getSmartAccountsEnvironment(baseSepolia.id);
  console.log('OK', env);
} catch (e) {
  console.error('NOT DEPLOYED on baseSepolia for this toolkit version:', e.message);
}
```

Run: `rtk npx tsx scripts/smoke-sak.ts`
Expected: prints `OK` with environment addresses. **If it throws**, the framework isn't on this chain for the toolkit version → either `overrideDeployedEnvironment` with addresses from `@metamask/delegation-deployments`, or `deployDeleGatorEnvironment` **[VERIFY]** — STOP and resolve this before any migration work.

- [ ] **Step 2: Only if the smoke test passes — scaffold Nuxt + viem/wagmi, port screen-by-screen**

Migrate incrementally; keep the current `frontend/` working until parity. Each ported screen gets a Vitest + a manual smoke check. Do not big-bang.

- [ ] **Step 3: Commit per ported screen**

```bash
git add frontend-next/
git commit -m "chore(migration): port <screen> to Nuxt/viem (parity verified)"
```

---

## Self-Review checklist

- [ ] 5.1→Task1, 5.2→Tasks 2+3, 5.3→Task5, 5.4→Task4, 5.5→Task6.
- [ ] No placeholders; every code step has full code. **`DEPOSITOR_TARGET` throws at module load on missing/invalid env — no `0xDEP_FROM_DEPLOYMENTS` sentinel can reach runtime** (negative test asserts the throw).
- [ ] Test fixtures use valid lowercase 20-byte addresses (no viem `InvalidAddressError`/checksum surprise).
- [ ] `maxAtRisk` has a NON-boundary case (172801s → 3 periods) so `ceil` is actually proven, not `floor`-equivalent.
- [ ] `capPerPeriod` is bigint everywhere (asserted) — single source = single type; `approvedByUser` guard blocks deriving grant args from an unreviewed scope.
- [ ] Blocker 1 = SETTLED (EIP-712): relay layer already has `sig` param + `signDeposit` + domain/types. execId comment clarifies it is an OFF-chain agent contract, NOT verified on-chain.
- [ ] Revoke gas asterisk documented in threat-model §3 (native gas escape hatch) + UI balance warning.
- [ ] Type consistency: `computeExecId({owner,vault,planId,step})` matches the contract's `keccak256(abi.encode(owner,vault,planId,stepIndex))` (Phase 1 execId note); `toAuthorizeArgs` order matches `AgentRegistry.authorizeSessionKey(agent,vault,token,capPerPeriod,periodDuration,expiry)`.
- [ ] The Nuxt migration is gated by the smoke test and sequenced last (no migration on an unproven primitive).
- [ ] Single-source guarantee: on-chain args + UI summary both come from `permissionScope.js`.
