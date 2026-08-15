# IQ Alter Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close F-01 through F-11 by making account ownership, delegated spending, execution evidence, Base association, money amounts, and release evidence deterministic and fail closed.

**Architecture:** The browser carries a wallet-account epoch and a session-key proof; the router enforces a V3 bounded reusable grant and V4 agent ABI; D1 holds authenticated execution receipts and Base child intents; the relayer persists post-burn reporting in SQLite; and all Base valuation and mandate status are evidence-bearing reads.

**Tech Stack:** React/Vite/Vitest, Cloudflare Pages Functions/D1, Soroban Rust, Stellar SDK/XDR, Node/SQLite, viem/ZeroDev, GitHub Actions.

## Global Constraints

- Current deployed `funding_router` is V2. New entry points and contract package are V3; newly deployed agent accounts are ABI generation V4. Never overwrite or reinterpret V2 receipts.
- The Protect ceiling defaults to exactly `plannedUnitsNow`. Raising it is an explicit user action; no implicit buffer, rounding, or reuse-derived increase is allowed.
- The only reusable expiry choices are 24 hours and 7 days. Each selection serializes an explicit absolute `liveUntilLedger` from a fresh ledger read; there is no indefinite option.
- Browser execution-receipt writes authenticate with a session-key challenge proof. Do not put owner secrets, wallet signatures, or relay secrets in browser storage.
- D1 migrations are, in this order, `frontend/migrations/0005_execution_receipts.sql` and `frontend/migrations/0006_base_child_intents.sql`. Do not create competing migration names or duplicate tables.
- Base lifecycle delivery uses the existing relayer SQLite database as an outbox; do not introduce Cloudflare Queues in this remediation.
- Base status must use `prepareUserOperation({ callData })` and verify the installed Kernel `permissionConfig`; simulation alone is not mandate evidence.
- ERC-4626 `balanceOf` and `convertToAssets` reads for a position use one common block tag. Missing Base data makes Base and overall coverage partial while retaining a known Stellar subtotal.
- Deployment JSON is canonical tracked configuration. `deployments/base-sepolia.json` contains only generic `baseMandatePolicy` facts: chain ID, Kernel `0.3.1` implementation, EntryPoint `0.7`, CallPolicy `0.0.4`, timestamp-policy and ECDSA-signer contracts, allowed targets/selectors/call type/native value, and the execution-safety horizon. User-specific kernel, session signer, permission ID, policy digest, binding digest, and expiry come from the stored mandate and live reads; they are never global deployment facts. Environment values may only select matching immutable facts outside development.
- A direct legacy exit is permitted only when that exact pinned WASM hash has a proven `scope_of` owner ABI. Otherwise deny it; an exit-router path needs its own owner-to-self proof.
- Local Soroban build, test, and clippy commands run through `wsl -e bash -lc` only. CI runs pinned Ubuntu tooling: Rust 1.82.0 and `stellar-cli` 26.1.0.
- ESLint CI enforces a warning-fingerprint baseline, not zero warnings. Do not retain `continue-on-error` for a required quality check.
- Keep changes scoped to the named files; do not stage, deploy, migrate shared environments, rotate secrets, publish contracts, or change live deployment JSON values without the separate-authority checklist.

## Dependency table

| Tasks | Produces | Required by |
| --- | --- | --- |
| 1 | authoritative account epoch | 5–10 |
| 2 | canonical config plus hardened legacy exit policy | 8–10 |
| 3 | authenticated receipt and Base-child repositories | 6–8 |
| 4 | Router V3, agent V4, and owner-to-self contract invariant | 5–7 |
| 5 | stable permission scope and reviewed reusable ceiling | 6–7 |
| 6 | producer-to-render allocation evidence | 7–10 |
| 7 | phase-aware recovery command/UI | 13 |
| 8 | durable Base intent and lifecycle outbox | 9–10 |
| 9 | live exact-call Base mandate evidence | 10, 13 |
| 10 | all-child, unique-position money projection | 13 |
| 11 | exact asset-unit parsing and partial withdrawal | 13 |
| 12 | enforced CI evidence | 14 |
| 13 | cross-layer regression verification | 14 |

### Task 1: Make the active wallet account an epoch-bound capability

**Files:** create `frontend/src/stellar/activeAccount.{js,test.js}` and `frontend/src/app.activeAccount.test.jsx`; modify `frontend/src/stellar/{walletKit,walletKit.test,walletKitLoader,vfWalletModule,vfWalletModule.test,ownerAuthorization,ownerAuthorization.test}.js`, `frontend/src/{app.jsx,orchestrator.js,orchestrator.test.js,orchestrator.baseleg.test.js,baseLeg.js,baseLeg.test.js}`, `frontend/src/components/WithdrawModal.jsx`, `frontend/src/components/console/{OpsConsole,OpsConsole.test,PositionsZone,PositionsZone.test}.jsx`, `frontend/src/agents/{agentController,agentController.test}.js`, and `frontend/src/stellar/{grant,grant.test,exit,exit.test,revoke,revoke.test,partialWithdraw,partialWithdraw.test}.js`.

