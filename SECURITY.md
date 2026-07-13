# Security

> **Status honesty:** everything below documents an **internal security review and
> hardening pass** (2026-07-13) performed by the project's own developers with automated
> tooling. It is **not** an independent professional audit, formal verification, or a
> guarantee of safety. Vibing Farmer runs on **Stellar testnet / Base Sepolia** and is not
> cleared for unrestricted mainnet value.

## Scope

First-party contracts and the client/relayer controls enforcing their authorization model:

- **Soroban (Rust, SDK 26.1.0):** `funding_router`, `agent_account`, `rwa_vault`
  (autofarm vault), `blend_strategy`, `registry`, `attestation`
- **Solidity (0.8.23, OpenZeppelin 5.x):** `YieldRouter`, `AaveV3Adapter4626`
- **Off-chain:** ZeroDev session-key policy (`frontend/src/base/policyEngine.js`,
  `frontend/src/wallet/mandate.js`), CCTP relayer (`relayer/`), fee-bump relay allowlist
  (`frontend/api/stellar-relay`)

Blend, Soroswap, Circle CCTP, Aave, ZeroDev, OpenZeppelin, and the Stellar host are
**dependency trust boundaries** — used with validation and least privilege, not re-audited.

## Threat model (what the hardening assumes)

Attackers may control ordinary user accounts; steal an ephemeral Stellar or ZeroDev
session key before expiry; supply callback-capable ERC-20/ERC-4626 contracts if an admin
mistakenly allowlists them; return malformed, reverting, negative, or inflated values from
a vault strategy; observe the mempool and front-run predictable deployment salts; and
break any single keeper, relayer, or RPC dependency.

## Verified controls

Each control below has regression tests that fail if it breaks.

### Stellar authorization

- **One-signature grant, native leash.** `funding_router.grant` nests the SEP-41
  `token.approve(owner→router, budget, expiry_ledger)` under the owner's single auth
  entry; the token allowance IS the budget and expiry. The router holds no funds and has
  no admin/upgrade path. Only factory-deployed agents can `pull`, only from their recorded
  owner (fake-agent attack structurally blocked; tested with the real agent wasm).
- **Grant validation, fail-closed.** Empty agent lists, dead allowance ledgers, zero
  period durations, past scope expiries, and non-positive caps/budgets are all rejected
  before the approval or any deploy.
- **Owner-bound deployment salt.** Agent addresses derive from
  `sha256("vibing-farmer/agent-salt/v1" ‖ router ‖ owner ‖ raw salt)` — another owner
  cannot squat a predictable salt namespace.
- **Session keys are deposit-only.** `agent_account.__check_auth` verifies the ed25519
  session signature and enforces the constructor-pinned scope: only `deposit@vault`
  (cap-per-period, rolling window, expiry) and `pull@deploying-router` are authorizable.
  Approve/transfer/anything-else fails closed.
- **Per-agent revoke is enforced on-chain.** `agent_account.revoke()` (owner-signed,
  idempotent) sets the exact `revoked` flag `__check_auth` checks, zeroes the agent's
  standing vault allowance, and emits `agent_revoked`. `owner_withdraw` also clears the
  allowance on exit. The frontend kill switch calls the agent contract directly and does
  not depend on the relayer.
- **Registry is metadata only.** `registry.authorize(agent)` derives every stored field
  from the agent's own `scope_of()` under the derived owner's auth; records cannot switch
  owner; `is_active`/`is_revoked` are fail-closed for unknown agents. Nothing reads the
  Registry for authorization decisions.

### Vault (autofarm / rwa_vault)

- **Inflation-attack guard** (dead shares + minimum first deposit) and pro-rata share
  pricing with zero/negative-NAV guards on both deposit and redeem.
- **Strategies are untrusted.** NAV clamps negative reports and saturates inflated sums;
  compound slices are precomputed and a failed slice (trap, wrong-type return, dishonest
  pull) stays idle instead of being rerouted; transient allowances are cleared after every
  attempt; rebalance and emergency de-risk trust only the **observed token balance
  delta** and fail closed (`StrategyMisbehaved`) when a strategy's report disagrees.
- **Fail-closed parameters.** `max_move_bps` is capped at 10 000; cooldown gates use
  checked arithmetic (overflow = still cooling down, never a trap).
- **Incident hatches.** `quarantine_strategy(strategy, acknowledged_loss)` removes a
  bricked strategy **without calling it**, restoring deposit/redeem/price liveness and
  emitting the acknowledged write-off; `emergency_derisk` engages its flag before any
  external call, drains best-effort, and is idempotent; redeem drains strategies
  best-effort and never traps on a single bricked strategy.

### Blend strategy

- **Live NAV, not book value.** `balance()` reads the pool's own
  `get_positions`/`get_reserve` and prices bTokens at `floor(b_tokens · b_rate / 1e12)`
  with overflow-safe (I256-backed) checked math — accrued yield raises it, socialized bad
  debt lowers it. Malformed reserve data (negative values, unrepresentable products)
  returns `InvalidReserveData` instead of trapping.
- **Finite crisis exits.** Full drains size a finite request from the live position;
  `i128::MAX` never reaches Blend (whose bToken conversion overflows on it when
  `b_rate < 1e12` — the exact condition of a bad-debt crisis).
- **No stranded yield.** Harvest determines position existence from the live position
  map, not book principal, so residual yield after a principal-sized withdrawal is still
  realized; shortfalls mark the book down.

