# EVM Decommission (sub-project 6, LAST) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the now-dead EVM half of Vibing Farmer (Solidity stack + EVM frontend chain-layer + ethers/viem/1Shot deps) once the Stellar path carries the whole flow, leaving a single-chain Soroban codebase.

**Architecture:** This is a teardown, executed **after** the Stellar chain layer (SP3) and the full frontend re-point (SP4: orchestrator/worker/app/wallet) are live and the residual EVM features (x402/session/attestation/positionsStore/readProvider/gasSnapshot) are re-pointed or removed. (SP5 = ZK-KYC, cancelled — not part of this.) It does **not** add behavior. Every deletion is **grep-guarded**: before removing a module we prove zero *kept* code imports it; after removing it we prove the full test suite + build stay green. The guard doubles as the precondition check — if a guard still finds the orchestrator (or any kept module) importing an EVM file, SP4/SP5 are not finished and the task **halts** rather than bricking the app.

**Tech Stack:** git (file deletion + commits), Vitest (regression net), Vite (build net), npm (dep removal). No new code. Foundry/forge is being *deleted*, so no forge run is needed.

---

## ⚠️ PARTIALLY UNBLOCKED — re-point the EVM *features* before this runs clean (updated 2026-06-21)

**SP4 execution re-point is DONE** (commits `c2437cc`→`e151a32` on `iq`; see `docs/superpowers/plans/2026-06-21-sp4-execution-repoint-phase2-3.md`). The Stellar chain layer is now **load-bearing**: `orchestrator.js`, `worker.js`, `app.jsx`, `wallet.js`, `agents/agentController.js` import `frontend/src/stellar/**`. **Task 0 Step 1 (Stellar wired) now PASSES.**

**But the EVM path is not fully unplugged.** SP4 swapped the deposit / authorize / exit **seam** onto Stellar; it left the EVM-era **features** still wired into kept code, none of which has a shipped Stellar equivalent:

- `app.jsx` still imports `x402` (Venice wallet-funded inference), `strategy/session` (ERC-7715 grant), `attestation` (on-chain strategy attestation), `positionsStore` + `readProvider` (ethers reads).
- the kept brain still wires EVM: `strategy/fetchDag.js`→`positionsStore`, `strategy/gasSnapshot.js`→`readProvider`, `strategy/rehydrate.js`→`session`, `venice.js`→`attestation`.
- `wallet.js` → `readProvider`/`session`/`relay`; `components/ExplorerPage.jsx`/`SettingsPage.jsx` → `readProvider`/`x402`.

**Consequence: Tasks 1–2 will correctly HALT** — their guards find these kept files still importing the doomed modules, so nothing gets deleted (safe but stuck). Before this teardown runs end-to-end, each EVM-only feature must be **re-pointed to Stellar or removed as a feature** (this is residual SP4 work, NOT a separate sub-project):

1. `positionsStore` / `readProvider` ethers reads → `stellar/client.js` reads.
2. `gasSnapshot` (EVM gas) → Stellar relayer fee model, or drop (the worker already dropped its gas arg).
3. `x402` inference funding, `session` (ERC-7715 grant), `attestation` → product decision: keep-on-Stellar vs drop. x402 is Base-mainnet USDC for Venice; the ERC-7715 grant has no Stellar analogue (the Stellar path authorizes per-agent via `registry.authorize`, not a wallet grant); on-chain attestation has no Soroban equivalent shipped.

**On the "SP5" numbering:** the master-spec sub-project **SP5 = optional on-chain ZK-KYC (Groth16), CANCELLED by the user** (RWA→DeFi-yield pivot, no KYC needed). It is **not** a remaining task. Earlier wording in this plan that said "SP5 = app.jsx + screens re-point" was a mislabel — that re-point is part of **SP4**. Ignore any "do SP5" instruction below; the only gate left is the feature re-point/removal in the list above.

Running this plan now: Task 0 passes, Task 1 halts on the first kept importer. Finish items 1–3, then this teardown runs clean.

---

## Context the engineer needs (read before starting)