**Interface:** `classifyActiveAccount({ address, networkPassphrase, connectorId, epoch })` validates with the Stellar SDK and returns immutable `{version:1,kind:'G'|'C',address,networkPassphrase,connectorId,epoch}`. `assertCurrentActiveAccount({captured,current})` throws `ACTIVE_ACCOUNT_CHANGED`; `connectActiveAccount` returns the complete record. `signReviewedTransaction({xdr,activeAccount,reviewedTxHash})` passes expected address/network to the connector, verifies the returned signer/network, and proves the signed envelope body still hashes to `reviewedTxHash` before returning signed XDR. C is an authorizer only; it is never a classic transaction source.

- [ ] **RED:** Test SDK-valid/invalid G and C addresses; G full-sign, G sponsored auth-entry, and C sponsored auth-entry; signer/network/body mismatch; a connector without reliable events; and G→C, C→G, C1→C2, network, connector, and disconnect transitions during build/review/sign/submit. Assert no C source or stale transaction is submitted and no old-owner grant/receipt/Base/My Money state renders after the switch.
- [ ] Run `cd frontend && npm test -- --run src/stellar/activeAccount.test.js src/app.activeAccount.test.jsx`; expected: failing imports/changed-account assertions.
- [ ] **GREEN:** Subscribe to kit state changes, increment the epoch, abort in-flight requests, reject queued approvals, and atomically clear plan review, prepared XDR/auth, permission proof, receipt/journal, Base binding, and money reads before installing the next account. Capture and compare the record at every async completion and pre-sign/pre-submit boundary; derive address only for display and pass the unchanged record through grant, orchestrator, sweep, revoke, partial exit, My Money, and Base binding.
- [ ] Re-run the RED command; expected: all tests pass.
- [ ] Commit exactly the files listed in Task 1 (including their named tests), and no other paths: `fix(frontend): bind owner actions to active wallet account`.

### Task 2: Centralize immutable deployment facts and safe legacy capabilities

**Files:** create `relayer/src/deploymentFacts.mjs`, `frontend/api/agentCapabilities.js`, `frontend/api/stellar-relay-auth.{js,test.js}`; modify `relayer/src/{config,server,httpRouter}.mjs`, `relayer/test/{config,serverConfig,httpRouter}.test.mjs`, `relayer/.dev.vars.example`, `deployments/base-sepolia.json`, `frontend/api/stellar-relay.{js,test.js}`, `frontend/src/stellar/{exit,exit.test}.js`, and `frontend/extension/{txSummary,txSummary.test,approvalView,approvalView.test}.js`.

**Interfaces:** `loadDeploymentFacts()` validates the two tracked deployment JSON files. `loadConfig(env)` returns immutable canonical facts, `publicOrigin`, reporter URL/schema, boolean secret presence, and readiness without serializing secrets. Add generic `baseMandatePolicy` facts only: chain `84532`; Kernel `0.3.1` implementation `0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D`; EntryPoint `0.7` at `0x0000000071727De22E5E9d8BAf0edAc6f37da032`; CallPolicy `0.0.4` at `0x9a52283276A0ec8740DF50bF01B28A80D880eaf2`; TimestampPolicy `0xB9f8f524bE6EcD8C945b1b87f9ae5C192FdCE20F`; ECDSA signer `0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF`; tracked Base USDC/YieldRouter targets; approve/deposit selectors; non-delegate call and zero native value; and `executionHorizonSeconds:2700` (25-minute Iris poll + up to three 2-minute serial UserOps + buffer). User-specific kernel/session/permission/binding values remain in the stored mandate. `AGENT_WASM_CAPABILITIES` maps a pinned hash to `{generation,scopeOfOwnerAbi,allowedRelayOps}`; an unproven hash has no direct-withdraw capability. `assertOwnerWithdrawAuthorization` parses real XDR/auth and validates the stored on-chain owner/scope.

- [ ] **RED:** Test production rejects missing config, HTTP, URL credentials/path/query/fragment, JSON/env disagreement, and missing generic policy facts. Real-XDR fixtures reject wrong network/root/agent/signer/token/vault/recipient, source override, extra operation/auth/sibling invocation, expired auth, and an unknown or unproven legacy hash. Valid G full-sign, G sponsored, and C sponsored owner-to-self fixtures remain accepted.
- [ ] Run `cd relayer && npm test -- --run test/config.test.mjs test/serverConfig.test.mjs test/httpRouter.test.mjs` and `cd frontend && npm test -- --run api/stellar-relay-auth.test.js api/stellar-relay.test.js src/stellar/exit.test.js`; expected: failures for unvalidated sources and unsafe exits.
- [ ] **GREEN:** Canonicalize origins with `URL.origin`, require HTTPS in staging/production, restrict development overrides to validated values and production overrides to equality with tracked facts, and expose only non-secret readiness/digests. Make the relay decode canonical XDR/auth, read `scope_of` only for hashes whose ABI is proven, require recipient/auth/source owner equality and expected token/vault, run enforcing simulation after signatures, then fee-bump. Ordinary exit derives `to` from owner; approval UI shows full owner/network/function/token/recipient and all-funds consequence and binds consent to the exact post-simulation body/auth digest.
- [ ] Re-run both commands; expected: all pass.
- [ ] Commit exactly these files: `fix(relayer): derive runtime configuration from deployment facts`; then commit the frontend files: `fix(relay): deny unproven legacy direct exits`.

### Task 3: Add authenticated receipt and Base-child D1 repositories

