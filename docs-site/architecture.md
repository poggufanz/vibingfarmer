# Architecture

Vibing Farmer is a single-chain app on **Stellar / Soroban**, with an optional cross-chain leg to Base. The flow runs from user input, through AI planning and review, to a single grant signature, and then to a parallel swarm of scoped worker agents.

```
User input (amount, risk level, vault count)
                |
                v
        AI strategist (Venice AI — key or x402; DeepSeek proxy fallback)
          |-- Multi-vault allocation + live DeFiLlama data
          |-- Skill JSON per agent (deposit cap + expiry)
                |
                v
        Monte Carlo sim (200 runs, 30d)
        AI Council (yield + risk + market specialists)
                |
                v
        User connects wallet + single-signature grant (funding_router)
                |
                v
        OrchestratorAgent --- attest strategy hash on-chain
          |
    +-----+-----+
    v     v     v
 Worker Worker Worker   (parallel agents)
   ed25519 session key signs a Soroban auth entry
   fee-bump relay broadcasts — user pays zero gas
   autofarm vault -> Blend Capital v2 (real testnet lending yield)
                |
                v
        Autonomous monitor loop + keeper compound + lifeboat radar
```

## Data flow, hop by hop

Each stage below hands a specific payload to the next, and each external dependency in the chain has a defined failure mode — nothing in the pipeline is allowed to hang or throw the whole run.

**User input → strategist.** The form collects three numbers — `amount`, `riskLevel`, `numVaults` — and nothing else is asked of the user at this stage. Those three values seed everything downstream: the AI prompt, the Monte Carlo simulation, and the eventual per-agent spending caps.

