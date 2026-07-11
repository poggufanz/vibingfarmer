# Vibing Farmer — Product Requirements Document

**Type:** Indie Open-Source Project
**Motivation:** Built out of frustration with sequential, click-heavy DeFi yield farming.
**Tagline:** "Set once. Vibe forever."
**Last updated:** 2026-07-11 (post one-popup grant + testnet hardening)

---

## Problem Statement

### Yield Farming UX is Broken

Yield farmers execute **8+ manual transactions** per rebalance cycle — remove liquidity, swap, approve, supply, borrow, deposit, stake. **Every step = wallet popup + gas fee + risk of mis-click.**

### User Research (X/Twitter 2025–2026)

> "Are you tired of the tedious, multi-step dance of adjusting liquidity in DeFi?" — @John_Peace1

> "Normally it's: bridge → swap → find the right vault → deposit… and hope you didn't miss a step 😭" — @kokocodes

> "agent finance UX is still broken. Today you choose between: full wallet access (risky) • human over-control (co-approving every step)." — @0xYann_

> "only ~15–18% of wallet connects end in a real transaction." — @agnt_hub

---

## Solution: Vibing Farmer

### Elevator Pitch

> AI-coordinated agent swarm for automated real-yield farming on **Stellar/Soroban**. An AI strategist (DeepSeek by default, Venice AI via wallet-funded x402/SIWE, deterministic fallback) generates an allocation strategy that a **multi-perspective AI council** (proposer / risk-compliance / validator debate loop + continuous market monitor) reviews before anything executes. A **fail-closed eligibility gate** checks live protocol facts (DeFiLlama TVL, curated audit data) per target. The user signs **exactly ONE wallet popup** — a `grant` that sets a spending budget and an expiry they choose. From that single signature the on-chain **funding router** deploys one fresh, cryptographically-scoped agent account per vault, and the swarm runs gas-free: agents fund themselves within the granted allowance, deposit into a vault that supplies **real Blend lending yield**, and a keeper compounds on a cron while a ledger-speed **lifeboat radar** stands ready to de-risk the vault in an emergency. A real-time force-directed graph tracks every agent's status and memory. An optional cross-chain leg bridges USDC to Base via **Circle CCTP v2** for EVM pool exposure.

### The One-Popup Flow (core UX)

```
[user] budget + duration + risk  ──►  ONE wallet signature (router.grant)
        └─ nested SEP-41 approve(budget, expiry)      ← allowance IS the leash
        └─ router deploys N agent accounts             ← signer = fresh session key each
[autonomous, 0 popups, 0 gas]  agent.pull(funding) → vault.deposit → Blend supply
[keeper cron]  compound / rebalance          [radar]  emergency de-risk + resume
[anytime]      revoke = approve(router, 0)   ← user kill switch, 1 popup
```

First run: **1 popup** (was 6 before the funding router, 9 before that). Repeat runs within the grant: **0 popups**. Every boundary is enforced on-chain, not by the client.

### What Makes This Different

| Feature | Vibing Farmer | Manual DeFi | Auto-compound bots | Vault aggregators |
|---------|--------------|-------------|--------------------|-------------------|
| Popups per farming run | **1 first run / 0 repeat** | 8+ | deposit per vault | deposit per vault |
| Agent execution | Parallel multi-agent swarm | N/A | N/A | single strategy |
| Permission model | On-chain scoped agent accounts: per-agent cap + expiry + fn allowlist (`__check_auth`), budget bounded by SEP-41 allowance with native expiry, user-revocable | full manual | full custody to contract | full custody to contract |
| AI decision layer | Strategist + council debate + continuous monitor + eligibility gate (fail-closed, live facts) | ❌ | ❌ | curated list |
| Yield source | **Real Blend v2 lending interest** (not a mock drip) | real | real | real |
| Gas | 0 for the user (own fee-bump relay, fail-closed allowlist) | user pays | varies | varies |
| Emergency response | Ledger-speed lifeboat radar → vault-level de-risk under a user mandate | manual | ❌ | pause at best |
| Agent memory + live graph | ✅ per-agent memory, force-graph UI | ❌ | ❌ | ❌ |
| Cross-chain | Optional Stellar↔Base USDC leg via Circle CCTP v2 | manual bridging | ❌ | rare |

