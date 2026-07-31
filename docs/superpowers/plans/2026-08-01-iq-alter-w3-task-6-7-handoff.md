# IQ Alter Remediation — handoff: W3, the outstanding re-review, then Tasks 6 and 7

Written 2026-08-01, after a session that ended on an API limit. Everything below is standalone —
`.superpowers/` is gitignored (`.gitignore:75`) so the briefs and the run ledger do NOT travel with
this file. What you need from them is inlined.

## Position

Branch `iq-alter`, HEAD `eaaceb7`, working tree clean apart from
`frontend/public/brand/assets.manifest.json` (LF↔CRLF drift on Windows — **never commit it**).

Twelve commits landed this session, on top of `5ca7dfa`:

| commit | what |
| --- | --- |
| `6ecf985` | gate V3 reuse on eligible agent generations |
| `c39f9bf` | **soroban** — expose `linked_permission`, pin cross-layer scope-id vectors |
| `47bdb44` | correct a mis-reported mutation, harden fail-closed edges in the eligibility gate |
| `dfd9a21` | `submitGrantV3` |
| `2e43dc8` | **derive the v3 scope id the way the router does** (the session's main fix) |
| `72357b3` | one `0x`-hex convention for 32-byte ids; fail closed on malformed bridge scope |
| `75e0264` | normalize `permissionId` to hex |
| `10709c7` | correct the gap docblock, distinguish silent scope-drift failures |
| `8598e8d` | `readPermissionGrant` + `readRemainingBudget` |
| `c750b67` | correct the bridge-field coverage claim, preserve error evidence |
| `639aca4` | kill the 32-byte guard blind spot, fix comment scope |
| `eaaceb7` | close the permission-reader guard gaps |

Contracts verified green on this machine with honest exit codes: `stellar contract build` 0,
`cargo test` 0 (14 binaries), `cargo clippy --all-targets -- -D warnings` 0.

> First-time trap on this checkout: `soroban/contracts/rwa_vault/` may hold only a gitignored
> `test_snapshots/` left over from the crate's rename to `autofarm_vault` in `b4a9078`. The
> `members = ["contracts/*"]` glob trips on it and every cargo command dies with "failed to load
> manifest for workspace member". Move the directory aside; it has zero tracked files.

## The two things NOT finished

### 1. The grant.js re-review (small, do it first)

Commits `639aca4` and `eaaceb7` closed review findings on `frontend/src/stellar/grant.js` but their
scoped re-review never ran — its agent died on the API limit. Two different implementers edited the
same file sequentially, so the specific risk is that the second undid something the first
established.

Check at minimum:

- exactly ONE `bytes32ToHexId`-style helper exists, not two;
- `permissionId` is `'0x' + 64 lowercase hex` at every boundary and no `Buffer` leaks out;
- the seam test's load-bearing `mode: 'reuse'` assertion survived (see F-SCOPE below — that single
  assertion is what stands between this repo and a repeat of its worst defect);
- `readRemainingBudget`'s refactor to delegate to `requireI128UnitsString` did not weaken its own
  negative-value rejection or change its error surface;
- each of the four decoded-field guards is INDIVIDUALLY killable — the prior review disabled all
  four at once and the suite stayed green.

### 2. Task W3 — never started

Its agent died before making any edit. Two parts.

**Part A — a live defect in committed code.** `proveReusablePermission`
(`frontend/src/strategy/permissionGrantV3.js`) contains two checks of roughly this shape:

    if (BigInt(row.perRunCapUnits)     !== BigInt(grant.perRunMaxUnits))     ...
    if (BigInt(row.cumulativeCapUnits) !== BigInt(grant.mandateCeilingUnits)) ...

**Neither row field can be sourced from the chain.** Verify it yourself in
`soroban/contracts/funding_router/src/lib.rs` (the agent-deploy loop inside `grant_v3`) and in
`agent_account`'s `AgentScope`: the scope written into every deployed agent carries
`cap_per_period: init.cap` and `per_execution_max: per_agent_max` and nothing else cap-shaped.
`per_run_max` and `mandate_ceiling` live only in `PermissionGrantV3` on the router, and `AgentScope`
has no cumulative aggregate at all. Both checks pass today only because the fixtures invent the
values.

