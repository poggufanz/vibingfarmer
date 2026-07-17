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

## Repository map

```
soroban/contracts/     # funding_router, agent_account, autofarm_vault,
                       # blend_strategy, registry, attestation
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

For the full requirements and functional-requirement table, see the [PRD](../prd.md). For the design system, see [DESIGN.md](../DESIGN.md).
