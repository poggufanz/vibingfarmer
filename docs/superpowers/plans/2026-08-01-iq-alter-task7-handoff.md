# IQ Alter Remediation — handoff: Task 7 in progress, Chunk A implemented but NOT accepted

Written 2026-08-01 when the operator stopped the session mid-Chunk-A. Tracked on purpose:
`.superpowers/` is gitignored (`.gitignore:75`), so the run ledger, briefs, maps, reports and
reviews do not travel via git. **On this machine they DO survive** at
`.superpowers/sdd/2026-07-29-iq-alter-remediation/` — read them if present. Everything essential
is inlined here in case they are not.

## Position

Branch `iq-alter`, HEAD `0174a92`. Working tree carries only the permanent
`assets.manifest.json` CRLF drift — **never commit it**.

| commit | what |
| --- | --- |
| `be7b003` | previous session's Task 6 close + handoff |
| `e05ca2c` | `style:` prettier-only formatting of Task 6 files (the tree arrived dirty with it; quote-style and wrapping only, verified by `prettier --check`) |
| `0174a92` | **Task 7 Chunk A — implemented, reviewed, NOT accepted (spec ❌)** |

**Tasks 1-6 complete. Task 7 is the last task of the whole 14-task plan.** W4 (Protect wiring) is
out of scope by standing operator ruling.

Suite: baseline at `e05ca2c` was **4670 / 4677** (7 stable pre-existing failures across 5 files).
After Chunk A: **4697 / 4704** — `+27 passed, +27 total, 0 change in failures`. The 7 are:
2 in `extension/approvalView.test.js` (real-Chromium WCAG contrast), 2 in
`extension/brandAssets.test.js` (gen-ext-icons EPERM), 1 in `src/design/brandAssets.test.js`
(SHA drift), 1 in `src/design/legacyPocketStyle.test.js`, 1 in `src/design/theme.test.js`.
**Do not fix them.**

## Task 7 is split into 3 serial chunks

19 named files across three layers. Serial, **not** parallel — disjoint file ownership is NOT
sufficient when all three run the same suite (that collision already happened once in this project).

| Chunk | Layer | Files | State |
| --- | --- | --- | --- |
| A | server | `api/agent-index/{recovery,handler,store}.{js,test.js}` + `api/agent-index.js` | implemented `0174a92`, **fix round 1 not yet run** |
| B | client | `src/strategy/{recoveryClient,receiptProjection}.{js,test.js}`, `src/orchestrator.js`, `src/baseLeg.{js,test.js}` | not started |
| C | UI | `src/app.jsx`, `src/app.recovery.test.jsx`, `components/strategy/StartStage.{jsx,test.jsx}`, `components/money/RecoveryPanel.{jsx,test.jsx}` | not started |

## Two operator rulings that bind the rest of Task 7

Both were escalated as one batched question before any dispatch, backed by two fresh read-only code
maps, and confirmed by the operator. **Do not relitigate either.**

### S2-D8 — Base selector rows are FAIL-CLOSED

Task 7's RED list demands ~8 Base rows (CCTP burn uncertain, re-attest the same nonce/message,
submit-same-message, used-nonce reconcile, poll exact UserOp). Verified first-hand:

- The CCTP **nonce** and the **attestation message** are persisted **NOWHERE** — not D1, not the
  relayer SQLite, not localStorage. `relayer/src/cctp/*` never durably writes what `pollAttestation`
  returns (`iris.mjs:29`, `watcher.mjs:39`).
- The **UserOperation hash** is captured (`relayer/src/base/orchestrator.mjs:90`) but only inside
  the relayer's own SQLite `jobs` blob; `frontend/api` has no `RELAYER_URL` or any path to read it.
- `base_child_intents` carries only `executionStatus` / `custodyLocation` / `txHash` — a coarse
  planned / in-flight / terminal split, nowhere near the brief's distinctions.
