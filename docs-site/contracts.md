# Deployed contracts

All contracts run on **Stellar testnet** (`Test SDF Network ; September 2015`, RPC `https://soroban-testnet.stellar.org`). Verify any of them on [Stellar Expert](https://stellar.expert/explorer/testnet) at `https://stellar.expert/explorer/testnet/contract/<address>`.

| Contract | Address | Role |
|----------|---------|------|
| Funding router | `CCEWWRQVYKEIWTO7GTX2QVHQASC3GIQOZZTDMGTOHFQYKZIX5KJ6CYE5` | Single-signature grant factory + funding gate, zero custody |
| Agent account (wasm v3, per-run deploy) | wasm hash `d61ceaaaf5a3fd9fd25987eba0f843ccb79880f3eaa137e066b5f63ab9eaa2ba` | Scoped, disposable worker account |
| Autofarm vault (live deposit, `vfVLT` 7-dp) | `CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77` | Share-ledger yield vault |
| Blend strategy | `CAR7XFFRKMUYSERYBSLQ4LXRY2E2W7G7WG4VQI55FWLSJWQVLNTAFVBE` | Supplies vault deposits into Blend, harvests interest + BLND |
| Blend v2 pool | `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF` | The lending market — the actual yield source |
| Blend USDC token (7-dp) | `CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU` | Funding asset |
| Exit router | `CDGDIPHBN3MSNURDX33IZBXXQTJPT7THAXSMVBAIOIXLOA6OF32IRS2J` | One-signature batch exit — sweeps a whole run's agents in one transaction |
| Attestation | `CDDOW2FZ7ALBWBXF22TPMPDHPXSKTMLQGGQWUYX7YOJZAHICD7DUO2K6` | On-chain strategy-hash record |
| Registry | `CAP5E2FPDAGEQ7SR55YRY4Z56GPBSTRRZJCYN2PQ6PZQHQJKYEDVM5FB` | Per-agent scope registry — live, but not called by the current deposit path (see below) |

The full manifest — wasm hashes, deploy transactions, and every legacy address — is in [`deployments/stellar-testnet.json`](../deployments/stellar-testnet.json). The optional Base Sepolia leg is manifested in [`deployments/base-sepolia.json`](../deployments/base-sepolia.json).

## Contract roles at a glance

The **funding router** is the single entry point you grant to; it holds no funds, has no admin path, and deploys scoped agent accounts. Each **agent account** is a disposable, deposit-only, vault-pinned, expiring signer. The **autofarm vault** takes deposits and forwards them to the **Blend strategy**, which supplies into the **Blend v2 pool** for real testnet lending yield. The **exit router** is the exit-side mirror of the grant: one signature sweeps every agent's position back to its owner. The **attestation** contract records the hash of the approved strategy so it can be verified against the original file. The **registry** tracks deployed agent scopes but sits outside the flow that actually moves money.

## Funding router

`funding_router` (`soroban/contracts/funding_router/src/lib.rs`) is a factory plus a funding gate — it never holds a balance of its own. `__constructor(agent_wasm_hash, token)` runs once, at deploy time, and pins two values permanently: the exact wasm hash every agent account it deploys must use, and the SEP-41 token it will ever move. Neither has a setter anywhere in the contract, which is what makes "no admin, zero custody" true rather than aspirational.

`grant(owner, budget, expiry_ledger, agents[])` is the one signature the whole product leans on. Under a single `owner.require_auth()` it does two things: it calls `token.approve(owner, router, budget, expiry_ledger)` — a native SEP-41 allowance, the actual spending boundary — and it deploys one `agent_account` per entry in `agents[]` from the pinned wasm hash, recording `agent -> owner` in persistent storage. Both actions ride the same auth entry because the router is the direct invoker of the nested `approve` call, so the wallet only ever shows one prompt. Every `AgentInit` (cap, period, expiry) is validated before the allowance is touched or anything is deployed, so a single bad entry in the batch leaves no partial state — the whole call reverts.

`pull(agent, amount)` is what a worker's session key calls, through the relay, to draw its slice of the budget. It only accepts a call from an address the router itself deployed (looked up from the `Deployed` map, never trusted from caller input) and moves `owner -> agent` through the SEP-41 allowance via `token.transfer_from`. The router invokes the transfer; it never holds the funds mid-flight.

`owner_of(agent)` and `config()` are read-only views — which owner deployed a given agent, and the pinned wasm hash plus token. Revocation needs no router function at all: `token.approve(owner, router, 0, ...)` submitted directly against the token contract zeroes the allowance, and works even if the router or the relay is unreachable.

## Agent account

`agent_account` (`soroban/contracts/agent_account/src/lib.rs` + `account.rs`) is a Soroban custom account implementing `CustomAccountInterface` — deployed fresh per worker, per run, by the router, on the pinned v3 wasm hash. Its scope is fixed at construction and stored as one record, checked on every authorization:

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

`__check_auth` recognizes exactly two signing tags. Tag `0x00` is deposit auth, verified against the ephemeral session key: `enforce()` rejects a revoked or expired scope, resets the rolling period if it has elapsed, and only lets the call through for `vault.deposit()` within the remaining cap or `router.pull()` (uncapped locally — the SEP-41 allowance at the router is the real limiter for a pull). Tag `0x01` is exit auth, verified against a separate, optional exit signer set via `set_exit_signer()`: `enforce_exit()` only allows `vault.redeem()` or a `token.transfer()` whose receiver is the recorded owner — funds can leave the agent, but never to any address other than the human who owns it.

`owner_withdraw(to)` is the owner-gated emergency exit: a direct signature from the owner (not the session key) redeems all of the agent's vault shares and sweeps its token balance to `to`, immediately, with no cooldown. It also flips `revoked` and clears the agent's standing vault allowance, so a swept agent can't be left half-alive with a session key that still thinks it can fund a deposit into an empty account. `revoke()` is the plain kill switch — same `revoked` flip and allowance clear, without redeeming or sweeping anything first.

## Exit router

`exit_router` (`soroban/contracts/exit_router/src/lib.rs`, deployed 2026-07-16) is the exit-side mirror of `grant()`. `sweep(owner, agents, to)` batches one `agent_account.owner_withdraw` per agent into the single host-function invocation a Soroban transaction allows, so exiting N agents costs one wallet signature instead of N — the same source-account mechanism that lets `grant()` cover its nested `token.approve` covers the whole tree here, with the owner's `require_auth` in the router and inside every agent all satisfied by the transaction source.

The contract is stateless — no admin, no upgrade path, zero custody — and grants no authority of its own: each agent still checks its own stored owner, so naming an agent you don't own sweeps nothing from it. Per-agent calls are `try_` calls, so a revoked or already-empty agent reports 0 while its neighbors still sweep; a sweep that moves nothing at all errors (`NothingSwept`) rather than returning an empty success. Unsetting `VITE_SOROBAN_EXIT_ROUTER_ADDRESS` rolls the app back to the per-agent, N-signature exit loop.

## Autofarm vault

`autofarm_vault` (`soroban/contracts/autofarm_vault/src/vault.rs`) is an ERC-4626-style share ledger. `deposit(from, amount)` mints shares against `price_per_share() = total_assets / total_supply` (scaled 1e7); the first deposit carves out a fixed `DEAD_SHARES` amount locked forever in the vault itself, an inflation-attack guard on the very first mint. `redeem(from, shares)` burns shares for their pro-rata share of `total_assets` at the current price. `deposit` is gated `#[when_not_paused]`; `redeem` deliberately is not — an admin can pause new deposits, but a paused vault can always be exited, so a pause can never trap funds already inside it.

`compound(min_outs)` is keeper-only (`require_keeper`) and cooldown-gated: it calls `harvest()` on every registered strategy, sweeps the resulting gains back into the vault, and is what makes `price_per_share` rise over time. `rebalance(from, to, amount)` is also keeper-only, capped per move (`max_move_bps`) and cooldown-gated, moving capital between strategies (or to vault-idle) without one bad call being able to move everything at once.

`emergency_derisk(reason_code)` and `resume()` are the lifeboat's on-chain half: both are keeper-only *and* require a currently live, unexpired mandate (`set_mandate`, `set_mandate_authority`) — an expired mandate can authorize neither. `emergency_derisk` drains every strategy back to vault-idle and sets a `Derisked` flag that blocks `compound`; it's idempotent, so a second call while already derisked safely no-ops rather than re-draining. `resume()` clears that flag. See [Security model](security-overview.md) for the radar's engage/resume thresholds.

**Upgrade timelock (code on the `iq-alter` branch, not yet on the live testnet wasm).** `schedule_upgrade(new_wasm_hash)` (admin-only) records a pending upgrade with `eta = now + TIMELOCK_DELAY_S`, a compile-time constant of `259_200` seconds (3 days) with no setter — a settable delay would just be a bypass (set it to zero, then upgrade). Calling it again before the eta overwrites the pending upgrade and resets the full delay. `execute_upgrade()` (admin-only) checks the eta has passed — failing with `TimelockNotElapsed` if not — clears the pending-upgrade slot *before* swapping the contract's wasm via `update_current_contract_wasm()` (atomic either way: on success the pending state is gone and can't re-fire; if the swap itself traps, the whole transaction reverts and the pending upgrade survives), then calls `extend_instance()` to refresh the contract's storage TTL. The swap does not re-run `__constructor` and preserves existing instance storage. `cancel_upgrade()` (admin-only) clears a pending upgrade at any time before execution; both it and `execute_upgrade()` fail with `NoPendingUpgrade` if nothing is scheduled. A read-only `pending_upgrade()` view lets anyone check what's queued without waiting for an event. The three state transitions each emit an event — `UpgradeScheduled { wasm_hash, eta }`, `UpgradeExecuted { wasm_hash }`, `UpgradeCancelled { wasm_hash }` — which the frontend decodes and surfaces as a "vault upgrade scheduled" banner and ops-console alert, and which the lifeboat radar logs a one-time warning for on schedule and an info line for on clear. The vault currently live on testnet was deployed 2026-07-14, before this feature existed, so it does not have `schedule_upgrade`, `execute_upgrade`, `cancel_upgrade`, or `pending_upgrade` callable today — activating it needs a fresh wasm build, upload, and redeploy.

