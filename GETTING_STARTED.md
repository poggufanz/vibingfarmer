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
* Optional: funded `STELLAR_RELAYER_SECRET` for gasless agent txs in local Functions

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

### Minimal `.dev.vars` (local gasless + AI)

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
SOROBAN_ROUTER_ADDRESS=CCEWWRQVYKEIWTO7GTX2QVHQASC3GIQOZZTDMGTOHFQYKZIX5KJ6CYE5
```

There are **no** `ONESHOT_*` variables. Do not add them.

Addresses and notes: [`deployments/stellar-testnet.json`](deployments/stellar-testnet.json).

***

## 3. Demo path (happy path)

1. Connect Freighter (testnet).
2. Fund wallet (Friendbot + testnet Blend USDC / faucet if configured).
3. Open **Strategy** wizard: amount, risk, agent count.
4. Review AI skills + council / eligibility (if shown) → approve.
5. **a single signature:** `funding_router.grant` (budget + duration).
6. Workers deposit gas-free via session keys + fee-bump relay.
7. Check graph / positions; kill switch = revoke allowance / agent revoke.

Optional: **`/farm`** cross-chain flow needs `relayer/` running + ZeroDev/CCTP env (see `relayer/` and `frontend/.env.example` Base section).

***

## 4. Contracts (WSL only)

```bash
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && stellar contract build"
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test"
```

Deploy/seed scripts live under `scripts/soroban/` (e.g. `deploy-seed.sh`). Never run `cargo`/`stellar` from bare PowerShell.

***

## 5. Repo map (what you will edit)

```
soroban/contracts/          # funding_router, agent_account, vault, blend_strategy, registry, …
frontend/src/stellar/       # chain client, session keys, relay client
frontend/api/stellar-relay.js   # gasless fee-bump (replaces 1Shot)
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

```bash
cd frontend && npm test && npm run lint:ci && npm run build

wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test"
```

`npm run lint:ci` is what CI actually gates on — ESLint checked against the warning-fingerprint
baseline in `frontend/scripts/eslint-warning-baseline.json` (new warnings fail, fewer warnings
always pass). Reviewed a warning change locally and want to update the baseline? Run
`npm run lint:warnings:update` (it refuses under `CI=true`, so this is always a local, committed
decision, never something CI does to itself). `npm run lint` still runs plain ESLint with no gate,
useful while iterating.

CI (`.github/workflows/frontend.yml`) is built around one gate check, `release-gate`, which fails
unless `frontend-unit-build`, `relayer`, `keeper`, `soroban` (pinned Rust 1.91.0 + `stellar-cli`
26.1.0 on Ubuntu 24.04), and `playwright` all report success — a skipped job fails the gate exactly
like a failed one. Deploy to Cloudflare Pages needs only `release-gate`.

Two caveats before you rely on that: `release-gate` is not yet **registered** as the required status
check in branch protection, and the `playwright` job's visual baselines have never run on a runner.
Both, plus everything else standing between this branch and a release, are in section 8.

***

## 8. Release prerequisites (read before deploying anything)

Local suites being green is **not** release readiness. This section is the honest state of the
branch, split into what ships, what was never built, and what still needs an explicit human
decision. Nothing in the "needs authority" list has been done.

### 8.1 Built and locally verified

`frontend` (`lint:ci`, `npm test`, `npm run build`), `relayer` (`npm test`), `keeper` (`npm test`)
and `node --test scripts/ci/release-gate.test.mjs` all pass on a Linux dev box. That exercises the
Stellar grant/relay path, the Base mandate + durable-intent path, the agent-index D1 receipt and
base-child stores, the relayer association outbox, the money/valuation layer and the CI gate's own
self-test.

Green does not mean complete, and the Base leg specifically is **not** fully covered by the above:
section 8.8 records one open money-custody defect and one parked coverage gap that sit inside that
same Base mandate/burn path. Read 8.8 before treating the Base leg as verified.

### 8.2 Not built — do not read these as "pending verification"

**Router V3 and agent-account V4 do not exist.** No `grant_v3`, `pull_v3`, `permission_grant` or
per-execution scope entry point exists anywhere under `soroban/contracts/`. The live contracts are
still the V2 generation recorded in `deployments/stellar-testnet.json`. Consequently these are also
absent, not merely untested: the reviewed **Protect grant** that would read a V3 remaining-budget
view, the `AllocationReceiptV2` **producer-to-render custody** chain, and **lease-owned recovery**
(no `selectRecoveryAction`, no `requestRecovery`). There is no V3/V4 contract to deploy, no new WASM
hash to record, and no deployment JSON to update.

**Soroban build/test/clippy is UNVERIFIED on this branch**, separately from the above: the commands
in section 4 are WSL-only and were not run. The CI `soroban` job (pinned Rust 1.91.0) is the first
place they will execute. Treat a green local checkout as saying nothing about the contracts.

**Relayer outbox dead-letters are not observable in the product.** The relayer stores and
dead-letters correctly, and `GET /status/:jobId` returns `associationDelivery`, but
`crossChainFarm.js` `runFarmFlow` drops that field and `app.jsx` never passes it to
`readOwnerMoney`. The money layer therefore reports `associationCoverage: 'unknown'` and a null
complete-Base total for any owner with a Base child. That is deliberate fail-closed behaviour — the
proven Stellar subtotal and the known Base subtotal are still retained and rendered — but a
user-visible dead-letter needs `associationDelivery` wired through the poll path first.

### 8.3 Relayer production boot contract (new — get the order right)

In `production`/`staging` the relayer refuses to open its listener until every one of these holds.
It is fail-closed by design, so a missed step looks like a boot failure, not silent degradation.