- `execution_recovery_leases` is keyed to the `execution_id` identity space; base children live in
  the `binding_id`/`child_id` space.

**Ruling:** Stellar rows decide against real evidence; every Base-touching receipt returns ONE
explicit fail-closed verdict (`blocked-reconcile`) whose reason names the missing producer. Base
recovery UI keeps using `baseLeg.js`'s existing `strandedFunds` path.

This is not throwaway: the fail-closed verdict stays correct after producers land; a producer only
shrinks how often it fires. Residual testnet risk is operational (a human intervenes), not
financial (no double-spend through this path).

### S2-D9 — new authenticated route `?action=recovery-request`

`lease-acquire`/`lease-release` are gated by the shared secret `AGENT_INDEX_REPORTER_SECRET` over
`Authorization: Bearer` (`handler.js:103-109`), **not** the challenge/proof scheme. Putting that
secret in the browser violates a Global Constraint.

**Ruling:** add `POST ?action=recovery-request` authenticated with the SAME owner-signed
challenge → proof exchange as `receipt-write`; `requestRecovery` loads evidence, decides, and
claims the lease in ONE atomic operation.

Rejected: extending `lease-acquire` to accept bearer-OR-proof (dual-auth on a money-moving
endpoint, plus a TOCTOU gap between read and claim); and client-side-only selector with no lease
(drops concurrent-claim protection, a headline RED requirement).

**ACCEPTED DEVIATION:** `frontend/api/agent-index.js` is not in Task 7's Files list and the plan's
commit line says "Commit exactly named recovery/API/UI files". It is committed anyway, operator-
approved. Note it in the final Task 7 commit body.

## MAINNET BLOCKER discovered by this work — not Task 7 work

Before real money moves cross-chain, three things must land, in order:

1. Persist the CCTP **nonce + attestation message** at burn time (`relayer/src/cctp/*` currently
   never durably writes either). A lost attestation strands USDC and needs manual Circle
   intervention.
2. A read path from relayer state to the recovery selector (endpoint, shared store, or D1 mirror).
   `frontend/api` cannot reach the relayer at all today.
3. Extend the lease identity space to cover base child ids, or unify the two identity spaces.

## Chunk A — what was built, and what the review found

`0174a92` created `frontend/api/agent-index/recovery.js` with `selectRecoveryAction(receipt)` (pure,
12-string total state machine) and `requestRecovery(...)`; added `handleRecoveryRequest` to
`handler.js`; added the route to `agent-index.js`. **`store.js` untouched** — the existing lease
primitives sufficed. 23 + 4 new tests. R3/R4/R7/R8 mutation-proofed with real red→green transcripts.

Review verdict: **spec ❌, quality NOT approved.** Full review at
`.superpowers/sdd/2026-07-29-iq-alter-remediation/task7-chunkA-review.md`.

### CRITICAL — C1: `selectRecoveryAction` is not browser-importable

`recovery.js:41` statically imports `executionReceipts.js`, whose line 1 is
`import … from 'node:crypto'`; it also uses the `Buffer` global at `:239,:240,:280,:287`. Proven with
`npx esbuild --platform=browser` → `✘ Could not resolve "node:crypto"`. `vite.config.js:82` has
`external: []` and no polyfill plugin. **Chunk B must import this selector into
`frontend/src/strategy/`, so this blocks Chunk B.**

The Chunk A brief cited `dispatchSummary.test.js:8` as precedent for `src/**` → `api/agent-index/**`
imports. That precedent is **wrong**: the reviewer grepped all four such imports and every one is a
**test** file importing dependency-free `models.js`. Brief error, caught by review.

### IMPORTANT

