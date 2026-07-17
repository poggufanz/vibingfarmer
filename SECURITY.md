# Security

> This page is an **internal review and hardening pass** (2026-07-13) by the project's own developers plus automated tooling. It is **not** an independent audit, formal verification, or a safety guarantee. Vibing Farmer runs on **Stellar testnet** and **Base Sepolia**. It is not cleared for unrestricted mainnet value.

## Scope

First-party contracts and the client/relayer code that enforces their auth model:

- **Soroban (Rust, SDK 26.1.0):** `funding_router`, `agent_account`, `autofarm_vault`, `blend_strategy`, `registry`, `attestation`
- **Solidity (0.8.23, OpenZeppelin 5.x):** `YieldRouter`, `AaveV3Adapter4626`
- **Off-chain:** ZeroDev session-key policy (`frontend/src/base/policyEngine.js`, `frontend/src/wallet/mandate.js`), CCTP relayer (`relayer/`), fee-bump allowlist (`frontend/api/stellar-relay`)

Blend, Soroswap, Circle CCTP, Aave, ZeroDev, OpenZeppelin, and the Stellar host are **dependency trust boundaries**. We use them with validation and least privilege. We did not re-audit them.

## Threat model

What this hardening assumes an attacker can do:

- Control ordinary user accounts
- Steal an ephemeral Stellar or ZeroDev session key before it expires
- Supply callback-capable ERC-20 / ERC-4626 contracts if an admin allowlists them by mistake
- Return malformed, reverting, negative, or inflated values from a vault strategy
- Watch the mempool and front-run predictable deployment salts
- Take down any single keeper, relayer, or RPC

## Verified controls

Each control below has regression tests that fail if it breaks.

### Stellar authorization

- **One-signature grant, native leash.** `funding_router.grant` nests SEP-41 `token.approve(owner→router, budget, expiry_ledger)` under the owner's single auth entry. Token allowance *is* budget and expiry. The router holds no funds and has no admin or upgrade path. Only factory-deployed agents can `pull`, and only from their recorded owner. Fake-agent attacks are blocked at the structure (tested with the real agent wasm).
- **Grant validation, fail-closed.** Empty agent lists, dead allowance ledgers, zero period durations, past scope expiries, and non-positive caps/budgets are rejected before approval or deploy.
- **Owner-bound deployment salt.** Agent addresses derive from `sha256("vibing-farmer/agent-salt/v1" ‖ router ‖ owner ‖ raw salt)`. Another owner cannot squat a predictable salt namespace.
- **Session keys are deposit-only.** `agent_account.__check_auth` checks the ed25519 session signature and the constructor-pinned scope: only `deposit@vault` (cap-per-period, rolling window, expiry) and `pull@deploying-router` are allowed. Approve, transfer, and everything else fails closed.
- **Per-agent revoke on-chain.** `agent_account.revoke()` (owner-signed, idempotent) sets the `revoked` flag that `__check_auth` checks, zeroes the agent's vault allowance, and emits `agent_revoked`. `owner_withdraw` also clears the allowance on exit. The frontend kill switch talks to the agent contract directly; it does not need the relayer.
- **Registry is metadata only.** `registry.authorize(agent)` fills stored fields from the agent's own `scope_of()` under the derived owner's auth. Records cannot change owner. `is_active` / `is_revoked` fail closed for unknown agents. Nothing uses the Registry for authorization decisions.

### Vault (autofarm_vault)

- **Inflation guard:** dead shares + minimum first deposit; pro-rata share pricing with zero/negative-NAV guards on deposit and redeem.
- **Strategies are untrusted.** NAV clamps negative reports and saturates inflated sums. Compound slices are precomputed; a failed slice (trap, wrong-type return, dishonest pull) stays idle instead of being rerouted. Transient allowances clear after every attempt. Rebalance and emergency de-risk trust only the **observed token balance delta**, and fail closed (`StrategyMisbehaved`) when a strategy report disagrees.
- **Fail-closed parameters.** `max_move_bps` capped at 10_000. Cooldown math uses checked arithmetic (overflow means still cooling down, never a trap).
- **Incident hatches.** `quarantine_strategy(strategy, acknowledged_loss)` removes a bricked strategy **without calling it**, restores deposit/redeem/price liveness, and emits the acknowledged write-off. `emergency_derisk` sets its flag before any external call, drains best-effort, and is idempotent. Redeem drains strategies best-effort and never traps on a single bricked strategy.

### Blend strategy

- **Live NAV, not book value.** `balance()` reads the pool's `get_positions` / `get_reserve` and prices bTokens as `floor(b_tokens · b_rate / 1e12)` with overflow-safe (I256-backed) checked math. Accrued yield raises NAV; socialized bad debt lowers it. Malformed reserve data (negative values, unrepresentable products) returns `InvalidReserveData` instead of trapping.
- **Finite crisis exits.** Full drains size a finite request from the live position. `i128::MAX` never goes to Blend (bToken conversion overflows on that when `b_rate < 1e12`, which is exactly a bad-debt crisis case).
- **No stranded yield.** Harvest uses the live position map, not book principal, so residual yield after a principal-sized withdrawal still realizes. Shortfalls mark the book down.

### Base leg (YieldRouter / AaveV3Adapter4626)

