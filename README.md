# Vibing Farmer

<div align="center"><img src=".gitbook/assets/vibing_farmer.logo.png" alt="Vibing Farmer Logo" width="100%"></div>

> **Set once. Vibe forever.** An AI agent swarm that farms yield for you on Stellar, under limits you sign once and the chain enforces.

**Live app:** [vibing-farmer.pages.dev](https://vibing-farmer.pages.dev) · [Demo video (2 min)](https://youtu.be/8mS_DsrNxbM) · [VF Wallet extension](https://github.com/poggufanz/vibingfarmer/releases/latest/download/vibingfarmer-extension.zip) · Stellar testnet

<div align="center">
  <a href="https://youtu.be/8mS_DsrNxbM">
    <img src="https://img.youtube.com/vi/8mS_DsrNxbM/maxresdefault.jpg" alt="Vibing Farmer demo" width="70%">
  </a>
  <p><em>▶ 2-minute walkthrough — strategy → AI council → one signature → parallel deposits</em></p>
</div>

Yield farming is the same loop: find a vault, approve, deposit, do it again for the next protocol. Vibing Farmer turns that into one wallet signature. An AI strategist picks vaults and writes per-agent instructions; workers deposit in parallel. Network fee sponsored by fee-bump relay.

The AI does not get custody of your funds. Each agent runs in a disposable on-chain account with hard limits: how much it can deposit, which vault, until when. Those limits live in contracts (allowance, expiry, vault pin), not in a prompt.

***

## Try it in two minutes

1. Open [vibing-farmer.pages.dev](https://vibing-farmer.pages.dev).
2. Create a VF Wallet (passkey-based, no seed phrase, no extension required). Freighter, xBull, and Albedo work on testnet if you prefer those.
3. Get test USDC from VF Wallet's built-in faucet.
4. Go to Strategy, set amount, risk, and number of agents, review the plan, then sign once.
5. Watch agents deposit in parallel and follow decisions on the Agent dashboard. Network fee sponsored by fee-bump relay.

Everything runs on Stellar testnet. No real funds.

## How it works

1. **Strategy.** You set deposit amount, risk, and vault count. The AI returns an allocation plan and a skill file per agent, using live DeFiLlama data. A Monte Carlo pass stress-tests the allocation over 200 scenarios before anything runs.
2. **AI council.** Three specialists (yield, risk, market) score the proposal on their own. Disagreements go to a synthesis round. Verdict, cited playbook rules, and conflict resolution are logged for review.
3. **Review.** Skill files open in the Skills Drawer. Edit caps, expiries, or targets. Nothing runs until you approve.
4. **One signature.** You sign `funding_router.grant` (budget + permission lifetime). One selected permission lifetime is encoded as an agent Unix expiry and a SEP-41 allowance ledger cutoff derived from the same captured start time. The allowance is the leash: the router deploys a fresh, scoped `agent_account` per worker and can only pull what you approved.

5. **Parallel deposit.** Workers sign with ephemeral ed25519 session keys. A fee-bump relayer sponsors each transaction. One worker failing does not abort the others. Network fee sponsored by fee-bump relay. (A Base pool in the plan settles as a sibling leg — see [Optional Base leg](#optional-base-leg) for its extra prompts.)
6. **Attestation.** The strategy JSON is hashed and written on-chain so anyone with the original file can check what was approved.
7. **Autonomy.** A monitor loop polls positions, flags APY drift, and can propose rebalances. Each cycle goes back through the council. A keeper compounds on a cron; lifeboat radar can de-risk the vault at ledger speed under a user-signed mandate.
8. **Kill switch.** Two exits you can sign yourself, even if every server is down:
   * **Global:** `token.approve(router, 0)` — zero the allowance and funding stops.
   * **Per agent:** `agent_account.revoke()` — flips an on-chain flag that authorization checks fail closed on.

### Optional Base leg

A Base pool only appears in the plan when the cross-chain relayer answers healthy. It settles alongside the Stellar workers in step 5, but it uses a separate Base flow and costs extra prompts:

* **First Base run:** worst case 4 prompts — grant + passkey setup (once, ever) + wallet-signed CCTP approve + burn.
* **Every run after:** 3 wallet signatures (grant + approve + burn) plus a passkey login confirmation. The login never goes away.

Withdraw that position anytime from the dashboard.

## Security

Scope is enforced by contracts, not promises:

* Agent accounts are deposit-only: pinned vault, amount cap per period, hard expiry. Approve, transfer, and anything else fails closed.
* The router holds no funds and has no admin or upgrade path.
* Vault hardening includes a share-inflation guard, untrusted-strategy NAV clamps, balance-delta verification, and emergency de-risk / quarantine hatches.
* The fee-bump relayer only sponsors an allowlisted set of operations. Both kill switches work without it.

Threat model, verified controls, test evidence, and residual risks: [SECURITY.md](SECURITY.md). Testnet software; not an independent audit.

***

## Architecture

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
   Network fee sponsored by fee-bump relay.
   autofarm vault → Blend Capital v2 (real testnet lending yield)
                |
                v
        Autonomous monitor loop + keeper compound + lifeboat radar
```

Primary chain: Stellar / Soroban. Optional cross-chain leg to Base via Circle CCTP v2 + ZeroDev session keys.

***

## Deployed contracts (Stellar testnet)

The Explorer tracks 7 Soroban source crates, 6 first-party Vibing Farmer deployments, and 2
external protocol contracts: 8 static Stellar testnet addresses in total. Agent accounts are
created dynamically per run and are not static deployments.

| Ownership | Contract | Address |
| --------- | -------- | ------- |
| first-party | Funding Router V2 (current app) | `CB675TTSFM6COTGHGB7K2I7IODPQ3HTHOTTTXU2LJHXXNGTS45NOTRSE` |
| first-party | Autofarm vault (live deposit, `vfVLT` 7-dp) | `CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77` |
| first-party | Blend strategy | `CAR7XFFRKMUYSERYBSLQ4LXRY2E2W7G7WG4VQI55FWLSJWQVLNTAFVBE` |
| first-party | Exit router | `CDGDIPHBN3MSNURDX33IZBXXQTJPT7THAXSMVBAIOIXLOA6OF32IRS2J` |
| first-party | Strategy attestation | `CDDOW2FZ7ALBWBXF22TPMPDHPXSKTMLQGGQWUYX7YOJZAHICD7DUO2K6` |
| first-party | Agent registry | `CAP5E2FPDAGEQ7SR55YRY4Z56GPBSTRRZJCYN2PQ6PZQHQJKYEDVM5FB` |
| external | Blend v2 pool | `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF` |
| external | Stellar testnet USDC token (7-dp) | `CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU` |

Look up any address on [Stellar Expert](https://stellar.expert/explorer/testnet):
`https://stellar.expert/explorer/testnet/contract/<address>`. The manifest also records WASM
hashes and deployment receipts; an agent WASM value is a hash, not a contract address:
[`deployments/stellar-testnet.json`](deployments/stellar-testnet.json). The retired V1 router
remains a relay compatibility address in that manifest, but is not the active app router or an
Explorer static-deployment count.

***

## Tech stack

| Layer                  | Technology                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| Smart contracts        | Rust, Soroban SDK, OpenZeppelin Stellar contracts                                                 |
| Frontend               | React 18, Vite 5, React Router v6, Framer Motion, react-force-graph-2d                            |
| Chain client           | `@stellar/stellar-sdk`, Stellar Wallets Kit (Freighter / xBull / Albedo)                          |
| Wallet                 | VF Wallet (passkey smart account + extension) or any standard Stellar wallet                      |
| AI                     | Venice AI via API key or x402 (SIWE, prepaid USDC); DeepSeek server proxy as zero-config fallback |
| Yield                  | Autofarm vault → Blend Capital v2 (testnet lending interest)                                      |
| Live market data       | DeFiLlama API (APY, TVL, 7-day history); Tavily search for strategy context                       |
| Network fee            | Sponsored by fee-bump relay (`/api/stellar-relay`, allowlisted ops)                                |
| Cross-chain (optional) | Circle CCTP v2 + relayer + ZeroDev on Base Sepolia                                                |
| Crypto                 | ed25519 session keys; libsodium KDF-sealed per-worker key vault                                   |
| Hosting                | Cloudflare Pages: static SPA + `/api/*` Pages Functions                                           |

***

## Pages

| Route       | Description                                                      |
| ----------- | ---------------------------------------------------------------- |
| `/`         | Landing; no wallet required                                      |
| `/home`     | Portfolio, positions, alerts, market pulse                       |
| `/strategy` | Wizard: input → connect → skills → permission → execute → done   |
| `/agent`    | Dashboard: scopes, revoke, monitor status, journal, decision log |
| `/history`  | Tx and strategy history                                          |
| `/settings` | Wallet, permissions, agent config, language, skill source        |
| `/explorer` | Stellar deployment facts and on-chain attestations; no wallet  |
| `/replay`   | Timeline replay from static JSON (no RPC)                        |

***

## Skill system

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

`maxAmount` is 7-dp base units (`1000000000` = 100 USDC). Every field is editable in the Skills Drawer before approval. You can load custom skill files in Settings.

***

## Development

### Run locally

```bash
cd frontend
cp .env.example .env.local       # Vite client vars
cp .dev.vars.example .dev.vars   # server proxy + relayer secrets (Pages Functions)
npm install
npm run dev                      # http://localhost:5173
```

AI keys are optional. Paste a Venice key in Settings, set a server-side `DEEPSEEK_API_KEY`, or use neither: a deterministic fallback keeps the demo working.

### Environment variables

Server-side only (Cloudflare Pages env / `.dev.vars` — never `VITE_` for secrets):

```env
STELLAR_RELAYER_SECRET=S...                       # fee-bump sponsor (fund on testnet)
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
SOROBAN_VAULT_ADDRESS=CDWHNHIH…KM77               # autofarm vault
SOROBAN_ROUTER_ADDRESSES=CB675TTS…TRSE,CCEWWRQV…CYE5  # canonical V2,V1 order
SOROBAN_AGENT_WASM_HASHES=1fdbe175…fbe1,d61ceaaa…a2ba # matching ordered hashes
SOROBAN_ROUTER_ADDRESS=CB675TTS…TRSE              # singular current-V2 compatibility fallback
ALLOWED_ORIGIN=https://your-project.pages.dev     # /api/* origin allowlist
DEEPSEEK_API_KEY=sk-...                           # optional AI fallback (BYOK-first)
TAVILY_API_KEY=tvly-...                           # optional market search
```

Leave host AI keys unset for a lockdown deploy (users bring their own keys).

### Contracts

Contract commands are WSL-only on Windows. From a WSL shell, change to this checkout's
`soroban/` directory (for example `/mnt/<drive>/<path-to-repo>/soroban`), then run:

```bash
cd /mnt/<drive>/<path-to-repo>/soroban
stellar contract build
cargo test                                   # unit + integration + security drills
cargo clippy --all-targets -- -D warnings
```

Deploy and seed scripts live in `scripts/soroban/`. Addresses land in `deployments/stellar-testnet.json`.

### Frontend scripts

```bash
cd frontend
npm test                       # Vitest suite
npm run lint                   # ESLint flat config (all warnings, no gate)
npm run lint:ci                # ESLint gated against the checked-in warning-fingerprint baseline
npm run lint:warnings:update   # regenerate the baseline locally after a reviewed warning change (refuses under CI=true)
npm run build                  # production → dist/
npm run build:ext              # VF Wallet extension → extension-dist/
npm run pages:dev              # build + wrangler pages dev (Functions locally)
```

### CI/CD

`.github/workflows/frontend.yml` triggers on every `push` to `main`/`dev`, every `pull_request`, and `merge_group` (no narrowing `types`/`paths` filters — the gate always evaluates). Six stable jobs always report a result: `frontend-unit-build` (`npm ci`, `lint:ci`, `format:check`, `brand:check`, unit tests, `build`, `build:ext`, `manifest:check`, banned-string scan), `relayer`, `keeper`, `soroban` (pinned Ubuntu 24.04 + Rust 1.91.0 + `stellar-cli` 26.1.0 — the SDK's MSRV, not the plan's stated 1.82.0 — `stellar contract build`, `cargo test --locked`, `cargo clippy --locked --all-targets -- -D warnings`), `playwright` (`test:visual`, uploads the report/traces on failure), and `claim-evidence` (public-claim scan, evidence matrix, and feature-freeze validation). `release-gate` (`if: always()`, `needs` on all six, evaluated by `scripts/ci/release-gate.mjs`) is the intended single required check — it fails if any job is anything other than `success`, including skipped. `deploy` needs only `release-gate`, so no other job can be bypassed to reach Cloudflare Pages: `dev` → preview, `main` → the `production` GitHub Environment, with a non-secret readiness check before the traffic-shifting `wrangler pages deploy` step and serialized (non-cancelling) concurrency per ref.

Two of those guarantees are repo settings, not YAML, and are **not yet in place**: `release-gate` still has to be registered as the required status check in branch protection, and the `production` environment has to be created and protected — `frontend.yml` only names it. The `playwright` job is also merge-blocking on 47 visual baselines that were frozen on a developer box and have never run on a runner, at zero pixel tolerance. See [GETTING\_STARTED.md](GETTING_STARTED.md) section 8 for the full release-prerequisite list, including source-only V3/V4 activation, the three Base-recovery evidence blockers, and the relayer's production boot ordering (D1 `0005`/`0006` before the relayer, never after).

### Directory structure

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

### Documentation

| Document                                        | Focus                                           |
| ----------------------------------------------- | ----------------------------------------------- |
| [prd.md](prd.md)                                | Product requirements and feature status         |
| [SECURITY.md](SECURITY.md)                      | Threat model, verified controls, residual risks |
| [GETTING\_STARTED.md](GETTING_STARTED.md)       | Local setup and demo checklist                  |
| [EVIDENCE_MATRIX.md](EVIDENCE_MATRIX.md)        | Release claim evidence and feature-freeze policy |
| [DESIGN.md](/broken/pages/6Jx8uHi61JqMhzEpSKM5) | Design system / UI                              |
| [soroban/README.md](soroban/)                   | Contract build and test                         |

***

## Resources

* [Stellar Developers](https://developers.stellar.org) · [Soroban smart contracts](https://developers.stellar.org/docs/build/smart-contracts)
* [Blend Capital](https://docs.blend.capital) · [Stellar Wallets Kit](https://stellarwalletskit.dev)
* [Circle CCTP](https://developers.circle.com/cctp) · [ZeroDev](https://docs.zerodev.app)
* [Venice AI](https://venice.ai) · [DeFiLlama API](https://defillama.com/docs/api) · [Cloudflare Pages](https://developers.cloudflare.com/pages/)

## License

MIT