**Files:** create `frontend/migrations/0005_execution_receipts.sql`, `frontend/migrations/0006_base_child_intents.sql`, and `frontend/api/agent-index.test.js`; modify `frontend/api/agent-index.js`, `frontend/api/agent-index/{models,store,handler,associations}.{js,test.js}`, and create/modify `frontend/api/agent-index/executionReceipts.{js,test.js}`.

**Interfaces:** D1 migration `0005` stores a current `AllocationReceiptV2` projection keyed by `(network_id,execution_id,allocation_id)`, append-only phase attempts keyed by `attempt_id`, single-use challenges, and recovery leases keyed by execution/allocation/child/phase. Each receipt contains `executionId`, `runId`, `allocationId`, optional `parentAllocationId`/`childId`, worker/agent, exact intent, phases (`pull|stellar_deposit|cctp_burn|cctp_mint|base_deposit` with `not_started|submitted|confirmed|failed|unknown`), and custody (`owner|stellar-agent|stellar-vault|cctp-transit|base-kernel|base-vault|unknown`, confirmation, exact units or null, reason). Migration `0006` adds immutable Base child intent identity `(network_id,binding_id,allocation_id,child_id)`, digest and monotonic lifecycle sequence. Money is TEXT; evidence is append-only and receipt versions use compare-and-swap.

Challenge issuance validates network/owner/address syntax plus router `owner_of(agent)`, `scope_of().owner`, and `signer()`. The browser signs `vf-agent-index/receipt-proof/v1|network|owner|agent|challengeId|expiresAt|requestDigest` with the existing agent session key. The write route recomputes the body digest, re-reads owner/scope/signer, verifies ed25519, atomically consumes the challenge, and applies the CAS update. The browser never receives server secrets; its local account epoch is checked client-side but is not server authority.

- [ ] **RED:** Migration/repository tests cover exact-owner/network filtering, immutable intent conflicts, monotonic receipt versions, confirmed evidence that cannot be erased, no secret-like fields, expired/replayed/altered-body/wrong-signer challenge proofs for G- and C-owned agents, revoked-scope reconciliation proof, lease contention, and two children sharing a binding without sharing an idempotency key.
- [ ] Run `cd frontend && npm test -- --run api/agent-index/executionReceipts.test.js api/agent-index/associations.test.js api/agent-index/handler.test.js`; expected: failures until tables and atomic verification exist.
- [ ] **GREEN:** Load migrations `0002` through `0006` in numeric order in store tests. Create intent and first attempt atomically; update the projection and append evidence under one expected-version transaction/batch; make exact duplicates idempotent and immutable conflicts explicit. Challenge consumption and receipt mutation are atomic and reject secret/private/session-key properties before serialization.
- [ ] Re-run the RED command; expected: all pass and migrations apply to a fresh local D1 database in order.
- [ ] Commit exactly `frontend/migrations/0005_execution_receipts.sql frontend/migrations/0006_base_child_intents.sql frontend/api/agent-index/models.js frontend/api/agent-index/store.js frontend/api/agent-index/handler.js frontend/api/agent-index/associations.js frontend/api/agent-index/executionReceipts.js` and associated tests: `feat(agent-index): persist authenticated execution and child intent evidence`.

### Task 4: Enforce owner-to-self exit and implement bounded Router V3 / agent-account V4

**Files:** modify `soroban/contracts/funding_router/src/{lib.rs,types.rs,test.rs}`, `soroban/contracts/funding_router/Cargo.toml` only if tests require it, `soroban/contracts/agent_account/src/{lib.rs,account.rs,types.rs,test.rs}`, `soroban/contracts/agent_account/Cargo.toml` only if tests require it, `scripts/soroban/deploy-seed.sh`, `frontend/src/stellar/{routerSchema,routerSchema.test,agentCreatorManifest,agentCreatorManifest.test,routerEvents,routerEvents.test}.js`, `frontend/api/stellar-relay.{js,test.js}`, and the schema/history notes in `deployments/stellar-testnet.json` only. Do not insert undeployed addresses/hashes or replace live values.

**Interfaces:** Keep the ordinary agent ABI compatible but make `owner_withdraw(to)` reject `to != stored_owner` before revoked-state, allowance, share, balance, or external-call mutation. Router V3 adds `PermissionGrantV3 {permission_id,scope_id,owner,token,mandate_ceiling,confirmed_spent,per_run_max,live_until_ledger,revoked}` plus immutable agent linkage and replay storage. It exposes `grant_v3(...)`, `pull_v3(permission_id,execution_id,agent,amount)`, `permission_grant(permission_id)`, and an exact remaining-budget view. Agent V4 scope retains the period/cumulative cap and adds `per_execution_max`; its auth rejects one execution above that cap. Every pull verifies unique execution ID, linked agent, exact immutable scope, per-run/cumulative headroom, expiry/revoke, then updates spend and calls SEP-41 `transfer_from` in the same invocation so failure rolls back both.

