# Vibing Farmer — Product Requirements Document

**Type:** Indie Open-Source Project
**Motivation:** Built out of frustration with sequential, click-heavy DeFi yield farming.
**Tagline:** "Set once. Vibe forever."
**Last updated:** 2026-07-11 (post single-signature grant + testnet hardening)

---

## Problem Statement

### Yield Farming UX is Broken

Yield farmers execute **8+ manual transactions** per rebalance cycle — remove liquidity, swap, approve, supply, borrow, deposit, stake. **Every step = wallet signature + gas fee + risk of mis-click.**

### User Research (X/Twitter 2025–2026)

> "Are you tired of the tedious, multi-step dance of adjusting liquidity in DeFi?" — @John_Peace1

> "Normally it's: bridge → swap → find the right vault → deposit… and hope you didn't miss a step ðŸ˜­" — @kokocodes

> "agent finance UX is still broken. Today you choose between: full wallet access (risky) â€¢ human over-control (co-approving every step)." — @0xYann_

> "only ~15–18% of wallet connects end in a real transaction." — @agnt_hub

---

## Solution: Vibing Farmer

### Elevator Pitch

> AI-coordinated agent swarm for automated real-yield farming on **Stellar/Soroban**. An AI strategist (DeepSeek by default, Venice AI via wallet-funded x402/SIWE, deterministic fallback) generates an allocation strategy that a **multi-perspective AI council** (proposer / risk-compliance / validator debate loop + continuous market monitor) reviews before anything executes. A **fail-closed eligibility gate** checks live protocol facts (DeFiLlama TVL, curated audit data) per target. The user signs **exactly ONE wallet signature** — a `grant` that sets a spending budget and an expiry they choose. From that single signature the on-chain **funding router** deploys one fresh, cryptographically-scoped agent account per vault, and the swarm runs gas-free: agents fund themselves within the granted allowance, deposit into a vault that supplies **real Blend lending yield**, and a keeper compounds on a cron while a ledger-speed **lifeboat radar** stands ready to de-risk the vault in an emergency. A real-time force-directed graph tracks every agent's status and memory. An optional cross-chain leg bridges USDC to Base via **Circle CCTP v2** for EVM pool exposure.

### The single-signature Flow (core UX)

```
[user] budget + duration + risk  â”€â”€â–º  ONE wallet signature (router.grant)
        â””â”€ nested SEP-41 approve(budget, expiry)      ← allowance IS the leash
        â””â”€ router deploys N agent accounts             ← signer = fresh session key each
[autonomous, 0 further signatures, 0 gas]  agent.pull(funding) → vault.deposit → Blend supply
[keeper cron]  compound / rebalance          [radar]  emergency de-risk + resume
[anytime]      revoke = approve(router, 0)   ← user kill switch, 1 signature
```

First run: **1 signature** (was 6 before the funding router, 9 before that). Repeat runs within the grant: **0 further signatures**. Every boundary is enforced on-chain, not by the client.

### What Makes This Different

| Feature | Vibing Farmer | Manual DeFi | Auto-compound bots | Vault aggregators |
|---------|--------------|-------------|--------------------|-------------------|
| Wallet signatures per farming run | **1 first run / 0 repeat** | 8+ | deposit per vault | deposit per vault |
| Agent execution | Parallel multi-agent swarm | N/A | N/A | single strategy |
| Permission model | On-chain scoped agent accounts: per-agent cap + expiry + fn allowlist (`__check_auth`), budget bounded by SEP-41 allowance with native expiry, user-revocable | full manual | full custody to contract | full custody to contract |
| AI decision layer | Strategist + council debate + continuous monitor + eligibility gate (fail-closed, live facts) | âŒ | âŒ | curated list |
| Yield source | **Real Blend v2 lending interest** (not a mock drip) | real | real | real |
| Gas | 0 for the user (own fee-bump relay, fail-closed allowlist) | user pays | varies | varies |
| Emergency response | Ledger-speed lifeboat radar → vault-level de-risk under a user mandate | manual | âŒ | pause at best |
| Agent memory + live graph | âœ… per-agent memory, force-graph UI | âŒ | âŒ | âŒ |
| Cross-chain | Optional Stellarâ†”Base USDC leg via Circle CCTP v2 | manual bridging | âŒ | rare |

