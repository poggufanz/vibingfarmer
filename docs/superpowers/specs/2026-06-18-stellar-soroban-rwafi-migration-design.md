# Design Spec 0 — Stellar/Soroban Migration + RWA-Fi Evolution

**Date:** 2026-06-18
**Status:** ⛔ RWA-Fi direction CANCELLED 2026-06-20 — reverted to plain DeFi yield farming
**Type:** Master architecture / product definition (sub-project 0 — gates 1–4)
**Author:** brainstorming session (caveman-ultra)

> Local-only doc. `docs/superpowers/` is gitignored per project rule — do **not** commit.

> **⛔ CANCELLED 2026-06-20 (commit 52bf9a5 on `iq`).** The RWA-Fi layer was removed and
> the product returned to **plain DeFi yield farming on Soroban**. Dropped: 1b (T-REX
> rwa_token + identity/claim stack + compliance) and 1d (compliance guardrail). The
> `rwa_vault` is now a plain yield vault over any SEP-41/SAC asset (stable-NAV
> daily-dividend yield). **Kept:** 1a (agent accounts + registry) and 2 (gasless fee-bump
> relay). Redeployed to testnet — vault `CCDXZ6BUA7TPR3EXQWJWUD7EYR6OUMJRYIKYXPE53HRJOJFY5CXEHTN5`,
> token (plain SAC `VFUSD`) `CAJSGONIIU4QPLNIVVOO7QCYC2LWGYMGXTD7BXSSNIQWWDHWFQTSAEB4`.
> Everything below documents the abandoned RWA-Fi plan — keep for history only.

---

## 1. Goal

Re-platform Vibing Farmer from EVM (Base Sepolia) to **Stellar Soroban** and evolve the
product from "agent swarm → multi-vault deposit" into a **RWA-Fi** system: an AI agent
swarm that autonomously farms a **mock yield-bearing RWA token** under cryptographic
agent boundaries, on-chain compliance, and an off-chain BlackRock-Aladdin-style risk
engine.

- **Production re-platform** (long-term move, not a hackathon throwaway). Correctness and
  audit-readiness matter.
- **Testnet first** (Soroban testnet). Real RWA assets (FOBXX etc.) are mainnet-only, so the
  RWA token is **mocked** on testnet.

## 2. Scope

**In scope (this program):**
- Full chain migration EVM → Soroban (contracts, wallet, relay, SDK, tests).
- Mock yield-bearing, KYC-gated RWA token.
- AI agent swarm preserved (orchestrator/workers/council), re-pointed to Soroban.
- Five new RWA-Fi features: KYC asset gating, on-chain compliance guardrails, RWA yield
  distribution, passkey smart-wallet onboarding, Aladdin risk engine.

**Out of scope (now):**
- Mainnet deployment, real RWA issuer integration, real fiat on/off-ramp, real KYC
  provider, legal/regulatory filing (OJK etc.). Design should not *block* these later, but
  they are not built here.
- The Indonesian-mutual-fund / OJK narrative from the source doc is **product framing only**,
  not a build target.

## 3. Source-doc fact-check (neutralize `docs/migration_stellar.md`)

`docs/migration_stellar.md` is an AI chat-log dump. Directionally useful, but contains hard
errors. **Do not trust it directly.** Corrected facts:

