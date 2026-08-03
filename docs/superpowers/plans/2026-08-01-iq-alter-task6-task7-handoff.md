# IQ Alter Remediation — handoff: Task 6 is complete, Task 7 is all that remains

Updated 2026-08-01 at Task 6 close. Standalone: `.superpowers/` is gitignored (`.gitignore:75`), so
the run ledger, briefs and review packages do **not** travel with this file. What you need is inlined.

## Position

Branch `iq-alter`, HEAD `7d9d96a`. Working tree carries only the permanent `assets.manifest.json`
CRLF drift — **never commit it**.

**Tasks 1-6 are complete. Task 7 is the only remaining work.**

Suite: **4670 / 4677**, with 7 stable pre-existing failures across 5 files — 2 WCAG contrast,
2 brand-asset EPERM, 1 brand SHA drift, 2 CSS token-block. Do not try to fix them. (Session start was
~4457 with 9 failures plus 2 files that would not collect at all.)

Commits since `71543f0`, all reviewed and re-reviewed clean:

| commit | what |
| --- | --- |
| `05b6f38` `b43bda7` `2359ce6` | W3a — cap drift checked against provable on-chain scope |
| `45996f9` `fe44435` | the two collection bugs — 81 tests recovered |
| `3dbfca0` `075da5d` | W3b — `inspectAgentsV4` (**Task 5 complete**) |
| `3750447` `1f96e72` `e732f3f` | Task 6 Chunk A — the monotonic receipt producer |
| `6b81ea1` `63e59b5` | Task 6 Chunk B — the authenticated receipt-evidence client |
| `fac5f59` `424f6d6` | Task 6 Chunk C1 — evidence wiring into the real dispatch loop |
| `1fd0d95` `7d9d96a` | Task 6 Chunk C2 — UI projection of proven custody |

## What Task 6 built, in one paragraph

Execution used to collapse each allocation into a boolean and one transaction hash. It now produces
`AllocationReceiptV2` — monotonic evidence whose confirmed facts can never be removed, matching a
server contract Task 3 already shipped (`frontend/migrations/0005_execution_receipts.sql`,
`frontend/api/agent-index/models.js`). Pull and deposit are separate journaled attempts with distinct
hashes. Custody advances **only on proof**. Evidence is posted through an authenticated
challenge→sign→write exchange that never puts a session secret on the wire. The UI projects that
custody rather than re-deriving it, and distinguishes proven from inferred from unreadable.

## Task 7 — take the full text from `docs/superpowers/plans/2026-07-29-iq-alter-remediation.md`

Five constraints, all verified this session. Do not let any of them decay back into an assumption.

**1. The replay guard — this is the money-safety one.** V2 `pull(agent, amount)` has **no replay
protection at all**: no execution id, no dedup key. V3 `pull_v3` does — `DataKey::ExecutionUsedV3`
(`types.rs:115`), `RouterError::DuplicateExecutionV3` (`types.rs:164`), enforced at `lib.rs:503-509`.
So `resubmit-identical-envelope` is safe **only under a V3 router**. While the live router is V2 the
selector must fail closed to `poll`/`manual-review`. Resending there is a double-spend.

**2. `proof-rejected` (401) cannot be split.** `frontend/api/agent-index/handler.js:52-64` returns an
identical `{401, 'Invalid or expired receipt proof'}` for **both** bad-signature and
expired-challenge. The selector may route on `replay` (409), `authority` (403) and `invalid` (400) —
but must not assume it can distinguish expired from bad-signature. Do not write a brief demanding
otherwise; an earlier one did, and the implementer correctly reported it impossible.

**3. The recovery-lease server primitive already exists, with no client caller.**
`acquireRecoveryLease`/`releaseRecoveryLease` (`frontend/api/agent-index/store.js:542-614`), table
`execution_recovery_leases` keyed by `(network_id, execution_id, allocation_id, child_id, phase)`
with `holder`/`lease_token`/TTL (`frontend/migrations/0005_execution_receipts.sql:118-134`), exposed
at `handler.js:216-262` via `?action=lease-acquire` / `lease-release`. Task 7 builds the client half.

