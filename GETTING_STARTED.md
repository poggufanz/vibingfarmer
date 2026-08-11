# Getting started (developers)

**"Set once. Vibe forever."**\
Indie open-source · AI agent swarm for automated yield farming on **Stellar/Soroban**.

Canonical product claims: [`prd.md`](prd.md). Architecture overview: [`README.md`](./).

***

## 0. What this is (current stack)

| Layer                  | Status                            | Notes                                              |
| ---------------------- | --------------------------------- | -------------------------------------------------- |
| Primary chain          | âœ… Stellar **testnet** / Soroban | Live deposit → autofarm vault → **Blend v2** pool  |
| Gas abstraction        | âœ… Own fee-bump relay            | `/api/stellar-relay` — **not 1Shot**               |
| single-signature grant | âœ… `funding_router`              | Budget + expiry; deploys per-run agents            |
| AI                     | âœ… Venice / DeepSeek / fallback  | BYOK-first; host keys optional                     |
| Cross-chain (optional) | âœ… CCTP v2 + ZeroDev             | Base Sepolia leg via `relayer/` — **not 1Shot**    |
| EVM single-chain path  | âŒ Superseded                    | Old AgentVaultDepositor + 1Shot removed 2026-06-21 |

***

## 1. Prerequisites

* **Node.js** 20+ and npm
* **Stellar wallet** on testnet: [Freighter](https://www.freighter.app), xBull, or Albedo
* **Friendbot** for test XLM: https://friendbot.stellar.org
* Optional: WSL + Rust + Stellar CLI (only if you build/deploy contracts)
* Optional: funded `STELLAR_RELAYER_SECRET` for sponsored agent transactions in local Functions

***

## 2. Quick start (frontend)

```bash
cd frontend
cp .env.example .env.local
cp .dev.vars.example .dev.vars   # server secrets for Pages Functions / local API

npm install
npm run dev
```

Open `http://localhost:5173`, connect a testnet wallet.

### Minimal `.dev.vars` (local sponsored fees + AI)

```env
# Optional host AI (leave unset for BYOK / fallback-only)
# DEEPSEEK_API_KEY=sk-...

ALLOWED_ORIGIN=http://localhost:5173

# Fee-bump relayer (server-only). Generate + fund on testnet.
STELLAR_RELAYER_SECRET=S...
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015

# See deployments/stellar-testnet.json for live values
SOROBAN_VAULT_ADDRESS=CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77
SOROBAN_ROUTER_ADDRESSES=CB675TTSFM6COTGHGB7K2I7IODPQ3HTHOTTTXU2LJHXXNGTS45NOTRSE,CCEWWRQVYKEIWTO7GTX2QVHQASC3GIQOZZTDMGTOHFQYKZIX5KJ6CYE5
SOROBAN_AGENT_WASM_HASHES=1fdbe175ddeb6d237a178c3c117b4e6c168122eec7d94f06a4b27ee4026efbe1,d61ceaaaf5a3fd9fd25987eba0f843ccb79880f3eaa137e066b5f63ab9eaa2ba
# Single-value compatibility fallback; V2 is the current app router. The plural V2,V1 list above
# remains canonical for the relay's dual-support migration window.
SOROBAN_ROUTER_ADDRESS=CB675TTSFM6COTGHGB7K2I7IODPQ3HTHOTTTXU2LJHXXNGTS45NOTRSE
```

There are **no** `ONESHOT_*` variables. Do not add them.

Addresses and notes: [`deployments/stellar-testnet.json`](deployments/stellar-testnet.json).

The public Stellar deployment facts are fixed at 7 Soroban source crates, 6 first-party Vibing
Farmer deployments, 2 external protocol contracts, and 8 static addresses. Agent accounts are
created dynamically per run. Values named `SOROBAN_AGENT_WASM_HASHES` are code hashes, not
contract addresses.

***

## 3. Demo path (happy path)

1. Connect Freighter (testnet).
2. Fund wallet (Friendbot + testnet Blend USDC / faucet if configured).
3. Open **Strategy** wizard: amount, risk, agent count.
4. Review AI skills + council / eligibility (if shown) → approve.
5. **a single signature:** `funding_router.grant` (budget + duration).
6. Workers deposit via session keys + fee-bump relay. Network fee sponsored by fee-bump relay.
7. Check graph / positions; kill switch = revoke allowance / agent revoke.

Optional: **`/farm`** cross-chain flow needs `relayer/` running + ZeroDev/CCTP env (see `relayer/` and `frontend/.env.example` Base section).

***

## 4. Contracts (WSL only)

```bash
# Replace <repo> with this checkout's WSL path.
wsl -e bash -lc "cd /mnt/<drive>/<repo>/soroban && stellar contract build"
wsl -e bash -lc "cd /mnt/<drive>/<repo>/soroban && cargo test"
```

Deploy/seed scripts live under `scripts/soroban/` (e.g. `deploy-seed.sh`). Never run `cargo`/`stellar` from bare PowerShell.

***

## 5. Repo map (what you will edit)

```
soroban/contracts/          # funding_router, agent_account, vault, blend_strategy, registry, …
frontend/src/stellar/       # chain client, session keys, relay client
frontend/api/stellar-relay.js   # sponsored fee-bump (replaces 1Shot)
frontend/src/orchestrator.js
frontend/src/worker.js
frontend/src/strategy/      # council, gates, Monte Carlo, monitor
relayer/                    # CCTP + Base/ZeroDev (optional leg)
keeper/                     # lifeboat radar
base-contracts/             # YieldRouter + adapters (Base)
deployments/                # stellar-testnet.json, base-sepolia.json
prd.md                      # product requirements
```

***

## 6. Gas abstraction — who replaced 1Shot?

| Era                        | Mechanism                                                                |
| -------------------------- | ------------------------------------------------------------------------ |
| EVM prototype (superseded) | 1Shot Managed / Permissionless relayer                                   |
| **Live Stellar path**      | Own **fee-bump** relayer: `POST /api/stellar-relay` with allowlisted ops |
| **Live Base cross-chain**  | Own Node relayer + **ZeroDev** session keys / UserOps                    |

If a doc still says “1Shot”, treat it as historical unless it is this file or `prd.md` timeline “superseded”.

***

## 7. Tests & lint

Run every gate below as an independent serial step. From `frontend/`, run lint and the full suite
separately:

```bash
npm run lint:ci
npm test
```

On this Windows checkout, continue only when `npm test` reproduces the accepted **exactly 7
failures in 5 files** signature described in section 8.1. That result is still **not PASS**. Any
different test failure or count stops verification. Only after the exact accepted signature, still
from `frontend/`, run the build independently:

```bash
npm run build
```

Then return to the repository root and run the relayer and keeper suites as separate steps:

```bash
cd relayer && npm test
cd ..
cd keeper && npm test
cd ..
```

Finally, run the complete contract gate under WSL only, replacing the placeholder with this
checkout's WSL path:

```bash
wsl -e bash -lc "cd /mnt/<drive>/<repo>/soroban && stellar contract build && cargo test && cargo clippy --all-targets -- -D warnings"
```

Every gate other than the accepted frontend 7-in-5 signature must exit 0. Stop verification on any
other nonzero result.

`npm run lint:ci` is what CI actually gates on — ESLint checked against the warning-fingerprint
baseline in `frontend/scripts/eslint-warning-baseline.json` (new warnings fail, fewer warnings
always pass). Reviewed a warning change locally and want to update the baseline? Run
`npm run lint:warnings:update` (it refuses under `CI=true`, so this is always a local, committed
decision, never something CI does to itself). `npm run lint` still runs plain ESLint with no gate,
useful while iterating.

CI (`.github/workflows/frontend.yml`) is built around one gate check, `release-gate`, which fails
unless `frontend-unit-build`, `relayer`, `keeper`, `soroban` (pinned Rust 1.93.0 + `stellar-cli`
26.1.0 on Ubuntu 24.04), and `playwright` all report success — a skipped job fails the gate exactly
like a failed one. Deploy to Cloudflare Pages needs only `release-gate`.

Two caveats before you rely on that: `release-gate` is not yet **registered** as the required status
check in branch protection, and the `playwright` job's visual baselines have never run on a runner.
Both, plus everything else standing between this branch and a release, are in section 8.

***

## 8. Release prerequisites (read before deploying anything)

All implementation tasks in the IQ Alter Remediation plan have now been attempted and landed, but
the plan is **not complete**: Task 13 confirm-list item 2 remains `NOT VERIFIED`. A fresh Router
V3 permission still stops at the production dispatch boundary, so the distinct-run, zero-confirm
reuse seam has not been proved. W4/Protect activation and every release action remain separate
authority.

Local checks are evidence about this checkout, not release readiness. Nothing in the "needs
authority" list below was performed by this review.

### 8.1 Current local verification evidence

The Task 14 rerun ran every gate listed in section 7 as an independent serial step. On this Windows
checkout:

* `npm run lint:ci` stays within the checked-in warning baseline.
* `npm test` exits 1 with the accepted Windows baseline: **exactly 7 failures in 5 files** —
  two approval-view CRLF substitutions, two extension-brand symlink `EPERM` failures, one
  brand-manifest SHA drift, and two CSS CRLF parser failures. This is baseline equivalence, **not
  PASS**.
* `npm run build`, the relayer suite, and the keeper suite pass.
* WSL `stellar contract build`, `cargo test`, and
  `cargo clippy --all-targets -- -D warnings` pass from this checkout's `soroban/`
  directory. Cargo was not run natively.

These checks exercise source and local artifacts only. They do not prove a live deployment,
production D1 schema, worker activation, repository settings, or a release.

### 8.2 Source exists; V3/V4 is not live

Router V3 and agent-account V4 exist in source and local tests. The source contains `grant_v3`,
`pull_v3`, `permission_grant`, `remaining_budget`, V3 replay/spend accounting,
and the V4 `per_execution_max`/owner-withdraw constraints. A local contract build produces
verification artifacts only.

No reviewed V3/V4 **release artifact** or hash is registered, no V3/V4 WASM was uploaded, no
contract was deployed, no V3 address/schema was registered, and no live path was activated.
`submitGrantV3` exists, but the registered router schemas still contain only live V2 and V1;
production fresh mode independently throws `VF_V3_FRESH_GRANT_UNSUPPORTED`. The live relay and
receipt-authority order remains:

```env
SOROBAN_ROUTER_ADDRESSES=CB675TTSFM6COTGHGB7K2I7IODPQ3HTHOTTTXU2LJHXXNGTS45NOTRSE,CCEWWRQVYKEIWTO7GTX2QVHQASC3GIQOZZTDMGTOHFQYKZIX5KJ6CYE5
SOROBAN_AGENT_WASM_HASHES=1fdbe175ddeb6d237a178c3c117b4e6c168122eec7d94f06a4b27ee4026efbe1,d61ceaaaf5a3fd9fd25987eba0f843ccb79880f3eaa137e066b5f63ab9eaa2ba
SOROBAN_ROUTER_ADDRESS=CB675TTSFM6COTGHGB7K2I7IODPQ3HTHOTTTXU2LJHXXNGTS45NOTRSE
```

The singular V2 value is the current compatibility fallback; it is not the canonical production
relay list, which retains the ordered V2,V1 migration list above.
Do not add a V3 address or hash until an authorized deployment produces one.

Stellar receipt/recovery is implemented and tested: authenticated challenges, fresh ordered-router
authority reads, durable receipts, one-use proofs, leases, recovery selection, and guarded
pull/deposit/poll execution all exist. Every receipt that touches Base deliberately returns
`blocked-reconcile`; see section 8.8.

### 8.3 D1 and relayer production boot contract

Migrations `0005_execution_receipts.sql` and `0006_base_child_intents.sql` exist and run in
local SQLite-backed repository tests. That does **not** mean they have been applied to production.

In `production`/`staging` the relayer refuses to open its listener until these hold:

1. Apply D1 `0005` then `0006`, with a backup and a post-migration schema check.
   The boot probe requires `ready:true`, schema version 1, and both receipt/Base-child stores.
2. Set the same server-only `AGENT_INDEX_REPORTER_SECRET` on Pages and the relayer.
3. Set `RELAYER_DB_PATH`; production requires it and it backs jobs, mandates, idempotency,
   and the association outbox.
4. Use HTTPS for `RELAYER_PUBLIC_ORIGIN` and `AGENT_INDEX_REPORTER_URL`; the public
   origin must contain no credentials, path, query, or fragment.
5. Keep tracked deployment facts canonical. The loader validates the tracked Stellar/Base JSON,
   including the pinned Base mandate policy; supported production env mirrors must equal their
   tracked values. Deployment JSON never supplies secrets.

### 8.4 Needs explicit authority — none of this was done

* Build and approve V3/V4 release artifacts; upload, deploy, register, and activate them only under
  separate authority. W4 must wire Protect activation, fresh-ledger reads, current grant readers,
  `submitGrantV3`, and production dispatch before Task 13 item 2 can be re-run.
* Apply production D1 `0005` then `0006` with backup and schema verification.
* Write target-environment secrets/configuration, enable the relayer outbox worker, and validate it
  against a non-production reporter.
* Create/protect the `production` GitHub Environment, register `release-gate` as the
  required status check, push/publish, or enable deployment.

Product/marketing claims of “0 repeat” in `prd.md`, `FEATURES.md`, the docs site,
`AGENTS.md`, and `CLAUDE.md` remain out-of-scope release blockers until the fresh-V3
seam is live and verified. This setup/operations review does not edit or validate those claims.

### 8.5 Two gate settings that live in repo settings, not YAML

`.github/workflows/frontend.yml` describes `release-gate` as the intended single required
check, but repository settings still need to register it and create/protect the `production`
GitHub Environment. Naming an environment in YAML does not create it.

### 8.6 Visual baselines still need runner evidence

`test:visual` is merge-blocking through `playwright`, but the 47 baseline PNGs were
frozen on a developer box and the config has no pixel-difference tolerance. Re-freeze them on the
runner image (or a matching container) before making `release-gate` required. No tolerance
was added by this review.

### 8.7 CI Rust pin

CI pins Ubuntu 24.04, Rust 1.93.0, and `stellar-cli` 26.1.0. The pinned CLI requires Rust
1.93.0, which satisfies the `soroban-sdk` 26.1.0 minimum of 1.91.0; the remediation plan's
1.82.0 cannot build this tree.

### 8.8 Base recovery is deliberately blocked pending durable evidence

The stale burn-custody defect described by older revisions is fixed: the client and server relays
now use typed `RelaySubmissionUnknownError` evidence, `runAgentBurn` preserves it, and
`baseLeg` reports unknown/unconfirmed custody for an ambiguous submission. The mounted App
pre-grant mandate producer also has a producer-faithful regression test.

Stellar recovery is automated only from durable receipt evidence. Base/CCTP recovery remains
manual: any Base-touched receipt returns `blocked-reconcile`. Before mainnet cross-chain
money movement, these three blockers must land in order:

1. **Persist the CCTP nonce and attestation message at burn time.** The watcher currently persists
   only pending/minted job status around polling; the nonce/message needed to resume the same mint
   is not durable.
2. **Provide a relayer → frontend/API/D1 read path for durable Base evidence.** The UserOperation
   hash is captured only inside relayer job state, and no recovery reader exposes the exact
   UserOperation, vault transaction/event, or resulting vault-position evidence.
3. **Bind the full Base-child identity into the recovery lease, or prove a one-to-one mapping.**
   The existing lease already includes `child_id`, but remains rooted in
   `(execution_id, allocation_id, child_id)`. Base children instead use the full
   `(binding_id, allocation_id, child_id)` identity. Bind `binding_id` and that full Base identity
   into the lease, or prove a one-to-one mapping to the existing execution identity, before the
   selector can safely claim a Base child movement.

The relayer association outbox still persists retries/dead letters and `GET /status/:jobId`
returns `associationDelivery`, but `crossChainFarm.js` drops that field before the
frontend money/recovery readers. Wiring that read path is product work, not Task 14 work.

***

## 9. Checklist — local demo ready

* [ ] `frontend` deps installed; `npm run dev` serves the app
* [ ] Wallet on **Stellar testnet** with Friendbot XLM
* [ ] `.dev.vars` has relayer secret + vault/router addresses from deployments JSON
* [ ] Strategy run: a single grant signature, workers deposit, shares increase on explorer/positions
* [ ] No `ONESHOT_*` in env; relay logs show fee-bump submit (not 1shotapi.com)
* [ ] (Optional) Cross-chain: `relayer` up + ZeroDev project id for `/farm`

***

## 10. Further reading

| Doc                                             | Use                                           |
| ----------------------------------------------- | --------------------------------------------- |
| [prd.md](prd.md)                                | Full product requirements, FR table, timeline |
| [README.md](./)                                 | Architecture, routes, env templates           |
| [DESIGN.md](/broken/pages/6Jx8uHi61JqMhzEpSKM5) | UI / design system                            |
| [AGENTS.md](AGENTS.md) / [CLAUDE.md](CLAUDE.md) | Agent coding instructions                     |
| [soroban/README.md](soroban/)                   | Contract build/test one-liners                |
| Stellar docs                                    | https://developers.stellar.org                |
| Blend                                           | https://docs.blend.capital                    |
| Circle CCTP                                     | https://developers.circle.com/cctp            |
| ZeroDev                                         | https://docs.zerodev.app                      |

***

## Historical note

Earlier drafts of this file described an **EVM Sepolia** MVP (EIP-7702, ERC-7715, AgentVaultDepositor, MockVault, 1Shot). That path was **decommissioned 2026-06-21**. This document describes the **current** Stellar-first product only.