---

## Core Architecture

### 1. AI Strategist + Council

- Inputs: amount, risk level, number of vaults.
- Provider chain (`resolveProvider`): Venice AI (wallet-funded x402 + SIWE) → DeepSeek (server proxy `/api/ai` or user BYOK key) → deterministic equal-split fallback. Never blocks the flow.
- **Council review** (`councilReview`/`councilDebate`): proposer, risk-compliance (hard-veto power), and validator specialists debate the strategy; split decisions escalate to one bounded AI call. A **continuous monitor** re-evaluates market drift (APY drift, VaR breach) against localStorage snapshots and surfaces a status badge.
- **Eligibility gate** (fail-closed): per-protocol facts — TVL live from DeFiLlama (6h cache, snapshot fallback with provenance labels), audit/qualitative facts curated — must pass ponzi-ratio/staleness/audit checks or the basket drops that target; all-fail aborts the run.

### 2. single-signature grant (funding_router)

- `funding_router` (Soroban, no admin, zero custody) is a **factory + funding gate**:
  - `grant(owner, budget, expiry_ledger, agents[])` — the a single signature. Owner's signature covers a nested `token.approve(owner→router, budget, expiry_ledger)` (SEP-41 native expiry) AND the deploy of each agent account (wasm hash pinned at router construction).
  - `pull(agent, amount)` — session-key-signed, relayed; only agents the router itself deployed can pull, only from their recorded owner, only within the live allowance.
  - Revoke = `approve(router, 0)` — a single signature, instant GLOBAL funding kill switch. Per-agent: `agent_account.revoke()` (owner-signed) flips the on-chain `revoked` flag `__check_auth` enforces and zeroes the agent's vault allowance; the Registry only mirrors it as metadata.
- Fake-agent attacks are structurally impossible (factory registry, tested), and the agent wasm only authorizes `pull` on its deployer router.

### 3. Agent Swarm (parallel, scoped, gas-free)

- **Orchestrator** (frontend): session keys generated first → a single grant signature → dispatches N Workers in parallel (`Promise.allSettled`).
- **Worker agents**: each is a fresh on-chain `agent_account` custom account — `__check_auth` verifies the run's ed25519 session key against a constructor-pinned scope (vault, token, cap per period, expiry, revocable). Deposits are signed by the session key and **fee-bumped by the relay** (user pays 0 XLM).
- **Agent reuse cache**: valid agents (scope headroom, unexpired) are reused across runs → signature-free repeats.
- **Memory system**: every agent writes memory entries (step, status, shares, timing, lesson) shown in the graph node detail and fed back to the AI next session.

### 4. Real Yield + Autonomy

- **Autofarm vault** (Soroban): share-ledger SEP-41 vault, exchange-rate priced shares; supplies deposits into the **Blend Capital v2 testnet USDC pool** (real lending interest, BLND emissions best-effort via Soroswap).
- **Keeper** (Cloudflare Worker cron, 15 min, dedicated identity): `compound` / `rebalance` under on-chain cooldown + caps.
- **Lifeboat radar** (persistent daemon): evaluates every ledger (~6s) — utilization spike, liquidity drop, oracle divergence (real reference feeds, 60s cache) — and submits `emergency_derisk`/`resume` under a user-granted mandate; fail-closed alarm when the mandate is missing.

### 5. Gasless Relay (own infrastructure)

- `/api/stellar-relay` (Cloudflare Pages Function): fee-bumps user/agent-signed inner txs from a funded relayer key. **Fail-closed allowlist**: vault `deposit`/`redeem`, router `grant`/`pull` (env-gated), allowlisted token transfers, and create-from-hash of pinned wasm only. Origin allowlist + per-IP rate limiting + error sanitization on every endpoint.