- [ ] **RED:** First prove an otherwise-owner-authorized foreign `owner_withdraw` leaves shares, balances, revoked state, and allowance unchanged. Then prove V2 methods remain untouched/fresh-only; V3 rejects zero/negative amounts, ceiling below planned, expired ledger, wrong agent/scope/token/target, per-execution and cumulative overflow, revoke, and duplicate `execution_id`; concurrent pulls cannot overspend and a failed token transfer does not advance spend.
- [ ] Run only through WSL: `wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test"`; expected: new V3/V4 authorization tests fail.
- [ ] **GREEN:** Place the recipient check immediately after loading stored owner and before any mutation/external call. Add separate V3 storage keys/events, stable permission-to-agent links and V4 ABI/version constants; deterministically split the reviewed cumulative ceiling across V4 agent scopes without aggregate rounding above the total. Preserve old event decoders/discovery, mark V1–V3 agents fresh-only for reuse, and make every new auth check fail closed.
- [ ] Re-run the WSL test command plus `wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && stellar contract build && cargo clippy --all-targets -- -D warnings"`; expected: build, tests, and clippy pass.
- [ ] Commit exactly the listed Soroban manifests/contracts/scripts: `feat(soroban): add bounded router v3 and agent account v4`.

### Task 5: Require a reviewed V3 Protect grant before execution

**Files:** create `frontend/src/strategy/permissionGrantV3.{js,test.js}`; modify `frontend/src/strategy/{reusePreflight,reusePreflight.test,flowState,flowState.test}.js`, `frontend/src/stellar/{grant,grant.test,grantReceiptStore,grantReceiptStore.test,allowanceProof,allowanceProof.test}.js`, `frontend/src/{app.jsx,orchestrator.js,orchestrator.router.test.js}`, and `frontend/src/components/strategy/{ProtectStage,ProtectStage.test}.jsx`.

**Interfaces:** `buildReusableApproval({plannedUnitsNow,mandateCeilingUnits=plannedUnitsNow,currentLedger,durationSeconds,secondsPerLedger})` validates decimal integer strings, takes only the existing explicit 24h/7d selection, and serializes one absolute `liveUntilLedger`; it is never recomputed after review. `buildScopeId` hashes immutable network/owner/token/router/agent/code/signer/target allowlist/per-run and cumulative caps/policy version but excludes `runId`, timestamps, and allocation IDs. `makeAllocationExecution({runId,allocationId,scopeId,amountUnits})` creates a unique execution. `proveReusablePermission` reads the Router V3 grant/remaining view, SEP-41 allowance, agent signer/code/scope/target/token/caps, credential availability, and gap-free event/version proof; any Base child forces fresh.

- [ ] **RED:** Test default ceiling is byte-for-byte `plannedUnitsNow` and therefore leaves no repeat headroom after spend; only an explicit user edit can raise it. Test lower/inexact ceiling rejection, fresh-ledger conversion for both 24h/7d and no third option, stable same-scope/different-run reuse, unique execution IDs, exact allowance/spend progression, stale account, revoke/zero/expiry/headroom/event-gap/credential/code/signer/target/token/cap drift, and mandatory fresh mode for Base.
- [ ] Run `cd frontend && npm test -- --run src/strategy/permissionGrantV3.test.js src/strategy/reusePreflight.test.js src/strategy/flowState.test.js src/stellar/grant.test.js src/orchestrator.router.test.js src/components/strategy/ProtectStage.test.jsx`; expected: failures for V2/default/unbounded flows.
- [ ] **GREEN:** Render planned movement, cumulative ceiling, confirmed spend, remaining headroom, absolute ledger expiry, and narrow scope. Require an explicit edit to raise exposure. Carry the exact `scopeId`, permission ID, executions, active account, and reviewed fields into grant/pull; store old receipts as history/fresh-only. Re-read canonical proof immediately before the first pull and never infer reusable headroom from local receipts or bounded RPC history with a gap.
- [ ] Re-run the RED command; expected: all pass.
- [ ] Commit exactly the named frontend files and their tests: `feat(frontend): review explicit router v3 spending bounds`.

### Task 6: Produce and render evidence-carrying allocation receipts

**Files:** create `frontend/src/strategy/allocationReceipt.{js,test.js}` and `frontend/src/stellar/agentIndexReceiptClient.{js,test.js}`; modify `frontend/src/{worker,worker.test,orchestrator,orchestrator.test,orchestrator.baseleg.test}.js`, `frontend/src/stellar/{sessionKey,grant,grant.test,agentDeposit,agentDeposit.test}.js`, `frontend/src/strategy/{dispatchSummary,dispatchSummary.test}.js`, and `frontend/src/components/strategy/{StrategyReceipt,StrategyReceipt.test}.jsx`.

**Interfaces:** `createAllocationReceipt`, `appendPhase`, and `confirmCustody` return a new monotonic `AllocationReceiptV2`; confirmed evidence is never removed. `postReceiptEvidence({activeAccount,agentAddress,sessionKey,body})` performs Task 3's challenge/sign/write exchange without transmitting the secret. Pull and deposit use separate attempts and hashes. Custody is `owner/confirmed` before movement, `stellar-agent/confirmed` only after an exact successful pull, `stellar-vault/confirmed` only after final transaction success plus a matching share/deposit event, and `unknown` with `amountUnits:null` for ambiguous responses, stale `NOT_FOUND`, RPC gaps, or mismatched evidence.