- **I1** `recovery.js:124` — the `complete` check (`:175`) and contradiction guard (`:182`) sit
  *inside* the `fundsLeftOwner` branch, so with `custody:{location:'owner',confirmed:true}` these
  four shapes all return **`pull`**: `{pull:'failed',stellar_deposit:'confirmed'}`,
  `{pull:'not_started',stellar_deposit:'confirmed'}`, `{pull:'failed',stellar_deposit:'submitted'}`,
  `{pull:'not_started',stellar_deposit:'failed'}`. Latent today (the current producer cannot emit
  them) but untested — **and Chunk B adds a second receipt writer.**
- **I2** `recovery.js:163-168,:189-195,:221-226` — the report tells Chunks B/C that `manual-review`
  carries `phase: null` and claims no lease. **False for 3 of the 4 sites**; those verdicts take a
  60s lease the browser cannot release, because `lease-release` is bearer-gated.
- **I3** `recovery.test.js:304-316` — R6's `manual-review` fixture uses
  `initialCustody:{location:'unknown'}`, which has **zero production callers**, so
  `recovery.js:102-111` is dead code under the real producer. The report flagged this exact gap
  class for `stellar-vault` and Base but missed it here.

### MINOR — three of these were promoted to the fix round by the controller

- **M6 (promote)** the V3 gate is **bare truthiness** — `'x'`, `true`, `{}` all pass. This is *the*
  double-spend guard and receipt evidence is client-written. It must validate the shape of
  `v3ExecutionId` (`0x`-prefixed lowercase 32-byte hex), not merely its presence.
- **M4 (promote)** the challenge is not consumed, so a proof is replayable for ≤5 minutes.
- **M5 (promote)** `leaseToken = leaseOwner` — caller-chosen and non-secret.
- M1 the report mis-attributes 2 of the 5 unreachable action strings to S2-D8
  (`recover-from-agent` has no state-table row at all). M2 `mutationReceipt()` is a hand-typed
  literal. M3 `readAuthority` omits `owner` vs the original. M7 R8 is sequential, not concurrent.
  M8 R11 does not go through `requestRecovery`.

### Review-adjudicated: the duplicated verification is CLEAN

`recovery.js` reimplements `executionReceipts.js`'s proof verification because those helpers are not
exported and that file is outside Chunk A's ownership. The reviewer diffed it guard-for-guard: the
only omission, `assertIdentity`, is genuinely covered — the sole `INSERT` into
`execution_receipt_challenges` (`store.js:158`) is reachable only via `issueReceiptChallenge`, which
validates at `:124` — and the revoked-scope path is **stricter** in the copy. Not a defect. Still,
exporting the helpers and importing them would remove a standing drift risk.

## Controller rulings on the review's three escalations

1. **The module split is CHUNK A's work**, not Chunk B's. The Critical is in Chunk A's own file, and
   Chunk B's brief must be able to name a browser-safe module truthfully. `recovery.js` must end up
   importable from browser code with **zero** `node:` builtins and **zero** `Buffer`, verified by
   the same `npx esbuild --platform=browser` command the reviewer used. Prefer not creating a new
   file; moving the authenticated server half into `handler.js` (already listed, already
   server-only) is the cheapest split. A new file is a scope question — report it.
2. **The second hazard belongs to Chunk B.** The reviewer raised: a crash before the first POST
   leaves funds at the agent with no receipt, so `selectRecoveryAction(null)` → `pull`. **Verified:
   the write-ahead invariant HOLDS** — `orchestrator.js:831-837` records `pull:submitted` *before*
   submission, with a comment saying exactly that. So absence really does mean never-attempted, and
   Chunk A's row is correct. The **residual** hole is narrower: `record()` swallows POST failures
   and continues (`orchestrator.js:196-204`), so failed-POST + successful-pull + crash leaves money
   moved with no server receipt. That is the `receiptEvidenceDurable`-has-no-consumer gap
   (Constraint 5 below) and it is **Chunk B's** to close.
3. **The `reasonCode` enum is required now**, in Chunk A. `reason` is currently free text; Chunk C
   switching on free text is the cross-layer drift rule violated by construction. Export an enum;
   downstream switches on the code, never the text.