---

## Core Architecture

### 1. AI Strategist + Council

- Inputs: amount, risk level, number of vaults.
- Provider chain (`resolveProvider`): Venice AI (wallet-funded x402 + SIWE) → DeepSeek (server proxy `/api/ai` or user BYOK key) → deterministic equal-split fallback. Never blocks the flow.
- **Council review** (`councilReview`/`councilDebate`): proposer, risk-compliance (hard-veto power), and validator specialists debate the strategy; split decisions escalate to one bounded AI call. A **continuous monitor** re-evaluates market drift (APY drift, VaR breach) against localStorage snapshots and surfaces a status badge.
- **Eligibility gate** (fail-closed): per-protocol facts — TVL live from DeFiLlama (6h cache, snapshot fallback with provenance labels), audit/qualitative facts curated — must pass ponzi-ratio/staleness/audit checks or the basket drops that target; all-fail aborts the run.

### 2. One-Popup Grant (funding_router)

- `funding_router` (Soroban, no admin, zero custody) is a **factory + funding gate**:
  - `grant(owner, budget, expiry_ledger, agents[])` — the ONE popup. Owner's signature covers a nested `token.approve(owner→router, budget, expiry_ledger)` (SEP-41 native expiry) AND the deploy of each agent account (wasm hash pinned at router construction).
  - `pull(agent, amount)` — session-key-signed, relayed; only agents the router itself deployed can pull, only from their recorded owner, only within the live allowance.
  - Revoke = `approve(router, 0)` — one popup, instant kill switch.
- Fake-agent attacks are structurally impossible (factory registry, tested), and the agent wasm only authorizes `pull` on its deployer router.

### 3. Agent Swarm (parallel, scoped, gas-free)

- **Orchestrator** (frontend): session keys generated first → one grant popup → dispatches N Workers in parallel (`Promise.allSettled`).
- **Worker agents**: each is a fresh on-chain `agent_account` custom account — `__check_auth` verifies the run's ed25519 session key against a constructor-pinned scope (vault, token, cap per period, expiry, revocable). Deposits are signed by the session key and **fee-bumped by the relay** (user pays 0 XLM).
- **Agent reuse cache**: valid agents (scope headroom, unexpired) are reused across runs → 0-popup repeats.
- **Memory system**: every agent writes memory entries (step, status, shares, timing, lesson) shown in the graph node detail and fed back to the AI next session.

### 4. Real Yield + Autonomy

- **Autofarm vault** (Soroban): share-ledger SEP-41 vault, exchange-rate priced shares; supplies deposits into the **Blend Capital v2 testnet USDC pool** (real lending interest, BLND emissions best-effort via Soroswap).
- **Keeper** (Cloudflare Worker cron, 15 min, dedicated identity): `compound` / `rebalance` under on-chain cooldown + caps.
- **Lifeboat radar** (persistent daemon): evaluates every ledger (~6s) — utilization spike, liquidity drop, oracle divergence (real reference feeds, 60s cache) — and submits `emergency_derisk`/`resume` under a user-granted mandate; fail-closed alarm when the mandate is missing.

### 5. Gasless Relay (own infrastructure)

- `/api/stellar-relay` (Cloudflare Pages Function): fee-bumps user/agent-signed inner txs from a funded relayer key. **Fail-closed allowlist**: vault `deposit`/`redeem`, router `grant`/`pull` (env-gated), allowlisted token transfers, and create-from-hash of pinned wasm only. Origin allowlist + per-IP rate limiting + error sanitization on every endpoint.

### 6. Real-time Agent Graph

- `react-force-graph-2d`: Orchestrator + Workers + Vaults as nodes, live states (idle → running → confirmed → failed), council-monitor badge, node detail = step, scope bounds, memory entries.

### 7. Cross-chain Leg (optional, `/farm`)

- Stellar USDC → **Circle CCTP v2** burn → Node relayer (SQLite-persistent jobs/mandates, shared-secret auth behind a Cloudflare-proxied tunnel, Docker/Oracle-VM runbook) → `YieldRouter` (Base Sepolia) deposits into whitelisted ERC-4626 pools via a ZeroDev session key (one CallPolicy permission; router enforces the pool allowlist). Unwind relays the reverse mint. Both legs live-proven.
- **Honesty note:** no real lending protocol on Base Sepolia accepts Circle USDC (Aave testnet lists its own faucet token — verified on-chain), so testnet pools are honest test vaults while `AaveV3Adapter4626` is **mainnet-ready and fork-proven** against real Aave bytecode; the mainnet flip is a config change.