### Base leg (YieldRouter / AaveV3Adapter4626)

- **Reentrancy-guarded value flow** (OpenZeppelin `ReentrancyGuard` on all public
  mutation entrypoints of both contracts), immutable canonical asset, pool allowlisting
  with exact-asset validation, exact pre/post balance-delta enforcement, transient
  allowances reset to zero, and disabled pools that remain withdrawable so incident
  response cannot trap users. The unenforceable address-based performance fee was
  **removed**, not patched.
- **Session-key policy parity.** The ZeroDev permission set grants exactly two calls —
  USDC `approve` with the spender pinned to the deployed router and the amount capped by
  the mandate, and `YieldRouter.deposit` capped the same way — and tests decode the
  relayer's actual batched calls to prove each passes the generated policy, so drift
  fails CI. No policy grants an unconstrained approval spender.

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

**Slither triage.** All 17 remaining results are accepted: the `reentrancy-*` and
`incorrect-equality` hits point at the deliberate pre/post balance-delta `require`s inside
functions already protected by `nonReentrant` (adversarial callback tests in
`YieldRouterReentrancy.t.sol` and `AaveV3Adapter.t.sol` prove reentry reverts; strict
equality is the fail-closed exactness check, incompatible tokens are meant to revert);
`pragma` and `naming-convention` are informational (OZ `^0.8.20` vs first-party `^0.8.23`;
Aave's canonical `UNDERLYING_ASSET_ADDRESS` casing).

## Trust assumptions and residual risks

- **Admin keys.** The vault admin can register strategies, set the keeper, pause, and
  upgrade the vault wasm; a compromised admin key is a compromised vault. The funding
  router has no admin; deployed agent accounts are immutable.
- **Dependency protocols.** Blend insolvency, a malicious Soroswap router quote, a Circle
  CCTP outage, or an Aave freeze degrade or trap the affected leg; controls limit the
  blast radius (finite requests, slippage floors, balance-delta checks) but cannot make a
  broken dependency solvent.
- **Session-key compromise.** Blast radius is that agent's scope: deposits into the
  pinned vault within cap/expiry plus pulls within the owner's remaining allowance. Funds
  can only ever move owner → agent → vault and back toward the owner. Response: per-agent
  `revoke()` and/or global `approve(router, 0)`, both single user signatures, neither
  dependent on the relayer.
- **Keeper/relayer failure.** Fail-safe, not fail-deadly: deposits/redeems and both kill
  switches work without them; only compounding, rebalancing, and the lifeboat need the
  keeper (which itself needs a live user mandate).
- **Partial lifeboat drain.** `emergency_derisk` is idempotent — once the derisked flag is
  set, a retry returns `Ok(0)` without re-running the drain. If a strategy's withdrawal
  reverts mid-rescue (e.g. a frozen pool) and the user mandate then expires before it
  recovers, no keeper path re-drains that strategy. Recovery paths remain: the admin
  `emergency_withdraw(strategy)` (not derisk-gated) and ordinary user `redeem` (drains
  strategies best-effort), and while the mandate is still live a `resume()` +
  `emergency_derisk()` pair re-runs the drain. Accepted as a low-severity operational edge.
- **Very long agent scopes.** An agent's vault allowance is sized to outlast its scope but
  is capped at the network's maximum entry TTL (~1 year at 5s ledgers). A scope longer than
  that horizon would see deposits brick once the allowance lapses; funds stay recoverable
  via `owner_withdraw` and a fresh grant. Keep scope expiries within the max TTL.
- **Unit-test blind spots.** Soroban tests exercise contract logic against faithful
  mocks, not the live Blend testnet pool; the fork tests cover Aave on Base. Live smoke
  on testnet is part of the rollout gate below.

## Deployment status

**Stellar stack redeployed from this hardening pass on 2026-07-14** (deployer:
`vf-deployer`). The published addresses in `deployments/stellar-testnet.json`, README, and
PRD now point at the hardened contracts; per-contract wasm hashes and deploy/smoke tx
receipts live in the deployments JSON (`hardenedRedeploy` key and per-contract notes).

Rollout gate executed in order:

1. ✅ uploaded `agent_account` wasm v3 → deployed `funding_router` pinning that hash
2. ✅ deployed `blend_strategy` + fresh `rwa_vault` (pre-hardening vault retired, not
   upgraded in place), strategy registered, keeper + mandate authority wired
3. ✅ deployed `registry` (new `authorize(agent)` derived-record ABI)
4. ⏳ Base leg (optional cross-chain): `YieldRouter` + adapter/pools redeploy and ZeroDev
   policy regeneration remain pending — the Base Sepolia addresses in
   `deployments/base-sepolia.json` still predate the hardening pass
5. ✅ live smoke on the new stack: grant → pull → deposit → per-agent revoke → global
   revoke (allowance→0) → owner exit (`owner_withdraw`) → compound (idle sweep into
   Blend) → derisk/resume under mandate. Base approve+deposit/withdraw smoke deferred
   with the Base leg
6. ✅ `deployments/stellar-testnet.json` updated from confirmed receipts; legacy notices
   removed from README/PRD

## Reporting a vulnerability

Open a GitHub security advisory or email the maintainer (see repository profile). Please
do not open public issues for exploitable findings; testnet-only or not, we fix before we
disclose.
