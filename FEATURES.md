# Vibing Farmer — Feature Guide

> **Set once. Vibe forever.**

This document explains every feature of Vibing Farmer for two audiences at once: judges and curious humans who don't write Solidity or Rust for a living, and engineers who want the exact contract calls and file paths. Every section leads with a plain-language explanation, then drops into the technical flow underneath. Every claim here is grounded in the actual code and live testnet deployments — where something is a demo, a mock, or unfinished, this document says so.

---

## Table of Contents

1. [What is Vibing Farmer?](#1-what-is-vibing-farmer)
2. [The 60-Second Story](#2-the-60-second-story)
3. [Feature Deep Dives](#3-feature-deep-dives)
   - [3.1 AI Strategist](#31-ai-strategist)
   - [3.2 AI Council](#32-ai-council)
   - [3.3 Eligibility Gate ("F8")](#33-eligibility-gate-f8)
   - [3.4 One-Signature Grant](#34-one-signature-grant)
   - [3.5 Agent Accounts + Session Keys](#35-agent-accounts--session-keys)
   - [3.6 Gasless Execution](#36-gasless-execution)
   - [3.7 Parallel Agent Swarm](#37-parallel-agent-swarm)
   - [3.8 Real Yield](#38-real-yield)
   - [3.9 Keeper Autonomy + Lifeboat Radar](#39-keeper-autonomy--lifeboat-radar)
   - [3.10 On-Chain Attestation](#310-on-chain-attestation)
   - [3.11 Cross-Chain Optional Leg](#311-cross-chain-optional-leg)
   - [3.12 Wallets + On-Ramp](#312-wallets--on-ramp)
   - [3.13 Backend API](#313-backend-api)
   - [3.14 User Interface](#314-user-interface)
4. [Architecture at a Glance](#4-architecture-at-a-glance)
5. [Live Deployments](#5-live-deployments)
6. [Security & Trust Model](#6-security--trust-model)
7. [What's Real vs. What's Demo](#7-whats-real-vs-whats-demo)
8. [Glossary](#8-glossary)
9. [FAQ for Judges](#9-faq-for-judges)

---

## 1. What is Vibing Farmer?

### The elevator pitch

Vibing Farmer is an AI-coordinated swarm of autonomous agents that farm yield on Stellar's Soroban smart-contract platform. You tell it how much money, how much risk, and how many "workers" you want. An AI strategist designs an allocation plan, a panel of AI specialists argues about whether it's safe, and a fail-closed risk gate double-checks the facts against live protocol data. You sign your wallet **exactly once**. From that single signature, the app deploys a small swarm of disposable, cryptographically leashed worker accounts that fund themselves, deposit into a real lending pool (Blend Capital), and keep working — compounding interest and standing ready to bail out to safety — without asking you to sign anything else, and without you paying a cent of network gas.

### The problem: yield farming is a chore

Today, "yield farming" in DeFi typically means: find a vault, check the protocol isn't a rug, approve a token, deposit, wait, come back, harvest, redeposit, and repeat across every protocol you want exposure to. Each of those steps is its own wallet pop-up, its own gas fee, and its own chance to fat-finger an amount or approve the wrong contract. Users on X/Twitter describe this candidly: *"bridge → swap → find the right vault → deposit… and hope you didn't miss a step"* and note that only "~15–18% of wallet connects end in a real transaction" — because the process is simply too tedious to finish. The industry's other answer — handing a bot full wallet access — trades tedium for a different kind of risk: unlimited custody.

### The one-sentence solution

Vibing Farmer lets a user express intent once (amount, risk tolerance, number of agents) and enforces every boundary of what happens next in cryptography and smart-contract code — a spending allowance with an expiry, not a promise from a bot — while an AI strategist and a council of risk specialists do the deciding, and gas-sponsoring infrastructure means the user never pays a network fee.

### Explain it to my grandmother

Imagine you want to put $100 into a savings account, but instead of walking into the bank yourself, you hire a few trustworthy interns. You don't hand them your whole wallet — you give them a single signed note that says "you may spend up to $100 from my account, and only until next Tuesday, and only to deposit into this one specific savings account." That note is the only thing you sign. The interns then go do the depositing themselves, and a courier service that already agreed to work for the bank pays for their bus fare (gas) so you don't have to. If a storm warning comes in (a risky market event), a guard you separately authorized can pull all the money out of the savings account and put it somewhere safe — but only if your permission slip for *that guard* is still valid. You can cancel the interns' note instantly, at any time, with one more signature.

---

## 2. The 60-Second Story

This is the end-to-end user journey, step by step. Each step lists **what the user sees** and **what happens under the hood**.

### Step 1 — Connect a wallet

- **User sees:** A "Connect Wallet" button; a picker for Freighter, xBull, Albedo, or the project's own VF Wallet (passkey-based).
- **Under the hood:** The app calls into `@creit.tech/stellar-wallets-kit` (`frontend/src/stellar/walletKit.js`) to get a Stellar `G...` address. No permission is requested yet — connecting a wallet is just an identity handshake, not a spending authorization.

### Step 2 — Enter amount, risk, and agent count

- **User sees:** A simple form: deposit amount (USDC), a risk slider (low/medium/high), and how many worker agents to split the deposit across.
- **Under the hood:** These three numbers (`amount`, `riskLevel`, `numVaults`) become the seed for everything that follows — the AI prompt, the Monte Carlo simulation, and the eventual per-agent spending caps.

### Step 3 — AI strategist + council + eligibility gate run

- **User sees:** A "Building your plan" animation while live market data loads.
- **Under the hood (in order):**
  1. The strategist (`frontend/src/strategist.js`) fetches live vault data from DeFiLlama and market context from Tavily, in parallel, with an overall 15-second timeout.
  2. It calls an AI model (Venice, then a DeepSeek proxy, then a deterministic equal-split fallback — see [§3.1](#31-ai-strategist)) to produce an allocation across vaults.
  3. Three deterministic AI-council specialists (Yield, Risk, Market) each vote on the strategy; the Risk specialist has hard veto power (see [§3.2](#32-ai-council)).
  4. The fail-closed eligibility gate (nicknamed "F8" in code comments) checks each candidate protocol against live TVL, audit status, yield-to-revenue ratio, and oracle-safety facts, and drops anything that doesn't qualify (see [§3.3](#33-eligibility-gate-f8)).
  5. A Monte Carlo simulation (200 scenarios, 30-day horizon) sanity-checks the resulting allocation before it's shown to the user.

### Step 4 — Review the generated skills

- **User sees:** A card listing each worker agent, its target vault, allocation percentage, expected APY, and a plain-language reason for the pick. Every field is editable in a slide-out drawer before approval.
- **Under the hood:** Each agent gets a typed "skill" JSON — essentially a permission slip — capped to a `maxAmount` (in 7-decimal base units) and an expiry timestamp. Nothing executes until the user clicks approve.

### Step 5 — ONE wallet signature

- **User sees:** A single wallet pop-up. That's it — one signature for the whole run.
- **Under the hood:** The wallet signs a call to `funding_router.grant(owner, budget, expiry_ledger, agents[])`. This one signature simultaneously (a) sets a SEP-41 token allowance from the user to the router (the spending leash) and (b) deploys N fresh `agent_account` contracts, one per worker, each pre-scoped to its own vault, cap, and expiry. See [§3.4](#34-one-signature-grant).

### Step 6 — Agents deploy and deposit, gas-free

- **User sees:** A live force-graph of orchestrator → worker agents → vault, with nodes lighting up as each agent's deposit lands. No further pop-ups.
- **Under the hood:** Each worker signs a Soroban authorization entry with its own ephemeral ed25519 **session key** (a "valet key" — see [§3.5](#35-agent-accounts--session-keys)), which authorizes only a deposit into its assigned vault, up to its cap. Workers are dispatched in sequence with a short delay between each to respect relay rate limits (not simultaneously — see the honest note in [§3.7](#37-parallel-agent-swarm)), and one worker's failure does not abort the others. Every transaction is fee-bumped by the app's own relay (see [§3.6](#36-gasless-execution)) — the user's wallet never pays XLM.

### Step 7 — Vault supplies Blend

- **User sees:** A position showing shares in the "Vibing Farmer Autofarm" vault (`vfVLT`), with a projected yield.
- **Under the hood:** The autofarm vault (an ERC-4626-style share ledger) forwards the deposited USDC to a strategy contract, which supplies it into the **Blend Capital v2** lending pool on Stellar testnet — a real lending market, not a simulated interest drip. See [§3.8](#38-real-yield).

### Step 8 — Keeper compounds

- **User sees:** The share price (price-per-share) of the vault slowly ticking up over time; a "keeper" events feed in the ops console.
- **Under the hood:** A dedicated keeper identity (separate from the relayer) calls `compound()` on a schedule, harvesting interest and BLND emissions from Blend and sweeping them back into the vault, raising the price of every share. See [§3.9](#39-keeper-autonomy--lifeboat-radar).

### Step 9 — Lifeboat guards

- **User sees:** A radar-style widget in the ops console showing ARMED / ENGAGED / DISARMED, and a "renew 24h mandate" button.
- **Under the hood:** A separate radar process evaluates the pool's health roughly every Stellar ledger (~6 seconds) — utilization spikes, liquidity drops, oracle price divergence. If it detects danger **and** the user has an active, time-boxed "mandate" granted, it can autonomously call `emergency_derisk()` to pull funds out of the strategy back to vault-idle. Without a live mandate, it only raises an alarm — it never acts on its own initiative. See [§3.9](#39-keeper-autonomy--lifeboat-radar).

### Step 10 — Graph + memory update

- **User sees:** The `/agent` operations console: a live force-directed graph of every agent's status, a council decision log, position values, and keeper/lifeboat activity, all updating in real time.
- **Under the hood:** Every agent writes memory entries (step, status, shares minted, timing, and a "lesson") to `localStorage`, which is re-surfaced in the graph's node-detail modal and can feed back into future AI strategy sessions.

### Revoke, anytime

At any point, one more signature (`token.approve(router, 0)`) instantly zeroes out the spending allowance. No contract-level admin function is needed — the leash itself is the kill switch.

---

## 3. Feature Deep Dives

### 3.1 AI Strategist

**What & why.** The strategist is the "financial advisor" of the swarm — it looks at your amount, risk tolerance, and live market data, then proposes how to split your deposit across vaults. Because AI providers can be slow, expensive, unavailable, or simply refuse to answer, the strategist is built as a **chain of fallbacks that never blocks**: if the fanciest option isn't available, it quietly steps down to a simpler one, all the way down to a deterministic equal split that requires no AI at all and never fails.

**Provider priority chain** (`frontend/src/strategist.js`, function `resolveProvider` / `resolveProviderFromSettings`):

1. **Venice x402** — the user signs a wallet-based SIWE (Sign-In-With-Ethereum-style) message to pay for the AI call directly, no API key needed.
2. **Venice API key (BYOK)** — user pastes their own Venice key in Settings; called directly from the browser.
3. **DeepSeek API key (BYOK)** — same idea, user's own DeepSeek key.
4. **Host proxy** — falls back to the app's own server-side `/api/ai` endpoint (DeepSeek, key held only in deploy environment). On a "BYOK lockdown" deploy, this key is intentionally unset, so the app degrades to option 5.
5. **Deterministic fallback** — `buildFallbackForParams()` does an equal-split allocation across the static vault catalog. Zero cost, cannot hang, cannot fail.

**Step-by-step flow** (`generateStrategy({ amount, riskLevel, numVaults, ... })`):

1. **Parallel data fetch (15s budget):** live vault catalog from DeFiLlama, market context from Tavily, plus gas/position/market-signal snapshots, all fetched concurrently via a small fetch-DAG. Any timeout or failure falls back to a static catalog and a null market context — the run is never blocked waiting on the network.
2. **Prompt assembly:** a system prompt (the "vault-advisor" skill) has its `[VAULT_CATALOG_JSON]` placeholder replaced with the real (or fallback) vault data, and — if available — a "## LIVE MARKET CONTEXT" section appended from Tavily.
3. **AI call:** the resolved provider is called with `response_format: json_object` and a hard per-call timeout (`VENICE_TIMEOUT_MS`).
4. **Response validation** (`validateStrategyResponse`): every selected vault address must already exist in the allowlisted catalog (no hallucinated addresses are accepted), each `reasoning` string must be at least 20 characters, `expected_apy` must be in (0, 100], `allocation` in (0, 1], `risk_tier` must be one of low/medium/high, and allocations must sum to ~1.0 (±1%).
5. **Formal decision framing (MDP):** the strategist also frames the decision as a small Markov Decision Process — a `STATE` (amount, risk, market turbulence, gas level), an `ACTION` (the vault selection, clamped to the risk ceiling and renormalized), and a `REWARD` score — mirroring the FinRL style of framing used in quantitative trading research.
6. **Attestation & history:** the final (enforced) strategy is hashed (`hashStrategy`) for later on-chain attestation, and the full session (amount, risk, vaults, per-vault reasoning, DAG timings) is written to `localStorage` for the decision log and future AI context.
7. **Monte Carlo check:** a seeded 200-run, 30-day simulation (`frontend/src/strategy/simulation.js`) sanity-checks the resulting allocation before it's shown to the user.

**Agent skill generation:** for each worker, `generateAgentSkills()` produces a typed JSON permission slip:
```json
{
  "agentId": "worker-agent-1",
  "vaultAddress": "CDWHNHIH...KM77",
  "skills": {
    "deposit": { "maxAmount": "1000000000", "vaultAddress": "CDWHNHIH...KM77", "expiresAt": 1749686400 }
  },
  "generatedBy": "venice-ai",
  "approvedByUser": true
}
```
If the AI call fails, a deterministic fallback skill (deposit-only, capped, 1-hour default expiry) is substituted — the flow never throws.

**Key files:** `frontend/src/strategist.js`, `frontend/src/defiLlama.js` (live vault data), `frontend/src/marketSearch.js` + `frontend/api/search.js` (Tavily), `frontend/src/strategy/simulation.js`, `frontend/src/attestation.js`, `frontend/src/history.js`.

**For judges:** the strategist can never crash or hang the product — every provider tier down to "no AI at all" produces a valid, boundable, spend-capped result, and every AI-selected address is checked against an allowlist before it's trusted.

---

### 3.2 AI Council

**What & why.** Think of the council as three specialist advisors sitting across the table from the strategist, each looking at the plan from a different angle, before it's allowed to proceed. They are cheap, deterministic (rule-based, not AI calls) by default — so the council never adds AI latency or cost unless the specialists genuinely disagree, in which case exactly one AI call breaks the tie.

**The three specialists** (`frontend/src/strategy/council.js`, inspired by the "TradingAgents" multi-agent debate framework, arXiv 2412.20138):

| Specialist | Rules | Default |
|---|---|---|
| **Yield Analyst** | Harvest = free reward claim → DEPOSIT (0.8 confidence). Risk-adjusted uplift detected → DEPOSIT (0.6–0.95, scaled to uplift size) | No uplift → HOLD (0.6) |
| **Risk Analyst** (has hard veto power) | Turbulent market → WITHDRAW (0.9) **[veto]**. Gate violations → WITHDRAW (0.88) **[veto]** | Calm, no violations → DEPOSIT (0.6) |
| **Market/Gas Analyst** | Harvest timing always fine → DEPOSIT (0.75). Net gain (APY − gas) > 0 → DEPOSIT (0.8) | Gas exceeds gain → HOLD (0.7) |

**Verdict synthesis algorithm:**

1. **Hard veto:** if the Risk Analyst says WITHDRAW with confidence > **0.85**, the strategy is rejected immediately — no vote-counting needed.
2. **Unanimous:** if all three specialists agree on DEPOSIT, it's kept (confidence = their average). If all three agree on HOLD/WITHDRAW, it's discarded.
3. **Weighted majority:** confidence scores are tallied by signal. If DEPOSIT's total exceeds HOLD+WITHDRAW's total by more than a 0.25 margin (or vice versa), that side wins.
4. **Genuine split:** only when the vote is genuinely close does the system escalate to **one bounded AI call** (`resolveCouncilConflict`), which is explicitly instructed to be safety-first (prefer HOLD/WITHDRAW when unsure). If even that call fails, the result defaults to HOLD.

**Return shape:**
```js
{
  verdict: 'keep' | 'discard',
  reason: 'Risk Analyst' | 'AI synthesis' | null,
  confidence: 0.0–1.0,
  citedRules: [...],
  specialists: [{ role, signal, confidence, citedRules, concerns }],
  resolvedBy: 'veto' | 'unanimous' | 'weighted' | 'ai-conflict'
}
```

**A second, deeper council for strategy-level risk** (`frontend/src/strategy/councilLoop.js`) exists alongside the deposit-gate council above: a bounded (max 2 rounds) proposer / risk-compliance / validator debate loop over VaR/CVaR tail-risk metrics, used to sanity-check a proposed strategy's simulated risk against a compliance corpus before it converges, no-consensuses, or fails fatally (e.g. if the proposer's cited numbers don't match the simulation). This is distinct from the per-deposit Yield/Risk/Market gate above; both exist in the codebase and both are deterministic-first with a single bounded AI call as tie-breaker.

**Key files:** `frontend/src/strategy/council.js`, `frontend/src/strategy/councilLoop.js`, `frontend/src/strategist.js` (`resolveCouncilConflict`, `councilSpecialistVerdict`).

**For judges:** the council can reject a strategy without ever calling an AI model — the safety-critical path (the Risk Analyst's veto) is pure deterministic code, and AI is used only to break a tie, with a hard-coded safety-first bias.

---

### 3.3 Eligibility Gate ("F8")

**What & why.** Before any protocol is allowed into the allocation, it has to pass a background check — like a landlord checking references before renting an apartment. This gate exists specifically to catch two classes of danger: protocols paying out yield they can't actually afford (a Ponzi pattern), and protocols with weak security practices (no audit, thin governance, no oracle circuit breaker). It is **fail-closed**: if the facts needed to clear a protocol aren't available or aren't fresh, that protocol is rejected by default, not admitted by default.

**Required facts** (each must be present and no older than 30 days): `annualizedDistributed` (claimed APY), `protocolRevenue` (actual on-chain revenue), `audit` status, `ageDays`, `tvl`, `adminKey` (governance type), `oracleType`, `collateralLiquidityDepthUsd`, `poolClass` (curated vs. community), `supplierConcentrationPct`.

**Test 1 — Yield Reality (anti-Ponzi):**
```
ratio = annualizedDistributed / protocolRevenue
ratio < 1.5  → "real"     (pass)
ratio ≥ 1.5  → "ponzi"    (reject — paying more than it earns)
either null  → "unknown"  (reject — can't verify, so don't trust)
```

**Test 2 — Security Score (weighted, threshold 60/100):**

| Component | Weight | How it's scored |
|---|---|---|
| Audit | Hard gate | Must be `audited`, or the protocol is auto-rejected regardless of score |
| Age | 30% | `clamp(ageDays / 180)` |
| TVL | 40% | log-scaled between $100k and $100M |
| Admin key | 30% | timelock+multisig = 1.0, multisig = 0.7, timelock = 0.5, plain EOA = 0.0 |

**Lifeboat extension (post-YieldBlox hardening):** added after lessons from a real February-2026 exploit of a community-managed pool with a weak oracle. Four additional checks, all must pass:

| Check | Requirement |
|---|---|
| Pool class | Must be `curated`, not community-managed |
| Oracle type | Must include a `circuit_breaker` |
| Collateral liquidity | At least $250,000 depth |
| Supplier concentration | No single supplier over 40% |

**Verdict object:**
```js
{
  protocol, eligible: boolean,
  yieldReality: { ratio, verdict, inputs },
  security: { score, auditGate, components },
  reasons: [...],  // why it failed, if it did
  isFixture, facts
}
```

An **eligibility token** (`mintToken` / `verifyToken`) is minted once a verdict passes, valid for 15 minutes, and checked again just before the actual deposit executes (`worker.js`) — a soft, defense-in-depth assertion, not a security boundary by itself (the real boundary is the on-chain scope on the agent account).

**Key files:** `frontend/src/strategy/eligibilityGate.js`, `frontend/api/vf/eligibility.js` (server-side variant), `frontend/src/strategy/gates.js` (a lighter, four-gate turbulence/gas/capital/universe pre-check that runs even earlier and blocks *offensive* actions like deposit/rebalance in bad conditions, while always letting *defensive* actions like withdraw/harvest through).

**For judges:** this gate is designed to fail toward safety — missing data, stale data, or an unaudited protocol all result in rejection, not a shrug-and-proceed. The Ponzi check specifically catches protocols paying yield they haven't actually earned.

---

### 3.4 One-Signature Grant

**What & why.** This is the headline feature. Instead of signing a separate transaction for every agent's setup and every deposit (the old flow required up to 6–9 signatures), the user signs **once**. That one signature does two things simultaneously: it sets a spending allowance — like a monthly budget with an expiry date on a shared credit card — and it deploys a batch of fresh, disposable worker accounts that are only allowed to spend from within that budget. Revoking is just as simple: setting that same allowance back to zero, in one more signature, instantly kills every worker's ability to pull more funds.

**The contract:** `funding_router` (Soroban, `soroban/contracts/funding_router/src/lib.rs`) — live at `CCEWWRQVYKEIWTO7GTX2QVHQASC3GIQOZZTDMGTOHFQYKZIX5KJ6CYE5`. It is a **factory + funding gate with no admin and zero custody** — it never holds user funds itself.

**Public functions:**

| Function | What it does |
|---|---|
| `__constructor(agent_wasm_hash, token)` | One-time, immutable: pins the exact agent-account code hash and the funding token forever |
| `grant(owner, budget, expiry_ledger, agents[])` | **The one signature.** Nested: approves the router to spend up to `budget` from `owner` until `expiry_ledger` (SEP-41 allowance), *and* deploys one `agent_account` per entry in `agents[]` |
| `pull(agent, amount)` | Session-key-signed, relayed. Only an agent the router itself deployed can call this, pulling `owner → agent` via the SEP-41 allowance |
| `owner_of(agent)` | Read: which owner deployed a given agent |
| `config()` | Read: the pinned agent wasm hash + funding token |

**Why one signature covers two on-chain actions:** the transaction's source account is the owner. Both the `owner.require_auth()` on `grant` *and* the nested `token.approve(owner, router, budget, expiry_ledger)` sub-call are satisfied by the same source-account credential — so a single wallet signature authorizes both the deploy and the allowance in one shot.

**Step-by-step flow** (`frontend/src/stellar/grant.js`):

1. For each worker, build an `AgentInit` struct: a fresh session-key public key, a random salt (for deterministic-but-unique deploy addresses), a cap (that worker's slice of the deposit), the target vault, a period duration, and an expiry.
2. Build the transaction: `router.grant(owner, totalBudget, expiryLedger, agentInits[])`.
3. Simulate the transaction to capture the `Vec<Address>` of the agents that *will* be deployed (Soroban deploy addresses are deterministic from the salt).
4. **User signs once** in their wallet.
5. Submit — preferably through the fee-bump relay (which allowlists `router.grant`); if the relay is unavailable, fall back to a direct user-paid submission so the flow never gets stuck.

**Repeat runs cost zero signatures** when: the router is deployed and enabled, the local agent cache has agents for this (owner, vault, network) tuple, each cached agent's **on-chain** scope (re-read fresh, not trusted from cache) still has headroom and hasn't expired or been revoked, and the SEP-41 allowance still covers the new run's total. If all of that holds, the orchestrator skips the grant entirely and funds agents via a relayed `router.pull()` — no wallet interaction at all.

**Revoke (the kill switch):** `revokeGrant()` sets `token.approve(owner, router, 0)`. This is a direct, user-signed submission (deliberately *not* routed through the relay) so that revocation works even if the relay infrastructure itself is down.

**Key files:** `soroban/contracts/funding_router/src/lib.rs`, `frontend/src/stellar/grant.js`, `frontend/src/stellar/agentCache.js`, `frontend/src/orchestrator.js` (lines ~313–369 for the router path).

**For judges:** the "budget + expiry" isn't a UI promise — it's a native SEP-41 token allowance enforced by the Stellar protocol itself. Even if every line of the app's own code were malicious, the token contract itself refuses to move more than the granted amount, and refuses anything after the expiry ledger.

---

### 3.5 Agent Accounts + Session Keys

**What & why.** Each worker agent is not a wallet the user hands out — it's a purpose-built, disposable Soroban smart account, deployed fresh for this run, that can *only* do one thing: deposit up to its cap into its one assigned vault, using its own throwaway signing key. Think of it as a valet key for a car: it starts the engine and lets the valet park the car, but it can't open the trunk, glovebox, or garage. If that valet key is ever compromised, the attacker can, at absolute worst, push the remaining allowance into the *user's own* vault position — they cannot redirect it anywhere else, and they cannot touch the user's real wallet.

**The contract:** `agent_account` (Soroban custom account implementing `CustomAccountInterface`, `soroban/contracts/agent_account/src/lib.rs` + `account.rs`). A fresh instance is deployed per worker, per run, by the funding router (pinned wasm hash `d61ceaaaf5a3fd9fd25987eba0f843ccb79880f3eaa137e066b5f63ab9eaa2ba`, "v3" — the hardened build: on-chain enforced revoke, `owner_withdraw` terminal exit, and `scope_of()` for the registry's derived records).

**The scope, pinned at deploy time and enforced on every authorization check:**
```
owner              — the human's Stellar address
vault              — the one vault this agent may deposit into
token              — the funding asset
cap_per_period     — max spend per rolling period
period_duration    — length of that rolling period (seconds)
spent_in_period    — running total (mutated on each deposit)
period_start       — when the current period began (mutated)
expiry             — absolute expiry timestamp; agent is dead after this
revoked            — instant kill flag
```

**Two signing tags, two purposes** (`__check_auth`):

1. **Deposit auth (tag `0x00`):** verified against the deposit session key. `enforce()` checks the scope isn't revoked or expired, resets the rolling period if elapsed, and only allows contexts that are either `vault.deposit()` within cap, or `router.pull()` (uncapped locally — the SEP-41 allowance is the real budget limiter for pulls).
2. **Exit auth (tag `0x01`):** verified against a *separate, optional* exit signer (owner can call `set_exit_signer()` to use a different key for exits than for deposits). `enforce_exit()` only allows `vault.redeem()` or `token.transfer()` where the receiver is the owner — funds can leave the agent, but only back to the human who owns it.

**Owner-gated emergency exit:** `owner_withdraw(to)` — the human's own wallet signature redeems all vault shares held by the agent and sweeps its token balance to the destination address, immediately, no cooldown.

**Key files:** `soroban/contracts/agent_account/src/lib.rs`, `soroban/contracts/agent_account/src/account.rs`, `frontend/src/stellar/sessionKey.js` (ed25519 keypair generation, `Keypair.random()`), `frontend/src/stellar/agentDeposit.js` (build + sign + submit).

**A load-bearing implementation detail:** signing a Soroban authorization entry requires a two-pass "prepare" cycle — the first simulation runs in recording mode (skipping `__check_auth` entirely, so it doesn't yet know the full resource footprint the custom account will touch), the session key signs the resulting hash, and then the transaction is **re-simulated** with the signature attached, in enforcing mode, to capture the complete footprint. The signature itself only covers the authorization preimage hash, so the footprint change afterward doesn't invalidate it.

**For judges:** the on-chain scope — not client-side trust — is what makes a leaked session key a bounded, low-consequence event instead of a catastrophic one. The blast radius of a compromised session key is exactly: that one agent's remaining headroom, and it can only move to the vault it was already scoped to, ultimately recoverable by the owner.

---

### 3.6 Gasless Execution

**What & why.** On most blockchains, "gas" is a fee paid in the network's native token for every transaction — and for a user who just wants USDC yield, having to also hold and manage XLM just to pay fees is friction that kills the whole "set once, vibe forever" pitch. Vibing Farmer runs its own **fee-bump relay**: a server-side wallet that co-signs every allowed transaction and pays its network fee, like a company postage meter that stamps outgoing mail so employees never touch a stamp.

**The endpoint:** `POST /api/stellar-relay` (`frontend/api/stellar-relay.js`), a Cloudflare Pages Function.

**How the fee-bump works:** the user or agent signs their *inner* transaction (the actual deposit, grant, or pull) normally. The relay wraps that already-signed inner transaction inside a Stellar "fee-bump" transaction, where the *relay's own keypair* is the fee-paying source account. The inner transaction's logic and authorization are untouched — only the fee source changes.

**Fail-closed allowlist — the relay will only fee-bump:**
- `vault.deposit()` or `vault.redeem()` on the configured vault address
- `token.transfer()` where the `from` address is on an explicit agent allowlist (covers a two-leg exit path)
- `router.grant()` or `router.pull()` on the configured funding router
- `createContractV2` deploys, but only if the wasm hash exactly matches a pinned hash

Anything else — including admin functions like `add_strategy`, `set_keeper`, or `upgrade` — is refused. If the vault address isn't configured at all, the guard is *skipped entirely* (fail-closed in the other direction: an unconfigured deploy relays nothing at all rather than relaying everything).

**Other protections:**
- **Origin allowlist + rate limiting:** 15 requests/minute per IP on the relay endpoint specifically (`frontend/api/_guard.js`).
- **Replay guard:** each inner-transaction hash is cached for 30 minutes to deduplicate in-flight resubmissions (returns 409 on a duplicate submit; a failed submit's cache entry is cleared so a legitimate retry can proceed).
- **Fee margin:** the relay pays the inner transaction's resource fee plus a fixed margin of 1,000,000 stroops (0.1 XLM) — deliberately generous on testnet so the fee-bump always clears the SDK's "fee-bump fee ≥ inner fee" floor.

**Required environment:** `STELLAR_RELAYER_SECRET` (the relay's own funded keypair, server-side only), `SOROBAN_VAULT_ADDRESS`, optionally `SOROBAN_TOKEN_ADDRESS`, `SOROBAN_AGENT_ALLOWLIST`, `SOROBAN_ROUTER_ADDRESS`. Missing the relayer secret returns a 503, not a silent bypass.

**Key files:** `frontend/api/stellar-relay.js`, `frontend/api/_guard.js`, `frontend/api/_pagesAdapter.js`, `frontend/src/stellar/relay.js` (pure-fetch client, no SDK or secrets in the browser).

**For judges:** the relay never has custody of user funds and can't be tricked into paying for arbitrary contract calls — it inspects the *specific operation type* inside the transaction and rejects anything not on a short, explicit allowlist, before it ever reaches its own signing key.

---

### 3.7 Parallel Agent Swarm

**What & why.** Once the grant lands, N worker agents each need to pull their share of the budget and deposit it. The product's design goal is that these workers act **independently** — one worker's failure or slowness should never block or crash the others' deposits.

**Honest description of the dispatch mechanism:** the orchestrator (`frontend/src/orchestrator.js`) dispatches workers with a deliberate **2-second gap between each worker's submission** (a serial loop, not truly simultaneous execution) specifically to avoid tripping the relay's own per-IP rate limit. This is not the same as literally firing all N deposits at the same instant. What *is* true, and what matters functionally, is the **failure-isolation guarantee**: each worker's execution is wrapped so that one worker throwing an error does not abort or roll back any other worker — the orchestrator collects `{ completed, failed, results }` across all workers regardless of individual failures, which is the practical behavior that `Promise.allSettled` is used for elsewhere in the flow (e.g. generating all N agent skills concurrently in step 2 of dispatch, which genuinely does run in parallel).

**Full dispatch flow** (`orchestrator.dispatch()`):

1. Map the strategy's per-vault allocation percentages to concrete agent amounts (base units).
2. Generate all agent skills **in parallel** (`Promise.allSettled`).
3. Pre-flight balance check — abort early if the user's wallet doesn't hold enough of the funding token.
4. Agent setup — either the router path (one grant signature, described in [§3.4](#34-one-signature-grant)) or a legacy per-agent path (multiple signatures; kept for environments without the router deployed).
5. Dispatch workers **serially, 2 seconds apart**, each isolated so a single failure doesn't abort the run.
6. Aggregate results; emit a completion event.

**Per-worker execution** (`frontend/src/worker.js`):

1. Check the eligibility token is still valid (not stale).
2. Generate or reuse a session key.
3. Run a lightweight pre-submit rate-anomaly check.
4. **Read a baseline** of the agent's vault shares *before* depositing — this baseline is what turns "the transaction was accepted" into "the transaction actually worked," because Soroban transaction success doesn't always guarantee state changed as expected.
5. Build and sign the deposit authorization entry with the session key; submit via the relay.
6. **Poll** `vault.balance(agentAddress)` up to 8 times, 3 seconds apart, until shares are confirmed to have increased.
7. Write a memory entry (shares delta, timing, a "lesson") and emit a `completed` event with the transaction hash.

**Error handling:** any error at any step results in a `failed` event and a memory write — never a silent drop, never a crash of the whole run. If *every* agent's setup fails, the whole run aborts with a clear error; if only some fail, the run continues with the rest.

**Key files:** `frontend/src/orchestrator.js`, `frontend/src/worker.js`, `frontend/src/stellar/agentSetup.js` (legacy path), `frontend/src/stellar/agentDeposit.js`.

**For judges:** this is a case where being precise matters more than sounding impressive — the code genuinely does isolate per-agent failures (the safety property that matters for a swarm), even though the submissions themselves are paced rather than instantaneous (a rate-limit accommodation, not a design flaw).

---

### 3.8 Real Yield

**What & why.** The whole point of "yield farming" is earning interest — and Vibing Farmer's vault genuinely lends the deposited USDC into a real lending market (Blend Capital) on Stellar testnet, rather than crediting a fabricated interest number. On testnet this yield is smaller and less liquid than a mainnet market, but the mechanism — supply, accrue interest, harvest, compound — is the real DeFi lending primitive, not a simulation.

**The vault** ("autofarm vault", contract `autofarm_vault`, live at `CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77`, share symbol `vfVLT`, name "Vibing Farmer Autofarm", 7-decimal USDC): an ERC-4626-style share ledger. Depositing mints shares at the current price-per-share; redeeming burns shares for the equivalent underlying assets. `price_per_share() = total_assets / total_shares`, scaled by 1e7 — as interest compounds in, this number rises, meaning every existing share is worth more USDC over time.

**The strategy** (`blend_strategy`, live at `CAR7XFFRKMUYSERYBSLQ4LXRY2E2W7G7WG4VQI55FWLSJWQVLNTAFVBE`): holds deposits on the vault's behalf and supplies them into the **Blend Capital v2** pool (`CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF`).

**Harvest mechanics** (`strategy.harvest(min_out)`):
1. Withdraw the entire position from Blend (draining it fully realizes accrued interest).
2. Claim BLND emissions from the pool (best-effort — a failed claim doesn't abort the harvest).
3. If `min_out > 0`, swap the claimed BLND to USDC via a Soroswap router; if `min_out == 0`, hold the BLND on the strategy contract and retry the swap on a future harvest (so BLND is never stranded, just deferred to a better exchange rate).
4. Re-supply the original principal back into Blend.
5. Forward interest + swap proceeds to the vault.

Emitted event:
```
StrategyHarvest {
  interest, blnd_claimed, blnd_swapped, usdc_out, blnd_held
}
```

**Compounding at the vault level:** `vault.compound(min_outs)` (keeper-only, cooldown-gated) calls `harvest()` on every registered strategy, sweeps the gains, and returns the total gain — this is what raises the vault's price-per-share over time.

**Single-strategy limitation (disclosed honestly):** a spike investigation found that self-deploying a second Blend pool can't reach "Active" status without seeding real backstop capital (`OWN_POOL_VIABLE=false`), so the vault currently runs one strategy and falls back to `rebalance(to=vault)` (moving capital to idle) rather than a second pool. Rebalancing between strategies (when there is more than one) is capped per move (`max_move_bps`) and cooldown-gated to prevent a single bad call from moving everything at once.

**Key files:** `soroban/contracts/autofarm_vault/src/lib.rs` + `vault.rs`, `soroban/contracts/blend_strategy/src/lib.rs` + `blend.rs` + `soroswap.rs`.

**For judges:** the yield here is a real Blend Capital lending position, verifiable on Stellar Expert by address — not a number the frontend makes up. The "single strategy" limitation is disclosed in the repo's own deployment notes, not glossed over.

---

### 3.9 Keeper Autonomy + Lifeboat Radar

**What & why.** Two separate automated systems keep the vault healthy without the user lifting a finger for routine maintenance, while drawing a hard line around what's allowed to happen *without* the user's explicit, time-boxed permission.

#### The Worker keeper — routine, fully autonomous

A dedicated keeper identity (deliberately **separate** from the relayer's identity, to enforce role separation) runs on roughly a 15-minute cadence and:
- **Compounds:** harvests strategies' realized gains and sweeps idle balances back in — pure optimization, blocked automatically while the vault is in a "derisked" emergency state.
- **Rebalances:** moves capital between strategies when the APR gap crosses a threshold, capped per move and cooldown-gated.

Both actions require no human involvement and no time-boxed permission — they're bounded by their own hard caps and cooldowns, not by an expiring mandate.

#### The Lifeboat radar — emergency, mandate-gated

A separate, persistent process (`keeper/src/radar-runner.mjs`) evaluates the pool's health **once per Stellar ledger, roughly every 6 seconds** (polled every 2s so no ledger is missed) — the fastest cadence the network itself allows. It watches three signals, degrading gracefully to "off" for any signal it can't read rather than false-triggering:

| Signal | Engage threshold (derisk) | Resume threshold (stricter, prevents flapping) |
|---|---|---|
| Pool utilization | ≥ 95% | < 85% |
| Liquidity drop | ≥ 30% | (same, no separate resume threshold) |
| Oracle price divergence | ≥ 2.5% | < 0.5% |

If any signal breaches its engage threshold, the radar wants to act — but whether it's *allowed* to depends entirely on a **live, time-boxed mandate**:

```
if danger detected:
    if mandate is live (not expired):
        call emergency_derisk()  → drains all strategies to vault-idle, sets Derisked flag
    else:
        log an ALARM only — never acts

if already derisked and all-clear for 100 consecutive ledgers (~10 min):
    if mandate is live:
        call resume()  → clears Derisked flag, normal compounding resumes
    else:
        stay derisked — funds remain safely idle
```

This is the crux of the "fail-closed" design: **danger without a live mandate produces a loud alarm and zero action.** Funds are never moved autonomously without the user having pre-authorized it within a specific time window — but once authorized, the reaction is as fast as the chain itself allows.

**The mandate, from the user's side:** a "renew 24h mandate" button in the ops console signs `set_mandate(now + 24h)` — one signature by a dedicated `mandate_authority` role (a separately settable address via `set_mandate_authority`; on the current testnet deploy this role is held by the deployer account). Both `emergency_derisk()` and `resume()` require both the keeper's own signature *and* a currently-unexpired mandate; neither can act on an expired one, and an already-derisked call is idempotent (a second call safely returns without re-draining anything).

**Hysteresis, deliberately:** the resume threshold is stricter than the engage threshold, and a 100-ledger "all clear" streak is required before resuming — this prevents the radar from flapping in and out of the emergency state on a noisy signal.

**Key files:** `keeper/src/radar-runner.mjs`, `keeper/src/radar.js`, `keeper/src/lifeboat.js`, `keeper/src/chain.js`, `soroban/contracts/autofarm_vault/src/vault.rs` (lines ~442–519), `keeper/src/decide.js` (Worker keeper), `frontend/src/components/console/LifeboatZone.jsx`, `frontend/src/stellar/keeperEvents.js`.

**For judges:** this is one of the most carefully reasoned pieces of the system — "autonomous" is only true within a scope the user explicitly and repeatedly re-authorizes; an emergency without permission produces a log line, not an action.

---

### 3.10 On-Chain Attestation

**What & why.** After the AI strategist decides on an allocation, that exact decision is hashed and written on-chain — a receipt that lets anyone independently verify the strategy the app claims it ran is the one it actually ran, and that it hasn't been silently altered after the fact.

**The contract:** `attestation` (live at `CDDOW2FZ7ALBWBXF22TPMPDHPXSKTMLQGGQWUYX7YOJZAHICD7DUO2K6`) — deliberately minimal: it stores a per-attester counter and emits an event, nothing more.

**Public functions:**

| Function | Purpose |
|---|---|
| `attest(attester, strategy_hash, label)` | Attester-signed; bumps that attester's counter, emits `StrategyAttested`, returns the new count |
| `count_of(attester)` | Read-only: how many attestations a given address has made |

**Event:**
```
StrategyAttested { attester, strategy_hash, ledger, label }
```

**How the hash is computed:** `hashStrategy()` (`frontend/src/attestation.js`) produces a deterministic hash of the *enforced* strategy JSON (after the action-space clamp and any council adjustments), tagged with which provider generated it. Because the hashing function is deterministic and the input JSON is exactly what the user reviewed and approved, anyone with the original strategy JSON can reproduce the exact same hash and compare it to what's on-chain.

**Key files:** `soroban/contracts/attestation/src/lib.rs`, `frontend/src/attestation.js`.

**For judges:** this is a small, focused primitive — not a complex proof system — but it does the one thing that matters: it makes "the AI decided X" a checkable, on-chain claim instead of a trust-me screenshot.

---

### 3.11 Cross-Chain Optional Leg

**What & why.** For users who want exposure to Base-chain yield pools as well, Vibing Farmer has an optional `/farm` flow that bridges USDC from Stellar to Base using Circle's official cross-chain transfer protocol (CCTP v2), then deposits into whitelisted pools using a Base-side session key — all gas-sponsored, mirroring the Stellar-side experience. This leg is explicitly optional and clearly labeled as testnet/demo-grade where real yield protocols aren't reachable yet.

**Architecture:**
```
Passkey wallet (Stellar + Base) → session-key mandate (ZeroDev CallPolicy, 1h TTL)
    → Farm: burn USDC on Stellar (CCTP) → own Node relayer relays the mint → Base YieldRouter deposits into whitelisted pools
    → Unwind: burn on Base (with hookData encoding the Stellar recipient) → relayer relays the mint back on Stellar
```

**The relayer** (`relayer/`, Node.js ESM): owns session-key registration, CCTP message + IRIS attestation handling, ZeroDev Kernel account reconstruction, and job tracking (in-memory or SQLite). It is explicitly **non-custodial**: deposits are routed through session-key-signed Base transactions, and unwind minting only ever completes a burn the user already signed client-side — the relayer never holds user funds itself.

Key endpoints (`relayer/src/httpRouter.mjs`, proxied at `/api/vf-cross/*`):

| Endpoint | Purpose |
|---|---|
| `POST /mandate` | Register a session key (TTL 1 hour, swept automatically) |
| `POST /farm` | Submit a Stellar burn tx hash + Base pool allocations; relay mints on Base and deposits |
| `POST /unwind` | Submit a Base burn tx hash (with recipient baked into hookData); relay mints back on Stellar |
| `GET /status/:jobId` | Poll a background job's progress |

**The Base contract:** `YieldRouter` (live at `0xF80aa8F571E6d24Ea72F051Fc6F9A9C516727B6d`) — no custody (funds move straight through in one transaction), whitelisted pools only (`allowedPool[pool]`), and a performance fee capped at 20% of *yield only*, never principal. Session keys (via ZeroDev's `CallPolicy`) can call *only* `deposit`/`withdraw` on whitelisted pools — `setPool`/`setFee` remain owner-only and are never delegatable.

**ZeroDev session-key mechanics:** a Kernel v3.1 smart account (ERC-4337, Entry Point 0.7) with a permission validator scoped to exactly two call signatures on the YieldRouter, and a ZeroDev-sponsored paymaster covering gas for those calls.

**Honesty about yield on the Base leg:** the three Base-Sepolia pools currently whitelisted (`0x389250…`, `0x5E843A…`, `0xadD3c1…`) are `MockERC4626` contracts doing **honest 1:1 custody of real Circle CCTP USDC** — they do not fabricate yield, because a specific investigation (`relayer/scripts/check-aave-usdc.mjs`, run 2026-07-09) proved that no real lending protocol on Base Sepolia actually accepts Circle's bridged USDC (Aave's testnet deployment lists its own separate faucet token; Morpho, Moonwell, and Compound are mainnet-only on Base). A mainnet-ready `AaveV3Adapter4626` contract exists, unit-tested and fork-tested against real Aave Base-mainnet bytecode, ready to swap in as a drop-in replacement once deployed for real — but it is **not deployed on testnet** because there's nothing real for it to wrap there.

**Key files:** `relayer/src/server.mjs`, `relayer/src/httpRouter.mjs`, `relayer/src/base/session.mjs`, `relayer/src/cctp/forward.mjs` + `reverse.mjs`, `base-contracts/src/YieldRouter.sol`, `base-contracts/src/AaveV3Adapter4626.sol`, `frontend/src/screens/CrossChainFarmFlow.jsx`, `frontend/src/wallet/mandate.js`.

**For judges:** the CCTP burn/mint corridor itself is real and live-proven in both directions; the "yield" on the Base side is explicitly disclosed as custody-only on testnet, with a genuinely mainnet-ready (not just planned) adapter waiting for a real deployment target.

---

### 3.12 Wallets + On-Ramp

**What & why.** Users can connect with wallets they may already have (Freighter, xBull, Albedo) or use the project's own VF Wallet, which supports both a modern passkey-based smart account (fingerprint/Face ID instead of a seed phrase) and a classic seed-phrase wallet. A fiat on-ramp (Transak) lets a brand-new user buy USDC directly with a card, no separate exchange account needed.

**Standard wallets** (via `@creit.tech/stellar-wallets-kit`): Freighter, xBull, Albedo — classic `G...` address wallets, each signs Soroban authorization entries through the kit's shared interface. `frontend/src/stellar/walletKitLoader.js` is the single file that imports the kit package, so any upstream API change is a one-file fix.

**VF Wallet — Passkey (Stellar):** a Soroban smart account (`C...` contract address, not a classic `G...` address) built on OpenZeppelin's smart-account-kit, secured by a WebAuthn passkey (Face ID, Windows Hello, a hardware key, etc.) using the secp256r1 curve. Signing flow: DER-encoded ECDSA signature → converted to raw 64-byte r||s → normalized to low-S form (a Soroban/OZ verifier invariant) → the WebAuthn challenge is built directly from the Soroban authorization preimage hash, so the passkey signature *is* the on-chain authorization, with no intermediate re-hash to trip up.

**VF Wallet — Passkey (Base):** a separate smart account on Base, using ZeroDev's Kernel v3.1 (ERC-4337 account abstraction), authorized by a *different* WebAuthn credential than the Stellar passkey (a different relying party) — meaning a user sees two separate "use your passkey" prompts across the two chains during onboarding, even though the physical authenticator (e.g. the same fingerprint sensor) is shared.

**VF Wallet — Classic (ed25519):** a standard Stellar keypair derived from a BIP-39 24-word mnemonic via SLIP-0010 (`m/44'/148'/0'`), for users who prefer a familiar seed-phrase wallet. This path is implemented in code (key generation, import, encrypted storage) but its onboarding UI integration is still in progress.

**Risk-aware signing — the eligibility gate lives inside the wallet too:** the same fail-closed F8 check from [§3.3](#33-eligibility-gate-f8) is wired directly into VF Wallet's transaction-building layer, not just the app's strategy flow. `depositToVault()` (`frontend/src/wallet/account.js`) calls the eligibility check *before building* the deposit — if the verdict is ineligible, the unsigned transaction is never even constructed. The generic send flow (`frontend/src/wallet/send.js`) does the same when the destination is a recognized VF vault: the F8 verdict is checked fail-closed *before any signing*, and non-vault destinations are not gated. In practice this makes VF Wallet a wallet that refuses to sign a deposit into a vault that fails the safety check — a protection that holds even if the user reaches the wallet through a path that skipped the strategy UI.

**Clear signing:** before every approval, the wallet renders a plain-language explanation of what is actually being signed (`frontend/src/wallet/clearSign.js`, surfaced through `ApproveOverlay.jsx` and `HonestyLabels.jsx`) — the operation, the amounts, the destination, and honest caveat labels — instead of presenting an unreadable transaction blob. The user can read what they're authorizing in sentences, not hex.

**Everyday wallet features:** beyond signing, the classic wallet ships the full expected surface — send/receive with QR codes, transaction history, live asset prices, encrypted vault storage (AES-GCM), backup with confirmation, import/recovery, and onboarding/unlock/settings screens (`frontend/src/wallet/` and `frontend/src/wallet/ui/classic/`).

**The VF Wallet browser extension:** a Manifest V3 Chrome extension. Because WebAuthn credentials are bound to the origin they were created on, the actual signing ceremony runs in a separate browser tab (not the popup) at the extension's own origin — the popup relays a sign request to a background service worker, which opens the ceremony tab, and the result flows back once signed. The extension also injects a wallet provider into visited pages (`frontend/extension/providerInject.js` + `providerBridge.js`), meaning VF Wallet can serve as the signing wallet for *other* Stellar apps, not only Vibing Farmer.

**On-ramp:** `POST /api/onramp-session` proxies to Transak's session API server-side (the API secret never touches the browser), returning a short-lived widget URL pre-locked to the user's Stellar address and USDC — the user can't accidentally change the destination address inside the widget. A Coinbase fallback path exists in the code but currently returns `501 Not Implemented`.

**Key files:** `frontend/src/stellar/walletKit.js` + `walletKitLoader.js`, `frontend/src/stellar/vfWalletModule.js`, `frontend/src/wallet/passkeyStellar.js` + `passkey.js` + `account.js`, `frontend/src/wallet/passkeyBase.js`, `frontend/src/wallet/classicKeypair.js`, `frontend/src/wallet/send.js` + `clearSign.js` + `ui/ApproveOverlay.jsx` + `ui/HonestyLabels.jsx`, `frontend/extension/` (manifest, popup, ceremony, background, provider inject/bridge), `frontend/api/onramp-session.js`.

**For judges:** three genuinely different wallet trust models are supported side by side — bring-your-own classic wallet, a modern biometric smart account, and a classic-key fallback — without forcing a single choice on the user. And uniquely, the wallet itself is risk-aware: the same fail-closed eligibility engine that screens the strategy also sits at the signing layer, so an unsafe deposit is refused at the last line of defense too, with every approval explained in plain language before it's signed.

---

### 3.13 Backend API

**What & why.** Behind the frontend sits a small set of server-side endpoints whose entire job is to keep secrets off the browser: API keys for AI providers and search, the relayer's funded keypair, and a faucet's treasury key never leave the server. A second, separate API surface (`/api/vf/*`) offers the same core capabilities to *external* developers via issued API keys, so the product's building blocks (market data, transaction building, AI strategy) are reusable outside the app itself.

**Public proxy endpoints** (origin allowlist + per-IP rate limit via `frontend/api/_guard.js`):

| Endpoint | Purpose | Rate limit |
|---|---|---|
| `POST /api/stellar-relay` | Fee-bump relay (see [§3.6](#36-gasless-execution)) | 15/min |
| `POST /api/ai` | DeepSeek proxy (model + message allowlist) | 30/min |
| `POST /api/search` | Tavily web-search proxy | 30/min |
| `POST /api/faucet` | Testnet USDC dispense (per-recipient + global daily caps) | 3/min |
| `ANY /api/vf-cross/*` | Proxy to the cross-chain relayer | 30/min |
| `POST /api/onramp-session` | Transak widget session | 10/min |

**Faucet caps (defense against drain):** 300 tokens/day per recipient, 5,000/day globally, single-dispense capped at 100 tokens, default 10 — enforced in-memory (best-effort; resets on serverless cold start, not a hard SLA).

**The developer API gateway** (`/api/vf/*`, `frontend/api/vf/_router.js`): Bearer-token auth using issued `vf_...` keys, with per-key and per-scope rate limiting stored in Cloudflare D1 (in-memory in dev/test). Key routes:

| Route | Scope | Purpose |
|---|---|---|
| `GET /auth/challenge`, `POST /auth/token` | — | SEP-10-based login → JWT for the developer portal |
| `GET/POST/DELETE /keys` | JWT | Issue, list, revoke `vf_...` API keys |
| `GET /vault-facts` | `market` | Vault metadata (Blend APR, TVL, etc.) |
| `POST /eligibility` | `market` | Same fail-closed eligibility check as [§3.3](#33-eligibility-gate-f8), as an API |
| `GET /prices` | `market` | DeFiLlama XLM/USDC price passthrough |
| `POST /build-tx` | `tx` | Build an unsigned deposit transaction envelope |
| `POST /simulate`, `POST /scan` | `tx` | Simulate / inspect a transaction |
| `POST /submit` | `submit` | Same fee-bump relay, keyed |
| `POST /strategy` | `strategy` | AI allocation (LLM or deterministic equal-split fallback), 8s timeout, never blocks |
| `GET /usage` | JWT | Usage report, last 30 days |

**Key implementation notes:** Cloudflare Pages Functions wrap all handlers via `_pagesAdapter.js`, translating between the Web Request/Response API and a Node-style `(req, res)` handler so the exact same code runs locally under Vite and in production on the edge; a handler throwing an unhandled error always degrades to a generic `502` rather than leaking a stack trace.

**Key files:** `frontend/api/_guard.js`, `frontend/api/_pagesAdapter.js`, `frontend/api/stellar-relay.js`, `frontend/api/ai.js`, `frontend/api/search.js`, `frontend/api/faucet.js`, `frontend/api/vf-cross.js`, `frontend/api/onramp-session.js`, `frontend/api/vf/_router.js`, `frontend/api/vf/_vfauth.js`, `frontend/api/vf/_db.js`, `frontend/api/vf/_keystore.js`.

**For judges:** every endpoint that touches a secret is server-only by construction (the secret literally cannot appear in a bundled browser file), and every endpoint has an explicit, testable failure mode (503 for missing config, 429 for rate limits, 403 for bad origin) rather than an implicit one.

---

### 3.14 User Interface

**What & why.** The interface is split into three distinct visual registers depending on what kind of trust each screen needs to convey. Everyday flows (strategy setup, the grant signature) look calm and document-like on purpose — this is where real money moves, and flashy decoration would work against trust. Marketing/exploration screens (landing, ecosystem, explorer) allow a little more visual flourish since nothing there is transactional. And the live operations console is intentionally the most visually rich surface, because a real-time system genuinely benefits from data-dense, motion-driven feedback.

**Design system — "Acid Yield":** a warm near-black background (`#0e0f0c`) with a single acid-lime accent color (`#cfff3d`) reserved strictly for the *current, actionable* element — never used decoratively. Typography is Geist, with tabular figures for aligned numeric data. Animations are restricted to compositor-friendly CSS properties (`transform`, `opacity`, `clip-path`) and are always `prefers-reduced-motion`-safe.

**13 routes** (plus a first-visit landing takeover at `/`), grouped by design tier:

| Route | Tier | Purpose |
|---|---|---|
| `/` | — | First-time visitors get a full-screen landing hero + onboarding; connected users are redirected to `/home` |
| `/home` | A (trust UI) | Positions, alerts, quick actions |
| `/strategy` | A | Multi-stage flow: input → thinking → council → grant → execute |
| `/agent` | D (data-rich console) | The live operations console — see below |
| `/settings` | A | Language, palette, rule store |
| `/vault/:protocol` | A | Single-vault metrics and history |
| `/farm` | A | Cross-chain CCTP burn/relay/deposit flow |
| `/history`, `/tx/:txHash` | A | Transaction log and detail |
| `/developers/*` | B (marketing) | 4-section API/integration portal |
| `/explorer` | B | Vault/protocol directory with live metrics — public, standalone, no wallet required |
| `/ecosystem` | B | Protocol/tech-stack overview — public, no wallet required |
| `/replay` | B | Static historical session replay — public, no wallet required |

The three public pages (`/explorer`, `/ecosystem`, `/replay`) are deliberately reachable without connecting a wallet, so judges and visitors can browse live on-chain data before trusting the app with anything.

**The `/agent` operations console — 8 zones, one shared 1-second clock:**

1. **CommandStrip** — running status, cycle count, total earned, blended APY.
2. **SwarmZone** — the live force-directed graph (`react-force-graph-2d`): Orchestrator → Workers → Vault, orb-shaped nodes with a radial gradient, an amber additive "running" glow, lime flow particles on active edges only, curved dim rails, and target-tinted arrowheads. Nodes are clickable for a per-agent memory/trace modal. Keeper compound/rebalance events pulse the matching edge for 2.6 seconds.
3. **CouncilZone** — a paginated decision log (last 30 decisions) showing each cycle's per-specialist verdict, confidence, and how the final call was resolved (veto / unanimous / weighted / AI tie-break).
4. **PositionsZone** — current vault shares, projected USD value, unclaimed rewards, with a withdraw action.
5. **KeeperZone** — compound/rebalance event feed with a radar (armed sweep 5–6s) and an EKG-style beat on new cycles.
6. **MonitorZone** — the background autonomous monitor loop's cycle journal (keep/hold/discard tallies, next-tick countdown).
7. **LifeboatZone** — ARMED / ENGAGED / DISARMED state, a radar visualization of recent derisk events, mandate countdown, and the "renew 24h mandate" action.
8. **MandateZone** — the live SEP-41 allowance scopes per agent (budget, expiry, issued/revoked), with a per-agent revoke action.

**A development-only "view-as" override** (`frontend/src/dev/viewAs.js`): behind an `import.meta.env.DEV` gate that is dead-code-eliminated in production builds, `/agent?as=G...` lets a developer impersonate another address to demo the console with real historical positions, without ever touching a real wallet's keys. A build-time script (`frontend/scripts/assert-no-dev-dispatch.mjs`) checks this can't leak into production.

**Key files:** `DESIGN.md` (design system source of truth), `frontend/src/app.jsx` (router), `frontend/src/components/console/OpsConsole.jsx` + its 8 zone components, `frontend/src/agents.jsx` (the `AgentGraph` force-graph component and the `DecisionLogPanel`), `frontend/src/positionsStore.js`, `frontend/src/dev/viewAs.js`.

**For judges:** the visual complexity scales with the actual stakes of the screen — the money-moving screens are the calmest ones, and the richest visuals are reserved for a read-mostly monitoring surface where extra motion genuinely communicates state rather than just decorating it.

---

## 4. Architecture at a Glance

```
                              ┌───────────────────────────────┐
                              │   USER (browser / wallet)     │
                              │  amount · risk · agent count  │
                              └───────────────┬───────────────┘
                                              │
                                              ▼
                     ┌────────────────────────────────────────────┐
                     │            AI STRATEGIST                   │
                     │  Venice x402 → Venice key → DeepSeek key →  │
                     │  DeepSeek proxy → deterministic fallback    │
                     │  + live DeFiLlama vaults + Tavily context   │
                     └───────────────────┬──────────────────────┘
                                         │ allocation plan
                                         ▼
                     ┌────────────────────────────────────────────┐
                     │              AI COUNCIL                    │
                     │  Yield · Risk (hard veto>0.85) · Market     │
                     │  unanimous → weighted → AI tie-break        │
                     └───────────────────┬──────────────────────┘
                                         │ kept strategy
                                         ▼
                     ┌────────────────────────────────────────────┐
                     │       ELIGIBILITY GATE ("F8")               │
                     │  yield-reality (anti-ponzi) + security      │
                     │  score + curated-pool/oracle/liquidity      │
                     │  fail-closed: reject on missing/stale facts │
                     └───────────────────┬──────────────────────┘
                                         │ eligible vaults only
                                         ▼
                     ┌────────────────────────────────────────────┐
                     │        USER REVIEWS & APPROVES              │
                     └───────────────────┬──────────────────────┘
                                         │
                                         ▼           ONE wallet signature
                     ┌────────────────────────────────────────────┐
                     │   funding_router.grant(owner, budget,       │
                     │      expiry_ledger, agents[])               │
                     │   ├─ token.approve(owner→router, budget)    │  ← SEP-41 leash
                     │   └─ deploy_v2(agent_account) × N           │  ← disposable workers
                     └───────────────────┬──────────────────────┘
                                         │
                       ┌─────────────────┼─────────────────┐
                       ▼                 ▼                 ▼
                  agent_account_1   agent_account_2   agent_account_N
                  session key A     session key B     session key N
                       │                 │                 │
                       │  router.pull() (relayed, fee-bumped)
                       ▼                 ▼                 ▼
                  vault.deposit()   vault.deposit()   vault.deposit()
                       │                 │                 │
                       └─────────────────┼─────────────────┘
                                         ▼
                     ┌────────────────────────────────────────────┐
                     │   AUTOFARM VAULT (vfVLT shares, 7-dp)       │
                     │   ├─ blend_strategy.deposit()               │
                     │   └─ Blend Capital v2 pool (real lending)   │
                     └───────────┬───────────────────┬────────────┘
                                 │                   │
                    ┌────────────▼──────┐   ┌────────▼────────────┐
                    │  WORKER KEEPER      │   │  LIFEBOAT RADAR      │
                    │  ~15 min cron       │   │  ~6s ledger tick     │
                    │  compound/rebalance │   │  util/liq/oracle     │
                    │  fully autonomous   │   │  emergency_derisk()  │
                    │                     │   │  ONLY if live mandate│
                    └─────────────────────┘   │  else: alarm only   │
                                               └──────────────────────┘
                                         │
                                         ▼
                     ┌────────────────────────────────────────────┐
                     │  /agent OPS CONSOLE (8 zones)                │
                     │  live force-graph · council log · positions │
                     │  keeper feed · lifeboat radar · mandate      │
                     └────────────────────────────────────────────┘

  Gas for every relayed step above ────► /api/stellar-relay
                                          (own fee-bump, allowlist fail-closed)

  Optional: Stellar USDC ──CCTP v2 burn──► own Node relayer ──mint──►
            Base YieldRouter (whitelisted pools, ZeroDev session key, gas-sponsored)
```

---

## 5. Live Deployments

### Stellar Testnet (network: `Test SDF Network ; September 2015`, RPC: `https://soroban-testnet.stellar.org`)

| Contract | Address | Role |
|---|---|---|
| **funding_router** | `CCEWWRQVYKEIWTO7GTX2QVHQASC3GIQOZZTDMGTOHFQYKZIX5KJ6CYE5` | One-signature grant factory + funding gate (zero custody) |
| **agent_account** (wasm v3, per-run deploy) | wasm hash `d61ceaaaf5a3fd9fd25987eba0f843ccb79880f3eaa137e066b5f63ab9eaa2ba` | Scoped, disposable worker account, deployed fresh per grant |
| **autofarm_vault** ("autofarmVault") | `CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77` | Share-ledger yield vault (`vfVLT`, 7-dp), current live deposit target |
| **blend_strategy** ("strategy1") | `CAR7XFFRKMUYSERYBSLQ4LXRY2E2W7G7WG4VQI55FWLSJWQVLNTAFVBE` | Supplies vault deposits into Blend, harvests interest + BLND |
| **Blend v2 pool** | `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF` | The actual lending market (real yield source) |
| **Blend USDC token** | `CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU` | 7-decimal funding asset |
| **attestation** | `CDDOW2FZ7ALBWBXF22TPMPDHPXSKTMLQGGQWUYX7YOJZAHICD7DUO2K6` | On-chain strategy-hash attestation counter |
| **exit_router** | `CDGDIPHBN3MSNURDX33IZBXXQTJPT7THAXSMVBAIOIXLOA6OF32IRS2J` | Exit-side mirror of the grant: `sweep(owner, agents, to)` batches every agent's `owner_withdraw` into one signed transaction. Stateless — no admin, no upgrade path, zero custody; grants no authority (each agent still checks its stored owner) |
| **registry** | `CAP5E2FPDAGEQ7SR55YRY4Z56GPBSTRRZJCYN2PQ6PZQHQJKYEDVM5FB` | Per-agent scope registry. `authorize(agent)` derives the record from the agent's own `scope_of()` (caller supplies nothing but the address); `revoke(owner, agent)` is a metadata mirror — `AgentAccount.revoke()` is the enforcing kill switch. Not required by the deposit path |
| **Demo agent** (legacy) | `CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC` | Pre-seeded smoke agent on **v1** wasm; its constructor-only scope pins the retired vault, so deposits from it do **not** reach the live vault. Explorer/history only — product flows use per-run agents from the grant path |

**Superseded by the 2026-07-14 hardening redeploy** (kept live for history/rollback only — do not interact):

| Contract | Address | Note |
|---|---|---|
| Legacy funding_router | `CBEI5VJKKWLXKQUUUETBAPZSQQLH7I57TSIDTMV4WJMBKIGVF7NSNOFY` | Pre-hardening one-popup factory (pinned agent wasm v2) |
| Retired autofarm vault | `CB5VKYDUIYX3RZWGVLKKNBPG7V7Z5JIHF2QPNQKWKAHVA3IPSLFZJDYU` | Pre-hardening vault — no dead-shares inflation guard, no faulty-strategy isolation |
| Legacy blend_strategy | `CCH424TVLTP2P3URNRGGF26X24XRPBVBXCRZ6QBCWLSX6KH4QZSLNBC2` | Wired to the retired vault; cached-bToken NAV |
| Legacy registry | `CAEHOZGUGVNRCAFVJCSR3B2EFJ55LEA34S76HTRQGH7XSPBO7YIMNZOQ` | Old owner-supplied `authorize` ABI |
| Legacy agent wasm | v1 `8c607112…dda62`, v2 `7ced45e7…ca717` | Superseded by v3 `d61ceaaa…a2ba` |
| Older pre-autofarm vault | `CBZNITAPHCLSPEXC3UKIERYRUJR56GISM2G2Z5XD6KZH3U4ZZ76XNQOU` | Dividend-model vault, predates strategies/keeper/compound |
| **Relayer** identity | `GBVJ34MT4GDKZJGILI6DRYGD75ZNUBJGGZIDUV7IPFNVVDWGE5GBLV3X` | Fee-bump sponsor keypair |
| **Keeper** identity | `GA2CMBS3LRY5MH64KKMHOYVA6WTLPMKRMIWEJDOIGHYPB7WMC3QHRCBU` | Dedicated compound/rebalance/derisk signer (separate from relayer) |

### Base Sepolia (chain ID 84532 — optional cross-chain leg)

| Contract | Address | Role |
|---|---|---|
| **YieldRouter** | `0xF80aa8F571E6d24Ea72F051Fc6F9A9C516727B6d` | No-custody router, whitelisted pools, yield-only performance fee (≤20%) |
| MockERC4626 pool v1 | `0x389250872044368759D3db5C09b2706A6628d4e0` | Honest 1:1 custody of real CCTP USDC (no fabricated yield) |
| MockERC4626 pool v2 | `0x5E843A639F0555E2A6669601621befC887Bdb479` | Same |
| MockERC4626 pool v3 | `0xadD3c1A75c7Cef2516b51750959BD829a4AD4761` | Same |
| Circle USDC (CCTP) | `0x036CbD53842c5426634e7929541eC2318f3dCd01` | Real bridged USDC |
| MessageTransmitterV2 | `0x0a992d191DEeC32aFeBd72d8b38d079999f24e1d` | CCTP mint endpoint |
| AaveV3Adapter4626 | *(not deployed on testnet)* | Mainnet-ready, fork-tested against real Aave; swap-in target once deployed for real |

All addresses are drawn from `deployments/stellar-testnet.json` and `deployments/base-sepolia.json`, verifiable on Stellar Expert (`https://stellar.expert/explorer/testnet/contract/<address>`) or a Base Sepolia block explorer.

---

## 6. Security & Trust Model

**Custody: none.** No contract in this system — not the router, not the relayer, not the keeper — ever holds user funds at rest as a matter of design. The router is a pass-through factory; the relayer only ever pays network fees, never moves principal; funds live either in the user's own wallet, in an agent's own bounded scope, or in the vault's share ledger, which the user can redeem at any time.

**The leash is the allowance, not a promise.** The "budget + expiry" the user grants is a native SEP-41 token allowance — enforced by the token contract itself at the protocol level, not by application logic that could be bypassed by a bug elsewhere in the stack. Even a fully compromised frontend cannot move more than the granted allowance, and cannot move anything after the expiry ledger.

**Fail-closed, everywhere it matters:**
- The **fee-bump relay** allowlists specific operation types; an unconfigured or unmatched call is refused, not silently permitted.
- The **eligibility gate** rejects on missing or stale facts rather than assuming safety by default.
- The **lifeboat radar** only acts under a live, time-boxed mandate; danger without a mandate produces an alarm, never an action.
- The **AI council**'s Risk Analyst has hard veto power over the Yield and Market analysts combined.

**Ephemeral, scoped session keys.** Every worker agent signs with its own fresh ed25519 keypair, generated client-side and never reused across runs by default. The worst-case blast radius of a leaked session key is bounded to that one agent's remaining allowance and its one assigned vault — it cannot reach the user's real wallet, cannot touch another agent's funds, and cannot be redirected to a different destination than the one it was scoped to at deploy time.

**Revocation paths, layered:**
1. **Instant, global:** `token.approve(router, 0)` — one signature, zeroes the entire grant, works even if the relayer is down (submitted directly, user-paid).
2. **Per-agent:** an agent's own `revoked` flag can be set, or its owner can call `owner_withdraw()` to sweep that specific agent's assets out immediately. The exit router (`sweep(owner, agents, to)`) batches every agent's `owner_withdraw` into one signed transaction for a whole-run exit.
3. **Vault-level pause:** the vault admin can pause new deposits — but `redeem` is deliberately *not* pause-gated, so a pause can never trap a user's funds; exits always work.
4. **Emergency de-risk:** under an active mandate, the lifeboat can pull *all* strategy capital back to vault-idle in response to a detected market threat.

**Separation of duties.** The relayer's signing key (pays gas) and the keeper's signing key (executes compound/rebalance/derisk) are deliberately distinct identities — a compromise of one does not grant the powers of the other.

---

## 7. What's Real vs. What's Demo

Judges reward honesty. Here is exactly what's real, what's an honest testnet stand-in, and what's still a work in progress.

| Component | Status | Notes |
|---|---|---|
| **Blend Capital lending yield** | ✅ Real | Actual Blend v2 testnet pool; interest and BLND emissions are genuinely accrued and harvested, not simulated |
| **Circle CCTP bridge (both directions)** | ✅ Real, live-proven | Burn/mint corridor between Stellar and Base Sepolia proven working in both directions |
| **Fee-bump relay (gasless deposits)** | ✅ Real, live-proven | User genuinely pays 0 XLM; relay wallet funds the network fee |
| **One-signature grant** | ✅ Real, live-proven | `funding_router.grant()` deploying N agents + setting the SEP-41 allowance in a single signed transaction |
| **Lifeboat emergency derisk** | ✅ Real, live-proven | A "whale-attack drill" derisk-then-resume cycle has been executed live on testnet |
| **Base-side yield pools (MockERC4626)** | ⚠️ Honest testnet stand-in | 1:1 custody of *real* CCTP-bridged USDC, but no fabricated yield — because no real lending protocol on Base Sepolia currently accepts Circle's bridged USDC (verified by a dedicated on-chain check) |
| **AaveV3Adapter4626 (mainnet adapter)** | ⚠️ Built, not deployed | Unit-tested and fork-tested against real Aave Base-mainnet bytecode; ready as a mainnet drop-in, but there's nothing real for it to wrap on testnet today |
| **Testnet faucet** | ⚠️ Testnet-only | Dispenses testnet USDC with strict per-recipient/global daily caps; not present or meaningful on mainnet |
| **Demo agent (`CCY452UM...`)** | ⚠️ Smoke-test fixture | A seeded agent with a fixed, constructor-only scope, kept for explorer/smoke checks; product flows always deploy fresh session agents via the grant path instead |
| **View-as dev override** (`/agent?as=`) | ⚠️ Dev-only | Behind `import.meta.env.DEV`, dead-code-eliminated in production builds, used only to demo the ops console with a different address's real positions |
| **Registry contract** | ⚠️ Legacy, live but unused | Still deployed and readable, but the current router + agent-account flow does not call it; superseded by per-agent on-chain scoping |
| **"Parallel" agent dispatch** | ⚠️ Precision note | Workers are dispatched in sequence with a 2-second gap (to respect relay rate limits), not literally simultaneously; the safety property that matters — one worker's failure never blocking or aborting another's — is genuinely implemented |
| **VF Wallet classic (ed25519)** | ⚠️ Implemented, UI pending | Keypair generation, import, and encrypted storage exist in code; onboarding UI integration into the main app flow is not yet complete |
| **Coinbase on-ramp fallback** | ⚠️ Stubbed | Returns `501 Not Implemented`; Transak is the working primary on-ramp |
| **1Shot (EVM-era relayer)** | ⛔ Fully removed | Decommissioned 2026-06-21 alongside the EVM stack; no `ONESHOT_*` environment variables exist anywhere in the current codebase |

---

## 8. Glossary

- **Soroban** — Stellar's smart-contract platform (Rust, WebAssembly). Where every contract in this project (`funding_router`, `agent_account`, the vault, the strategy, `attestation`) lives.
- **SEP-41 allowance** — Stellar's standard token-approval mechanism (comparable to ERC-20's `approve`), extended with a native, on-chain expiry. This is the "spending leash" — a budget cap plus a hard cutoff date, enforced by the token contract itself.
- **Session key** — a throwaway ed25519 keypair generated fresh for one worker agent, valid only for that agent's scoped operations. The "valet key" analogy: it can do one narrow job and nothing else.
- **Fee-bump (relay)** — a Stellar transaction type where a second party (the relay) pays the network fee for someone else's already-signed transaction, without altering what that transaction does. The "postage meter" of the system.
- **Custom account / `__check_auth`** — Soroban's mechanism for a smart contract to define its own authorization rules instead of using a plain keypair. `agent_account` uses this to enforce its spending scope on every transaction.
- **CCTP (Cross-Chain Transfer Protocol)** — Circle's official burn-and-mint bridge for USDC, used here to move USDC between Stellar and Base without a third-party custodial bridge.
- **Vault share** — a unit of ownership in the yield vault, minted on deposit and burned on withdrawal; its price rises as the vault earns interest, similar to a money-market fund's NAV per share.
- **Mandate** — a time-boxed permission the user grants specifically to the lifeboat radar, allowing it to autonomously pull funds to safety during that window only. Distinct from the funding grant — this mandate authorizes *emergency* action, not deposits.
- **Fail-closed** — a design principle where, when something can't be verified (a missing fact, an expired permission, an unreachable signal), the system defaults to the safer/more restrictive outcome (reject, alarm, do-nothing) rather than the permissive one.
- **BLND emissions** — reward tokens paid out by the Blend Capital protocol to lenders, on top of ordinary interest; harvested and (optionally) swapped to USDC by the strategy contract.
- **ZeroDev Kernel** — an ERC-4337 ("account abstraction") smart-account framework used on the Base side, enabling session keys and gas sponsorship analogous to what the Stellar side achieves with custom accounts and the fee-bump relay.
- **BYOK (Bring Your Own Key)** — a design pattern where a user can supply their own API key (for an AI provider or search service) to bypass the app's own server-side key and its rate limits, with the app's key acting only as a zero-setup fallback.

---

## 9. FAQ for Judges

**Q: What stops the AI from making a reckless allocation decision?**
A: Four independent layers, any of which can stop it: the strategist's own response validation (rejecting hallucinated vault addresses or malformed numbers), the AI council's Risk Analyst (hard veto if risk confidence exceeds 0.85), the fail-closed eligibility gate (rejecting unaudited, thin-liquidity, or yield-doesn't-match-revenue protocols), and finally the user, who reviews and can edit every field before approving anything.

**Q: What if the AI provider is down, rate-limited, or just wrong?**
A: The strategist has five fallback tiers, ending in a deterministic equal-split allocation that requires no AI call at all and cannot fail. The flow is designed to never block on an external AI provider.

**Q: What can a compromised worker session key actually do?**
A: At absolute worst, drain that one agent's remaining allowance into the vault it was already scoped to — which is where the user's money was headed anyway. It cannot reach the user's main wallet, cannot touch other agents, and cannot redirect funds to an attacker's address (exit paths on the agent account only ever send to the recorded owner).

**Q: How is this different from just giving a bot my private key?**
A: The user never signs over their private key or unlimited access. They sign one bounded, expiring, on-chain allowance and a batch deployment of pre-scoped worker contracts. The boundary — cap, vault, expiry — is enforced by Soroban's authorization system and the SEP-41 token contract, not by a promise from the application's own code.

**Q: What happens in an actual market emergency — does the system automatically pull my funds?**
A: Only if the user has an active, time-boxed mandate granted at that moment. The lifeboat radar checks for danger every ~6 seconds regardless, but if the mandate has expired, it logs an alarm and does nothing — it will not act without standing, current permission. This is a deliberate trade-off: faster reaction time in exchange for requiring the user to periodically re-affirm they want autonomous emergency action enabled.

**Q: Is the yield real, or is this crediting a made-up interest rate?**
A: The Stellar-side yield is real — USDC is genuinely supplied into the Blend Capital v2 lending pool on testnet, and interest is genuinely accrued and harvested. The optional Base-side pools are explicitly disclosed as honest 1:1 custody vaults (no fabricated yield) because no real lending protocol on Base Sepolia currently accepts the bridged USDC — this is stated plainly in the deployment notes, not hidden.

**Q: Why does the user pay zero gas — who's actually paying?**
A: The project runs its own funded relayer keypair that fee-bumps every allowlisted transaction. It is not a general-purpose sponsor — it only pays for a short, explicit list of operation types (vault deposit/redeem, router grant/pull, and pinned-wasm deploys), so it cannot be tricked into subsidizing arbitrary contract calls.

**Q: How does the user get out, and how fast?**
A: Several ways, depending on urgency: revoke the whole grant instantly with one signature (works even if the app's relay infrastructure is down); withdraw a single agent's position directly (`owner_withdraw`); or redeem vault shares back to USDC at any time through the normal position UI. None of these require waiting on a cooldown for the user's own exit — cooldowns exist for the *keeper's* rebalancing, not for the user pulling their own funds.

**Q: Is any part of this "fake" for the demo?**
A: Yes, and it's disclosed rather than hidden — see [§7](#7-whats-real-vs-whats-demo). The clearest example is the Base-side mock vaults, which honestly custody real bridged USDC without inventing a yield number, precisely because the team verified no real yield source exists there yet on testnet.

**Q: Why Stellar/Soroban instead of Ethereum or another EVM chain?**
A: The project actually started on an EVM stack and migrated fully to Stellar/Soroban (the EVM-era registry, depositor, and 1Shot relay were decommissioned on 2026-06-21). Soroban's native custom-account authorization (`__check_auth`) and SEP-41's built-in allowance expiry map unusually well onto "one scoped signature, many bounded autonomous actions" — the core UX thesis of the product — without needing a bolted-on account-abstraction layer the way EVM chains do.

**Q: What's the single most load-bearing security property in this whole system?**
A: That the spending boundary (budget + expiry) is a native token-level allowance, not application logic. Everything else — the AI, the council, the gate, the UI — can misbehave or have bugs, and the worst outcome is still bounded by that one on-chain, protocol-enforced number.