1. **D1 migrations `0005` and `0006` applied first.** Boot probes
   `POST /api/agent-index?action=base-child-ready` and demands `ready:true`, `schemaVersion:1` and
   both the `executionReceipts` and `baseChildIntents` stores present. Migrations before relayer,
   never the other way round.
2. **`AGENT_INDEX_REPORTER_SECRET` set identically on both sides** — the Pages env and the relayer
   VM. It is the Bearer credential for every receipt/intent/lifecycle write and for that same boot
   probe. Server-side only; the browser never receives it.
3. **`RELAYER_DB_PATH` set** (`config.mjs` `need()`s it in production). It is also what starts the
   association outbox delivery worker; without it `POST /farm` answers 503.
4. **`RELAYER_PUBLIC_ORIGIN` and `AGENT_INDEX_REPORTER_URL` over HTTPS**, and the public origin must
   be an origin only — no credentials, path, query or fragment.
5. **Deployment facts must match.** The relayer loads `deployments/stellar-testnet.json` and
   `deployments/base-sepolia.json` at config time and refuses to start if a production env mirror
   disagrees with the tracked fact (including every `baseMandatePolicy` address and selector). Set
   env values from those files; never the reverse, and never source secrets from them.

### 8.4 Needs explicit authority — none of this has been done

* Apply D1 `0005` then `0006` per environment, with a backup and a post-migration schema check.
* Set `RELAYER_DB_PATH`, reporter credentials, `RELAYER_PUBLIC_ORIGIN` and deployment-fact values in
  the target environment.
* Enable the relayer outbox worker and validate its retry/dead-letter behaviour against a
  **non-production** reporter.
* Push, merge, or enable deploy after CI `release-gate` is green.
* Deploy contracts. (Nothing to deploy on this branch — see 8.2 — but the authority requirement
  stands for any contract change.)

### 8.5 Two gate settings that live in repo settings, not in YAML

`release-gate` is only *described* as the required check by `.github/workflows/frontend.yml`. Until
someone does both of these, "one required check" is aspirational:

* Register `release-gate` as the **required status check** in branch protection.
* Create and protect the `production` GitHub Environment. `frontend.yml` names it; naming does not
  create it. Note that adding required reviewers turns every `main` deploy into a manual approval.

### 8.6 Known gate blocker: visual baselines have never run on a runner

`test:visual` is merge-blocking through the `playwright` job, but the 47 baseline PNGs were frozen on
a developer box and `frontend/playwright.config.js` sets **no** `maxDiffPixels`/`maxDiffPixelRatio`,
so they are compared at **zero** tolerance on `ubuntu-latest`. `test:visual` has never executed on a
runner. **Re-freeze the baselines on the runner image (or a matching container) before making
`release-gate` the required check.** A diff tolerance is deliberately not the fix — it weakens a real
guard — and `snapshotPathTemplate`'s missing `{platform}` key buys nothing here, since it resolves to
`linux` on both hosts.

### 8.7 Deliberate deviation to know about: the CI Rust pin is 1.91.0

The remediation plan mandated `1.82.0`. That is unbuildable: `soroban/Cargo.toml` pins
`soroban-sdk = "26.1.0"`, whose manifest declares `rust-version = "1.91.0"`, and the
`wasm32v1-none` target did not exist before Rust 1.84. A 1.82.0 pin would make the `soroban` job —
and therefore `release-gate`, and therefore every merge — permanently red. `1.91.0` is the exact
minimum that satisfies both the SDK and the "pinned, deterministic, not `stable`" intent.

### 8.8 Open defect and parked coverage gap in the Base leg

Both of these sit in the Base mandate/burn path that section 8.1's green suites otherwise exercise.
Neither is a regression from recent work; both were found while verifying it and are written down here
rather than assumed.

**Open defect — a lost burn response is reported as confirmed agent custody.**
`frontend/src/stellar/agentBurn.js:89-93` re-wraps *every* relay failure as a bare
`new Error('deposit_for_burn: ' + err.message)`, discarding the `code`, `result` and `submission`
fields the relay error carried. The `VF_SUBMISSION_UNKNOWN` tag that marks an indeterminate
submission is one of the things thrown away, so a real relay timeout — where the CCTP burn may well
have landed on-chain but the response was lost — arrives at `frontend/src/baseLeg.js:330` untagged and
indistinguishable from a clean failure. Custody is then reported as
`{ location: 'agent', confirmed: true }`.

Concretely, for an operator: **the USDC can be in CCTP transit while the dashboard states the agent
still holds it.** Under a lost-response timeout, treat any agent-custody claim on a Base allocation as
unproven and reconcile against the CCTP burn on-chain and the relayer's own job status before acting
on it — in particular, do not re-run the allocation on the assumption nothing moved.

This is an **open defect awaiting its own task**, not a known-and-accepted limitation. The fix is to
preserve the relay error's `code`/`result`/`submission` through the re-wrap so the existing
indeterminate-submission handling downstream can see them; it was outside the scope of every task in
the work that found it.

**Parked coverage gap — the pre-grant Base mandate re-check is untested.**
`runOrchestratorDispatch` (`frontend/src/app.jsx:3176`) re-checks each Base allocation's mandate
immediately before the Stellar grant, and has **zero** test references — no test mounts `App` with a
Base allocation, so the block never executes under test. The production code is believed correct on
inspection, and the same "a revoked mandate blocks the flow" gate is covered one layer down at
`frontend/src/baseLeg.js:190-210`, which does have tests. So the untested code duplicates a
covered guarantee rather than being the only thing standing behind it. Parked deliberately: closing it
needs a new `App`-mounting integration test, judged disproportionate to the risk. Assessed as **not
merge-blocking** — but it is untested code on a money path, so weigh it yourself rather than taking
that assessment on trust.

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