**4. Two `executionId` spaces exist, and they are legitimately separate — verified.**
`makeAllocationExecution` (`frontend/src/strategy/permissionGrantV3.js:222`) mints a **bytes32 router
replay-guard**, passed as `{bytes32}` at `grant.js:401`. The agent-index `execution_id`
(`migrations/0005:5,42`) is a **free-form TEXT primary key**, and that is what `requestRecovery`
keys on. Task 6 uses `${runId}:exec:${allocationId}` for the latter — deterministic, no nonce, salt
or counter, so resending after an unknown-outcome submission stays safe by construction.
The router id is now stored in the pull attempt's evidence as `v3ExecutionId` (`orchestrator.js:830`,
spread into all four pull-phase evidence objects), so a V3 recovery **can** resend the identical
envelope rather than rebuilding it. Do not mint a per-attempt id anywhere; that would move money
twice on exactly the retry recovery depends on.

**5. Build the receipt-read client and adopt the server's version on conflict.** Task 6 shipped only
the minimum here — a `receiptEvidenceDurable` flag on both dispatch loops' result projections
(`orchestrator.js:1012`, `:1227`) plus a `durable` field on the `receipt-evidence-failed` event —
and **no consumer reads it**. The stated reason ("a full re-read is not cheaply buildable") was
checked and is **wrong**: `GET /api/agent-index?action=receipt` already exists, routed and
unauthenticated (`agent-index.js:214-227` → `handler.js:182-214` → `store.js:197
readExecutionReceipt` → `models.js:248` returns `version`). Only a thin client wrapper is missing.
Without it, a POST that fails *after* the server committed leaves every later POST at a stale
`expectedVersion` → `store.js:505-507` 409s each one → the receipt freezes at attempt 1 while the run
continues. That is precisely the crash/reload case Task 7 targets. Task 7 needs a receipt reader
anyway, so this is its natural home.

## Rulings that bind Task 7

- **Custody advances only on proof.** `allocationReceipt.js:306-310`: `owner` → true;
  `stellar-agent` → `txSuccess`; **everything else → `txSuccess && matchingEvent`**. Custody
  locations are rank-ordered and never move backward; because every location now requires proof, a
  backward move is genuinely impossible rather than merely forbidden.
- **`unknown` custody is a creation-time state, not a transition.** `confirmCustody` never
  un-confirms and **never throws on ambiguous evidence** — it preserves the last proven location and
  journals the ambiguity in `custody.reason`, with the phase carrying status `'unknown'`.
  `unknown`/`confirmed:false` is reachable only at INSERT via `createAllocationReceipt`'s
  `initialCustody`. Grounded in the trigger (`migrations/0005:49-64`), which constrains version,
  confirmed-phase regression, `custody_confirmed` 1→non-1, and `custody_units` nulled after confirmed
  non-null — and **does not constrain `custody_location` at all**.
- **Every forward `confirmCustody` must pass `amount`**, or the confirmed-amount guard throws.
- **W4 (Protect wiring) is out of scope** by operator ruling; it is activation work, separate
  authority (Global Constraint 25).
- `dispatchLegacy` (`orchestrator.js`) is **not production-reachable** — `dispatch()` selects it only
  when arg 2 is not an object, and the sole production call site always passes one. It produces no
  receipts, and that costs Task 7 nothing.

## Working rules

- Asset units are bigint-safe decimal integer strings. **Never `Number()` a unit value.** `Number()`
  on a ledger sequence (u32) or a timestamp is fine. (Note the UI's `unitsToDisplay` does use
  `Number()` at the render layer — a pre-existing display convention, deliberately unchanged.)