**Strategist → live data.** Before calling an AI model, the strategist fetches a live vault catalog from DeFiLlama and market context from Tavily, concurrently, inside an overall 15-second budget. **If DeFiLlama times out or errors, the strategist falls back to a static, hardcoded vault catalog** (the same one the frontend's Market Pulse widget seeds from) rather than blocking the run. If Tavily is unavailable, the market-context section is simply omitted from the prompt — the strategist proceeds without it.

**Strategist → AI provider.** The resolved provider (Venice x402, Venice key, DeepSeek key, host DeepSeek proxy, in that priority order) is called with a hard per-call timeout. **If every AI tier is unavailable or the response fails validation** (a hallucinated vault address, a malformed number, allocations that don't sum to ~1.0), the strategist drops to `buildFallbackForParams()` — a deterministic equal split across the vault catalog that requires no network call and cannot fail. The pipeline never blocks on AI: at worst it produces a less clever allocation.

**Strategist → council → gate.** The proposed allocation passes through the AI council (deterministic Yield/Risk/Market specialists, with the Risk Analyst holding hard veto power above 0.85 confidence) and then the fail-closed eligibility gate, which checks each candidate protocol's yield-to-revenue ratio and security score against facts no older than 30 days. A protocol with missing or stale facts is rejected, not admitted by default. Only vaults that survive both stages reach the user for review.

**User review → grant.** The user edits and approves the per-agent skill cards, then signs once: `funding_router.grant(owner, budget, expiry_ledger, agents[])`. This single signature sets a SEP-41 allowance from the user to the router and deploys N fresh `agent_account` contracts in the same transaction.

**Grant → relay → submission.** The signed grant transaction is submitted preferentially through the fee-bump relay, which pays the network fee so the user's wallet never touches XLM. **If the relay is unreachable (a 503, a network error, or a missing configuration), the flow falls back to a direct, user-paid submission** rather than getting stuck waiting on infrastructure that isn't there — the transaction still lands, just with the user's own account paying the fee this one time.

**Grant → workers → vault.** Each worker signs a deposit authorization with its own ephemeral session key and submits it via the relay. The orchestrator dispatches workers in sequence with a short gap between each (to respect the relay's per-IP rate limit — not simultaneous, see [§3.7 in FEATURES.md](../FEATURES.md#37-parallel-agent-swarm)), and wraps each worker's execution so one failure never aborts the others. Per worker, after submitting the deposit, the code reads a baseline of vault shares beforehand and then **polls `vault.balance(agentAddress)` up to 8 times, 3 seconds apart**, until the share increase is actually confirmed on-chain — because a Soroban transaction returning "success" doesn't by itself guarantee the expected state change landed. If the poll never confirms, the worker reports failure rather than silently assuming success.

**Vault → Blend.** The autofarm vault forwards deposited USDC to the strategy contract, which supplies it into the Blend Capital v2 lending pool — a real testnet lending market, not a simulated interest drip.

**Vault → autonomy plane.** From here, three separate background actors take over routine and emergency maintenance without further user signatures — described in full below.

## Layers

| Layer | Technology |
|-------|------------|
| Smart contracts | Rust, Soroban SDK, OpenZeppelin Stellar contracts |
| Frontend | React 18, Vite 5, React Router v6, Framer Motion, react-force-graph-2d |
| Chain client | `@stellar/stellar-sdk`, Stellar Wallets Kit (Freighter / xBull / Albedo) |
| Wallet | VF Wallet (passkey smart account + extension) or any standard Stellar wallet |
| AI | Venice AI via API key or x402 (SIWE, prepaid USDC); DeepSeek server proxy as zero-config fallback |
| Yield | Autofarm vault → Blend Capital v2 (real testnet lending interest) |
| Live market data | DeFiLlama API (APY, TVL, 7-day history); Tavily search for strategy context |
| Gas | Own fee-bump relayer (`/api/stellar-relay`, allowlisted ops) — user pays 0 |
| Cross-chain (optional) | Circle CCTP v2 + relayer + ZeroDev on Base Sepolia |
| Crypto | ed25519 session keys; libsodium KDF-sealed per-worker key vault |
| Hosting | Cloudflare Pages: static SPA + `/api/*` Pages Functions |

**Smart contracts on Soroban, not the EVM.** The project began on an EVM stack and migrated fully to Stellar because Soroban's native custom-account authorization (`__check_auth`) and SEP-41's built-in allowance expiry map directly onto "one scoped signature, many bounded autonomous actions" — the core UX thesis — without needing a bolted-on account-abstraction layer.

**React SPA on Cloudflare Pages Functions.** The API surface is Pages Functions rather than a separate backend service: the exact same handler code runs locally under Vite and in production on the edge (via a shared `_pagesAdapter.js`), and secrets (relayer key, AI keys, faucet treasury key) are guaranteed to never appear in a bundled browser file.

**A single wallet-kit loader file.** `frontend/src/stellar/walletKitLoader.js` is the one file that imports the Stellar Wallets Kit package, so an upstream change to how Freighter, xBull, or Albedo sign a transaction is a one-file fix rather than a change scattered across every screen that builds a signature request.

**VF Wallet is an origin-bound passkey account.** WebAuthn credentials are bound to the origin that created them, so the browser extension's actual signing ceremony runs in its own tab at the extension's origin rather than inside the popup — and because the extension injects a wallet provider into visited pages, VF Wallet can also serve as the signing wallet for other Stellar apps, not only this one.

**The autofarm vault supplies real yield through Blend Capital v2.** The vault is a share ledger; it doesn't credit interest itself. It supplies deposited USDC into Blend Capital v2, so price-per-share only rises when the pool has genuinely accrued and been harvested — there's no code path that just increments a number.

**Own fee-bump relay.** A relay the project controls can enforce a short, explicit operation allowlist before it ever signs — a general-purpose sponsor (or a service like the now-removed 1Shot) would either need broader trust or wouldn't fit Soroban's fee-bump transaction model as tightly.

**DeFiLlama + Tavily for live data, with a static fallback baked in.** Live data makes the strategist's picks and the Market Pulse UI genuinely current, but neither dependency is allowed to block a run — the static vault catalog exists specifically so the product still functions with both APIs down.

**ed25519 session keys, not a shared or long-lived key.** A fresh keypair per worker per run means a leaked key's blast radius is bounded to one agent's remaining allowance and its one assigned vault, not the user's actual wallet.

## Autonomy plane

Once funds are deposited, three separate background actors run without further user interaction. They differ in cadence, in what triggers them, and in whether they can act on their own initiative or need a standing, time-boxed permission first.

| Actor | Cadence | Can act without a fresh signature? | What it can do |
|---|---|---|---|
| Frontend monitor loop | Configurable heartbeat, default 60s | Moves no funds — propose only | Re-evaluate positions and, on a "keep" council verdict, surface a rebalance/de-risk proposal in the ops console for the user to act on |
| Worker keeper (compound cron) | ~15 minutes | Yes, always | Harvest strategy gains, sweep idle balances, rebalance capital between strategies within hard per-move caps |
| Lifeboat radar | ~6 seconds (one Stellar ledger; polled every 2s) | Only with a live mandate | Pull all strategy capital back to vault-idle (`emergency_derisk`) or resume normal operation |

**The frontend monitor loop** (`frontend/src/strategy/monitorLoop.js`) is a client-side interval, not a server cron — it only runs while the app is open, gated behind the `monitorEnabled` setting (default off) in Settings → Agent. Each tick runs a fixed pipeline: observe state → a pure, no-AI fast-fail gate (so a blocked cycle never spends an AI call) → simulate the current vs. proposed allocation → council verdict → surface the proposal only on a "keep" verdict → reflect on the outcome → journal the cycle. Re-evaluation is triggered either by the heartbeat itself or by `submitIdea()` when APY drift exceeds `apyDriftThreshold` (default 5%) or a VaR-style risk metric breaches `varBreachThreshold` (default 10%). The loop's execute step is deliberately wired to observe-and-propose only: a "keep" verdict logs the proposal to the ops console and moves no funds — withdrawing or rebalancing stays a user-signed action. The separate `autoApprove` setting only suppresses the "approved" status banner when a fast re-evaluation passes; it authorizes nothing. No single cycle's error can kill the loop — every cycle is wrapped so a throw becomes a journaled `crash` entry, and the `setInterval` keeps ticking regardless.

**The worker keeper** (`keeper/src/decide.js`, run on a roughly 15-minute cadence) handles routine vault maintenance that needs no time-boxed permission at all: it calls `compound()` to harvest each strategy's realized interest and BLND emissions and sweep them back into the vault (raising price-per-share), and it rebalances capital between strategies when the APR gap crosses a threshold — capped per move and cooldown-gated so no single call can move everything at once. Compounding is automatically blocked while the vault is in a derisked emergency state. The keeper's signing identity is deliberately separate from the relayer's, so a compromise of one doesn't grant the powers of the other.

**The lifeboat radar** (`keeper/src/radar-runner.mjs`) is the one actor with real teeth and the tightest leash. It polls the vault's health roughly every Stellar ledger — pool utilization, liquidity drop, oracle price divergence — and wants to act the moment any signal crosses its engage threshold (utilization ≥ 95%, liquidity drop ≥ 30%, oracle divergence ≥ 2.5%). But whether it's *allowed* to act depends entirely on a live, time-boxed mandate the user grants separately (`set_mandate(now + 24h)`, one signature, 24-hour TTL, renewable from the ops console). With a live mandate, it calls `emergency_derisk()` and drains all strategies to vault-idle; without one, it logs an alarm and does nothing. Resuming after an emergency requires a stricter, hysteresis-guarded all-clear (a 100-consecutive-ledger streak, roughly 10 minutes) and, again, a live mandate — otherwise funds stay safely idle even after the danger passes. This is the system's clearest fail-closed boundary: danger without standing permission produces a log line, never a transaction.

## Backend surface

Every endpoint that touches a secret — an AI provider key, the relayer's funded keypair, the faucet's treasury key — lives server-side as a Cloudflare Pages Function, never in the browser bundle. All public endpoints share a common origin allowlist and per-IP rate limiter (`frontend/api/_guard.js`).

| Endpoint | Purpose | Rate limit |
|---|---|---|
| `POST /api/stellar-relay` | Fee-bump relay for allowlisted ops (deposit, redeem, grant, pull, pinned-wasm deploy) | 15/min |
| `POST /api/ai` | DeepSeek proxy, model + message allowlisted | 30/min |
| `POST /api/search` | Tavily web-search proxy | 30/min |
| `POST /api/faucet` | Testnet USDC dispense (per-recipient + global daily caps) | 10/min |
| `ANY /api/vf-cross/*` | Proxy to the cross-chain relayer | 30/min |
| `POST /api/onramp-session` | Transak widget session | 10/min |

A handler that throws an unhandled error always degrades to a generic 502 rather than leaking a stack trace, and an endpoint missing its required configuration (for example, the relayer secret) returns a 503 instead of silently doing nothing or bypassing its own guard.

**The developer gateway (`/api/vf/*`)** is a separate, Bearer-token-authenticated API surface that exposes the same core building blocks to external developers via issued `vf_...` keys, with per-key and per-scope rate limiting backed by Cloudflare D1. It reuses the product's own internals rather than duplicating them: `POST /eligibility` runs the identical fail-closed eligibility check described above, `POST /strategy` calls the same AI-or-fallback allocation logic (8-second timeout, never blocks), and `POST /build-tx` / `POST /submit` let a third party build and relay a deposit transaction without reimplementing the Soroban plumbing. Auth is SEP-10-based: `GET /auth/challenge` + `POST /auth/token` exchange a signed challenge for a JWT, which is then used to issue, list, or revoke `vf_...` API keys and to pull a 30-day usage report.

## Repository map

```
soroban/contracts/     # funding_router, agent_account, autofarm_vault,
                       # blend_strategy, exit_router, registry, attestation
frontend/src/stellar/  # Soroban client, session keys, relay client, wallet kit
frontend/src/strategy/ # decision engine: MDP, Monte Carlo, council, gates,
                       # monitor loop, decision log, playbook curator
frontend/api/          # Pages Functions: ai, search, stellar-relay, faucet, guard
frontend/extension/    # VF Wallet browser extension source
relayer/               # optional Node CCTP + Base/ZeroDev cross-chain relayer
keeper/                # compound cron Worker + lifeboat radar
deployments/           # live contract manifests (Stellar testnet, Base Sepolia)
```

## Optional cross-chain leg

The `/farm` flow burns Stellar USDC via Circle CCTP v2, a Node relayer forwards to the Base `YieldRouter`, and a ZeroDev session key supplies into ERC-4626 pools. The unwind reverses the path. This leg is optional and independent of the core Stellar product.

The session key that authorizes Base-side deposits is scoped through a **1-hour TTL mandate**: registering it (`POST /mandate`) sets an expiry the relayer sweeps automatically, so a compromised or stale session key on the Base side has a short shelf life by construction, not by convention. On the contract side, `YieldRouter` never takes custody — funds move through in a single transaction — and only calls into a pool on its own `allowedPool[]` whitelist; `setPool` remains owner-only and is never delegatable to a session key, no matter how the ZeroDev `CallPolicy` is configured.

This whole leg is **fail-closed at the catalog level**: the strategist only folds Base pool allocations into a run when the relayer's own health probe answers healthy. If the probe fails, Base pools are simply absent from the vault catalog for that session — there's no separate error state or broken button, the option just doesn't appear.

Honesty note carried over from the feature docs: the currently whitelisted Base-Sepolia pools are `MockERC4626` contracts doing honest 1:1 custody of real CCTP-bridged USDC, not fabricated yield — a dedicated on-chain check found no real lending protocol on Base Sepolia currently accepts Circle's bridged USDC. A mainnet-ready `AaveV3Adapter4626`, fork-tested against real Aave Base-mainnet bytecode, exists in the repo as a drop-in replacement once a real deployment target exists.

For the full requirements and functional-requirement table, see the [PRD](../prd.md). For the design system, see [DESIGN.md](../DESIGN.md).