Fix: delete `cumulativeCapUnits` from the row contract; replace the per-run check with the agent's
on-chain `cap_per_period` compared against the REVIEWED `agentInits[i].cap.units`; give it its own
`freshReason` so a cap drift stays diagnosable. If you check `grant.perRunMaxUnits` /
`grant.mandateCeilingUnits` at all, check them against the reviewed approval, never against agent
rows.

**Part B — `inspectAgentsV4`.** The last missing supplier on the V3 read path. Put it in
`frontend/src/stellar/agentCache.js` beside the V2 `inspectReusableAgents` (~line 198), which is the
structural model — it returns a DIFFERENT shape and serves the live V2 path, so do not modify it.

Row contract, every field sourceable:

| field | source |
| --- | --- |
| `agentAddress` | local cache |
| `signerPub` | `readAgentSigner` |
| `target`, `token`, `capPerPeriodUnits`, `perExecutionMaxUnits`, `expiry`, `revoked` | `readAgentScope` (`scope_of()`) |
| `code` | the ROUTER's `config()` pinned wasm hash, NOT read from the agent |

Take the router `config()` read as an INJECTED dependency with no production default, exactly like
`readPermissionGrant`. Do not implement it — that belongs with the deploy work.

Note the format asymmetry on `code`: it feeds `generationForWasmHash`, which compares against
`AGENT_WASM_GENERATIONS[].wasmHash` — bare lowercase hex, no prefix — while the repo rule for
32-byte IDs is `0x`-prefixed. Handle the boundary explicitly.

## Findings that bind Tasks 6 and 7

**F-SCOPE (fixed, but understand it).** The V3 reuse path was non-functional by construction, not
merely dormant: the JS computed a `scopeId` by hashing a JSON blob of eleven fields while the router
derived `scope_id` from `(target, token, kind, mint_recipient, destination_domain)` over XDR bytes
with a domain tag. They could never be equal, so every reuse decision returned `scope-drift`
forever. It survived because `permissionGrantV3.test.js` computed the expected value **with the code
under test** and fed it back as the chain's answer.

The fix mirrors the Rust byte-for-byte and is pinned against vectors generated BY the Rust
(`soroban/contracts/funding_router/src/test.rs`, `scope_id_matches_pinned_cross_layer_vector`):

    target CCQKDIVDUSS2NJ5IVGVKXLFNV2X3BMNSWO2LLNVXXC43VO54XW7L65UW
    token  CCYLDMVTWS23NN5YXG5LXPF5X274BQOCYPCMLRWHZDE4VS6MZXHM6QJS
    kind 0, mintRecipient 32×00, domain 0 → 0x775ad5a5c5f2ec6382447626694b4ca75b25a23d466cfa3fda505596861d3202
    kind 1, mintRecipient 32×cd, domain 6 → 0x94e42b09c513c85d1d60633877efac275f528c3141a42743d7031523f04991d3

**Rule that came out of it, now binding: a cross-layer expectation may never be computed by the
layer under test.** Pin it to a constant produced by the other side.

**F-CAPS.** Described above. Notable because it was introduced BY the fix for F-SCOPE and passed a
clean review — the reviewer was judging against a brief that named fields nobody had checked existed.
A brief that names a field must cite where the field comes from.

**Replay guard — this one directly constrains Task 7.** V2 `pull(agent, amount)` has **no replay
protection at all**: no execution id, no dedup key. Resending an identical pull after an
indeterminate submission moves funds TWICE. V3 `pull_v3` does have it —
`DataKey::ExecutionUsedV3` (`types.rs:115`) and `RouterError::DuplicateExecutionV3` (`types.rs:164`),
enforced at `lib.rs:503-509`.

So Task 7's `resubmit-identical-envelope` recovery action is safe **only under a V3 router**. While
the live router is V2 it must fail closed to `poll` or `manual-review`. Resending there is a
double-spend. This is not optional hardening; it is the difference between recovery and fund loss.

**32-byte id convention.** Every 32-byte id crossing a JS boundary is `0x`-prefixed lowercase hex.
Raw bytes normalize at exactly one place — the point of decode. Known remaining exception:
`frontend/src/stellar/routerEvents.js:58,105` still types them as `Buffer`.

**Nothing is deployed.** Router V3 and agent_account V4 are source-only. The whole V3 path is
dormant by design: `resolveRouterSchema` knows no V3 address, so `proveReusablePermission` returns
`fresh`/`router-not-v3` before any read. Zero production callers on the V3 surface is CORRECT.
Deploying is a separate-authority action (plan Global Constraint 25, checklist item 214) — and note
`funding_router` has no upgrade function, only `__constructor(env, agent_wasm_hash)`, so V3 means a
NEW address and every user re-signing a grant.

