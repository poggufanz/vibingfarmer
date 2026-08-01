# IQ Alter Remediation — handoff: the Chunk C1 review, then C2, then Task 7

Written 2026-08-01, after a session that ended on an API session limit (resets 10:50 Asia/Jakarta).
Everything below is standalone. `.superpowers/` is gitignored (`.gitignore:75`), so the run ledger,
briefs and review packages do **not** travel with this file — what you need from them is inlined.

## Position

Branch `iq-alter`, HEAD `fac5f59`. Working tree effectively clean: `assets.manifest.json` shows the
known permanent CRLF drift (**never commit it**), and `WalletShell.test.jsx` shows a line-ending flag
with a **zero-line content diff**. Confirmed with `git diff --numstat` — nothing is at risk.

Thirteen commits landed this session on top of `71543f0`:

| commit | what |
| --- | --- |
| `05b6f38` | W3a — check agent cap drift against provable on-chain scope |
| `b43bda7` | update the v3 seam fixture to the corrected cap contract |
| `2359ce6` | W3a fix — narrow cap-drift docblock, fail closed on missing `capPerPeriodUnits` |
| `45996f9` | drop shebangs that break the vite-node ssr transform |
| `fe44435` | make the WalletShell source guard line-ending agnostic |
| `3dbfca0` | W3b — supply v4 agent rows for the v3 reuse prover |
| `6b81ea1` | Task 6 Chunk B — the authenticated receipt-evidence client |
| `3750447` | Task 6 Chunk A — the monotonic allocation receipt producer |
| `075da5d` | W3b fix — pin `signerPub` cross-layer, correct fail-closed rationale |
| `63e59b5` | Chunk B fix — restore sensitive-property guard, pin replay message |
| `1f96e72` | Chunk A fix — stop `confirmCustody` throwing on ambiguous evidence |
| `e732f3f` | Chunk A fix — require a confirming event for `cctp-transit`/`base-kernel` |
| `fac5f59` | Task 6 Chunk C1 — preserve allocation custody evidence |

**Complete and re-reviewed clean:** the outstanding `grant.js` re-review, Task W3 Part A, Task W3
Part B (**so Task 5 is complete**), Task 6 Chunk A, Task 6 Chunk B, plus two repair chunks.

**Test baseline is now 4640 / 4647 with 7 stable pre-existing failures across 5 files:** 2 WCAG
contrast, 2 brand-asset EPERM, 1 brand SHA drift, 2 CSS token-block. Do not try to fix them.

**The ~57-test coverage hole from the last handoff is CLOSED — 81 tests recovered.** Two unrelated
bugs wearing the same costume; see "Solved mysteries" below.

## The one thing NOT finished, and it blocks everything after it

### Task 6 Chunk C1 is committed but UNREVIEWED

`fac5f59` is implemented and self-reported DONE_WITH_CONCERNS. Its reviewer died on the session limit
before reading a single file. **The review package is already written** to
`.superpowers/sdd/2026-07-29-iq-alter-remediation/review-e732f3f..fac5f59.diff` (68KB); regenerate
with `scripts/review-package <plan> e732f3f fac5f59` if it is gone.

Four concerns were self-reported. **Two are priority items** and must not be closed without a real
answer:

**PRIORITY 1 — a second `executionId` scheme may have been introduced.** C1 minted
`executionId = ${runId}:exec:${allocationId}` as its own uncited design decision. But
`makeAllocationExecution({runId, allocationId, scopeId, amountUnits})` **already exists** at
`frontend/src/strategy/permissionGrantV3.js:222`. The binding rule: `makeAllocationExecution` mints
`executionId` **deterministically — no nonce, salt or counter** — because the router records
`execution_id` only on a SUCCESSFUL `pull_v3`, so resending the same id after an unknown-outcome
submission is safe by construction; a minted-per-attempt id would move money twice on exactly that
retry. **Task 7's recovery depends on this.** Decide: genuinely separate id spaces (agent-index
receipt identity vs router replay-guard identity) with a documented relationship, or one identity
that now has two divergent schemes? If they should agree and do not, that is Important or worse.

