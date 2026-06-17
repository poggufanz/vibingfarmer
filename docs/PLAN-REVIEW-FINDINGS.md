# Plan Review Findings — carry-forward ledger

**Purpose:** Every blocker/flaw found while verifying a roadmap-v2 phase plan lands here. **Any agent writing or executing a new plan MUST read this file first** and confirm none of these regress. A finding fixed in one phase is NOT allowed to reappear in another — that is the failure mode this ledger exists to stop.

> Reviewer meta-rule adopted globally: **a module built without an explicit integration task is NOT done** — self-review must name the production caller, not just show a green test.

---

## Recurring blockers (highest priority — these have appeared in MORE THAN ONE plan)

| ID | Blocker | Fix | First seen |
|----|---------|-----|-----------|
| R1 | `vm.writeJson` / `vm.writeFile` reverts | Add `fs_permissions = [{ access = "read-write", path = "./<dir>" }]` to `foundry.toml` **AND** create the target dir first (`mkdir -p` — cheatcodes do not mkdir) | Phase 1 Task 6, again Phase 3 Task 2 |

---

## Per-phase findings

### Phase 1 — Trust Foundation
- EIP-712 deposit auth settled (Blocker 1). Real signature: `executeAgentDeposit(uint256 amount, uint256 minAmount, bytes32 execId, bytes sig)`; signer recovered from sig (no `vm.prank`). `_sign` helper + `hashAgentDeposit` exist from Task 3.
- R1 (`writeJson` permissions) first surfaced here.

### Phase 2 — Ops Security
- **Dead-code risk:** modules (`keyVault`, `gasSnapshot`) built without a wiring task = dead code passing their own tests. Fix: every `Create` module task is paired with a `Modify` wiring task naming the production caller. Now consolidated in Phase 2 Task 4.
- **Accidental kill switch:** a gate consuming `gasSnapshotAt` with no producer → `undefined` → everything skipped. Always ship the producer + the wiring, not just the consumer.
- **Honesty — zeroize:** a `0x`-hex private key is an immutable JS string and CANNOT be wiped. Never claim "zeroized after use" for it. Honest claim = "exposure window minimized". Only `Uint8Array` buffers are actually zeroized.
- **Missing economic gate:** the Hermes "gas cost > expected benefit → cancel" idea must be present (`uneconomic` reason), not silently dropped.
- **Unbounded growth:** long-running worker decision logs need a ring buffer cap.
- **KDF + at-rest storage must be specified**, not left as a test stand-in (`new Uint8Array(32).fill(7)`). Production secret comes from `crypto_pwhash`; sealed blob lives in an explicit store (IndexedDB); the derived secret is never stored beside the blob.
- **Carry-forward to Phase 5 — execId/signing not yet wired.** Task 4's self-review line claimed "agent-side execId persistence is part of the worker change in Task 4"; the implementation deliberately scopes Task 4 to key lifecycle + circuit breaker only. `worker.js#signAtSubmitSite` opens the sealed key and drops it with `TODO(phase5): const sig = await signDeposit(pk, digest)` — no `execId` is generated or persisted yet. This is an honest, marked gap, not a silent omission. Phase 5 ledger entry on `execId` (viem↔Solidity `abi.encode` byte parity) already covers the requirement; any Phase 5 plan must include execId generation + `signDeposit` wiring as the Task 4 follow-up.
- **Pre-existing (unrelated) test failures on `iq`:** `orchestrator.test.js` ("still batches grants when no session") and `relay.test.js` (2x "redeem-first") fail at HEAD with `getRelayerAddress` / session-redemption mismatches. Confirmed via `git diff a79d824 HEAD -- frontend/src/relay.js frontend/src/orchestrator.js frontend/src/relay.test.js frontend/src/orchestrator.test.js` (empty diff) — these files are untouched by Phase 2 and were already broken before this phase started. Out of scope for Phase 2; do not "fix" them as part of an ops-security plan.
### Phase 3 — Historical Replay
- **R1 again** (see recurring table).
- **Archive-node check must query STATE, not a block header.** `cast block <old>` succeeds on any full node; only `cast balance <addr> --block <old>` (or another state read) proves archive. Also: `cast` does not auto-load `.env` — `MAINNET_RPC` must be `export`ed in the WSL shell.
- **No Monte Carlo theater.** If every sample collapses to one endpoint (P5=P50=P95), it is a constant dressed as a distribution. The agentic leg is deterministic (tx lands in the first block after signal; sub-block seconds are meaningless) — show one honest number; run MC only on the leg with real variance (manual).
- **Reproducibility:** any committed generated numbers must use a seeded PRNG (seed in metadata), not `Math.random`.
- **Provenance:** generated ground-truth JSON must carry `signalBlock` / `chainId` / date so the Assumptions panel is auditable.
- **SwapRouter02 has no `deadline`** in the `exactInputSingle` struct (SwapRouter01 does). Match the struct to the router address (`0x68b3…Fc45` = SwapRouter02).
- **`npm --prefix frontend exec -- vitest run <path>` keeps cwd at repo root**, not `frontend/`. A test under `scripts/replay/` is reached as `scripts/replay/monteCarlo.test.ts` (no `../` prefix) — the plan's `../scripts/...` path assumed cwd=`frontend/` and would fail to resolve.
- **`vm.serializeUint` emits uint256 above `Number.MAX_SAFE_INTEGER` as JSON strings** (e.g. `delay_2: "700875391021734441116"`). Any TS consumer must `Number(g[key])` before arithmetic — `monteCarlo.ts`'s `Ground = Record<string, number | string>` + `DELAY_KEYS` coercion is the pattern to copy.
- **Plan staleness — Task4 routing target.** Plan assumed a vanilla-JS `frontend/src/screens/replay.js` + `case 'replay':` dispatch in `app.js`/`ui.js`. The actual frontend is React Router v6 (`frontend/src/app.jsx`); no `screens/` dir exists. Resolved by following the existing `/explorer` and `/ecosystem` "public page, no wallet" precedent: new `frontend/src/components/ReplayPage.jsx` (+ scoped `ReplayStyle()`), an early-return route check in `app.jsx` for `location.pathname === '/replay'`, and a nav link in `NavBar.jsx`. Any future plan referencing `screens/`/`ui.js`/`app.js` dispatch for this repo is stale — use the `app.jsx` route-check + `components/*Page.jsx` pattern instead.
- **Plan staleness — Task4 Step3 "Aladdin/6-variable" docs cleanup is a no-op.** Grepped `docs/` and the whole repo (case-insensitive) for `Aladdin|6-variable|six-variable|6 variabel|predictive|forward-looking|scenario model`: zero matches anywhere. The referenced concept/text does not exist in this repo — likely already removed in an earlier phase. Step3 requires no action; do not re-attempt this grep expecting hits.