### 6. Real-time Agent Graph

- `react-force-graph-2d`: Orchestrator + Workers + Vaults as nodes, live states (idle → running → confirmed → failed), council-monitor badge, node detail = step, scope bounds, memory entries.

### 7. Cross-chain Leg (merged into Strategy, optional)

- The AI strategist offers Base pool allocations in the same merged catalog as Stellar vaults, but only when the relayer's health probe succeeds — **fail-closed**: Base pools are simply absent from the catalog otherwise, no separate page or flow to opt into.
- A Base allocation settles as a sibling leg beside the Stellar workers, never blocking them: ensure Base owner (ZeroDev passkey ceremony, once per lifetime — a login thereafter) → 1h mandate → Node relayer (SQLite-persistent jobs/mandates, shared-secret auth behind a Cloudflare-proxied tunnel, Docker/Oracle-VM runbook) → **Circle CCTP v2** burn (approve + deposit_for_burn, both signed by the connected wallet) → `YieldRouter` (Base Sepolia) deposits into whitelisted ERC-4626 pools via a ZeroDev session key (one CallPolicy permission; router enforces the pool allowlist). Unwind is a dashboard withdraw call, reversing the mint. Both legs live-proven.
- **Honest signature accounting:** worst case for any wallet (VF Wallet included — passkey reuse across chains is impossible, see `wallet/passkeyBridge.js`) whose strategy carries a Base allocation = `grant` (1) + one-time passkey ceremony (once per lifetime) + CCTP approve + burn (2) — 4 user actions on the very first Base run; repeat Base runs drop the ceremony to a passkey login prompt.
- **Honesty note:** no real lending protocol on Base Sepolia accepts Circle USDC (Aave testnet lists its own faucet token — verified on-chain), so testnet pools are honest test vaults while `AaveV3Adapter4626` is **mainnet-ready and fork-proven** against real Aave bytecode; the mainnet flip is a config change.

### 8. Wallets & On-ramp

- Any Stellar Wallets Kit wallet (Freighter, xBull, …) + **VF Wallet** (own extension: passkey Soroban smart wallet, registered as a wallet-kit module).
- Passkey smart wallets on both chains (OZ smart-account-kit on Stellar, ZeroDev kernel on Base).
- Fiat on-ramp: Transak session proxy (server-minted widget URL, secrets never in the bundle); Coinbase Onramp stubbed as fallback.

### 9. Trust & Verifiability

- On-chain **strategy attestation** (Soroban contract): keccak hash of the approved strategy anchored per run, relayer fee-bumped.
- Monte Carlo simulation (scenario sweep + VaR/CVaR), decision log, historical council snapshots.
- Per-network config: testnetâ†”mainnet switch is **env-only** (unfilled mainnet values throw loudly); quarterly testnet-reset recovery runbook + script.

---

## Functional Requirements