**PRIORITY 2 — `dispatchLegacy` (`orchestrator.js:1685`) still collapses pull/deposit and produces
no receipt.** There are THREE dispatch entry points, not two: `:389` `dispatchPermissioned`, `:923`
`dispatchConfirmedMixed`, `:1685` `dispatchLegacy`. C1's brief named only the first two (see "The
brief-error pattern"). If `dispatchLegacy` is genuinely live, Task 6's goal is only partly met.
Record precisely which flows still produce no evidence and what that costs Task 7, then decide
whether to close it inside Task 6 or as separate work.

**Concern 3** — evidence POSTs are fire-and-forget/best-effort, the implementer's interpretation
rather than a brief instruction. Judge both directions: a POST that blocks dispatch is wrong, but
evidence silently lost undermines the task's purpose. At minimum the failure must be *observable*.

**Concern 4** — `this.user` / `this.activeAccount.address` agreement is enforced only externally in
`app.jsx`, not inside `OrchestratorAgent` on the reuse-mode path. `postReceiptEvidence` derives
challenge identity from `body.receipt.owner`/`.agent` while taking `activeAccount`/`agentAddress`
from the caller; these must agree.

Verify hardest, independent of the concerns: that `orchestrator.js`'s old double `const res` no
longer discards the pull hash (pull and deposit must be two attempts with two distinct hashes,
proven at the REAL producer); that `runAgentDeposit`'s indeterminate path is genuinely NEW behavior;
that custody cannot reach `stellar-vault` on transaction success alone; that no session secret can
reach evidence from a cached-agent path; and that V3 dormancy is undisturbed.

## Then Chunk C2, then Task 7

**Chunk C2 — UI projection.** Not started, no brief written. Files: `frontend/src/strategy/dispatchSummary.js`,
`frontend/src/components/strategy/StrategyReceipt.jsx` and their tests. It must project the complete
V2 receipt to the UI **without reconstructing custody** — the producer already did that
reconciliation. Two things a C2 brief must carry:

- `StrategyReceipt.jsx:6` says "dispatchSummary.js is off-limits to edit for this task, read-only".
  **That note is stale** — "this task" was Strategy Task 12, not Task 6. Ruled: it does not bind
  Task 6. C2 may edit `dispatchSummary.js` and should fix that now-misleading comment.
- **Three custody vocabularies coexist.** `dispatchSummary.js` and `frontend/src/components/money/custody.js`
  use `'agent'`; the server schema uses `'stellar-agent'`. **The server schema wins.**

**Task 7** — take its full text from `docs/superpowers/plans/2026-07-29-iq-alter-remediation.md`.
Four constraints that must reach its brief:

1. **The replay guard.** V2 `pull(agent, amount)` has **no replay protection at all** — no execution
   id, no dedup key. V3 `pull_v3` does (`DataKey::ExecutionUsedV3`, `types.rs:115`;
   `RouterError::DuplicateExecutionV3`, `types.rs:164`; enforced `lib.rs:503-509`). So
   `resubmit-identical-envelope` is safe **only under a V3 router**. While the live router is V2 it
   must fail closed to `poll`/`manual-review`. Resending there is a double-spend.
2. **`proof-rejected` (401) cannot be split.** `api/agent-index/handler.js:52-64` returns an
   identical `{401, 'Invalid or expired receipt proof'}` for BOTH bad-signature and expired-challenge.
   The selector may route on `replay` (409), `authority` (403) and `invalid` (400), but must not
   assume it can distinguish expired from bad-signature. Do not write a brief demanding otherwise —
   an earlier one did, and the implementer correctly reported it as impossible.