### 8. Wallets & On-ramp

- Any Stellar Wallets Kit wallet (Freighter, xBull, …) + **VF Wallet** (own extension: passkey Soroban smart wallet, registered as a wallet-kit module).
- Passkey smart wallets on both chains (OZ smart-account-kit on Stellar, ZeroDev kernel on Base).
- Fiat on-ramp: Transak session proxy (server-minted widget URL, secrets never in the bundle); Coinbase Onramp stubbed as fallback.

### 9. Trust & Verifiability

- On-chain **strategy attestation** (Soroban contract): keccak hash of the approved strategy anchored per run, relayer fee-bumped.
- Monte Carlo simulation (scenario sweep + VaR/CVaR), decision log, historical council snapshots.
- Per-network config: testnet↔mainnet switch is **env-only** (unfilled mainnet values throw loudly); quarterly testnet-reset recovery runbook + script.

---

## Functional Requirements

| ID | Feature | Priority | Status |
|----|---------|---------|--------|
| FR-01 | AI strategy + per-agent scope generation (DeepSeek/Venice/fallback) | Must | ✅ |
| FR-02 | Council debate review + continuous market monitor | Must | ✅ |
| FR-03 | Fail-closed eligibility gate with live protocol facts | Must | ✅ |
| FR-04 | **One-popup grant** (budget + user-chosen expiry) → autonomous runs | Must | ✅ live-proven |
| FR-05 | Orchestrator: parallel Worker dispatch, per-agent failure isolation | Must | ✅ |
| FR-06 | Fresh scoped agent account per run (`__check_auth` session keys) | Must | ✅ |
| FR-07 | Gas-free execution via own fee-bump relay (fail-closed allowlist) | Must | ✅ |
| FR-08 | Real Blend v2 lending yield + keeper compound/rebalance | Must | ✅ |
| FR-09 | Lifeboat: ledger-speed emergency de-risk under user mandate | Must | ✅ |
| FR-10 | Real-time force-graph + per-agent memory | Must | ✅ |
| FR-11 | Revocation: grant kill switch + agent revoke + relay kill-switch | Must | ✅ |
| FR-12 | Withdraw / owner exit (full sweep back to owner) | Must | ✅ |
| FR-13 | On-chain strategy attestation | Should | ✅ |
| FR-14 | Cross-chain USDC leg (CCTP v2 Stellar↔Base) | Should | ✅ both legs live-proven |
| FR-15 | Monte Carlo (VaR/CVaR) decision support | Could | ✅ |
| FR-16 | VF Wallet extension (passkey smart wallet, wallet-kit module) | Could | ✅ (prod domain pending in manifest) |
| FR-17 | Fiat on-ramp (Transak) | Could | ✅ (sandbox; prod = KYB) |
| FR-18 | Session persistence across refresh | Should | ✅ |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Smart contracts | Rust / Soroban SDK 26 (`wasm32v1-none`): funding_router, agent_account, autofarm vault, blend_strategy, registry, attestation. Solidity ^0.8.23 + Foundry for the Base leg (YieldRouter, AaveV3Adapter4626) |
| Frontend | React 18 + Vite 5 + React Router + react-force-graph-2d |
| AI | DeepSeek (server proxy, BYOK-first) / Venice AI (x402 + SIWE) / deterministic fallback |
| Chain access | `@stellar/stellar-sdk` 16, viem 2 (Base), Stellar Wallets Kit |
| Relay | Own fee-bump relay (Pages Function) + Node CCTP relayer (SQLite, Docker, Oracle VM + cloudflared) |
| Keeper | Cloudflare Worker cron (autofarm) + Node radar daemon (lifeboat) |
| Networks | Stellar Testnet (primary) · Base Sepolia 84532 (cross-chain leg) |
| Hosting | Cloudflare Pages (SPA + `/api/*` Functions) |
| Tests | vitest (870+ frontend, relayer, keeper) · cargo (105 soroban) · forge (Base incl. fork tests) |