You may know nothing about this repo's migration. The facts that make this plan safe:

- **The project migrated EVM → Stellar/Soroban.** Both chain layers currently coexist in the tree. The Stellar layer lives in `frontend/src/stellar/` (`config/scval/client/sessionKey/walletKit/events/index/relay`) and `frontend/api/stellar-relay.js`. The EVM layer is everything that imports `ethers` or `viem`. This plan removes only the EVM layer.
- **"Kept" code** = the AI brain (`frontend/src/strategy/**` council/MonteCarlo/risk pipeline, `frontend/src/venice.js`-style AI providers), the force-graph UI, the orchestrator logic, and the entire `frontend/src/stellar/**` layer. None of these should import `ethers`/`viem` once SP4/SP5 are done — that is exactly what the guards verify.
- **The guards are the spec.** `git grep` for an import specifier is the source of truth for "is this file still wired?". Expected guard output is stated per step. If a guard returns **more** than the stated expected lines (i.e. a *kept* file still imports the doomed module), **STOP** and report: "SP4/SP5 incomplete — `<file>` still imports `<evm-module>`; re-point it to the Stellar equivalent before decommissioning." Do not edit kept files to force the guard green unless the step explicitly says to excise (Task 5).
- **Stellar equivalents of the EVM modules** (so you can confirm nothing is lost):
  - EVM `worker.js` (EIP-712 deposit) → Stellar `stellar/sessionKey.js` (sign) + `stellar/client.js` (submit) + `stellar/relay.js` (gasless).
  - EVM `relay.js` (1Shot) → `stellar/relay.js` + `api/stellar-relay.js`.
  - EVM `strategy/keyVault.js` / `strategy/session.js` (ephemeral key / viem walletClient) → `stellar/sessionKey.js` / `stellar/walletKit.js`.
  - EVM `readProvider.js` / `positionsStore.js` (ethers reads) → `stellar/client.js` reads.
  - EVM `redelegation.js` / `attestation.js` / `redeem.js` / `x402.js` → no Stellar equivalent shipped (redelegation/attestation/x402 were EVM-only features; redeem moved into the Stellar user-tx path). If a kept screen still calls them, that screen needs SP5 work first — the guard will catch it.
- **Planning files are gitignored** (see CLAUDE.md), so this plan file is not committed. The *deletion commits* this plan produces are real repo changes on branch `iq` (local-only, fork-PR workflow — do not push/merge).
- **Run all `git`/`npm`/`npx` commands from the stated directory.** Frontend test/build/lint run from `frontend/`. Deletions run from the repo root `C:/SharredData/project/competition/vibing-farmer`.

## File structure (what this plan touches)

```
DELETE (Solidity stack, repo root):
  contracts/                          all .sol
  test/                               all .sol tests
  script/                             Deploy.s.sol etc.
  lib/                                forge-std + openzeppelin-contracts submodules
  out/  cache/                        foundry build artifacts (if present)
  foundry.toml  remappings.txt
  deployments/base-sepolia.json       (KEEP deployments/stellar-testnet.json)
  .github/workflows/contracts.yml     EVM CI

DELETE (EVM frontend chain-layer, frontend/src/):
  worker.js  relay.js  relay.test.js  x402.js  redelegation.js
  attestation.js  readProvider.js  redeem.js
  positionsStore.js  positionsStore.test.js
  strategy/keyVault.js  strategy/keyVault.test.js
  strategy/session.js   strategy/session.test.js
  (+ any other module a guard proves is EVM-only & unimported)

DELETE (EVM server relay):
  frontend/api/relay.js
  frontend/functions/api/relay.js

EXCISE (kept files that may still carry an EVM import at execution time):
  frontend/src/config.js              remove EVM addresses/ABIs, keep app config
  frontend/src/wallet.js              EITHER delete (if fully replaced by stellar/walletKit.js) or excise EVM parts
  frontend/src/app.jsx                remove `import { ethers }` + EVM usage
  frontend/src/components/ExplorerPage.jsx   remove `import { ethers }` + EVM usage

MODIFY (dependency + doc cleanup):
  frontend/package.json               drop ethers, viem, @uxly/1shot-client, @metamask/smart-accounts-kit, @coinbase/cdp-sdk (+ libsodium if unimported)
  .env.example                        drop EVM-only vars
  CLAUDE.md                           mark EVM decommissioned / point at Stellar (doc-sync)
```