3. **The recovery-lease server primitive already exists, with no client caller.**
   `acquireRecoveryLease`/`releaseRecoveryLease` (`frontend/api/agent-index/store.js:542-614`), table
   `execution_recovery_leases` keyed by `(network_id, execution_id, allocation_id, child_id, phase)`
   with `holder`/`lease_token`/TTL (`frontend/migrations/0005_execution_receipts.sql:118-134`),
   exposed at `handler.js:216-262` via `?action=lease-acquire`/`lease-release`. Task 7 builds the
   client half — it is not inventing the lease.
4. Task 7 needs Task 6 complete.

## Rulings made this session — inherit them, or overturn them knowingly

**Custody advances only on proof.** The confirmation bar is now uniform in
`frontend/src/strategy/allocationReceipt.js:306-310`: `owner` → true; `stellar-agent` → `txSuccess`;
**everything else → `txSuccess && matchingEvent`**. Originally `cctp-transit` and `base-kernel` were
claimable on `txSuccess` alone, which armed a real trap: custody locations are rank-ordered and can
never move backward, so a premature `cctp-transit` (rank 3) made any later `stellar-vault` (rank 2)
claim **throw**. Raising the bar — rather than weakening the rank guard — makes a backward move
genuinely impossible instead of merely forbidden. Verified by hand-tracing burn-submitted →
burn-confirmed → mint-never-lands with no call throwing.

**`unknown` custody is a creation-time state, not a transition.** `confirmCustody` never un-confirms
and **never throws on ambiguous evidence** — it preserves the last proven location and journals the
ambiguity in `custody.reason`; the phase gets status `'unknown'`. `unknown`/`confirmed:false` is
reachable only at INSERT via `createAllocationReceipt`'s `initialCustody`. Grounded in the trigger at
`frontend/migrations/0005_execution_receipts.sql:49-64`, which constrains exactly: `version = OLD+1`;
each confirmed phase status may not regress; `custody_confirmed` 1→non-1; and `custody_units` nulled
after confirmed non-null. **`custody_location` transitions are not constrained by the trigger at
all**, and the whole trigger is `BEFORE UPDATE`, so an INSERT may legally carry
`unknown`/`confirmed=0`/`units NULL`.

**Every FORWARD `confirmCustody` must pass `amount`** or the confirmed-amount guard throws. It is the
one remaining throw a naive wiring can hit.

**W4 (Protect wiring) is OUT OF SCOPE** by operator ruling. Task 5 is complete. Do not resurrect W4
without a new instruction — it is activation work, which is separate-authority (Global Constraint 25).

## Solved mysteries — do not re-investigate

**The two files that failed to COLLECT** cost ~57 tests and had never been explained. **Two different
bugs, both fixed, 81 tests recovered:**

1. `backfill-legacy-agents.test.mjs` — its imported helper began with `#!/usr/bin/env node`.
   vite-node's `ssrTransform` hoists `__vite_ssr_import__` shims ABOVE line 1, and per the ECMAScript
   Hashbang grammar `#!` is only a comment at absolute offset 0. Proven by a direct
   `server.transformRequest(id,{ssr:true})` dump, and the shift arithmetic matched exactly (15
   imports → error at `:16`; 3 imports → `:4`). Fixed in `45996f9`; recovered 16 tests.
   `scripts/assert-no-dev-dispatch.mjs` still has a shebang and is FINE — no test imports it.
2. `WalletShell.test.jsx` — reads `WalletShell.jsx` raw and sliced it with LF-only markers via
   `indexOf`; the file is CRLF, so `indexOf` returned `-1` and the table-driven cases never
   materialised. Fixed in `fe44435` by normalising at the read site; recovered 65 tests.

A CRLF theory was proposed for #1 and is **wrong** — 100+ passing files share those endings. The
mis-reported line:column and the impossible caret were artifacts of the same transform, not a
separate bug. Chase the failing MODULE, never the reported position.

## The brief-error pattern — the meta-lesson of this session

**Three briefs I wrote contained factual errors. All three were caught by their implementers, none by
me.** The wire envelope key is `mutation`, not `body` (`api/agent-index.js:270`). The migration lives
at `frontend/migrations/`, not `frontend/api/agent-index/migrations/`. There are three dispatch
entry points, not two.