## Blend strategy

`blend_strategy` (`soroban/contracts/blend_strategy/src/lib.rs` + `blend.rs` + `soroswap.rs`) holds vault deposits and supplies them into the Blend Capital v2 pool. `deposit(amount)` only accepts a call from the vault (`vault.require_auth()`), pulls the token via `transfer_from`, and calls `blend::supply`. `harvest(min_out)` is the compounding engine, run in five steps:

1. Withdraw the entire position from Blend — draining fully is what actually realizes the accrued interest, rather than leaving it uncollected inside the pool.
2. Claim BLND emissions from the pool, best-effort — a failed claim doesn't abort the rest of the harvest.
3. If `min_out > 0`, swap the claimed BLND to USDC through a Soroswap router; if `min_out == 0`, hold the BLND on the strategy contract and retry the swap on a future harvest, so BLND is deferred to a better exchange rate rather than stranded or dumped at any price.
4. Re-supply the original principal back into Blend.
5. Forward the realized interest plus any swap proceeds to the vault.

It emits `StrategyHarvest { interest, blnd_claimed, blnd_swapped, usdc_out, blnd_held }` so every harvest is auditable off-chain. The vault currently runs this single strategy — a self-deployed second Blend pool can't reach "Active" status without seeding real backstop capital, so multi-strategy rebalancing falls back to moving capital to vault-idle rather than a second pool.