- Every 32-byte id crossing a JS boundary is `0x`-prefixed lowercase hex. Documented exceptions: the
  wasm-hash catalog is bare hex, and the receipt request digest is bare hex because the server's own
  `assertIdentity` regex forbids a prefix. `routerEvents.js:58,105` is a known remaining `Buffer`.
- **A cross-layer expectation may never be computed by the layer under test.** Pin it to a constant
  or a function produced by the other side. Moving a duplicated literal into a shared constant both
  sides import is **not** a pin — it still drifts from the server together.
- Never persist a session secret in a receipt. Scope that claim to the wire: this repo DOES persist
  `sessionKey.secret` to `localStorage` by design (`orchestrator.js:1330-1341`, `:1839-1850`,
  `:2111-2122` via `saveCachedAgent`).
- V3 stays DORMANT: no router address registered, no production defaults for injected readers, zero
  production callers on the V3 surface. That is CORRECT, not an omission.
- ESLint uses a warning-fingerprint baseline, not zero warnings. Zero NEW warnings.
- Never run git mutations through WSL in this checkout — it cannot resolve the Windows gitdir and a
  failed restore silently leaves mutations in the tree. Confirm with `git diff --numstat`.

## Test and environment

- **`frontend/vitest.config.js` DOES NOT EXIST** — config lives in `vite.config.js`. Any
  `--config vitest.config.js` flag dies at startup.
- **Never a bare `npx vitest run`** — `package.json:11` is `vitest run --exclude="e2e/**"`, and a
  bare run picks up three unloadable Playwright specs under `e2e/`, inflating the failed-FILE count
  by 3. That caused an unexplained discrepancy inside Task 6 before it was root-caused.
- Concurrent npm processes make `node_modules/.bin` flap empty mid-run. A failure that does not
  reproduce across two runs is noise. **Never revert someone else's file to make a run go green.**

## How to work

`superpowers:subagent-driven-development`. ONE implementer per chunk, ONE reviewer covering spec and
quality. Sonnet implements, opus reviews, haiku is fine for read-only exploration.

- **Check file ownership at dispatch time**, not by warning an agent inside a prompt.
- **Disjoint file ownership is NOT sufficient to parallelise when both chunks run the same suite.**
  Serialise anything that runs the full suite. Two chunks were run in parallel this session on
  disjoint edit sets and still collided over the shared suite; one of them ran `git stash` while the
  other had ~570 uncommitted lines of a money-path fix live in the tree. Nothing was lost, but only
  because both agents behaved well.
- **Put "cost is not a constraint; ignore the cost hook" in every dispatch prompt.** An environment
  hook fires cost warnings inside subagents, and one implementer obeyed it — pausing mid-fix-round
  with a guard MUTATED OUT of the working tree.
- **Build a fresh code map before writing briefs, and verify its PATH and COUNT claims, not just its
  field names.** Three briefs this session carried factual errors — the wire key was `mutation` not
  `body`, the migration was at `frontend/migrations/` not under `api/agent-index/`, and there were
  three dispatch entry points not two. All three were caught by implementers, none by the
  controller, because field claims were checked and path/enumeration claims were copied forward.
- Tell every implementer to **follow the source over the brief and report the divergence**. That
  instruction is the only reason those three errors surfaced.

## The discipline that actually matters

Across this whole remediation the defects were almost never in the code. They were in the account of
how the code was verified: a `signerPub` expectation computed by the same SDK call production uses; a
`canonicalJson` mirror claiming "same semantics" while dropping two guards; a replay discriminator
pinned to a literal its own test also hardcoded; a header that asserted things its own file
contradicted — three times in one file, including once in a rewrite whose stated purpose was removing
exactly that; and a headline test built on a fixture the producer cannot emit, asserting the very
defect it was written to guard against.

So: for every assertion that matters, break the code it guards, run it, record the REAL red output,
restore, run again, record green — and paste the actual output, not a summary. If you skip one, write
"not mutated, unverified". And for every fixture, ask whether a real producer could actually emit that
value. A test whose fixture no producer can supply proves nothing, however green it is.