| Doc claim | Verdict | Correct value |
|---|---|---|
| Testnet passphrase `"Testnet Global Stellar Network ; September 2015"` | ❌ wrong | `"Test SDF Network ; September 2015"` |
| Local node = `stellar contract network start` | ❌ wrong | `stellar container start local` (positional `local`/`testnet`/`futurenet`/`pubnet`; **not** a `--local` flag — that's the quickstart docker-image arg). Older alias: `stellar network container start local`. |
| Auth = `assert!(admin == env.current_contract_address())` | ❌ wrong | `admin.require_auth()` |
| Go SDK = `github.com/stellar/go-stellar-sdk`, `import "://github.com"` | ⚠️ partly wrong | Import string malformed. But `go-stellar-sdk` **does** exist (SDF SDK listing references it); long-standing monorepo is `github.com/stellar/go` (horizonclient, txnbuild). Pin/verify at impl time — don't assert one is "the only" path. |
| Stellar "Common Data Language" | ❌ fabricated | No such feature (Aladdin jargon) |
| `require_auth` removes `approve()` ("zero-step allowance") | ⚠️ misleading | SAC/SEP-41 still have approve/allowance for delegated spend |
| "Zero gas = Fee Bump" | ⚠️ incomplete | fee-bump + sponsored reserves; relayer = OZ Relayer / fee-bump sponsor (note: SDF deprecating Launchtube → Relayer) |
| `wasm32-unknown-unknown` target | ⚠️ version-dependent | Default contract target is now `wasm32v1-none` (Protocol-23-era switch in rs-soroban-env; Tier-2, needs `rustup target add wasm32v1-none`). `stellar contract build` handles it. NOT "soroban-sdk 22+". Pin per SDK; don't hardcode the path. |
| `stellar keys generate ... agent_admin` auto-funds | ⚠️ incomplete | needs `--fund` flag (friendbot) |
| Python SDK = "Stellar core team" | ⚠️ minor | community-maintained (StellarCN) |

**Verified correct in doc:** independent L1 / SCP (not L2); Soroban = Rust→WASM; Foundry
unusable (use stellar-cli + cargo); storage rent / TTL real; native custom accounts replace
ERC-7715/EIP-7702 (+ audited OZ Smart Accounts); `auth_required` regulated-asset flag; USDC
/ PYUSD / MoneyGram on Stellar; Franklin Templeton FOBXX on Stellar; SDEX/AMM 0.3%; ABI →
WASM custom section (no separate ABI); Solang is pre-alpha (don't rely).

**Unverified (non-technical, need web if relied on):** hackathon prize pools, $150k grant,
APAC deadline, OJK POJK timeline. Treat as unconfirmed.

## 4. EVM → Soroban migration map

| Current (EVM) | Soroban target | Verdict |
|---|---|---|
| `AgentRegistry.sol` (EIP-712 scope) | Agent **custom account** (`__check_auth`) + OZ Smart Accounts (signers + spend-cap + scope policy) + thin registry contract for audit/revoke/graph | Rewrite (Rust) |
| `AgentVaultDepositor.sol` (recover signer, deposit-only) | Folded into vault: agent calls `vault.deposit` with `require_auth`; cross-contract to RWA token via SAC | Rewrite |
| `MockVault.sol` (ERC-4626) | **SEP-56** tokenized vault (ERC-4626 equivalent; OZ vaults module) + yield accrual + distribution + guardrails | Reimplement on SEP-56 |
| EIP-712 sign in `worker.js` | Soroban tx + auth entries signed by agent session key / passkey | Rewrite |
| 1Shot Managed API relay | **fee-bump sponsor / OZ Relayer** (server wallet pays XLM) | Replace |
| ethers/viem + ABI | `@stellar/stellar-sdk` + contract spec + RPC simulate/assemble | Rewrite |
| Venice/DeepSeek/council/MonteCarlo/strategy | unchanged off-chain brain | **Reuse ~as-is** |
| react-force-graph monitor | same UI; data from Soroban RPC events | **Reuse, re-point** |
| Foundry tests | `cargo test` + soroban testutils + testnet | Rewrite |

**Reuse:** AI brain + UI. **Rewrite:** all on-chain + wallet/relay/SDK.

## 5. Target architecture

```
USER (passkey smart wallet)
   │ deposit mRWA + approve agent scope (once)
   ▼
OFF-CHAIN BRAIN
  Aladdin risk engine (Py/Go): stress-test / scenario / portfolio-opt   ── NEW
        │ allocation decision (inside compliance envelope)
  AI council / strategist (REUSE: venice / deepseek / Monte Carlo)
        │
  Orchestrator → Workers (REUSE logic; new signing + relay)
        │ sign Soroban tx w/ agent session key / passkey
  Gasless relay: fee-bump / OZ Relayer (server pays XLM)                 ── replaces 1Shot
        ▼
ON-CHAIN (Soroban / Rust)
  1. Agent smart accounts (__check_auth)        ← AgentRegistry + EIP-712
     OZ Smart Accounts: signers + spend-cap + scope policy
     + thin Registry (audit / revoke / graph)
  2. RWA token = Classic asset, auth_required (KYC) + SAC bridge   ← NEW
  3. Vault / RWA-Fi core: shares + yield accrual + pro-rata payout ← MockVault + Depositor
  4. Compliance guardrail: alloc/exposure caps + KYC check → REVERT ← NEW (enforces Aladdin)
        ▼
  RPC events → react-force-graph monitor (REUSE UI, re-point data)
```

### On-chain components (Soroban/Rust)

1. **Agent smart accounts** — per-worker custom-account contract implementing
   `CustomAccountInterface::__check_auth`. Built on **OpenZeppelin Smart Accounts** modules:
   signers (ephemeral session key and/or passkey), spend-limit policy, scope/context policy
   (allowed vault + asset, cap per period, expiry). Replaces `AgentRegistry` EIP-712 scope +
   session keys. A thin **Registry** contract records agent→owner→scope metadata and revoke
   state (keeps the force-graph monitor + revoke UX, gives an audit trail).

2. **RWA token (mock yield-bearing, KYC-gated)** — Stellar **Classic asset** issued with
   `auth_required` (and `auth_revocable` for clawback). KYC = issuer authorizes trustlines
   (native, regulator-recognized allowlist). Wrapped via **SAC** so the Soroban vault can
   move it. The token itself does **not** carry yield; yield lives in the vault.

3. **Vault / RWA-Fi core** — custom Soroban vault. Deposits mRWA, mints shares, accrues
   yield via **share-price growth** (4626-style: share count fixed, asset/share ratio grows;
   mock yield source = admin/oracle drip or time-based accrual), distributes pro-rata on
   redeem. Holds the agent-deposit entrypoint (`require_auth` on agent account). Consults the
   compliance guardrail before state-changing trades.

4. **Compliance guardrail** — allocation/exposure caps (e.g. max % per asset/agent per
   period) + KYC allowlist check. Reverts non-compliant agent trades regardless of AI
   decision. This is where the off-chain Aladdin limits are mirrored and enforced on-chain.
   Implemented as a module of the vault or a separate policy contract it calls.

### Off-chain components

5. **Aladdin risk engine (NEW, heaviest new piece)** — stress testing, scenario/factor risk,
   whole-portfolio optimization. Produces allocation decisions constrained to the compliance
   envelope. Deterministic + seeded (reuse existing strategy discipline). Hybrid model:
   off-chain brain, on-chain enforcement (no on-chain Monte Carlo).

6. **AI council / strategist** — reuse venice/deepseek/council/Monte Carlo; re-point inputs
   to Aladdin and outputs to Soroban signing.

7. **Orchestrator / workers** — reuse coordination logic; swap signing + relay to Soroban.

8. **Gasless relay** — fee-bump sponsor or OZ Relayer; server wallet pays XLM. User pays 0.

9. **Frontend** — `@stellar/stellar-sdk`, passkey + Freighter wallet, tx build/sign/
   simulate/assemble/submit, event indexing → force-graph (reuse UI).

## 6. Key ADRs (decisions made this session)

| Decision | Chosen | Rejected | Reason |
|---|---|---|---|
| Permission model | Custom account `__check_auth` + OZ Smart Accounts + thin registry | Re-implement EIP-712 registry in Rust | Native Soroban AA is first-class + audited; registry kept for audit/revoke/graph |
| **RWA compliance token** (REVISED — see ADR-A below) | **SEP-57 / ERC-3643 (T-REX) via OZ audited RWA module**, primary | Classic asset + `auth_required` + SAC; pure SEP-41 custom | Purpose-built for regulated RWA: identity registry (KYC/AML) + compliance framework + transfer controls + freeze + recovery, **audited by OZ** (kills the "custom audit surface" objection). `auth_required` kept as fallback if tooling support blocks. |
| **KYC verification** (who qualifies — see ADR-B) | **zkPass off-chain zkTLS proof** → writes verified status into T-REX identity registry (or `auth_required` allowlist in fallback) | zkPass proof verified on-chain on Soroban (no Stellar support); naive raw-ID upload | Privacy-preserving (raw ID never sent to us); least effort; layers cleanly ABOVE the token-standard gate. Optional trust-min upgrade = own Groth16 verifier on-chain (BLS12-381). |
| Vault standard | **SEP-56** tokenized vault (OZ vaults module) | Hand-rolled shares | SEP-56 = ERC-4626 equivalent; reuse audited primitive instead of reinventing |
| Yield mechanism (**LOCKED 2026-06-18**) | **(b) FOBXX-faithful: stable $1.00 NAV + daily dividend** (mint/distribute new units) | (a) SEP-56 share-price growth | Product mocks a real money-market RWA (FOBXX/BENJI); faithful daily-dividend behavior matches the asset we claim. Cost: drip + unit-distribution machinery layered on the SEP-56 vault. |
| Compliance | On-chain guardrail mirrors off-chain Aladdin caps | Trust off-chain only | Crypto boundary = contract reverts bad trades regardless of AI |
| Gasless | fee-bump / OZ Relayer (Stellar-native) | Port 1Shot | 1Shot is EVM; OZ Relayer is the Stellar equivalent |
| Aladdin compute | Off-chain brain, on-chain enforce | On-chain Monte Carlo | On-chain simulation infeasible/expensive |
| Onboarding | Passkey smart wallets (WebAuthn) | Seed-phrase EOA only | Soroban-native, modern UX, agent + user accounts unified |
| Tooling | stellar-cli + cargo + soroban testutils | Foundry | Foundry is EVM-only |

### ADR-A — Compliance token standard (added after review; gates layer 1b)

Three real options on Stellar for the KYC'd RWA token. Honest tradeoff — not an auto-pick.

| Option | What it is | Pros | Cons |
|---|---|---|---|
| **A1. SEP-57 / ERC-3643 (T-REX)** ← chosen | Permissioned token extending SEP-41 w/ identity registry + compliance modules. **OZ ships an audited RWA module** (KYC/AML, transfer controls, freeze, recovery, RBAC). | Purpose-built for regulated RWA; audited; covers 3 of 5 new features in one component (KYC gating, token-level compliance, regulated transfer); matches "production + audit-ready" goal | Higher complexity + execution cost; **limited wallet/indexer support** (validate Freighter/Mercury on testnet early); newer standard |
| A2. Classic asset + `auth_required` + SAC | Trustline-authorized classic asset, SAC-bridged | Native, battle-tested, simplest compliance, best ecosystem/wallet support | Compliance = coarse (hold/no-hold); reinvents transfer-rule logic in vault; trustline-authorize UX |
| A3. Pure SEP-41 custom token | Hand-rolled allowlist + rules | Full control, no trustline UX | Reinvents T-REX worse, all custom audit surface |

**Decision:** A1 (T-REX via OZ RWA module) primary; **A2 as fallback** if T-REX wallet/indexer support blocks the frontend/graph on testnet. Validate tooling support in spec 1b **before** committing.

**Consequence:** T-REX's compliance governs *who can hold/transfer the token*. It does **not** cover *agent allocation/exposure caps* (Aladdin limits) — guardrail contract #4 is still required and is a separate concern. Keep them distinct.

### ADR-B — KYC verification mechanism (zkPass / ZK; added 2026-06-18 research)

**Distinction from ADR-A:** ADR-A picks the *token standard* (where verified status lives on-chain + transfer compliance). ADR-B picks *how a user proves they qualify* — the identity check that feeds ADR-A's identity registry / allowlist. Separate concerns; both required.

**What zkPass is:** a zkTLS oracle. User runs the TransGate browser extension and proves a claim about private HTTPS data ("KYC-passed at exchange X", "age > 21", "accredited investor") **locally on-device** using a hybrid VOLE-ZK 23 + SNARK system (proof generated in ms). Raw data never leaves the device. Output: a proof verifiable off-chain, or on supported chains on-chain (verifier contract / soulbound credential). (User has prior hands-on experience with zkPass.)

**Soroban support status (verified 2026-06-18):**
- zkPass on-chain verifier targets **Ethereum, BNB, Solana** — **no Stellar/Soroban support, not on their roadmap.**
- Soroban ZK primitives (per `zk-proofs` skill): **BLS12-381 = CAP-0059, live**; official **Groth16 verifier reference** exists (`soroban-examples/groth16_verifier`). **BN254 / Poseidon = CAP-0074/0075, draft — do not rely.**
- Status-sensitive: re-verify CAP status + network protocol version + `soroban-sdk` host-fn support at impl time.

**Three paths:**

| Option | What | Effort | Verdict |
|---|---|---|---|
| **B1. zkPass off-chain** ← chosen default | zkPass proof verified by our backend off-chain → result writes the user into the T-REX identity registry / `auth_required` allowlist on-chain | Light | Works as zkPass is designed; privacy preserved; no dependency on zkPass supporting Stellar. Trust anchor = backend honest verify (mitigate: append-only audit log + optionally anchor proof hash on-chain) |
| B2. Own Groth16 on-chain | Build own KYC circuit (Noir/Circom → Groth16), verify on Soroban via BLS12-381 `groth16_verifier`; result gates the registry | Heavy | Fully on-chain ZK, self-contained, **no zkPass-Stellar dependency**. Reference exists. Needs circuit + credential issuance + verifier contract + anti-replay (nonce/domain binding) + verification-gateway/policy-split pattern (`zk-proofs` skill). Tracked as optional future sub-project |
| B3. zkPass native on-chain on Soroban | Submit a zkPass proof to a Soroban verifier | — | **Not viable now.** zkPass proof format is EVM-targeted; no Soroban verifier exists; porting their hybrid system is unjustified |

**Decision:** **B1** (zkPass off-chain → drives ADR-A registry/allowlist) as default. **B2** (own Groth16 on-chain) tracked as an optional future upgrade for trust-minimized, fully-on-chain KYC. **B3** ruled out.

**Correction to v0 draft:** the v0 spec implied on-chain ZK on Soroban had "no reference impl." That was wrong — **Groth16 verification has an official reference**; the real gap is specifically zkPass's *proof format* on Soroban (B3), not ZK-on-Soroban in general.

**Composition (three distinct layers — do not conflate):** zkPass B1 = "who qualifies" (private, off-chain) → ADR-A token registry/`auth_required` = "the on-chain holder gate" → guardrail #4 = "agent allocation/exposure caps".

**Impacts:** sub-project 1b (registry/allowlist authorize fn must be callable by a trusted KYC-backend signer), sub-project 3 (frontend integrates the zkPass TransGate flow), + new optional sub-project 5 for B2 (Groth16 verifier).

### 6.1 Yield-model decision (**LOCKED 2026-06-18 → (b) FOBXX-faithful**)

The product claims to "mock a yield-bearing RWA (T-bill / money-market)." Real money-market funds (e.g. FOBXX/BENJI) hold **stable $1.00 NAV + distribute yield as daily dividend** (more token units), and FOBXX is **multichain** (8 chains), not Stellar-exclusive. Two mock models, mutually exclusive:

- **(a) SEP-56 share-price growth** — fixed shares, asset/share ratio grows. Cleaner accounting, default for SEP-56/4626 vaults. **Not** faithful to FOBXX behavior.
- **(b) FOBXX-faithful** ← **CHOSEN** — stable $1.00 NAV + daily dividend (mint/distribute new units). Matches the asset we claim to mock; more moving parts.

**Decision:** (b). The demo narrative claims to mock FOBXX/BENJI money-market RWA, so the vault must behave faithfully — stable NAV, daily dividend distributing new units pro-rata. Avoids the framing/impl mismatch §3 flags as "the original doc's sin" (claiming FOBXX while shipping share-growth).

**Impl consequences for sub-project 1c (pin these in the 1c plan):**
- Vault still built on the SEP-56 / OZ vaults primitive for deposit/redeem/accounting, but the **accrual path is dividend-based**, not share-price-based: NAV per unit held ~stable; yield realized as **newly minted RWA units distributed pro-rata** to holders.
- Need a **dividend distribution mechanism**: an admin/oracle **drip** action (mock yield source) that mints+distributes on a cadence (daily epoch). Decide drip trigger in 1c (admin oracle call vs time/epoch-based claim-on-interaction). Lean claim-on-interaction to avoid unbounded loops + per-holder gas.
- **Storage/TTL:** per-holder dividend accounting (last-claimed epoch, cumulative-per-unit index) must `extend_ttl`; favor a **cumulative-dividend-index** pattern (O(1) per holder, no iteration) over per-holder push.
- Distinct from the **agent guardrail** (#4) and **T-REX transfer compliance** — dividend logic is vault-internal accounting only.

## 7. Decomposition (each = own spec → plan → build)

```
0. Target architecture + RWA-Fi definition   ← THIS spec (gates all)
1. Soroban core contracts                     ← foundation
     1a agent smart accounts + registry
     1b RWA token (SEP-57/ERC-3643 T-REX via OZ RWA module; auth_required fallback)
     1c vault (SEP-56 tokenized vault via OZ) + yield accrual + distribution
     1d compliance guardrail (agent allocation/exposure caps — distinct from T-REX transfer compliance)
2. Gasless relay (fee-bump / OZ Relayer)
3. Frontend chain layer (SDK + passkey wallet + tx + event indexing)
4. Aladdin risk engine + AI council re-point + yield orchestration
5. (optional/future) On-chain ZK-KYC — Groth16 verifier via BLS12-381 (ADR-B2), trust-minimized
6. EVM decommission (LAST) — delete Solidity (contracts/ test/ script/ foundry.toml lib/),
     deployments/base-sepolia.json, EVM frontend chain-layer (worker.js EIP-712, relay.js 1Shot,
     x402.js, redelegation.js, EVM parts of wallet.js/config.js), ethers/viem deps. Keep reused
     AI brain (venice/council/MonteCarlo/strategy) + force-graph UI + orchestrator logic.
```

**Sub-project 6 (EVM decommission) gating:** runs **only after** 3 + 4 are cut over to Soroban and
verified end-to-end on testnet. Do not delete EVM early — it is the working reference during
migration, and the frontend mixes trash (chain layer) with reuse (UI/brain), so premature deletion
risks breaking live code. Destructive + hard to reverse: gate behind a green testnet run.

**Dependencies / order:** 0 gates everything. 1 gates 2/3/4 (they target contract
interfaces). Recommended build order: 1 → 2 → 3 → 4. Within 1: 1a + 1b in parallel, then
1c, then 1d.

**Interfaces between sub-projects:** sub-project 1 publishes the contract specs (WASM custom
section) consumed by 2/3/4. The agent-account scope schema + vault deposit/redeem signatures
+ event topics are the contract between layers; pin them in spec 1.

## 8. Testnet specifics (must-handle)

- Network passphrase: `"Test SDF Network ; September 2015"`.
- RPC: `https://soroban-testnet.stellar.org`. Horizon: `https://horizon-testnet.stellar.org`.
- Funding: Friendbot (`stellar keys generate --global X --network testnet --fund`).
- WASM target per soroban-sdk version (`wasm32-unknown-unknown` or `wasm32v1-none`).
- **Storage rent / TTL**: all persistent contract data must `extend_ttl` proactively —
  budget this in vault/registry/guardrail design (RWA position data must not be archived).
- **Testnet resets ~quarterly**: redeploy + re-seed scripts required; don't rely on
  persistent testnet state. Config (addresses) must be regenerated like the current
  `deployments/base-sepolia.json` → `deployments/stellar-testnet.json`.
- Account base reserve (0.5 XLM) + per-trustline/data reserves; sponsor via sponsored
  reserves so users don't need to pre-fund.

## 9. Risks & open questions

- **SEP-57/T-REX tooling maturity** — "limited wallet/indexer support." Validate Freighter
  signing + Mercury/RPC event indexing for T-REX on testnet in spec 1b **before** committing;
  `auth_required` (ADR-A2) is the fallback. Confirm OZ RWA module release is testnet-ready.
- **Process lesson (this review):** original fact-check verified *backward* (debunking the
  old doc) but not *forward* (is our own choice still best). That caused missing SEP-56/57.
  Each sub-project spec must include a "is this still the current best primitive?" check
  against live Stellar docs before locking design.
- **Aladdin scope creep** — it's the biggest new piece and easiest to over-build. Spec 4
  must bound it (which risk factors, which stress scenarios, deterministic).
- **OZ Smart Accounts maturity** — confirm current release supports the policies we need
  (spend-limit + scope) on testnet at spec-1 time; fallback = hand-rolled `__check_auth`.
- **SAC ↔ vault interop** — confirm SAC client calls for an `auth_required` asset work as
  expected (authorize flow before transfer). Validate early in spec 1b/1c.
- **Passkey support** — gate on client/platform WebAuthn PRF support; provide Ed25519
  session-key fallback (see `webauthn-prf-wallet` skill).
- **Mock yield source** — decide drip mechanism (admin oracle vs time accrual) in spec 1c.
- **Force-graph data** — Soroban events are XDR; need an indexer/listener (Go SDK or RPC
  `getEvents`) to feed the graph. Sizing in spec 3.
- **zkPass off-chain trust (ADR-B1)** — backend verifies the proof, so backend honesty is the
  trust anchor. Mitigate: append-only audit log + optionally anchor proof hash on-chain.
  B2 (on-chain Groth16) removes this trust if ever needed. zkPass has **no** Stellar on-chain
  support — do not design for B3.
- **ZK primitive status** — BLS12-381 live (CAP-0059); BN254/Poseidon still draft
  (CAP-0074/0075). Any B2 design must re-verify CAP + `soroban-sdk` support before committing.

## 10. Success criteria (program-level)

- Agent swarm deposits into the mock RWA vault on Soroban testnet, gas-sponsored, end to end.
- Compliance guardrail provably reverts an out-of-policy agent trade (test).
- KYC gating provably blocks a non-allowlisted wallet (test).
- Yield accrues and distributes pro-rata (test).
- Passkey onboarding works (or documented fallback).
- Aladdin produces a risk-bounded allocation that the swarm executes within on-chain caps.
- Force-graph monitor renders the live Soroban agent network.

---

**Next:** review this spec, then `writing-plans` to produce the implementation plan for
**sub-project 1 (Soroban core contracts)** first.


## 11. Related Skill 
.claude\skills\assets