- [ ] **RED:** Start tests at real orchestrator/Worker producers. Cover pre-pull failure; pull success then deposit failure (preserving agent address, pull hash, exact units, and agent custody); `PENDING`, `DUPLICATE`, lost HTTP response, fee bump, wrong vault/amount/share event, RPC/event retention gaps, duplicate event pages, and confirmed pull+share mint. Mixed `Promise.allSettled` output must contain every planned allocation exactly once with successful siblings and separate phase hashes.
- [ ] Run `cd frontend && npm test -- --run src/strategy/allocationReceipt.test.js src/stellar/agentIndexReceiptClient.test.js src/worker.test.js src/orchestrator.test.js src/orchestrator.baseleg.test.js src/strategy/dispatchSummary.test.js src/components/strategy/StrategyReceipt.test.jsx`; expected: failures because current producers collapse evidence to booleans/one hash.
- [ ] **GREEN:** Persist intent before each pull/deposit submission, append submitted/final/failed/unknown evidence by exact hash, and project the complete V2 receipt to UI without reconstructing custody. Never persist a session secret, erase a confirmed phase, convert exact units through `Number`, or label transport acceptance as final custody.
- [ ] Re-run the RED command; expected: all pass.
- [ ] Commit exactly the named files and tests: `feat(execution): preserve allocation custody evidence`.

### Task 7: Add lease-owned recovery and evidence-first UI projection

**Files:** create/modify `frontend/api/agent-index/recovery.{js,test.js}`; modify `frontend/api/agent-index/{handler,store}.{js,test.js}`; create `frontend/src/strategy/{recoveryClient,recoveryClient.test,receiptProjection,receiptProjection.test}.js`; modify `frontend/src/{app.jsx,app.recovery.test.jsx,orchestrator.js,baseLeg.js,baseLeg.test.js}` and `frontend/src/components/{strategy/StartStage.jsx,strategy/StartStage.test.jsx,money/RecoveryPanel.jsx,money/RecoveryPanel.test.jsx}`.

**Interfaces:** `requestRecovery({executionId,allocationId,childId=null,expectedReceiptVersion,leaseOwner})` accepts identity/version only, loads Task 3 evidence under the authenticated network/owner, and atomically claims `(execution,allocation,child,phase)`. `selectRecoveryAction(receipt)` returns only `pull`, `resubmit-identical-envelope`, `deposit`, `poll`, `re-attest`, `submit-same-message`, `base-deposit`, `re-authorize`, `recover-from-agent`, `manual-review`, `blocked-reconcile`, or `complete`. Browser custody/action fields are ignored.

- [ ] **RED:** Test every state-table row: owner/never-submitted permits one pull; uncertain Stellar submit polls or resends the identical still-valid envelope and forbids rebuilding; confirmed agent custody permits deposit and forbids pull; vault confirmation is complete. CCTP burn uncertain never reburns; 404/empty/pending polls; expiry re-attests the same nonce/message; complete attestation submits that same message; used nonce reconciles destination custody. Base-kernel custody permits only Base deposit; uncertain UserOp polls exact UserOp/tx plus vault event; Base vault is complete. Any evidence gap blocks. Also cover two concurrent claims/one movement, expired lease takeover, crash/reload after every phase, child allocation/job routing, stale receipt version, forged browser custody, and missing original credential blocking without a replacement signer.
- [ ] Run `cd frontend && npm test -- --run api/agent-index/recovery.test.js src/strategy/recoveryClient.test.js src/strategy/receiptProjection.test.js src/app.recovery.test.jsx src/components/strategy/StartStage.test.jsx src/components/money/RecoveryPanel.test.jsx src/baseLeg.test.js`; expected: race, routing, and projection failures.
- [ ] **GREEN:** Implement the server selector/lease and a client executor that resolves the original agent address and client-only credential reference. Render action-specific Poll/Deposit/Re-authorize/Recover/Manual review controls; never render generic Retry for unknown evidence. Re-read the receipt after a command or lease conflict and route Base recovery by child allocation/job ID, not top-level plan agents.
- [ ] Re-run the RED command; expected: all pass.
- [ ] Commit exactly named recovery/API/UI files and their tests: `feat(recovery): resume execution from leased receipt evidence`.

### Task 8: Persist Base intent before burn and deliver lifecycle reports through SQLite

**Files:** create `relayer/src/{agentIndexConfig,associationOutbox}.mjs` and `relayer/test/{agentIndexConfig,associationOutbox}.test.mjs`; modify `relayer/src/{sqliteStores,agentIndexReporter,httpRouter,server,config}.mjs`, `relayer/test/{agentIndexReporter,httpRouter,sqliteStores,config}.test.mjs`, `relayer/test/serverConfig.test.mjs`, `frontend/src/{crossChainFarm,crossChainFarm.test}.js`, `frontend/src/base/{relayerClient,relayerClient.test}.js`, `frontend/src/orchestrator.baseleg.test.js`, `frontend/api/agent-index.test.js`, `frontend/api/agent-index/executionReceipts.test.js`, and `frontend/api/agent-index/{handler,associations,store}.{js,test.js}`. The server-config test is a fix-round test-only expansion proving local SQLite and authenticated remote readiness gate worker/listener startup. The other three extra tests are fixture-only scope: the real orchestrator path must acknowledge the new pre-burn `/farm` intent before reaching its existing unknown-burn assertion, while the API integration fixtures must use the exact immutable intent schema and `{acknowledged:true,...}` response. They do not expand production scope.