- **Reentrancy-guarded value flow.** OpenZeppelin `ReentrancyGuard` on all public mutation entrypoints of both contracts; immutable canonical asset; pool allowlisting with exact-asset checks; exact pre/post balance-delta enforcement; transient allowances reset to zero; disabled pools stay withdrawable so incident response cannot trap users. The unenforceable address-based performance fee was **removed**, not patched.
- **Session-key policy parity.** ZeroDev permissions grant exactly two calls: USDC `approve` with spender pinned to the deployed router and amount capped by the mandate, and `YieldRouter.deposit` capped the same way. Tests decode the relayer's batched calls and require each to pass the generated policy, so drift fails CI. No policy grants an unconstrained approval spender.

## Verification evidence (2026-07-13, all green)

```
soroban:        cargo +1.91.0 test --workspace --all-targets   → 134 tests pass
                cargo +1.91.0 clippy --workspace --all-targets -- -D warnings
                stellar contract build (stellar-cli 27.0.0, rustc 1.92.0) → 6 wasms
base-contracts: forge test (unit + fuzz + invariant + adversarial reentrancy) → 51 pass
                forge build --sizes
                slither . --exclude-dependencies → 17 results, all triaged (below)
frontend:       npm test (vitest) and npm run build
relayer:        npm test (vitest)
```

**Slither triage.** All 17 remaining findings are accepted:

- `reentrancy-*` and `incorrect-equality` hit the deliberate pre/post balance-delta `require`s inside functions already behind `nonReentrant`. Adversarial callback tests in `YieldRouterReentrancy.t.sol` and `AaveV3Adapter.t.sol` show reentry reverts. Strict equality is the fail-closed exactness check; incompatible tokens should revert.
- `pragma` and `naming-convention` are informational (OZ `^0.8.20` vs first-party `^0.8.23`; Aave's canonical `UNDERLYING_ASSET_ADDRESS` casing).

## Trust assumptions and residual risks

- **Admin keys.** Vault admin can register strategies, set the keeper, pause, and upgrade vault wasm. A compromised admin key is a compromised vault. Funding router has no admin. Deployed agent accounts are immutable.
- **Dependency protocols.** Blend insolvency, a bad Soroswap quote, a Circle CCTP outage, or an Aave freeze can degrade or trap that leg. Controls limit blast radius (finite requests, slippage floors, balance-delta checks). They cannot make a broken dependency solvent.
- **Session-key compromise.** Blast radius is that agent's scope: deposits into the pinned vault within cap/expiry, plus pulls within the owner's remaining allowance. Funds only move owner → agent → vault and back toward the owner. Response: per-agent `revoke()` and/or global `approve(router, 0)`. Both need one user signature. Neither needs the relayer.
- **Keeper / relayer failure.** Fail-safe, not fail-deadly. Deposits, redeems, and both kill switches work without them. Only compounding, rebalancing, and the lifeboat need the keeper (and a live user mandate).
- **Partial lifeboat drain.** `emergency_derisk` is idempotent: once the derisked flag is set, a retry returns `Ok(0)` without re-running the drain. If a strategy withdrawal reverts mid-rescue (e.g. frozen pool) and the user mandate expires before recovery, no keeper path re-drains that strategy. Recovery still possible: admin `emergency_withdraw(strategy)` (not derisk-gated), ordinary user `redeem` (best-effort drain), or while the mandate is live a `resume()` + `emergency_derisk()` pair. Accepted as a low-severity operational edge.
- **Very long agent scopes.** An agent's vault allowance is sized to outlast its scope but is capped at the network's max entry TTL (~1 year at 5s ledgers). A scope longer than that can brick deposits once the allowance lapses. Funds stay recoverable via `owner_withdraw` and a fresh grant. Keep scope expiries within the max TTL.
- **Unit-test blind spots.** Soroban tests hit contract logic against mocks, not the live Blend testnet pool. Fork tests cover Aave on Base. Live smoke on testnet is part of the rollout gate below.

## Deployment status

**Stellar stack redeployed from this hardening pass on 2026-07-14** (deployer: `vf-deployer`). Addresses in `deployments/stellar-testnet.json`, README, and PRD point at the hardened contracts. Per-contract wasm hashes and deploy/smoke receipts are in the deployments JSON (`hardenedRedeploy` key and per-contract notes).

Rollout gate, in order:

1. ✅ Uploaded `agent_account` wasm v3 → deployed `funding_router` pinning that hash
2. ✅ Deployed `blend_strategy` + fresh `autofarm_vault` (pre-hardening vault retired; not upgraded in place); strategy registered; keeper + mandate authority wired
3. ✅ Deployed `registry` (new `authorize(agent)` derived-record ABI)
4. ⏳ Base leg (optional cross-chain): `YieldRouter` + adapter/pools redeploy and ZeroDev policy regeneration still pending. Base Sepolia addresses in `deployments/base-sepolia.json` still predate the hardening pass
5. ✅ Live smoke on the new stack: grant → pull → deposit → per-agent revoke → global revoke (allowance→0) → owner exit (`owner_withdraw`) → compound (idle sweep into Blend) → derisk/resume under mandate. Base approve + deposit/withdraw smoke deferred with the Base leg
6. ✅ `deployments/stellar-testnet.json` updated from confirmed receipts; legacy notices removed from README/PRD

## Reporting a vulnerability

Open a GitHub security advisory, or email the maintainer (see the repository profile). Do not open public issues for exploitable findings. Even on testnet, we fix before we disclose.
