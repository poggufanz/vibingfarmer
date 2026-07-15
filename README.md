# Vibing Farmer

<div align="center"><img src=".gitbook/assets/vibing_farmer.logo.png" alt="Vibing Farmer Logo" width="100%"></div>

## Vibing Farmer

> **Set once. Vibe forever.** An AI agent swarm that farms yield for you on Stellar — under limits you sign once, enforced on-chain.

**▶ Live app:** [**vibing-farmer.pages.dev**](https://vibing-farmer.pages.dev) · [VF Wallet extension](https://github.com/poggufanz/vibingfarmer/releases/latest/download/vibingfarmer-extension.zip) · Stellar testnet

Yield farming is the same clicks repeated: find a vault, approve, deposit, repeat for the next protocol. Vibing Farmer collapses all of it into **one signature**. An AI strategist picks the vaults and writes per-agent instructions; a swarm of worker agents executes the deposits in parallel; you pay **zero gas**.

The AI is never trusted with your money. Every agent runs inside a disposable on-chain account whose powers are pinned by contract — how much it can deposit, into which vault, until when. Limits live on-chain (allowance, expiry, vault pin), not in a prompt.

***

### Try it in two minutes

1. Open [**vibing-farmer.pages.dev**](https://vibing-farmer.pages.dev).
2. Create a **VF Wallet** — passkey-based, no seed phrase, no extension needed. (Prefer your own? Freighter, xBull, and Albedo work too, on testnet.)
3. Get test USDC from VF Wallet's **built-in faucet**.
4. Go to **Strategy** → set amount, risk, number of agents → review the AI's plan → sign **once**.
5. Watch your agents deposit in parallel, gas-free, and track every decision on the **Agent** dashboard.

Everything runs on Stellar **testnet** — no real funds involved.

### How it works

1. **Strategy.** You set deposit amount, risk, and how many vaults. The AI strategist returns an allocation plan plus a skill file per agent, backed by live DeFiLlama market data. Before anything runs, a Monte Carlo simulation stress-tests the allocation over 200 scenarios.
2. **AI council.** Three specialists (yield, risk, market) score the proposal independently. Disagreements go to a synthesis round. The verdict, cited playbook rules, and conflict resolution are all logged for you to inspect.
3. **Review.** Every skill file is open in the Skills Drawer — edit caps, expiries, or targets. Nothing runs until you approve.
4. **One signature.** You sign `funding_router.grant` (budget + expiry). A SEP-41 token allowance _is_ the leash: the router deploys a fresh, scoped `agent_account` per worker and can only pull within what you approved.
5. **Parallel deposit.** Workers sign deposits with ephemeral ed25519 session keys; a fee-bump relayer sponsors every transaction. One worker failing never aborts the others. You pay 0 gas.
6. **Attestation.** The strategy JSON is hashed and written on-chain, so anyone holding the original file can verify what was approved.
7. **Autonomy.** A monitor loop polls positions, flags APY drift, and can propose rebalances — each cycle re-reviewed by the council. A keeper compounds yield on a cron; a lifeboat radar can de-risk the vault at ledger speed under a user-signed mandate.
8. **Kill switch.** Two user-signed exits that work even if every server is down:
   * **Global:** `token.approve(router, 0)` — the allowance is the budget; zero it and funding stops.
   * **Per agent:** `agent_account.revoke()` — flips an on-chain flag every authorization check fails closed on.

### Security

Scope is enforced by contracts, not promises:

* Agent accounts are **deposit-only**: pinned vault, amount cap per period, hard expiry. Approve/transfer/anything-else fails closed.
* The router holds no funds and has **no admin or upgrade path**.
* Vault hardening: share-inflation guard, untrusted-strategy NAV clamps, balance-delta verification, emergency de-risk and quarantine hatches.
* The fee-bump relayer only sponsors an **allowlisted** set of operations — and both kill switches work without it.

The full internal hardening review — threat model, verified controls, test evidence, and honest residual risks — is in [SECURITY.md](SECURITY.md). Testnet software; not an independent audit.

***

### Architecture

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
   autofarm vault → Blend Capital v2 (real testnet lending yield)
                |
                v
        Autonomous monitor loop + keeper compound + lifeboat radar
```

Single chain: **Stellar / Soroban**. Optional cross-chain leg to Base via Circle CCTP v2 + ZeroDev session keys.

***

### Deployed contracts (Stellar testnet)

| Contract                                    | Address                                                    |
| ------------------------------------------- | ---------------------------------------------------------- |
| Autofarm vault (live deposit, `vfVLT` 7-dp) | `CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77` |
| Funding router (single-signature grant)     | `CCEWWRQVYKEIWTO7GTX2QVHQASC3GIQOZZTDMGTOHFQYKZIX5KJ6CYE5` |
| Registry                                    | `CAP5E2FPDAGEQ7SR55YRY4Z56GPBSTRRZJCYN2PQ6PZQHQJKYEDVM5FB` |
| Blend USDC token (7-dp)                     | `CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU` |
| Blend v2 pool                               | `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF` |

Verify any of them on [Stellar Expert](https://stellar.expert/explorer/testnet): `https://stellar.expert/explorer/testnet/contract/<address>`. Full manifest with wasm hashes and deploy receipts: [`deployments/stellar-testnet.json`](deployments/stellar-testnet.json).

***

### Tech stack

| Layer                  | Technology                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| Smart contracts        | Rust, Soroban SDK, OpenZeppelin Stellar contracts                                                 |
| Frontend               | React 18, Vite 5, React Router v6, Framer Motion, react-force-graph-2d                            |
| Chain client           | `@stellar/stellar-sdk`, Stellar Wallets Kit (Freighter / xBull / Albedo)                          |
| Wallet                 | VF Wallet (passkey smart account + extension) or any standard Stellar wallet                      |
| AI                     | Venice AI via API key or x402 (SIWE, prepaid USDC); DeepSeek server proxy as zero-config fallback |
| Yield                  | Autofarm vault → Blend Capital v2 (real testnet lending interest)                                 |
| Live market data       | DeFiLlama API (APY, TVL, 7-day history); Tavily search for strategy context                       |
| Gas                    | Own fee-bump relayer (`/api/stellar-relay`, allowlisted ops) — user pays 0                        |
| Cross-chain (optional) | Circle CCTP v2 + relayer + ZeroDev on Base Sepolia                                                |
| Crypto                 | ed25519 session keys; libsodium KDF-sealed per-worker key vault                                   |
| Hosting                | Cloudflare Pages: static SPA + `/api/*` Pages Functions                                           |

***

### Pages

| Route       | Description                                                      |
| ----------- | ---------------------------------------------------------------- |
| `/`         | Landing; no wallet required                                      |
| `/home`     | Portfolio, positions, alerts, market pulse                       |
| `/strategy` | Wizard: input → connect → skills → permission → execute → done   |
| `/agent`    | Dashboard: scopes, revoke, monitor status, journal, decision log |
| `/history`  | Tx and strategy history                                          |
| `/settings` | Wallet, permissions, agent config, language, skill source        |
| `/explorer` | On-chain verification (contracts, TVL, test stats); no wallet    |
| `/replay`   | Timeline replay from static JSON (no RPC)                        |

***

### Skill system

One typed skill file per agent (deposit-only; amounts in 7-dp base units):

```json
{
  "agentId": "worker-agent-1",
  "vaultAddress": "CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77",
  "skills": {
    "deposit": { "maxAmount": "1000000000", "vaultAddress": "CDWHNHIH…KM77", "expiresAt": 1749686400 }
  },
  "generatedBy": "venice-ai",
  "approvedByUser": true
}
```

`maxAmount` is 7-dp base units (`1000000000` = 100 USDC). Every field is editable in the Skills Drawer before approval. You can swap custom skill files in Settings.

***

### Development

#### Run locally

```bash
cd frontend
cp .env.example .env.local       # Vite client vars
cp .dev.vars.example .dev.vars   # server proxy + relayer secrets (Pages Functions)
npm install
npm run dev                      # http://localhost:5173
```

AI keys are optional: paste a Venice key in Settings, set a server-side `DEEPSEEK_API_KEY`, or use neither — a deterministic fallback keeps the demo working.

#### Environment variables

Server-side only (Cloudflare Pages env / `.dev.vars` — never `VITE_` for secrets):

```env
STELLAR_RELAYER_SECRET=S...                       # fee-bump sponsor (fund on testnet)
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
SOROBAN_VAULT_ADDRESS=CDWHNHIH…KM77               # autofarm vault
SOROBAN_ROUTER_ADDRESS=CCEWWRQV…CYE5              # funding_router
ALLOWED_ORIGIN=https://your-project.pages.dev     # /api/* origin allowlist
DEEPSEEK_API_KEY=sk-...                           # optional AI fallback (BYOK-first)
TAVILY_API_KEY=tvly-...                           # optional market search
```

Leave host AI keys unset for a lockdown deploy (users bring their own keys).

#### Contracts

```bash
cd soroban
stellar contract build                       # 6 wasms
cargo test                                   # unit + integration + security drills
cargo clippy --all-targets -- -D warnings
```

Deploy + seed scripts live in `scripts/soroban/`. Addresses land in `deployments/stellar-testnet.json`.

#### Frontend scripts

```bash
cd frontend
npm test              # Vitest suite
npm run lint          # ESLint flat config
npm run build         # production → dist/
npm run build:ext     # VF Wallet extension → extension-dist/
npm run pages:dev     # build + wrangler pages dev (Functions locally)
```

#### CI/CD

`.github/workflows/frontend.yml` runs on every push/PR to `main` and `dev`: lint (soft-fail), full Vitest suite, production build. Pushes then auto-deploy to Cloudflare Pages — `dev` → preview, `main` → production.

#### Directory structure

```
soroban/contracts/     # funding_router, agent_account, rwa_vault (autofarm),
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

#### Documentation

| Document                                  | Focus                                           |
| ----------------------------------------- | ----------------------------------------------- |
| [prd.md](prd.md)                          | Product requirements and feature status         |
| [SECURITY.md](SECURITY.md)                | Threat model, verified controls, residual risks |
| [GETTING\_STARTED.md](GETTING_STARTED.md) | Local setup and demo checklist                  |
| [DESIGN.md](DESIGN.md)                    | Design system / UI                              |
| [soroban/README.md](soroban/)             | Contract build and test                         |

***

### Resources

* [Stellar Developers](https://developers.stellar.org) · [Soroban smart contracts](https://developers.stellar.org/docs/build/smart-contracts)
* [Blend Capital](https://docs.blend.capital) · [Stellar Wallets Kit](https://stellarwalletskit.dev)
* [Circle CCTP](https://developers.circle.com/cctp) · [ZeroDev](https://docs.zerodev.app)
* [Venice AI](https://venice.ai) · [DeFiLlama API](https://defillama.com/docs/api) · [Cloudflare Pages](https://developers.cloudflare.com/pages/)

### License

MIT