**Interfaces:** The exact sequence is browser → relayer intent-only `POST /farm` → synchronous authenticated relayer → D1 `commitBaseChildIntent` → validated `201 {acknowledged:true,identity,schemaVersion}` → response to browser → one Stellar burn → `POST /farm/attach` → poll. The browser never calls a D1 write directly and never gets `AGENT_INDEX_REPORTER_SECRET`. `associationOutbox.enqueue`, `leaseNext`, `markDelivered`, `markRetry`, and `markDead` store immutable report/digest, monotonic sequence, `pending|leased|delivered|dead`, attempts, bounded lease/retry, last error, and binding+child idempotency key in existing relayer SQLite.

- [ ] **RED:** Test exact ordering and zero burn/job execution for reporter 401, timeout, malformed acknowledgement, schema mismatch, or D1 failure. Reject a burn hash on the intent-only route; require attach to match the immutable job/binding/hash and make same-hash attach idempotent. Test duplicate/conflicting children, out-of-order lifecycle transitions, reporter non-2xx retention, concurrent lease, finite retry/dead-letter, and restart survival. Production refuses missing `RELAYER_DB_PATH`, reporter URL/secret, canonical origin, or authenticated schema/store readiness.
- [ ] Run `cd frontend && npm test -- --run src/crossChainFarm.test.js api/agent-index/associations.test.js` and `cd relayer && npm test -- --run test/agentIndexReporter.test.mjs test/associationOutbox.test.mjs test/httpRouter.test.mjs`; expected: failures for transient in-memory reporting.
- [ ] **GREEN:** Make intent the only synchronous reporter method and throw on any unacknowledged response. Store the job/context only after durable intent acknowledgement; attach is the only path that starts `runFarmJob`. Enqueue accepted/minted/deposited/held/failed lifecycle rows transactionally, resume a bounded unref'd worker after restart, and expose only non-secret delivery status/attempts. Dead/stale association evidence must remain observable as incomplete coverage.
- [ ] Re-run both commands; expected: all pass.
- [ ] Commit exactly named relayer/frontend/API files and tests: `feat(base): make child association intent durable before burn`.

### Task 9: Verify Base mandates with installed permissions and exact UserOperation preparation

**Files:** create `relayer/src/mandateStatus.mjs`, `relayer/test/mandateStatus.test.mjs`, `frontend/src/base/mandateStatus.{js,test.js}`; modify `relayer/src/{httpRouter,config}.mjs`, `relayer/test/httpRouter.test.mjs`, `frontend/src/base/{relayerClient,relayerClient.test}.js`, `frontend/src/{app.jsx,app.strategy.merge.test.jsx,baseLeg.js,baseLeg.test.js,mergeFlowHelpers.js,mergeFlowHelpers.test.js}`, and `frontend/src/strategy/{baseMandateView,baseMandateView.test}.js`.

**Interface:** `evaluateBaseMandateStatus({record,config,allocation,now=Date.now(),makePublicClient,reconstructSessionClientFn})` returns `BaseMandateStatusV2` (`active|not_yet_valid|expiring|expired|revoked|mismatch|unknown`) with expected, observed, checks, and reason codes. Expected chain/origin/Kernel implementation/EntryPoint/policy contracts/allowed calls/horizon come from Task 2 config; expected owner/kernel/session/permission/policy/binding/expiry come from the exact stored mandate, never the request. It decodes and statically validates policy, reconstructs the permission account, reads the EIP-1967 implementation and `KernelV3_1AccountAbi.permissionConfig(permissionId)`, compares signer and policy data/digest, encodes the actual durable-intent amount/minShares USDC approve + YieldRouter deposit calls, then calls `kernelClient.prepareUserOperation({callData})` without `sendUserOperation`.

- [ ] **RED:** Cover remote revoke/uninstall, not-yet-valid/expired/unsafe margin, owner/kernel/chain/session/permission/policy/binding/origin/implementation mismatch, wildcard/broader call, target/selector/recipient/asset/amount/value/call-type/paymaster mutation, malformed approval, stale block, RPC timeout, and prepare failure. Assert all are non-active/unknown, client-forged expected facts have no effect, and neither preparation nor status sends an operation.
- [ ] Run `cd relayer && npm test -- --run test/mandateStatus.test.mjs test/httpRouter.test.mjs` and `cd frontend && npm test -- --run src/base/mandateStatus.test.js src/base/relayerClient.test.js`; expected: failing mandate evidence tests.
- [ ] **GREEN:** Persist observed block number/hash/time, implementation, permission evidence, and prepared-call digest; return `Cache-Control: no-store` and map all errors/staleness to `unknown`. Fetch before Base catalog/review, immediately before Stellar grant, and immediately before burn. A material status change removes Base and requires plan re-review; a late revoke blocks burn. Add a read-only Base Sepolia smoke proving `prepareUserOperation` does not submit/consume a nonce; do not run that live smoke without separate network credentials/authority, and never fall back to a no-op simulation.
- [ ] Re-run both commands; expected: all pass.
- [ ] Commit exactly named files and tests: `feat(base): verify mandate permission and prepared operation`.

### Task 10: Make My Money aggregate all Base children honestly

**Files:** create `frontend/src/money/baseChildPositions.{js,test.js}`, `frontend/src/base/dashboardPositions.test.js`; modify `frontend/src/money/{readOwnerMoney,readOwnerMoney.test}.js`, `frontend/src/base/dashboardPositions.js`, and My Money renderer/tests that expose coverage.