## Working rules

- Asset units are bigint-safe decimal integer strings. **Never `Number()` a unit value.** `Number()`
  on a ledger sequence (u32) is fine.
- The live V2 path must be provably unchanged — proven by test, not asserted in a comment.
- ESLint uses a warning-fingerprint baseline (585w/523fp), not zero warnings. Zero NEW warnings.
- `makeAllocationExecution` mints `executionId` DETERMINISTICALLY — no nonce, salt or counter. The
  router records `execution_id` only on a SUCCESSFUL `pull_v3`, so resending the same id after an
  unknown-outcome submission is safe by construction. A minted id would move money twice on exactly
  that retry. Task 7 recovery depends on this.
- The `1h` duration preset in ProtectStage stays. The 24h/7d restriction applies only to REUSABLE
  expiry and is already enforced inside `buildReusableApproval`.
- Never run git mutations through WSL in this checkout — it cannot resolve the Windows gitdir and a
  failed restore silently leaves mutations in the tree. Drive them from Windows and confirm with
  `git diff --numstat`.
- Run cargo/stellar only under `wsl -e bash -lc`. Capture real exit codes — do NOT pipe to `tail`
  and read `$?`, which returns tail's status (this bit us once).

## Test baseline and environment

Use `npm test -- --run` from `frontend/`. **Never a bare `npx vitest run`** — it picks up Playwright
`.spec.js` under `e2e/` and reports phantom failures.

Stable pre-existing failures, all unrelated, do not try to fix:

- 3 brand-asset SHA tests (caused by the `assets.manifest.json` CRLF drift)
- 2 WCAG contrast, 2 CSS
- 2 files that fail to COLLECT entirely with `SyntaxError: Invalid or unexpected token` —
  `scripts/agent-index/backfill-legacy-agents.test.mjs` and `src/wallet/ui/WalletShell.test.jsx`.
  The sources are clean ASCII/LF and the reported error position is past the end of the line, so the
  error is not in the source as written. This costs the suite ~57 tests of real coverage and predates
  this work. **Worth investigating separately** — it is the largest unexplained coverage hole.

The figure "4457 passed" that appears in older handoff notes is **unsourced** — nobody has
reproduced it. Reconcile against the failure list above, not against that number.

Environment noise confirmed independently by three implementers: concurrent npm processes make
`node_modules/.bin` flap empty mid-run, and unrelated component/`baseleg` tests fail in a different
subset each run. A failure that does not reproduce across two runs is noise. Never revert someone
else's file to make a run go green.

## Then Tasks 6 and 7

Take their full text from `docs/superpowers/plans/2026-07-29-iq-alter-remediation.md`. Task 6 needs
Task 5 complete; Task 7 needs Task 6.

Carry the replay-guard constraint into Task 7's brief explicitly. Without it, the recovery selector
will happily hand a V2 router the one action that double-spends on it.

## How to work

`superpowers:subagent-driven-development`. ONE implementer per chunk, then ONE reviewer covering
both spec and quality. Do not fan out reviewers. Sonnet for implementation, opus for review; haiku is
fine for read-only exploration and can fan out.

**Check file ownership at dispatch time, not by warning the agent inside the prompt.** Two
implementers on the same file is not something a written caution prevents — it cost a near-miss this
session where one agent was sent to edit a file another was mid-write on, with uncommitted work at
risk.

Reviewers that need to run tests during concurrent work should use a detached `git worktree` at the
reviewed commit with `node_modules` junctioned, rather than touching the shared checkout.

## The discipline that actually mattered

Across this whole remediation the defects were almost never in the code. Nine tests that could not
fail, five mutation-table rows inaccurate as written, one docblock that took three passes to stop
asserting things its own file contradicted, and one cross-layer comparison that could never be
equal. The implementations were nearly always right; the account of how they were verified was not.

So: for every assertion that matters, break the code it guards, run it, record the REAL red output,
restore, run again, record green — and paste the actual output, not a summary. If you skip one, write
"not mutated, unverified". That is worth more than a tidy claim that does not hold.

And before writing "only X does Y" in a comment, grep for other Ys.