## Attestation

`attestation` (`soroban/contracts/attestation/src/lib.rs`) is deliberately minimal: a per-attester counter and an event, nothing else — no cross-contract calls, no admin. `attest(attester, strategy_hash, label)` requires the attester's own signature, increments that attester's counter, and publishes `StrategyAttested { attester, strategy_hash, ledger, label }`. `count_of(attester)` reads how many attestations a given address has made, defaulting to 0. The strategy hash it stores comes from `hashStrategy()` (`frontend/src/attestation.js`), run over the exact enforced strategy JSON the user reviewed and approved — so anyone holding that original JSON can reproduce the same hash and compare it against what's on-chain.

## Registry

`registry` (`CAP5E2FPDAGEQ7SR55YRY4Z56GPBSTRRZJCYN2PQ6PZQHQJKYEDVM5FB`) is live and readable on testnet, but honestly: the current router-plus-agent-account deposit path does not call it. `authorize(agent)` derives its record straight from the agent contract's own `scope_of()` — owner, vault, token, cap, expiry — gated by that scope's owner signature, so the caller supplies nothing but the address. `revoke(owner, agent)` is a metadata mirror only; the enforcing kill switch is always `AgentAccount.revoke()` on the agent itself, not anything in the registry. Treat the registry as an index for tooling and explorers, not as part of the security boundary.

## Legacy contracts

Several addresses that appear in `deployments/stellar-testnet.json` are superseded and kept only for history or rollback — a pre-hardening funding router, a retired autofarm vault without the dead-shares and faulty-strategy-isolation guards, an older blend_strategy wired to that retired vault, a pre-hardening registry, and two earlier agent-account wasm hashes (v1, v2). A pre-seeded demo agent (`CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC`) also still exists on testnet: it runs the v1 wasm, and its constructor-only scope pins the *retired* vault, so deposits sent from it never reach the live vault above. It's kept for explorer and smoke-test history only — every product flow deploys fresh, per-run agents through the funding router's `grant()` instead. The full superseded-contracts table, with addresses and why each was replaced, is in [`FEATURES.md` §5](../FEATURES.md#5-live-deployments).

For build and test one-liners, see [`soroban/README.md`](../soroban/README.md).