### Deployed Addresses — Stellar Testnet (`deployments/stellar-testnet.json`)

| Contract | Address |
|----------|---------|
| Autofarm vault (LIVE deposit target) | `CB5VKYDUIYX3RZWGVLKKNBPG7V7Z5JIHF2QPNQKWKAHVA3IPSLFZJDYU` |
| Funding router (one-popup grant) | `CBEI5VJKKWLXKQUUUETBAPZSQQLH7I57TSIDTMV4WJMBKIGVF7NSNOFY` |
| agent_account wasm v2 (per-run agents) | `7ced45e735e7e084d96d6a04df7cec6e07bc2b203eedb4d3422949a7e9cca717` |
| Blend v2 pool (yield source) | `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF` |
| USDC (Blend testnet, 7dp) | `CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU` |
| Strategy #1 (vault→Blend) | `CCH424TVLTP2P3URNRGGF26X24XRPBVBXCRZ6QBCWLSX6KH4QZSLNBC2` |
| Registry | `CAEHOZGUGVNRCAFVJCSR3B2EFJ55LEA34S76HTRQGH7XSPBO7YIMNZOQ` |
| Attestation | `CDDOW2FZ7ALBWBXF22TPMPDHPXSKTMLQGGQWUYX7YOJZAHICD7DUO2K6` |

### Deployed Addresses — Base Sepolia (`deployments/base-sepolia.json`)

| Contract | Address |
|----------|---------|
| YieldRouter | `0xF80aa8F571E6d24Ea72F051Fc6F9A9C516727B6d` |
| Circle USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Test pools ×3 (honest; Aave adapter is mainnet-ready, fork-proven) | see deployments JSON |

---

## Timeline

| Phase | Dates | Deliverable | Status |
|-------|-------|-------------|--------|
| 1 — Foundation (EVM era) | 26 Mei – 2 Juni | EVM prototype: registry + depositor + 1Shot relay | ✅ superseded |
| 2 — Stellar migration | 18–21 Juni | Full Soroban rebuild, EVM decommissioned | ✅ |
| 3 — Real yield + autonomy | 22 Jun – 4 Jul | Blend integration, autofarm vault + keeper, lifeboat | ✅ |
| 4 — Cross-chain + wallets | 4–8 Jul | CCTP v2 legs, passkey wallets, YieldRouter, on-ramp | ✅ |
| 5 — Hardening + one-popup | 9–11 Jul | No-mock testnet hardening, per-network config, funding_router one-popup grant | ✅ |
| 6 — Publish | 12–15 Jul | Production deploy, relayer VM, demo video, open-source publishing | 🔨 |

---

## Critical Failure Modes

| Failure | Mitigation |
|---------|-----------|
| AI provider down | Council + deterministic fallback; flow never blocks on AI |
| Eligibility facts unavailable | Snapshot fallback with provenance labels; gate stays fail-closed |
| Relay down | Grant falls back to direct user-paid submit; deposits/pulls surface clear per-agent errors, others continue |
| One Worker fails | `Promise.allSettled` + per-agent failure isolation — run continues |
| Session key leaked | Blast radius = that agent's scope (cap, expiry, fn allowlist) + remaining allowance; funds only ever move owner→agent→vault and back to owner; revoke kills the rest |
| Market emergency | Lifeboat radar de-risks the vault to idle under the user mandate; fail-closed alarm if mandate expired |
| CCTP attestation delay | Relayer polls Iris with persistent jobs; frontend polls status with timeout + resumable job IDs |
| Quarterly testnet reset | `scripts/redeploy-testnet.sh` + `docs/runbooks/testnet-reset.md` |
| Page refresh mid-session | Session resume snapshot + silent reconnect |

---

## Resources

- Stellar / Soroban: https://developers.stellar.org
- Blend Capital: https://docs.blend.capital
- Circle CCTP v2: https://developers.circle.com/cctp
- Stellar Wallets Kit: https://stellarwalletskit.dev
- OpenZeppelin Stellar contracts: https://docs.openzeppelin.com/stellar-contracts
- ZeroDev: https://docs.zerodev.app
- Venice AI: https://venice.ai/ · DeepSeek: https://platform.deepseek.com/
- react-force-graph: https://github.com/vasturiano/react-force-graph