**Interfaces:** `normalizeBaseChildren(children)` consumes all paginated D1 rows, stable-deduplicates exact child/allocation IDs, reports conflicting immutable duplicates, validates owner binding, and groups by lowercase `chainId:kernel:vault:asset`. `readBasePositions` gets one common block and makes one `balanceOf(kernel)` plus one `convertToAssets(shares)` read at that block per unique nonzero group. Output preserves every child history separately and returns positions, `stellarSubtotalUnits`, known `baseSubtotalUnits`, `completeBaseTotalUnits|null`, `overallTotalUnits|null`, valuation kind, and source/association/value coverage. `associationCoverage` reports complete/partial/unknown with stale/dead-letter/unavailable reasons.

- [ ] **RED:** Use at least three children, two sharing one position and one separate. Cover pagination/reordering, exact duplicate dedupe, immutable conflict, one/all unreadable groups, stale and dead-letter association evidence, same vault with distinct asset, large units, second-device empty browser cache, a successful `balanceOf == 0`, and common block passed to both calls. Assert one shared-position RPC/value inclusion, known Stellar subtotal retained, partial Base known subtotal retained, and complete Base/overall totals null when incomplete; all unavailable is unknown, never zero.
- [ ] Run `cd frontend && npm test -- --run src/money/baseChildPositions.test.js src/money/readOwnerMoney.test.js src/base/dashboardPositions.test.js`; expected: aggregation/coverage failures.
- [ ] **GREEN:** Delete `latestBaseChild` selection, fetch every page, dedupe/group before valuation, and use `convertToAssets` only as a labeled current estimate (never `maxWithdraw`, never per-child yield attribution). Compose source coverage, association delivery coverage, and position-read coverage without allowing local cache/browser hints to upgrade them. Render every child and the affected coverage reason while retaining proven Stellar and Base subtotals.
- [ ] Re-run the RED command; expected: all pass.
- [ ] Commit exactly named files and renderer tests: `fix(money): value every base child at a common block`.

### Task 11: Use exact integer asset units from input through planning

**Files:** create `frontend/src/money/assetUnits.{js,test.js}`; modify `frontend/src/strategy/{amountValidation,amountValidation.test}.js`, `frontend/src/components/money/{WithdrawDialog,WithdrawDialog.test}.jsx`, `frontend/src/money/{ownerActions,ownerActions.test}.js`, and the existing partial-withdraw client tests.

**Interfaces:** `I128_MAX=(1n<<127n)-1n`; `parseAssetUnits(raw,decimals,{availableUnits,maxUnits})` returns `{ok:true,units,canonical}` or `EMPTY|INVALID_FORMAT|ZERO|TOO_PRECISE|EXCEEDS_AVAILABLE|OVERFLOW`; `formatAssetUnits` is canonical non-localized output. Input remains `type="text" inputMode="decimal"` and raw string passes unchanged to the parser.

- [ ] **RED:** Cover one stroop, exact/max i128, exact available balance and one unit above, six- and seven-decimal round trips, leading/trailing zeros, zero, whitespace, signs, exponent, comma, NaN/Infinity, too many decimals, and no `Number`/`parseFloat`/`Math.round` loss from dialog to contract input. Planner rejects amount token or decimals that differ from the selected `stellar-vault` leg before comparing balances.
- [ ] Run `cd frontend && npm test -- --run src/money/assetUnits.test.js src/strategy/amountValidation.test.js src/components/money/WithdrawDialog.test.jsx`; expected: failures where floats are still used.
- [ ] **GREEN:** Use `<input type="text" inputMode="decimal">`, preserve raw input, route selected token decimals and available units through the shared parser, bind planner amount token/decimals to the selected leg, and submit the exact canonical integer string only after successful validation. Formatting uses string/BigInt slicing only.
- [ ] Re-run the RED command; expected: all pass.
- [ ] Commit exactly named money/strategy/dialog files and tests: `fix(money): plan withdrawals with exact asset units`.

### Task 12: Enforce a stable, always-triggered CI release gate

**Files:** create `scripts/ci/{release-gate,release-gate.test}.mjs`; create `frontend/scripts/{eslintWarningBaseline,eslintWarningBaseline.test,check-eslint-warning-baseline}.mjs` and `frontend/scripts/eslint-warning-baseline.json`; modify `.github/workflows/frontend.yml`, `frontend/package.json`, `README.md`, and `GETTING_STARTED.md`.

**Interfaces:** `evaluateReleaseGate(needs)` requires successful `frontend-unit-build`, `relayer`, `keeper`, `soroban`, and `playwright`. The final workflow job uses `if: always()` and parses `${{ toJSON(needs) }}`; deploy needs only `release-gate`. ESLint fingerprints `{relativePath,ruleId,messageId,message}` (no line/column); additions above the checked-in baseline fail, removals pass, and `CI=true` refuses baseline updates.