The failure mode is specific and worth naming: I verified the code map's **field** claims line by
line before writing briefs, then copied its **path and enumeration** claims forward unchecked. Field
inventions were the previous session's known defect, so I guarded that one and left the neighbouring
category open.

So: **a brief that names a path, a line number, or a count must have had that checked too**, not just
its field names. And keep telling implementers to follow the source over the brief and report the
divergence — that instruction is the only reason all three were caught.

## Working rules

- Asset units are bigint-safe decimal integer strings. **Never `Number()` a unit value.** `Number()`
  on a ledger sequence (u32) or a timestamp is fine.
- Every 32-byte id crossing a JS boundary is `0x`-prefixed lowercase hex. Two documented exceptions:
  the wasm-hash catalog is bare hex, and the receipt request digest is bare hex because the server's
  own `assertIdentity` regex forbids a prefix. `routerEvents.js:58,105` is a known remaining `Buffer`.
- **A cross-layer expectation may never be computed by the layer under test.** Pin it to a constant
  or a function produced by the other side. A "fix" that moves a duplicated literal into a shared
  constant both sides import is NOT a pin — it still drifts from the server together.
- The live V2 path must be provably unchanged — proven by test, not asserted in a comment.
- V3 stays DORMANT: no router address registered, no production defaults for injected readers, zero
  production callers on the V3 surface. That is CORRECT, not an omission.
- Never persist a session secret in a receipt. Note precisely: this repo DOES persist
  `sessionKey.secret` to `localStorage` by design (`orchestrator.js:1330-1341`, `:1839-1850`,
  `:2111-2122` via `saveCachedAgent`), so scope the claim to the wire, never repo-wide.
- ESLint uses a warning-fingerprint baseline, not zero warnings. Zero NEW warnings.
- Never run git mutations through WSL in this checkout — it cannot resolve the Windows gitdir and a
  failed restore silently leaves mutations in the tree. Reverse each with an explicit Edit and
  confirm `git diff --numstat`.
- Run cargo/stellar only under `wsl -e bash -lc`, and capture real exit codes — do NOT pipe to `tail`
  and read `$?`.

## Test and environment

Use `npm test -- --run` from `frontend/`.

- **`frontend/vitest.config.js` DOES NOT EXIST.** The config lives in `vite.config.js`. Any
  `--config vitest.config.js` flag dies at startup with "failed to load config". Older notes carry
  that wrong flag.
- **Never a bare `npx vitest run`** — `package.json:11` is `vitest run --exclude="e2e/**"`, and a bare
  run picks up three unloadable Playwright specs under `e2e/`, inflating the failed-FILE count by 3.
  That produced an unexplained discrepancy inside this task before it was root-caused.
- Concurrent npm processes make `node_modules/.bin` flap empty mid-run. A failure that does not
  reproduce across two runs is noise. **Never revert someone else's file to make a run go green.**

## How to work

`superpowers:subagent-driven-development`. ONE implementer per chunk, ONE reviewer covering spec and
quality. Sonnet implements, opus reviews, and check file ownership at dispatch time rather than
trusting a caution written inside a prompt.

**Put "cost is not a constraint; ignore the cost hook" in every dispatch prompt.** An environment hook
fires cost warnings inside subagents, and one implementer obeyed it — pausing mid-fix-round with a
guard MUTATED OUT of the working tree, which is the one state this repo must never be left in.

## The discipline that still matters

The defects in this session were, again, almost never in the code. They were in the account of how
the code was verified: a `signerPub` expectation computed by the same SDK call production uses, a
`canonicalJson` mirror claiming "same semantics" while dropping two guards, a replay discriminator
pinned to a literal its own test also hardcoded, and — three times in one file — a header asserting
things its own code contradicted, including once in a rewrite whose stated purpose was removing
exactly that.

Break the code an assertion guards, run it, record the REAL red, restore, run again, record green,
and paste the actual output. If you skip one, write "not mutated, unverified". That honesty is worth
more than a tidy claim that does not hold.