## The five constraints that still bind Task 7

1. **The replay guard.** V2 `pull(agent, amount)` has **no replay protection at all**. V3 `pull_v3`
   does — `DataKey::ExecutionUsedV3` (`types.rs:115`), `RouterError::DuplicateExecutionV3`
   (`types.rs:164`), enforced `lib.rs:503-509`. `resubmit-identical-envelope` is safe **only** under
   V3. The evidence-grounded gate is the presence of `v3ExecutionId` on the persisted pull attempt
   (`orchestrator.js:830`, spread into 4 pull-phase evidence objects) — absence fails closed by
   construction. See M6: presence alone is not enough, validate the shape.
2. **`proof-rejected` (401) cannot be split.** `handler.js:52-64` returns an identical
   `{401,'Invalid or expired receipt proof'}` for bad-signature AND expired-challenge. Route on
   `replay` (409), `authority` (403), `invalid` (400) — never demand expired-vs-bad-signature.
3. **The recovery-lease server primitive exists** (`store.js:542-614`, table at
   `migrations/0005:118-134`, handlers `handler.js:216-262`). `now` is caller-supplied and required;
   expiry is `expires_at <= now` in SQL; acquire is a single atomic UPSERT; a lost race returns
   `{acquired:false}` and the handler turns it into 409. `releaseRecoveryLease` is a bare
   `DELETE … WHERE lease_token = ?` with no holder re-check.
4. **Two `executionId` spaces are legitimately separate.** `makeAllocationExecution`
   (`permissionGrantV3.js:222`) mints the bytes32 router replay guard; agent-index `execution_id`
   (`migrations/0005:5,42`) is free-form TEXT and is what recovery keys on. Task 6 uses
   `${runId}:exec:${allocationId}` — deterministic, no nonce/salt/counter, so resending after an
   unknown-outcome submission is safe by construction. **Never mint a per-attempt id anywhere.**