---

### Task 0: Precondition gate — prove the Stellar path is load-bearing and EVM is dead

No deletion. This task establishes that SP3–SP5 are done so the teardown is safe. If any check fails, **STOP** and report which sub-project is unfinished.

**Files:** none (read-only verification)

- [ ] **Step 1: Confirm the Stellar chain layer exists and is wired**

Run from repo root:

```bash
ls frontend/src/stellar/index.js frontend/api/stellar-relay.js && \
git grep -lE "from ['\"].*stellar/(index|client|walletKit|sessionKey)" -- frontend/src | grep -v '/stellar/'
```

Expected: the two files list, AND at least one *non-stellar* kept file (orchestrator / a screen / app.jsx) imports the Stellar layer. If the second command prints nothing, the app is **not** yet using Stellar — SP4/SP5 unfinished. STOP.

- [ ] **Step 2: Capture the full EVM surface (the delete worklist)**

Run from repo root:

```bash
git grep -lE "from ['\"]ethers['\"]|from ['\"]viem['\"]|@uxly/1shot-client|@metamask/smart-accounts-kit|@coinbase/cdp-sdk" -- frontend
```

Expected (today's snapshot — yours may be shorter if SP4/SP5 already removed some): `worker.js relay.js readProvider.js redeem.js redelegation.js positionsStore.js wallet.js attestation.js app.jsx config.js components/ExplorerPage.jsx strategy/keyVault.js strategy/session.js`. **Write this list down** — it is the worklist Tasks 1–6 must drive to empty.

- [ ] **Step 3: Confirm the baseline suite is green before any deletion**

Run from `frontend/`: `npx vitest run`
Expected: all suites pass (per the last known state, 347 tests). Record the count — every later task must keep it green (minus the EVM tests you delete).

- [ ] **Step 4: Commit nothing**

This task has no changes. Proceed to Task 1.

---

### Task 1: Delete the EVM-only leaf chain modules (worker, relay, x402, redelegation, attestation, readProvider, redeem)

These are EVM-only and have Stellar equivalents (or were EVM-only features). Each is deleted only after a guard proves no *kept* file imports it.

**Files:**
- Delete: `frontend/src/worker.js`, `frontend/src/relay.js`, `frontend/src/relay.test.js`, `frontend/src/x402.js`, `frontend/src/redelegation.js`, `frontend/src/attestation.js`, `frontend/src/readProvider.js`, `frontend/src/redeem.js`

- [ ] **Step 1: Guard — prove nothing kept imports these**

Run from repo root:

```bash
git grep -nE "from ['\"]\.?\.?/?(worker|relay|x402|redelegation|attestation|readProvider|redeem)(\.js)?['\"]" -- frontend/src ':!frontend/src/stellar' ':!frontend/src/relay.test.js'
```

Expected: only self-references among the doomed files themselves (e.g. `worker.js` importing `relay.js`), and nothing from `strategy/**`, `orchestrator.js`, `app.jsx`, screens, or `components/**` **except** EVM files also slated for deletion. If a kept file (orchestrator, a strategy module, a screen that SP5 should have re-pointed) appears, **STOP** — that file must be re-pointed to the Stellar path first. Note: `frontend/src/stellar/relay.js` is a *different* file (excluded above) — do not delete it.

- [ ] **Step 2: Delete the files**

Run from repo root:

```bash
git rm frontend/src/worker.js frontend/src/relay.js frontend/src/relay.test.js \
       frontend/src/x402.js frontend/src/redelegation.js frontend/src/attestation.js \
       frontend/src/readProvider.js frontend/src/redeem.js
```

(If any path errors with "did not match any files", it was already removed by SP4/SP5 — drop it from the command and continue.)

- [ ] **Step 3: Verify the suite is still green**

Run from `frontend/`: `npx vitest run`
Expected: PASS, with the `relay.test.js` suite gone. No "Cannot find module './worker'"-style failures — a failure here means a kept file imported a deleted module and the Step 1 guard missed it (re-run the guard with the failing importer's path).

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor: remove EVM leaf chain modules (worker, relay, x402, redelegation, attestation, readProvider, redeem)"
```

---

### Task 2: Delete the EVM key/state modules (positionsStore, strategy/keyVault, strategy/session)

EVM ephemeral-key + viem-session + ethers-positions infra. Replaced by `stellar/sessionKey.js` / `stellar/walletKit.js` / `stellar/client.js`. Guarded because these sit inside `strategy/` (the kept brain) and must be proven unused by it.

**Files:**
- Delete: `frontend/src/positionsStore.js`, `frontend/src/positionsStore.test.js`, `frontend/src/strategy/keyVault.js`, `frontend/src/strategy/keyVault.test.js`, `frontend/src/strategy/session.js`, `frontend/src/strategy/session.test.js`

- [ ] **Step 1: Guard — prove the kept brain no longer imports them**

Run from repo root:

```bash
git grep -nE "from ['\"].*(positionsStore|keyVault|/session)(\.js)?['\"]" -- frontend/src ':!*.test.js'
```

Expected: nothing (or only references from other doomed files). If a kept strategy module (`monitorLoop.js`, `orchestrator.js`, `submitGate.js`, `riskCouncil.js`, etc.) still imports `keyVault`/`session`/`positionsStore`, **STOP** — SP4 has not finished re-pointing the execution path to Stellar. Do not delete; report the importer.

- [ ] **Step 2: Delete the files**

Run from repo root:

```bash
git rm frontend/src/positionsStore.js frontend/src/positionsStore.test.js \
       frontend/src/strategy/keyVault.js frontend/src/strategy/keyVault.test.js \
       frontend/src/strategy/session.js frontend/src/strategy/session.test.js
```

(Drop any already-removed path, as in Task 1.)

- [ ] **Step 3: Verify the suite is still green**

Run from `frontend/`: `npx vitest run`
Expected: PASS, three fewer test suites. Any "Cannot find module" failure ⇒ a kept file imported a deleted module ⇒ revert the matching `git rm` and re-point that importer (SP4 work) before retrying.

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor: remove EVM key/state modules (positionsStore, keyVault, session)"
```

---

### Task 3: Delete the EVM server relay (1Shot proxy)

`frontend/api/relay.js` + its Pages-Functions mirror are the EVM 1Shot relay. The Stellar relay is `api/stellar-relay.js` (kept). Confirm no Function route or test references the EVM relay before deleting.

**Files:**
- Delete: `frontend/api/relay.js`, `frontend/functions/api/relay.js`

- [ ] **Step 1: Guard — prove nothing references the EVM relay endpoint or module**

Run from repo root:

```bash
git grep -nE "api/relay|from ['\"].*/relay\.js['\"]|/api/relay" -- frontend ':!frontend/api/stellar-relay*' ':!frontend/functions/api/stellar-relay*' ':!frontend/src/stellar'
```

Expected: only the two files being deleted (and possibly a `_routes.json`/`_pagesAdapter.js` entry — note those for Step 2). No kept frontend code should POST to `/api/relay` (it should use `/api/stellar-relay` via `stellar/relay.js`). If a kept caller appears, STOP.

- [ ] **Step 2: Delete the relay Function + drop any route entry**

Run from repo root:

```bash
git rm frontend/api/relay.js frontend/functions/api/relay.js
```

If Step 1 surfaced a `/api/relay` entry in `frontend/_routes.json` or `frontend/functions/_routes.json`, open that file with Edit and remove only the `/api/relay` line, leaving `/api/stellar-relay`, `/api/ai`, `/api/search` intact.

- [ ] **Step 3: Verify the suite is still green**

Run from `frontend/`: `npx vitest run`
Expected: PASS (the EVM relay had no Vitest suite of its own; the Stellar relay test `stellar-relay.test.js` stays green).

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor: remove EVM 1Shot server relay (api/relay.js + functions mirror)"
```

---

### Task 4: Excise EVM from the kept shared files (config.js, wallet.js, app.jsx, ExplorerPage.jsx)

These are **kept** files (app config, wallet connect, UI shell, explorer) that may still carry an `ethers`/`viem` import at execution time. By SP5 they should already be on Stellar; this task removes any EVM residue so the dependency drop in Task 5 succeeds. Handle each file the guard still flags.

**Files:**
- Modify (or delete): `frontend/src/config.js`, `frontend/src/wallet.js`, `frontend/src/app.jsx`, `frontend/src/components/ExplorerPage.jsx`

- [ ] **Step 1: Guard — list the kept files still importing ethers/viem**

Run from repo root:

```bash
git grep -nE "from ['\"]ethers['\"]|from ['\"]viem['\"]" -- frontend/src ':!frontend/src/stellar'
```

Expected: at this point only kept shared files remain (`config.js`, `wallet.js`, `app.jsx`, `components/ExplorerPage.jsx`) — Tasks 1–2 removed the rest. If a leaf module from Task 1/2 still appears, you missed a `git rm`; go back.

- [ ] **Step 2: For each flagged file, decide delete-vs-excise and apply**

For each file the guard printed, open it with Read, then:

- **`frontend/src/wallet.js`** — if every export is now superseded by `stellar/walletKit.js` (connect/getAddress/sign) and nothing kept imports `wallet.js` (`git grep -nE "from ['\"].*/wallet(\.js)?['\"]" -- frontend/src ':!frontend/src/stellar'` prints nothing), `git rm frontend/src/wallet.js frontend/src/wallet.test.js`. Otherwise, with Edit, remove the `import { ethers }` / `import { createWalletClient, custom } from 'viem'` lines and any function body that builds an EVM provider/walletClient, leaving only chain-agnostic helpers; re-point the kept callers to `stellar/walletKit.js`.
- **`frontend/src/config.js`** — with Edit, delete the EVM constants/ABIs (depositor/registry addresses, `DEPOSITOR_ABI`, Base Sepolia chain id, model→address maps tied to EVM). Keep non-chain app config (AI model slugs, feature flags). The Stellar addresses live in `stellar/config.js`; do not duplicate them here.
- **`frontend/src/app.jsx`** — with Edit, remove `import { ethers }` (line ~30) and replace any `ethers`-based wallet/balance read with the Stellar equivalent already used elsewhere in the app (`stellar/walletKit.js` for address, `stellar/client.js` `horizonNativeBalance` for balance).
- **`frontend/src/components/ExplorerPage.jsx`** — with Edit, remove `import { ethers }` and replace any EVM tx/address formatting with the Stellar event data the force-graph already consumes (`stellar/events.js` decoded events).

- [ ] **Step 3: Re-run the guard — expect zero EVM imports outside the doomed deps**

Run from repo root:

```bash
git grep -nE "from ['\"]ethers['\"]|from ['\"]viem['\"]" -- frontend/src
```

Expected: **no output**. Every `ethers`/`viem` import is gone from `frontend/src` (including `stellar/`, which never used them). If anything remains, finish excising it before continuing.

- [ ] **Step 4: Verify the suite + build are green**

Run from `frontend/`: `npx vitest run && npm run build`
Expected: tests PASS and `vite build` succeeds. A build failure here is the real proof the excision was complete — fix any unresolved reference before committing.

- [ ] **Step 5: Commit**

```bash
git add -A frontend/src
git commit -m "refactor: excise EVM (ethers/viem) from kept config, wallet, app shell, explorer"
```

---

### Task 5: Drop the EVM dependencies from package.json

With zero importers left, remove the EVM packages so the bundle and install graph shed them. Each is removed only after a guard proves no source imports it.

**Files:**
- Modify: `frontend/package.json` (and `frontend/package-lock.json` via `npm install`)

- [ ] **Step 1: Guard — prove zero importers for each EVM package**

Run from repo root:

```bash
for p in ethers viem @uxly/1shot-client @metamask/smart-accounts-kit @coinbase/cdp-sdk libsodium-wrappers-sumo; do \
  echo "== $p =="; git grep -nE "from ['\"]$p|require\(['\"]$p" -- frontend/src frontend/api frontend/functions; done
```

Expected: every package prints its header with **no matches beneath it**. Any package that still has an importer is **not** safe to remove — leave it in `package.json` and report the importer (it means an earlier task left residue). `libsodium-wrappers-sumo` is included as a candidate because it backed the EVM `keyVault` KDF; only remove it if the guard shows zero matches (a kept `keyStore.js` may still use it — if so, keep it).

- [ ] **Step 2: Uninstall the unimported EVM packages**

Run from `frontend/` (omit any package the Step 1 guard showed still in use):

```bash
npm uninstall ethers viem @uxly/1shot-client @metamask/smart-accounts-kit @coinbase/cdp-sdk
```

Expected: `package.json` `dependencies` loses those entries; `package-lock.json` updates. `@stellar/stellar-sdk`, `@creit.tech/stellar-wallets-kit`, `react*`, `framer-motion`, `zod`, `vite`, `dotenv` remain.

- [ ] **Step 3: Reinstall + verify suite and build**

Run from `frontend/`: `npm install && npx vitest run && npm run build`
Expected: clean install, tests PASS, `vite build` succeeds with no "failed to resolve import 'ethers'/'viem'" errors. The build is the proof the dep removal is safe.

- [ ] **Step 4: Commit**

```bash
git add frontend/package.json frontend/package-lock.json
git commit -m "chore: drop EVM dependencies (ethers, viem, 1shot-client, smart-accounts-kit, cdp-sdk)"
```

---

### Task 6: Delete the Solidity stack + EVM deployment + EVM CI

The contracts are fully superseded by the deployed Soroban contracts (`soroban/`). Remove Foundry and everything it builds. This is pure deletion — no forge run needed.

**Files:**
- Delete: `contracts/`, `test/`, `script/`, `lib/`, `out/`, `cache/`, `foundry.toml`, `remappings.txt`, `deployments/base-sepolia.json`, `.github/workflows/contracts.yml`

- [ ] **Step 1: Guard — confirm no kept tooling references the Solidity tree**

Run from repo root:

```bash
git grep -nE "contracts/|foundry|forge |base-sepolia\.json|openzeppelin" -- . ':!docs' ':!soroban' ':!*.md' ':!planning' ':!graphify-out'
cat .gitmodules 2>/dev/null
```

Expected: code matches only inside `foundry.toml`, `remappings.txt`, `.github/workflows/contracts.yml`, `deployments/base-sepolia.json`, `.gitmodules`, and `foundry.lock` (all being deleted). `.gitmodules` should list `lib/openzeppelin-contracts` + `lib/forge-std` (the EVM Solidity OZ + forge-std submodules — **distinct** from the Soroban `stellar-tokens`/`stellar-contract-utils` crates in `soroban/Cargo.toml`, which are KEPT). Matches in `docs/**`/`*.md`/`graphify-out/**` are historical/cache and are fine to leave. If a kept script references `forge`, note it.

- [ ] **Step 2: Delete the Solidity stack (deregister submodules properly)**

`lib/openzeppelin-contracts` and `lib/forge-std` are git **submodules** — a bare `rm -rf lib` would orphan the `.gitmodules` entries and `.git/modules/lib`. Deinit them first. Run from repo root:

```bash
# 1. Deinit + git-rm the submodules (this also scrubs their .gitmodules entries).
git submodule deinit -f lib/openzeppelin-contracts lib/forge-std 2>/dev/null || true
git rm -f lib/openzeppelin-contracts lib/forge-std 2>/dev/null || git rm -r lib
# 2. Remove the rest of the Solidity stack.
git rm -r contracts test script foundry.toml remappings.txt foundry.lock deployments/base-sepolia.json .github/workflows/contracts.yml
# 3. Scrub leftover submodule git metadata + foundry build artifacts (not always tracked).
rm -rf .git/modules/lib lib out cache
```

If, after this, `.gitmodules` still contains a `lib/...` block (older git won't auto-clean it), open `.gitmodules` with Edit and remove the `[submodule "lib/openzeppelin-contracts"]` and `[submodule "lib/forge-std"]` blocks; if the file is now empty, `git rm -f .gitmodules`. Then confirm: `git config -f .gitmodules --list` prints nothing (or no `lib.` keys).

Confirm `deployments/stellar-testnet.json` and `soroban/` are **untouched** (`ls deployments/ soroban/`).

- [ ] **Step 3: Verify the frontend is unaffected**

Run from `frontend/`: `npx vitest run && npm run build`
Expected: PASS + build green (frontend never depended on the Solidity tree). The repo no longer contains a Foundry project.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: delete Solidity stack, Base Sepolia deployment, and EVM CI workflow"
```

---

### Task 7: Doc + env sync (decommission the EVM story)

A teardown that leaves `CLAUDE.md` and `.env.example` describing EVM as current is misleading. Update only the live operator-facing docs; leave the historical `docs/spikes` / ADR records as history.

**Files:**
- Modify: `.env.example`, `CLAUDE.md`

- [ ] **Step 1: Strip EVM-only vars from .env.example**

Open `.env.example` with Read, then with Edit remove the EVM-only keys: `BASE_SEPOLIA_RPC`, `PRIVATE_KEY` (deployer), `USDC_BASE_SEPOLIA`, `VAULT_DEPOSITOR_ADDRESS`, `MOCK_VAULT_ADDRESS`, `AGENT_VAULT_DEPOSITOR_ADDRESS`, `ONESHOT_KEY`/`ONESHOT_SECRET`/`ONESHOT_BIZ_ID`, `ETHERSCAN_API_KEY`, `MAINNET_RPC`/`BASE_MAINNET_RPC`. Keep the Stellar + AI vars (`DEEPSEEK_API_KEY`, `TAVILY_API_KEY`, and whatever `api/stellar-relay.js` reads for the relayer secret + RPC). If unsure which the Stellar relay needs, `git grep -nE "process\.env\.[A-Z_]+" -- frontend/api/stellar-relay.js` and keep exactly those.

- [ ] **Step 2: Update CLAUDE.md to single-chain Stellar**

With Edit, update `CLAUDE.md` so it no longer presents EVM as the live stack: change the "Commands → Smart Contracts (Foundry)" section to the Soroban/`stellar` CLI commands (mirror `soroban/`), drop the EVM env-var block, and add a one-line note under "Current Phase" that the EVM stack was decommissioned (sub-project 6, `2026-06-21`) in favor of Soroban. Do not rewrite the whole file — only the sections that assert EVM is current. Leave the ADR table's historical "Rejected" column as-is (it is accurate history).

- [ ] **Step 3: Final full-repo EVM sweep**

Run from repo root:

```bash
git grep -nlE "ethers|viem|EIP-712|1Shot|base[- ]?sepolia|AgentVaultDepositor|foundry|forge" -- . ':!docs' ':!planning' ':!*.md' ':!soroban'
```

Expected: **no output** outside docs/markdown history. Any live `.js`/`.json`/`.yml`/config hit is residual EVM — remove it before finishing. (Markdown + `docs/**` historical references are intentionally preserved.)

- [ ] **Step 4: Verify + commit**

Run from `frontend/`: `npx vitest run && npm run build && npm run lint`
Expected: tests PASS, build green, lint no new errors. Then from repo root:

```bash
git add -A
git commit -m "docs: decommission EVM in CLAUDE.md + .env.example (single-chain Stellar)"
```

---

### Task 8: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Prove the worklist from Task 0 Step 2 is empty**

Run from repo root:

```bash
git grep -lE "from ['\"]ethers['\"]|from ['\"]viem['\"]|@uxly/1shot-client|@metamask/smart-accounts-kit|@coinbase/cdp-sdk" -- frontend
```

Expected: **no output**. The EVM surface is gone.

- [ ] **Step 2: Prove the Solidity project is gone**

Run from repo root: `ls contracts test script foundry.toml 2>/dev/null; ls soroban deployments/stellar-testnet.json`
Expected: the first `ls` prints nothing (all removed); the second confirms `soroban/` and the Stellar deployment remain.

- [ ] **Step 3: Full green check**

Run from `frontend/`: `npx vitest run && npm run build && npm run lint`
Expected: all suites pass (the EVM suites `relay.test.js`, `positionsStore.test.js`, `keyVault.test.js`, `session.test.js` are gone; the Stellar + strategy suites remain green), `vite build` succeeds, lint clean of new errors.

- [ ] **Step 4: Confirm a single chain layer remains**

Run from repo root: `ls frontend/src/stellar/ && git grep -lE "stellar/(client|walletKit|sessionKey|events)" -- frontend/src | grep -v '/stellar/' | head`
Expected: the Stellar modules list, and kept code (orchestrator/screens/app) importing them — the app now runs entirely on Stellar.

- [ ] **Step 5: Final commit (only if Steps 1–4 produced fixes)**

```bash
git add -A
git commit -m "chore: verify EVM decommission complete (single-chain Stellar, tests + build + lint green)"
```

---

## Self-review (filled in by the plan author)

**Spec coverage** — the arg spec was: delete Solidity (`contracts/ test/ script/ foundry.toml lib/`), `deployments/base-sepolia.json`, EVM frontend chain-layer (`worker.js` EIP-712, `relay.js` 1Shot, `x402.js`, `redelegation.js`, EVM parts of `wallet.js`/`config.js`), ethers/viem deps; keep the AI brain + force-graph UI + orchestrator.
- Solidity + foundry + lib + base-sepolia.json → Task 6. ✓
- `worker.js`/`relay.js`/`x402.js`/`redelegation.js` → Task 1. ✓ (plus `attestation.js`/`readProvider.js`/`redeem.js` found by the ethers/viem grep — same EVM chain-layer, included).
- EVM parts of `wallet.js`/`config.js` → Task 4 (excise, with delete-if-fully-replaced for `wallet.js`). ✓
- ethers/viem deps → Task 5 (plus `@uxly/1shot-client`/`@metamask/smart-accounts-kit`/`@coinbase/cdp-sdk` — the EVM relay/account deps the grep proved EVM-only). ✓
- Keep AI brain (`strategy/**`) + force-graph UI + orchestrator → never deleted; Tasks 2 & 4 guards explicitly STOP if the kept brain still imports an EVM module (catches unfinished SP4). ✓
- Extra, justified: Task 3 (EVM server relay `api/relay.js` — the server half of the 1Shot path), Task 7 (doc/env sync so the repo stops claiming EVM is live). Both are inherent to "decommission EVM".

**Boundaries / safety** — every deletion is grep-guarded against kept code and netted by `vitest` + `vite build`; the plan halts (rather than editing kept files blindly) if the orchestrator/UI still wire to EVM, making it safe to run even if SP4/SP5 are only partially complete. Stellar layer (`frontend/src/stellar/**`, `api/stellar-relay.js`) and `soroban/` + `deployments/stellar-testnet.json` are explicitly excluded from every delete/guard.

**Type/name consistency** — guard patterns reference the exact module basenames deleted in the same task; the `stellar/relay.js` vs `src/relay.js` collision is disambiguated in Task 1 (path-excluded) and Task 3. The Task 0 Step 2 worklist is the single source the Task 8 Step 1 check drives to empty — same grep, start vs end.

**Placeholder scan** — no TODOs; every step is an exact command with stated expected output, or an Edit with the explicit lines/sections to remove. The two judgement points (delete-vs-excise `wallet.js` in Task 4; which env vars the Stellar relay needs in Task 7) are resolved by a concrete `git grep` the engineer runs, not left open.