### Phase 4 — Real Integration
- **Invariant suites must prove the HEADLINE claims, not just the structural ones.** `spentNeverExceedsCap` / `reservesNeverExceedBalance` are near-tautological. The two that actually back the product: `outflowBounded` (total outflow ≤ cap × periods elapsed — ghost `totalPulled` + `startTs` in Handler) and `noDepositsAfterRevoke` (ghost `revoked` + `depositsAfterRevoke == 0`). A fuzz run that only checks the easy two gives false confidence.
- **Foundry path globs don't reliably do brace expansion `{a,b}`.** Exclude fork/RPC tests by CONTRACT-NAME suffix `Fork` (`--no-match-contract Fork` / `--match-contract Fork`), deterministic on all forge versions. Silent non-exclusion → secret-less unit job runs a fork test → `envString` revert → permanent red CI.
- **GitHub `schedule:` cron fires only from the DEFAULT branch.** Nightly fork job will not run while work lives on `iq`; note it in the workflow so it isn't mistaken for breakage.
- **Conditional tests can pass hollow.** A test whose entire body sits behind `if (cond)` "passes" testing nothing when `cond` is false. Give it an explicit `else` that asserts the normal path.
- **Unpinned `vm.createSelectFork` = non-deterministic.** Pin a block (note the date) so vault state is frozen; green-today-red-tomorrow otherwise. Also lighter on the RPC.
- **Architecture promises must map to a task (the "dead promise" pattern again).** Phase 4 Architecture named a relayer-down drill that no task implemented — same shape as Phase-2 keyVault dead code. Every promised drill/module needs a concrete step.
- **Blocker 1 confirmed SETTLED (EIP-712 relayer).** Any downstream plan modeling deposit auth as `msg.sender` / naked `cast send` from the worker EOA is wrong — auth is the recovered EIP-712 signer; submitter is arbitrary. Reviewers flagging this as "still open" are stale against this ledger line + Phase 1.

### Phase 5 — Refactor & UX
- **Test fixtures need VALID addresses.** viem `encodeAbiParameters(... 'address')` validates EIP-55 checksum on mixed-case and throws `InvalidAddressError`; a too-short string (`'0xVa'`) also throws. Use all-lowercase 20-byte (`'0x'+'a1'.repeat(20)`) so the test exercises the logic, not address validation — otherwise the test fails for the wrong reason and an agent may "fix" it by loosening the impl.
- **Boundary-blind rounding tests.** A `ceil` test whose input lands exactly on an integer (2 days → 2) passes under `floor` too. Always add a partial case (+1s → 3) so the rounding direction is actually proven.
- **Placeholder sentinels that pass self-consistent tests.** `X ?? '0xPLACEHOLDER'` survives a test that only checks `X === X`. For addresses: NO fallback — throw at module load on missing/invalid env (`/^0x[0-9a-fA-F]{40}$/`), add a negative test asserting the throw. Same family as Phase 4's `require` halt-loudly.
- **Single source of truth = single TYPE.** A value shown in the UI and sent on-chain (`capPerPeriod`) must be one type (bigint) end-to-end; mixing Number/BigInt makes `toBe` identity asserts misleading and risks UI/chain drift. Assert the type at the module boundary. Pair with an `approvedByUser` guard so grant args can't derive from an unreviewed scope.
- **execId is an OFF-CHAIN contract.** The depositor stores `executed[execId]` as-given; it never recomputes the hash. Comments claiming the JS formula "matches the on-chain replay guard" mislead an agent into trying to verify it in Solidity. What matters is viem↔Solidity `abi.encode` byte parity so retries hash identically.
- **Gasless UX vs user-signed revoke (native-gas asterisk).** A user-signed escape-hatch (revoke) needs native gas the gasless flow never required — the wallet may be empty at the panic moment. Headline "revoke any time" claims must document the answer (hold gas, or pre-signed broadcastable revoke) in the threat model, not leave it implicit.
- **`app.jsx` exists; `strategy/` (not `core/`) is the real dir; `skills.test.js` does not exist (Create).** Verified via `ls frontend/src/` 2026-06-11. Guards against the ghost-file class (Phase 2 gasSnapshot).

---

## How to use this file (for the implementing agent)
1. Before writing a new phase plan: read this whole file.
2. For each finding, add an explicit step or guard to the new plan that prevents regression, or state in the self-review why it does not apply.
3. After a new review round, append findings here in the same shape — keep the recurring table honest (promote anything that appears twice).