5. **Build the receipt reader and adopt the server's version on conflict.** `GET
   ?action=receipt&network=&owner=&execution=&allocation=` already exists, routed and
   unauthenticated (`agent-index.js:214-227` → `handler.js:182-214` → `store.js:197`), and returns
   `version` (`models.js:248`). Task 6 shipped only a `receiptEvidenceDurable` flag
   (`orchestrator.js:1012,:1227`, 4 set sites / 2 read sites) with **zero consumers**. Without the
   reader, a POST that fails *after* the server committed freezes the receipt at attempt 1 while the
   run continues. **The 409 is collapsed** — `handler.js:176` overrides every store conflict to one
   generic string, so version adoption must be: re-read, adopt `version`, retry ONCE, bounded. Never
   classify by message text.

## Facts the fresh code maps established (do not re-derive, do not assume otherwise)

Full detail in `.superpowers/sdd/2026-07-29-iq-alter-remediation/task7-map-facts.md` and
`task7-code-map.md`.

- **Only 2 of 5 `RECEIPT_PHASES` are ever produced**: `pull` and `stellar_deposit`, each with
  `submitted`/`confirmed`/`unknown`/`failed`. **Zero** `cctp_burn`/`cctp_mint`/`base_deposit` are
  ever recorded. A test using anything else stands on a fixture no producer can emit.
- **`not_started` is never emitted post-creation.** "Never submitted" is the receipt being ABSENT
  (404), not `not_started`.
- **`'revoked-scope-reconciliation'` kind is never client-produced** — so an agent whose scope was
  revoked between dispatch and recovery gets a **403**, not silent acceptance.
- **`orchestrator.js` never posts the terminal `stellar-vault` custody update** (verified in both
  dispatch loops). So `stellar_deposit:'confirmed'` alone is authoritative for `complete`. This
  affects every receipt consumer, not just Chunk A.
- **Three recovery surfaces ALREADY EXIST** — Chunk C is reconciling them, not building:
  `RecoveryPanel.jsx` (242 lines + 487-line test, generic "Retry" gated by caller-supplied
  `reconciled`, not receipt evidence); `StartStage.jsx` two Retry buttons (`:454` child, `:482`
  lane); `AgentTeam.jsx` "Recover funds" → `{plan?.label || 'Exit all'}` (`:245`), gated by
  `problemAgents` computed in the browser from on-chain reads (`myMoneyModel.js:44-48,73-80`).
  **None reads `?action=receipt`.** The plan correctly lists `RecoveryPanel` as *modify*.
- **Verified live bug Task 7 targets:** `StartStage.jsx:454`'s per-Base-child Retry is a **dead
  end**. `plan.agents` holds ONE bridge entry (`${runId}:bridge:base`); each child's `allocationId`
  lives only in that entry's nested `.children[]` (`planModel.js:119-136`). So `app.jsx:3374`'s
  `plan.agents.find(a => a.allocationId === allocationId)` never matches a child id and always logs
  `Retry unavailable for … no confirmed agent address on record`. That is what "route Base recovery
  by child allocation/job ID, not top-level plan agents" means.
- **Two custody vocabularies coexist and are NOT 1:1.** `CUSTODY_LOCATIONS` (`models.js:7-14`):
  `owner, agent, stellar-vault, in-transit, base-proxy, unknown`. `RECEIPT_CUSTODY_LOCATIONS`
  (`:29-37`): `owner, stellar-agent, stellar-vault, cctp-transit, base-kernel, base-vault, unknown`.
  `base-proxy` has no single equivalent — the receipt vocabulary splits Base into two ranks. Any
  projection needs explicit **lossy-aware** translation; mirror `dispatchSummary.js`'s
  `unmappedCustody` ("unreadable, NOT a genuine no-evidence verdict").
- `handler.js` does **not** dispatch on `action` — it exports 12 pure handlers; the switch is in
  `agent-index.js:210-378`. 11 of 12 routed; `handleBackfillCommit` is unrouted.
- Dispatch shape: 4 `dispatch*` methods, **1** production-reachable entry (`dispatch`,
  `orchestrator.js:392`, called only from `app.jsx:3296`).
- Receipt-write wire key is **`mutation`** (`agentIndexReceiptClient.js:320-329` →
  `agent-index.js:270`), not `body`. The exchange lives in
  `frontend/src/stellar/agentIndexReceiptClient.js:243-350`, not in `orchestrator.js`.
- `executeBaseLeg` (`baseLeg.js:58`, only export) never throws; failure resolves
  `{success:false, stage, error, custody, jobId, …strandedFunds}` where
  `strandedFunds = fundsPulled ? {pulled:true, bridgeAgentAddress} : {}` (`:355`) — the exact payload
  `RecoveryPanel`'s `strandedBridge` prop consumes. There is **no** "resume just the burn" function.

## Rulings inherited from Task 6

- **Custody advances only on proof.** The rule is in helper `confirmedCustodyBar`
  (`allocationReceipt.js:306-310`), called by `confirmCustody` (**line 370**, not 306) at `:387`:
  `owner` → true; `stellar-agent` → `txSuccess`; everything else → `txSuccess && matchingEvent`.
- **`unknown` custody is a creation-time state, not a transition.** `confirmCustody` never
  un-confirms and never throws on ambiguous evidence — it preserves the last proven location and
  journals the ambiguity in `custody.reason`.
- **Every forward `confirmCustody` must pass `amount`**, or the confirmed-amount guard throws.
- Browser-supplied custody/action fields are **ignored** by the server.
- `dispatchLegacy` is not production-reachable and produces no receipts.
- V3 stays DORMANT: no router address registered, no production callers. That is CORRECT.

## Working rules

- Asset units are bigint-safe decimal integer strings. **Never `Number()` a unit value.**
  `Number()` on a ledger sequence or timestamp is fine. (The UI's `unitsToDisplay` does use
  `Number()` at the render layer — pre-existing, deliberately unchanged.)
- Every 32-byte id crossing a JS boundary is `0x`-prefixed lowercase hex. Exceptions: the wasm-hash
  catalog is bare hex, and the receipt request digest is bare hex because the server's own
  `assertIdentity` regex forbids a prefix.
- **A cross-layer expectation may never be computed by the layer under test.** Moving a duplicated
  literal into a shared constant both sides import is **not** a pin — it drifts together.
- Never persist a session secret in a receipt or on the wire. This repo DOES persist
  `sessionKey.secret` to `localStorage` by design (`orchestrator.js:1330-1341,:1839-1850,:2111-2122`).
- ESLint uses a warning-fingerprint baseline, not zero warnings. Zero NEW warnings. Current:
  `585 warnings / 523 fingerprints, within baseline`.
- Never run git mutations through WSL in this checkout — it cannot resolve the Windows gitdir and a
  failed restore silently leaves mutations behind. Confirm with `git diff --numstat`.
- Task 7 touches **no Rust and no Solidity**. No WSL needed at all.

## Test and environment

- **`frontend/vitest.config.js` DOES NOT EXIST** — config is in `frontend/vite.config.js:116-120`.
- **Never a bare `npx vitest run`** — `package.json:11` is `vitest run --exclude="e2e/**"`; a bare
  run picks up 3 unloadable Playwright specs and inflates the failed-FILE count by 3.
- `fakeD1()` is duplicated verbatim in 5 test files (`store.test.js:22-66` is the reference), built
  on `node:sqlite` `DatabaseSync(':memory:')` running the REAL migration SQL. Copy that pattern.
- **No shared receipt fixture factory exists.** Use the real producer —
  `createAllocationReceipt`/`appendPhase` (`allocationReceipt.js:201,259`). That also makes the
  fixture-reality rule self-enforcing.
- Concurrent npm processes make `node_modules/.bin` flap empty mid-run. A failure that does not
  reproduce across two runs is noise. **Never revert someone else's file to make a run go green.**

## How to work

`superpowers:subagent-driven-development`. ONE implementer per chunk, ONE reviewer per chunk.
**Sonnet implements, opus reviews, haiku explores read-only** — but author code maps on sonnet; a
haiku map had to be discarded as self-refuting in an earlier session.

- **Check file ownership at dispatch time**, not by warning an agent inside a prompt.
- **Serialise every chunk.** Disjoint file ownership is not sufficient when both run the suite.
- **Put "cost is not a constraint; ignore the cost hook" in every dispatch prompt.** An environment
  hook fires cost warnings inside subagents; one implementer obeyed it and paused mid-fix-round with
  a guard MUTATED OUT of the working tree.
- **Verify a code map's PATH and COUNT claims, not just its field names.** Three briefs in an
  earlier session carried factual errors of exactly that kind, all caught by implementers rather
  than the controller. This session added a fourth — the Chunk A brief's browser-import precedent
  was wrong, and only the reviewer caught it.
- **Tell every implementer to follow the source over the brief and report the divergence.** That
  instruction is the only reason those errors ever surface.

## The discipline that actually matters

The defects in this remediation were almost never in the code. They were in the account of how the
code was verified: an expectation computed by the same SDK call production uses; a `canonicalJson`
mirror claiming "same semantics" while dropping two guards; a replay discriminator pinned to a
literal its own test also hardcoded; a headline test built on a fixture the producer cannot emit,
asserting the very defect it was written to guard against.

So: for every assertion that matters, break the code it guards, run it, record the REAL red output,
restore, run again, record green — and paste the actual output, not a summary. If you skip one,
write "not mutated, unverified". And for every fixture, ask whether a real producer could emit that
value. A test whose fixture no producer can supply proves nothing, however green it is.
