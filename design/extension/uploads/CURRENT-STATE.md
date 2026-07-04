# Vibing Farmer — Current State (Code-Verified Snapshot)

> **Date:** 2026-06-28 · **Branch:** `iq` · **Tests:** 312 pass / 46 files (frontend), 3 soroban test files
> **Scope:** single-chain **Stellar / Soroban** (EVM fully decommissioned 2026-06-21)
> **Method:** built from a parallel deep-read of every subsystem + adversarial verification of the 3 headline gaps against source. File:line cites are from that read. Items labelled **VERIFIED** were independently re-checked against code; items labelled **(reader note)** come from a single-pass mapper and are likely-but-not-re-verified.

This file describes the app **as it actually runs today**, not as the README/CLAUDE.md historical sections describe it. Where the two disagree, the code wins and the disagreement is logged in [§7 Stale EVM copy](#7-stale-evm-copy-inventory).

---

## 1. TL;DR

Vibing Farmer is an AI-coordinated agent swarm for automated yield-vault deposits, now running **entirely on Stellar testnet**. A privacy-first AI strategist (Venice / DeepSeek / fallback) produces a multi-vault allocation + a per-agent skill JSON. The user approves once; an Orchestrator authorizes + funds an on-chain agent custom-account per worker, then dispatches Workers in parallel. Each Worker signs a Soroban **deposit auth-entry** with an ephemeral ed25519 session key; a server-side **fee-bump relayer** sponsors gas (user pays 0). A deterministic risk→council→permission pipeline gates execution, and an autonomous monitor loop self-improves a living playbook.

**Three confirmed issues** (all code-verified, [§6](#6-confirmed-gaps-code-verified)):
1. **10× decimal drift** — display layer divides by `1e6` while chain is 7-dp (`1e7`). Split-brain: some modules already correct, display + seed paths still wrong.
2. **"Multi-vault" is advisor fiction** — all catalog entries still point to one vault. *(Yield is no longer mock: as of the 2026-06-28 cutover the vault supplies into the Blend Capital v2 lending pool on testnet — real supply→harvest→redeem proven live, see [§6 GAP-2](#6-confirmed-gaps-code-verified).)*
3. **README + UI copy describe the dead EVM stack** — EIP-7702/ERC-7715/1Shot/MetaMask Flask/Base Sepolia, none of which exist anymore.

---

## 2. Deployment facts (`deployments/stellar-testnet.json`)

| Item | Value |
|------|-------|
| Network | testnet (`Test SDF Network ; September 2015`) |
| RPC | `https://soroban-testnet.stellar.org` |
| Registry | `CAEHOZGUGVNRCAFVJCSR3B2EFJ55LEA34S76HTRQGH7XSPBO7YIMNZOQ` |
| Vault (deposit target) | `CBZNITAPHCLSPEXC3UKIERYRUJR56GISM2G2Z5XD6KZH3U4ZZ76XNQOU` (Blend-USDC, cutover 2026-06-28) |
| Token (Blend USDC) | `CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU` |
| Blend v2 pool (real yield) | `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF` |
| **Decimals** | **7** (token + vault share; 1 VFUSD = 10,000,000 base units) |
| Share symbol | `vfVLT` |
| Relayer (server) | `GBVJ34MT4GDKZJGILI6DRYGD75ZNUBJGGZIDUV7IPFNVVDWGE5GBLV3X` |
| Demo agent account | `CD3MQJ4YZQ5MDSKDETEFZMDV5J5URVXM46NY5Y3RICUOVJJOFIZTKJ7K` (v2) |
| Agent-account WASM hash | `8c607112…540dda62` |

**Dependencies:** EVM deps = **NONE** (verified — no ethers/viem/1shot/web3/wagmi/metamask). Chain deps: `@stellar/stellar-sdk`, `@creit.tech/stellar-wallets-kit`.

---

## 3. End-to-end data flow (current, Stellar)

```
User input (amount, risk level → 1/2/3 agents)
   │
   ▼
AI strategist  (venice.js → resolveProvider: Venice x402/key → DeepSeek key → host /api/ai proxy)
   ├─ live market DAG: DeFiLlama pools + Tavily context + 7-day APY history
   ├─ allocation plan + per-agent skill JSON (deposit-only)
   ├─ Monte Carlo sim (seeded, riskParams → riskMetrics VaR/CVaR)
   └─ AI Council (yield/risk/market specialists) + consensus gate
   │
   ▼
User reviews skill JSON → approves   (fail-closed human gate, permissionLayer)
   │
   ▼
OrchestratorAgent.dispatch()
   ├─ generateAgentSkills (Promise.allSettled) → saveSkill (localStorage)
   ├─ per worker (SERIAL, user-signed): agentSetup.authorizeAndFundAgent
   │     → registry.authorize(owner, agent, vault, token, cap, period, expiry)
   │     → token.transfer(owner → agent, amount)
   └─ per worker (SERIAL, 2s gap): WorkerAgent.execute()
        ├─ submitGate.check (soft breaker)
        ├─ newSessionKey (ephemeral ed25519 = agent signer)
        ├─ runAgentDeposit → buildAgentDeposit(source = relayer)
        │     → signAgentDepositEntries (HashIdPreimageSorobanAuthorization → ed25519 sig)
        │     → submitViaRelay → POST /api/stellar-relay {action:'submit', xdr}
        │           → assertVaultDeposit (whitelist) → feeBumpAndSubmit (relayer secret) → poll
        ├─ verifyMinted (poll readVaultShares until > baseline)
        └─ writeMemory (localStorage 'yv_memory')
   │
   ▼
attestStrategyOnChain → hashStrategy (SHA256 via stellar-sdk) → { strategyHash, txHash: null }   ← OFF-CHAIN only
   │
   ▼
events.pollEvents (registry + vault) → graph deltas → react-force-graph UI
Autonomous monitor loop (monitorLoop, 60s) → gates → sim → council → execute → reflect → journal
Kill switch: revoke.revokeAgentOnChain (user-signed, direct submit — works even if relayer down)
Exit: exit.ownerWithdraw (owner_withdraw on agent custom account)
```

---

## 4. Subsystem map

### 4.1 Stellar chain client — `frontend/src/stellar/`
Browser-side Soroban client. Reads via `simulate`; writes build assembled XDR for either user-wallet signing or agent auth-entry attachment.

| File | Role | Key exports |
|------|------|-------------|
| `config.js` | testnet constants | addresses, `SOROBAN_DECIMALS=7`, `RELAY_PROXY_URL='/api/stellar-relay'` |
| `scval.js` | ScVal codec | `addrScVal`, `i128ScVal`, `u64ScVal`, `fromScVal` |
| `client.js` | invocation core | `readContract` (L42), `buildInvokeTx` (L66), `submitUserTx` (L97), `horizonNativeBalance` (L114) |
| `sessionKey.js` | ephemeral agent key | `newSessionKey` (L19) → ed25519 `{publicKey, rawPublicKey, secret, sign}` |
| `agentDeposit.js` | gasless deposit | `signAgentDepositEntries` (L29), `buildAgentDeposit` (L63), `runAgentDeposit` (L82), `readVaultShares` (L90), `readTokenBalance` (L105), `AUTH_TTL_LEDGERS=360` |
| `agentSetup.js` | user-signed auth+fund | `authorizeAndFundAgent` (L16) — `registry.authorize` then `token.transfer` |
| `events.js` | event poll → graph | `decodeEvent`, `eventToGraphDelta` (authorized/revoked/deposit/redeem/drip/claim), `pollEvents` |
| `revoke.js` | kill switch | `revokeAgentOnChain` (direct submit, NOT via relay), `subscribeAgentRevoked` |
| `exit.js` | owner exit | `ownerWithdraw` (owner_withdraw sweep) |
| `relay.js` | relay client | `submitViaRelay`, `getRelayerAddress` |
| `walletKit.js` / `walletKitLoader.js` | wallet connect | `connectWallet`, `getUserAddress`, `signTxXdr`; lazy Freighter/xBull/Albedo |
| `index.js` | barrel | public chain API |

### 4.2 Gasless relay + API security — `frontend/api/`
Fee-bump relayer + shared origin/rate-limit guard. Runs as Node handlers wrapped into Cloudflare Pages Functions.

| File | Role | Key exports |
|------|------|-------------|
| `stellar-relay.js` | fee-bump sponsor | `feeBumpAndSubmit` (L82), `assertVaultDeposit` (L44, deposit-only whitelist), `_seen` replay Map (L30, 30-min TTL), `handler` (L151: `/wallet`, `/submit`) |
| `_guard.js` | CORS + rate limit | `applyCors` (origin allowlist), `rateLimit` (per-IP fixed window), `clientIp` (XFF via `TRUST_PROXY_HOPS`) |
| `_pagesAdapter.js` | Pages bridge | `toPagesFunction` — maps `context.env`→`process.env`, CF-Connecting-IP→x-real-ip, fail-closed 502 |
| `ai.js` | DeepSeek proxy | model allowlist (`deepseek-v4-pro`/`-flash`), msg validation (≤10, ≤100k chars), 30/min |
| `search.js` | Tavily proxy | query ≤500 chars, `max_results`≤5, 30/min |

**Trust model:** the relayer is a "dumb fee sponsor" — it does NOT authorize the deposit. Authorization is the on-chain `AgentAccount.__check_auth` ed25519 signature + the `assertVaultDeposit` whitelist. Origin header is defense-in-depth only (forgeable by curl).

### 4.3 Agent swarm runtime — `frontend/src/`
| File | Role | Key exports |
|------|------|-------------|
| `orchestrator.js` | dispatch flow | `OrchestratorAgent.dispatch` (L43); `BASE_UNIT=10**SOROBAN_DECIMALS=1e7` (L11), `PERIOD_DURATION=86400`, `SCOPE_TTL=3600`, `DISPATCH_INTERVAL_MS=2000` |
| `worker.js` | single deposit | `WorkerAgent.setupKey`/`execute`/`verifyMinted`; signs auth ENTRY not tx |
| `memory.js` | localStorage memory | `createEntry`, `writeMemory`, `loadAllMemory`, `buildLesson` ('yv_memory') |
| `skills.js` | skill JSON + editor | `DEPOSITOR_TARGET` (throws on invalid), `buildSkill` (rejects worker-EOA target), `approveSkill`, `renderSkillEditor` |
| `skillLoader.js` | advisor skill | `loadVaultSkill` (localStorage → user file → bundled → hardcoded fallback) |
| `attestation.js` | strategy hash | `hashStrategy` (SHA256 via stellar-sdk), `attestStrategyOnChain` → **txHash always null (off-chain)** |

### 4.4 Risk → Council → Permission pipeline — `frontend/src/strategy/`
TradingAgents-style governance. Three council entry points + fail-closed human gate.

| File | Role |
|------|------|
| `gates.js` | fast-fail gates (FinRL turbulence index): turbulence/gas/capital/universe; defensive actions always pass |
| `riskParams.js` | param fusion + Monte Carlo runner (`DEFAULT_RUNS=10000`, 30-day, seeded) |
| `riskMetrics.js` | VaR / CVaR (Expected Shortfall) from MC sample |
| `council.js` | deterministic monitor-loop council (yield/risk/market); synthesis: hard-veto (Risk WITHDRAW>0.85) → unanimity → weighted-majority → 1 AI tie-break |
| `councilReview.js` | AI-first wizard council (real DeepSeek calls, role-filtered playbook subsets) |
| `councilLoop.js` | bounded VaR/CVaR debate; deterministic Validator short-circuit, then cite-or-abstain, max 2 iters |
| `riskCouncil.js` | Phase-1 orchestrator: context → sim → debate → human gate; `awaitingHuman:true, executed:false` (never executes on this path) |
| `permissionLayer.js` | human gate → 1 sentence + Yes/No; fail-closed allow-list (converge+proceed+answer==true) |
| `permissionScope.js` | single grant source-of-truth; `toAuthorizeArgs`, `maxAtRisk`; **BigInt cap** to prevent UI/chain divergence |
| `decisionLog.js` | ACC verdict log (EvoDS), localStorage ring buffer (max 100) |
| `submitGate.js` | soft circuit breaker (stale_gas / uneconomic / rate_anomaly), bounded ring buffer |

### 4.5 Autonomous monitor loop (ACE living playbook + MDP) — `frontend/src/strategy/`
Deterministic 60s self-improving loop. RNG fully seeded (Mulberry32) → every sim replayable.

| File | Role |
|------|------|
| `monitorLoop.js` | never-stop spine: observe→gate→simulate→council→execute→reflect→journal; resilience-first (no error stops loop) |
| `simulation.js` | Monte Carlo sweep (cadCAD-style), 3 weighted scenarios (bull/base/bear) |
| `mdp.js` | FinRL observation builder, 3-regime turbulence, `riskCeiling`, `enforceActionSpace`, reward scoring |
| `curator.js` | ACE grow — propose rules from notable outcomes via AI (fire-and-forget) |
| `merge.js` | ACE dedup — char-trigram cosine, within-role, threshold 0.8 |
| `prune.js` | ACE refine — hard-delete grown rules (evals≥5 AND harmful≥helpful×2); seeds retire-only |
| `ruleStore.js` | living playbook localStorage, Laplace-smoothed weight [0.5,1.5] |
| `seeds.js` | 20 protected baseline rules (yield/risk/market) |
| `reflector.js` / `outcome.js` | counter feedback after exec |
| `cycleJournal.js` | append-only audit ledger (max 100) |
| `rng.js` | Mulberry32 + Box-Muller gaussian, no global Math.random |
| `behavioral.js` | herd-stress model — **deterministic mock**; `emergentStress` is a local approximation (effect-mimicry, not a real engine) |
| `gasSnapshot.js` | **mock** — `{gwei:0, level:'normal', sponsored:true}` |
| `fetchDag.js` | EvoAgentX DAG fetch, parallel layers |
| `sessionResume.js` | wizard snapshot resume (stores no session key) |

### 4.6 Soroban contracts — `soroban/contracts/`
| Contract | Role | Notable |
|----------|------|---------|
| `rwa_vault` | stable-NAV (1:1) deposit/redeem + pro-rata dividend (cumulative `acc_div_per_share`, SCALE `1e12`) | `deposit`/`redeem`/`drip`/`claim`/`claimable`; `drip()` = **admin-only MOCK yield** (treasury transfer); `redeem` not pause-gated (exit-anytime) |
| `registry` | tracks authorized agents (cap/expiry metadata) | `authorize`/`revoke` |
| `agent_account` | custom smart wallet, session-key sigs + rolling cap (deposit-only), owner emergency withdraw | `__check_auth`; per-account revoke/expiry/cap state (no persistent scope-sync with registry) |

### 4.7 AI provider chain + market data — `frontend/src/`
BYOK-first: Venice x402 wallet auth → Venice API key → DeepSeek key → host `/api/ai` proxy. Both Venice & DeepSeek use slug `deepseek-v4-flash` (different endpoint/auth).

| File | Role |
|------|------|
| `venice.js` | `resolveProvider` (L92), `generateStrategy` (L140), `generateAgentSkills` (L363), `classifyRisk` (L492), `councilSpecialistVerdict` (L620). Contains **inert ERC-7715 docstring refs** |
| `config.js` | endpoints, model IDs, `VAULT_CATALOG` (4-vault fallback Aave/Morpho/Pendle/Fluid — **all route to the one `SOROBAN_VAULT_ADDRESS`**) |
| `settingsStore.js` | BYOK keys in sessionStorage (cleared on tab close), prefs in localStorage |
| `defiLlama.js` | real `https://yields.llama.fi/pools` fetch (Ethereum+USDC, 6 protocols, ≥$1M TVL) |
| `marketSearch.js` | Tavily context (BYOK or `/api/search`, 503 on lockdown) |
| `apyHistory.js` | 7-day APY history |
| `flaskDetect.js` | **dead/inert** — MetaMask Flask + ERC-7715 detection, no longer applies to Stellar |

---

## 5. Test & build status

- **Frontend:** `308 passed (46 files)` via `cd frontend && npx vitest run` — VERIFIED green.
- **Soroban:** 3 Rust test files (`rwa_vault/src/test.rs` etc.); run under WSL only.
- **Build:** Vite; Cloudflare Pages-ready (`/api/*` as Pages Functions).

---

## 6. Confirmed gaps (code-verified)

### GAP-1 — 10× decimal drift (split-brain) · **CRITICAL** · VERIFIED
Chain is **7-dp** but the display layer divides by **`1e6`**, rendering balances **10× too high**. Worse: the codebase is half-migrated — some modules use the correct `1e7`, others still `1e6`, so **seed and chain positions sum incorrectly when both exist**.

Correct (1e7) already:
- `stellar/config.js:22` — `export const SOROBAN_DECIMALS = 7`
- `orchestrator.js:11` — `const BASE_UNIT = 10 ** SOROBAN_DECIMALS // 1 VFUSD = 10_000_000`
- `positionsStore.js:77-78` — `// ponytail: balance is base-unit (7-dp) string — render sites must divide by 1e7 (SOROBAN_DECIMALS), not the legacy EVM 1e6.`

Still wrong (1e6):
- `components/AgentDashboard.jsx:9` — `const u = (units) => Number(units || 0) / 1e6`
- `components/HomePage.jsx:16` — `const u = (x) => Number(x || 0) / 1e6`
- `app.jsx:1938` — `{(Number(s.maxAtRisk) / 1e6).toFixed(2)}`
- `app.jsx:1472` — `const newBal = BigInt(Math.round(a.allocation * 1e6))` (seed position written at 1e6 scale)

**Impact:** real on-chain reads (`readVaultShares`/`readTokenBalance` return 1e7 base units) render 10× inflated; seed-vs-chain position totals diverge. **Fix:** replace every render-site `1e6` with `1e7` / `SOROBAN_DECIMALS` (single divisor helper), and fix the `app.jsx:1472` seed writer. Smallest, highest-value fix.

### GAP-2 — Yield NOW REAL (Blend v2 live on testnet); "multi-vault" still advisor fiction · UPDATED 2026-06-28

**Yield (RESOLVED):** the vault supplies deposits into the **Blend Capital v2** lending pool on testnet. Cutover 2026-06-28 — vault redeployed on Blend testnet USDC (`CAQCFVLO…RCJU`), pool `CCEBVDYM…44HGF` wired via `set_pool`. `deposit` → Blend supply (b_token position), `harvest` → real supply-interest delta distributed pro-rata, `redeem` → withdraw from Blend then pay holder. `drip()` retained as the no-pool offline fallback.
- Full supply→harvest→redeem round trip **proven live** on the v2 pool (100 USDC): vault USDC → 0 with real Blend `supply:{3:947161340}` b_token position after deposit; principal fully recovered on redeem; position empty after. Harvest interest ≈ 0 over the short hold — honest: testnet supply rate accrues over time (pool `b_rate` 1.0557 = real accrued interest), not in a one-minute window.
- Verified on-chain: `vault.pool()` == `CCEBVDYM…44HGF`; vault Blend position present after deposit, empty after redeem.
- `rwa_vault/src/vault.rs` — `deposit`/`redeem`/`harvest` route through the wired pool; `set_pool` one-time admin wiring; `pool()` getter returns `Some(pool)`.

**Multi-vault (STILL OPEN):** "multi-vault" remains advisor fiction.
- `config.js` — every catalog entry → `SOROBAN_VAULT_ADDRESS` (unchanged); the universe is what the advisor reasons over, not separate vaults.

**Impact:** yield is now real lending interest on testnet (frame honestly: testnet supply rate, near-zero over a short hold). Deposits still all land in one vault — keep the multi-vault caveat for any public/demo claim.

### GAP-3 — README + UI describe the dead EVM stack · VERIFIED
README and ~20 UI components still claim EIP-7702 / ERC-7715 / 1Shot EIP-7710 / MetaMask Flask / Base Sepolia / Solidity `AgentRegistry.sol`+`AgentVaultDepositor.sol` — **none of which exist**. Actual system is Stellar fee-bump + ed25519 + Soroban.

README hits: `:21` (EIP-7702 Flask upgrade), `:23` (`IERC20.approve`+`authorizeSessionKey` EIP-712), `:25` (1Shot EIP-7710), `:27` (`AgentVaultDepositor.attestStrategy`), `:31` (`AgentRegistry.revokeAgent`), `:60`, `:96`, `:112-114` (Solidity sigs), `:73-80` (dead Base Sepolia addresses incl. `0x1f5eb2…A4AA`).
UI hits: see [§7](#7-stale-evm-copy-inventory). **Impact:** total — every user-facing "how it works" is wrong; new users will hunt for nonexistent contracts.

---

## 7. Stale EVM copy inventory

User-facing strings still naming the dead EVM stack (Stellar has no 1Shot/relayer-gas-abstraction/ERC-7715/Flask/Base Sepolia). (reader note — line numbers from single-pass read, confirm before editing.)

- `screens.jsx` — L57 "relayed via 1Shot", L114 "24 active vaults on Base Sepolia", L175-325 ConnectCard (EIP-7702/ERC-7715/Flask/Base Sepolia/1Shot), L262 "1Shot Permissionless · EIP-7710", L245, L348 "Scoped permission · ERC-7715", L528 "gas paid by 1Shot relayer"
- `app.jsx` — L337/L345 Flask version detect, L343 "Flask gate for ERC-7715", L811 "fresh ERC-7715 permission", L1137 (comment acknowledges Stellar has no ERC-7715 but EIP-7702/7715 prompts still run), L1289 "via 1Shot relayer"
- `components.jsx` — L102 "relayer 1Shot · gas 0" (TopBar)
- `RightRail.jsx` — L32 "EIP-7702 active", L69 "ERC-7715 · batch"
- `agents.jsx` — L944 "1Shot relayer · parallel"
- `AgentActionPreview.jsx` — L39/L48 "Gas ~0 · 1Shot relayer", "ERC-7715"
- `EcosystemPage.jsx` — entire page = EVM stack (EIP-7702/7715/7710/Base Sepolia/1Shot) + ASCII diagram
- `FlaskGate.jsx` — entire component gates on MetaMask Flask + ERC-7715
- `HomePage.jsx` — L288 "relayer 1Shot · gas 0 · network sepolia"
- `LandingHero.jsx` — L32/L39-40/L98/L156 (1Shot/EIP-7702/ERC-7715/Base Sepolia)
- `OnboardingFlow.jsx` — L31/L54 ("1Shot relayer covers the gas", "MetaMask Flask")
- `SettingsPage.jsx` — L826/L962/L996/L1019/L1023/L1027 (1Shot/Base Sepolia/MetaMask/ERC-7715)
- `SkillDetailModal.jsx` — L50 "ERC-7715 scoped permission"
- `TxDetailPage.jsx` — L109 "View on Base Sepolia Basescan"
- `VaultDetailPage.jsx` — L164 "Base Sepolia testnet"
- `WithdrawModal.jsx` — L94/L119 "1Shot relayer"
- `skills.jsx` — L50 "single-vault deposit via ERC-7715 scoped permission"
- `flaskDetect.js` — whole file (Flask + ERC-7715 detection, inert)
- `venice.js` — inert ERC-7715 docstring in `generateAgentSkills`

Replace with Stellar equivalents: "fee-bump relayer · gas 0", "Soroban session-key scope", "ed25519 agent auth", "Stellar testnet".

---

## 8. Secondary findings (worth tracking, lower severity)

- **Multi-agent is partly stubbed:** `orchestrator.js` hardcodes `SOROBAN_DEMO_AGENT` for every worker (per the runtime map) — per-worker agent-account deploy is not yet wired, so N workers currently share **one** on-chain agent account. (reader note)
- **On-chain attestation dropped:** `attestation.js` returns `txHash:null` — strategy hash is computed off-chain only. The old EVM `attestStrategy` had no Stellar replacement. (VERIFIED — off-chain)
- **Relay anti-abuse is process-local:** `_seen` replay guard and `_buckets` rate limiter are warm-process in-memory only → not distributed, reset on deploy; a multi-replica deploy weakens both. Origin allowlist is defense-in-depth, not auth. (reader note)
- **authorize→fund not atomic:** `agentSetup.authorizeAndFundAgent` — if `token.transfer` fails after `registry.authorize` succeeds, the agent is authorized but unfunded (no rollback). (reader note)
- **`RELAY_PROXY_URL` is a relative path** (`/api/stellar-relay`) — breaks under non-root deploy paths. (reader note)
- **`gasSnapshot.js` is a mock** (`gwei:0, sponsored:true`) — fine for Stellar fee-bump, but flagged as a stub if real fee realization is ever needed.
- **`behavioral.js` emergent stress is a local approximation**, not a real engine — honest per the "prove claims in code" standard; keep labelled.

---

## 9. Where reality lives (read these, not the historical docs)

- Chain: `soroban/contracts/` + `frontend/src/stellar/` + `frontend/api/stellar-relay.js`
- Addresses: `deployments/stellar-testnet.json`
- Strategy engine: `frontend/src/strategy/`
- The README "How it works"/"Architecture" and the CLAUDE.md architecture/ADR/contract sections are **migration history** (EVM), retained but not current.

---

## 10. Commands (from CLAUDE.md)

```bash
# Soroban (WSL only)
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && stellar contract build"
wsl -e bash -lc "cd /mnt/c/SharredData/project/competition/vibing-farmer/soroban && cargo test"

# Frontend
cd frontend && npm run dev
cd frontend && npm test
cd frontend && npm run build
```