- [ ] **RED:** Unit-test failed/skipped/cancelled/missing job matrices and warning additions, multiplicity, removals, path normalization, and error handling. Workflow assertions prove `push`, `pull_request`, and `merge_group` are unfiltered; every stable job always reports; no blocking check uses `continue-on-error`; and preview/production deploy cannot bypass the gate.
- [ ] Run `node --test scripts/ci/release-gate.test.mjs` and `cd frontend && npm test -- --run scripts/eslintWarningBaseline.test.mjs`; expected: module-not-found failures until gate/baseline tooling exists.
- [ ] **GREEN:** Add stable `frontend-unit-build`, `relayer`, `keeper`, `soroban`, `playwright`, and `release-gate` jobs. Frontend runs `npm ci`, unit tests, `lint:ci`, format, brand, build, extension build, manifest, and the banned-string scan. Pin Soroban CI to Ubuntu 24.04, `dtolnay/rust-toolchain@1.82.0` with `wasm32v1-none`/clippy, and `cargo install --locked --version 26.1.0 stellar-cli`; verify versions then run `stellar contract build`, `cargo test --locked`, and `cargo clippy --locked --all-targets -- -D warnings`. Playwright installs Chromium/deps, runs `test:visual`, and uploads report/screenshots/traces on failure. `release-gate` has `needs` for all five, `if: always()`, and fails every result other than `success`; deploy needs only it, serializes concurrency without cancellation, runs non-secret readiness before traffic, and production uses a protected environment.
- [ ] Implement the ESLint checker with the installed Node API and location-independent `{relativePath,ruleId,messageId,message}` plus multiplicity. `lint:ci` fails errors or additions; removals pass. `lint:warnings:update` deterministically writes the reviewed baseline, refuses `CI=true`, and is never run in CI. Generate the initial file once and verify its 581-warning/519-fingerprint starting evidence before review.
- [ ] Re-run the two unit commands, then `cd frontend && npm run lint:ci && npm run format:check && npm run brand:check && npm test && npm run build && npm run build:ext && npm run manifest:check`, `cd relayer && npm test`, and `cd keeper && npm test`; expected: all pass under the recorded baseline.
- [ ] Commit exactly workflow, CI scripts, baseline, and package script files: `ci: gate releases on deterministic project checks`.

### Task 13: Run cross-layer regression verification

**Files:** create/modify only directly relevant integration test files under `frontend/src`, `frontend/api/agent-index`, `relayer/test`, and `soroban/contracts`; do not add product code in this task.

- [ ] Add no new behavior here. Confirm the producing tasks already contain real-boundary integration tests for: changed account blocking grant/action; fresh grant → confirmed pull/deposit → distinct-run zero-confirm reuse with true headroom; exact allowance/spend/replay; producer-to-render custody; recovery state table and lease; durable Base intent before burn; no reburn; outbox restart/dead letter; remote mandate revoke before review/grant/burn; all-child second-device reconstruction; and exact dialog-to-contract units. If any case exists only as an idealized pure fixture, return it to the owning task and add the missing producer-boundary test there.
- [ ] Run all focused frontend/API/relayer tests named in Tasks 1–11; expected: PASS. Run the full frontend, relayer, and keeper suites; expected: PASS.
- [ ] Run Soroban through WSL only: `wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test"`; expected: PASS. If WSL is unavailable in the execution environment, record this as unverified evidence and rely on neither native Cargo nor a completion claim.
- [ ] Run `git diff --check` and inspect `git status --short`; expected: no whitespace errors and only exact task paths.
- [ ] Commit only genuinely missing integration test files, if any: `test: cover bounded cross-chain execution evidence`; otherwise record verification without an empty commit.

### Task 14: Perform a release-readiness review without executing release actions

**Files:** modify only tracked setup/operations documentation that is changed by the new environment contracts; no deployment transaction, D1 production migration, secret write, or git publication is included.

- [ ] Verify local frontend commands: `cd frontend && npm run lint:ci && npm test && npm run build`.
- [ ] Verify relayer and keeper: `cd relayer && npm test` and `cd keeper && npm test`.
- [ ] Verify Soroban through WSL only: `wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && stellar contract build && cargo test && cargo clippy --all-targets -- -D warnings"`.
- [ ] Review `git diff --check`, exact commit paths, locked versions, no `ONESHOT_` references, no duplicate D1 migration, no non-V3/V4 terminology in new contracts, and no raw owner/browser secret in receipt code.
- [ ] Commit only documentation changed in this task: `docs: record bounded execution release prerequisites`.

## Separate-authority release checklist

- [ ] Obtain explicit authority to deploy Router V3 and agent-account V4, record their new WASM hashes/addresses, and update canonical deployment JSON in the same reviewed release.
- [ ] Obtain explicit authority to apply D1 migrations `0005` then `0006` to each environment, with a backup and a post-migration schema check.
- [ ] Obtain explicit authority to set `RELAYER_DB_PATH`, reporter credentials, `RELAYER_PUBLIC_ORIGIN`, and deployment-fact values in the target environment; do not source secrets from JSON.
- [ ] Obtain explicit authority to enable the relayer outbox worker and validate retry/dead-letter metrics against a non-production reporter.
- [ ] Obtain explicit authority to publish/push and to enable deployment after the required CI `release-gate` is green.

## Final acceptance commands

```bash
cd frontend && npm run lint:ci && npm test && npm run build
cd relayer && npm test
cd keeper && npm test
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && stellar contract build && cargo test && cargo clippy --all-targets -- -D warnings"
git diff --check
```

Expected result: all commands exit zero; CI reports the fingerprint baseline rather than ignoring warnings; no release action has been performed.