| ID | Feature | Priority | Status |
|----|---------|---------|--------|
| FR-01 | AI strategy + per-agent scope generation (DeepSeek/Venice/fallback) | Must | âœ… |
| FR-02 | Council debate review + continuous market monitor | Must | âœ… |
| FR-03 | Fail-closed eligibility gate with live protocol facts | Must | âœ… |
| FR-04 | **single-signature grant** (budget + user-chosen expiry) → autonomous runs | Must | âœ… live-proven |
| FR-05 | Orchestrator: parallel Worker dispatch, per-agent failure isolation | Must | âœ… |
| FR-06 | Fresh scoped agent account per run (`__check_auth` session keys) | Must | âœ… |
| FR-07 | Gas-free execution via own fee-bump relay (fail-closed allowlist) | Must | âœ… |
| FR-08 | Real Blend v2 lending yield + keeper compound/rebalance | Must | âœ… |
| FR-09 | Lifeboat: ledger-speed emergency de-risk under user mandate | Must | âœ… |
| FR-10 | Real-time force-graph + per-agent memory | Must | âœ… |
| FR-11 | Revocation: grant kill switch + agent revoke + relay kill-switch | Must | âœ… |
| FR-12 | Withdraw / owner exit (full sweep back to owner) | Must | âœ… |
| FR-13 | On-chain strategy attestation | Should | âœ… |
| FR-14 | Cross-chain USDC leg (CCTP v2 Stellarâ†”Base) | Should | âœ… both legs live-proven |
| FR-15 | Monte Carlo (VaR/CVaR) decision support | Could | âœ… |
| FR-16 | VF Wallet extension (passkey smart wallet, wallet-kit module) | Could | âœ… (prod domain pending in manifest) |
| FR-17 | Fiat on-ramp (Transak) | Could | âœ… (sandbox; prod = KYB) |
| FR-18 | Session persistence across refresh | Should | âœ… |

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
| Autofarm vault (LIVE deposit target) | `CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77` |
| Funding router (single-signature grant) | `CCEWWRQVYKEIWTO7GTX2QVHQASC3GIQOZZTDMGTOHFQYKZIX5KJ6CYE5` |
| agent_account wasm v3 (per-run agents) | `d61ceaaaf5a3fd9fd25987eba0f843ccb79880f3eaa137e066b5f63ab9eaa2ba` |
| Blend v2 pool (yield source) | `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF` |
| USDC (Blend testnet, 7dp) | `CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU` |
| Strategy #1 (vault→Blend) | `CAR7XFFRKMUYSERYBSLQ4LXRY2E2W7G7WG4VQI55FWLSJWQVLNTAFVBE` |
| Registry | `CAP5E2FPDAGEQ7SR55YRY4Z56GPBSTRRZJCYN2PQ6PZQHQJKYEDVM5FB` |
| Attestation | `CDDOW2FZ7ALBWBXF22TPMPDHPXSKTMLQGGQWUYX7YOJZAHICD7DUO2K6` |

### Deployed Addresses — Base Sepolia (`deployments/base-sepolia.json`)

| Contract | Address |
|----------|---------|
| YieldRouter | `0xF80aa8F571E6d24Ea72F051Fc6F9A9C516727B6d` |
| Circle USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Test pools Ã—3 (honest; Aave adapter is fork-proven against Aave v3) | see deployments JSON |

> **Status (2026-07-20):** the Stellar table reflects the hardened redeploy of 2026-07-14
> (see `SECURITY.md`), updated from confirmed transaction receipts. The autofarm vault was
> subsequently upgraded **in place** on 2026-07-20: upgrades are now timelocked (3-day
> schedule → execute, cancellable) and the vault admin is a 2-of-3 multisig. Base Sepolia
> addresses still predate the hardening pass (Base leg redeploy pending).

---

## Timeline

| Phase | Dates | Deliverable | Status |
|-------|-------|-------------|--------|
| 1 — Foundation (EVM era) | 26 Mei – 2 Juni | EVM prototype: registry + depositor + **1Shot relay (superseded — replaced by own Stellar fee-bump + optional ZeroDev on Base)** | âœ… superseded |
| 2 — Stellar migration | 18–21 Juni | Full Soroban rebuild, EVM decommissioned | âœ… |
| 3 — Real yield + autonomy | 22 Jun – 4 Jul | Blend integration, autofarm vault + keeper, lifeboat | âœ… |
| 4 — Cross-chain + wallets | 4–8 Jul | CCTP v2 legs, passkey wallets, YieldRouter, on-ramp | âœ… |
| 5 — Hardening + single-signature grant | 9–11 Jul | No-mock testnet hardening, per-network config, funding_router single-signature grant | âœ… |
| 6 — Publish | 12–15 Jul | Production deploy, relayer VM, demo video, open-source publishing | ðŸ”¨ |

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
