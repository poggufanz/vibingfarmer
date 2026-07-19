# Security model

Scope in Vibing Farmer is enforced by contracts, not promises. The AI proposes; the chain constrains. This page is the product-level summary — the full internal hardening review, with threat model, verified controls, test evidence, and honest residual risks, is in [SECURITY.md](../SECURITY.md).

## No custody, component by component

No contract in the system holds user funds at rest, and that isn't a single design choice — it's true separately of each piece:

- **The router is a pass-through factory.** `funding_router` never receives a deposit. `grant()` does two things in one signed call: it sets a SEP-41 allowance from the user to the router, and it deploys the run's `agent_account` contracts. `pull(agent, amount)` moves funds directly from the user's wallet to the calling agent — the router's own balance is never in the path.
- **The relayer pays fees, not principal.** The fee-bump relay wraps an already-signed inner transaction in a fee-bump envelope where its own keypair is only the fee source. It cannot alter the inner transaction's logic or authorization, and it never signs on the user's behalf.
- **Funds sit in one of three places, always addressable by the user:** the user's own wallet (before a grant), an agent account's bounded scope (mid-run, redeemable via that agent's owner-gated exit), or the vault's share ledger (`vfVLT`), which the user can redeem for the underlying asset at any time.

## The leash is a protocol-level allowance, not a promise

The "budget + expiry" a user grants is a native SEP-41 token allowance — the same mechanism as an ERC-20 `approve`, extended on Stellar with a built-in expiry ledger. It is enforced by the token contract itself, not by application code that could contain a bug or be tampered with. Practically: even if the entire frontend were replaced with malicious code, the token contract still refuses to move more than the granted `budget`, and refuses anything at all once the current ledger passes `expiry_ledger`. The allowance *is* the budget — there's no separate spending-cap variable elsewhere in the stack for an attacker to target.

## Agent account scope

Each worker agent is a fresh Soroban custom account (`agent_account`, pinned wasm hash `d61ceaaaf5a3fd9fd25987eba0f843ccb79880f3eaa137e066b5f63ab9eaa2ba`, deployed by the router — see [deployments](../deployments/stellar-testnet.json)), and its permissions are a fixed record pinned at deploy time:

```
owner              — the human's Stellar address
vault              — the one vault this agent may deposit into
token              — the funding asset
cap_per_period     — max spend per rolling period
period_duration    — length of that rolling period (seconds)
spent_in_period    — running total, mutated on each deposit
period_start       — when the current period began, mutated
expiry             — absolute expiry timestamp; agent is dead after this
revoked            — instant kill flag
```

Every authorization check against the agent runs through `__check_auth`, and it recognizes exactly two signing tags:

- **Deposit tag (`0x00`)** — verified against the ephemeral session key. `enforce()` rejects a revoked or expired scope, resets the rolling period if it has elapsed, and only allows the call through for `vault.deposit()` within the remaining cap, or `router.pull()` (the SEP-41 allowance, not this local cap, is what actually bounds a pull).
- **Exit tag (`0x01`)** — verified against a separate, optional exit signer. It only allows `vault.redeem()` or a `token.transfer()` whose receiver is the recorded owner. Funds can leave the agent, but only back to the human who owns it — never to an arbitrary address.

That split is what bounds the blast radius of a leaked session key: an attacker holding the deposit key can push the agent's remaining headroom into the vault it was already scoped to (which is where the money was headed anyway), and nothing more. They cannot approve a new spender, cannot transfer to themselves, cannot touch another agent's funds, and cannot reach the user's real wallet. The owner also retains `owner_withdraw(to)` — a direct, no-cooldown exit that redeems all of that agent's vault shares and sweeps its token balance out, usable even if the session key is compromised or lost.

## Fee-bump relay: allowlist, not a general sponsor

The relay (`POST /api/stellar-relay`) only fee-bumps a short, explicit set of operations:

- `vault.deposit()` or `vault.redeem()` on the configured vault address
- `token.transfer()` where the `from` address is on an explicit agent allowlist
- `router.grant()` or `router.pull()` on the configured funding router
- `createContractV2` deploys, but only when the wasm hash exactly matches a pinned hash

Anything outside that list is refused, including admin-style calls (`add_strategy`, `set_keeper`, `upgrade`, and so on) — the relay inspects the operation type inside the transaction before it ever reaches its own signing key. If the vault address isn't configured at all, the relay fails closed: it relays nothing. A missing relayer secret returns a 503, never a silent bypass.

Two more layers sit around the allowlist: an origin allowlist plus a 15-requests-per-minute per-IP rate limit on the relay endpoint, and a replay guard that caches each inner-transaction hash for 30 minutes so a duplicate submit gets a 409 instead of double-processing (a failed submit's cache entry is cleared so a legitimate retry can still go through).

## Fail-closed, by component

The system's default posture, everywhere it matters, is to do nothing rather than guess:

- **The relay** refuses anything not on its allowlist, and refuses everything if unconfigured.
- **The eligibility gate** rejects a protocol on missing or stale facts (data older than 30 days) instead of assuming it's safe.
- **The lifeboat radar** only acts on a detected threat if the user has a live, unexpired mandate; without one, it logs an alarm and takes no on-chain action.
- **The AI council's Risk Analyst** holds a hard veto — a WITHDRAW signal above 0.85 confidence rejects the strategy immediately, with no vote-counting against the other two specialists.

## Layered revocation

There is no single point that has to work for a user to get out:

1. **Instant, global:** `token.approve(router, 0)` zeroes the whole allowance in one signature. This call is submitted directly and user-paid rather than routed through the relay, specifically so it still works if the relay is offline.
2. **Per-agent:** an agent's `revoked` flag can be set, or its owner can call `owner_withdraw()` to sweep that one agent's assets out immediately, independent of any other agent's state. The exit router batches this across a whole run — `sweep(owner, agents, to)` performs every agent's `owner_withdraw` in one signed transaction, and grants no authority of its own: each agent still checks its stored owner.
3. **Vault-level pause:** the vault admin can pause new deposits, but `redeem()` is deliberately not gated by that pause — a paused vault can still be exited, so a pause can never trap funds already inside it.
4. **Emergency de-risk:** under an active mandate, the lifeboat radar can pull all strategy capital back to vault-idle in response to a detected threat (see [SECURITY.md](../SECURITY.md) for the utilization/liquidity/oracle thresholds).

## Separation of duties

The relayer's keypair (pays network fees) and the keeper's keypair (calls `compound`/`rebalance`/`derisk`/`resume`) are deliberately distinct identities on the live deployment. A compromise of one does not hand the attacker the other's powers — a stolen relayer key can waste testnet XLM on fee-bumps within the allowlist, but it cannot call a keeper-gated function, and vice versa.

## Vault upgrade governance

The router's "no admin, no upgrade path" claim is scoped to the router specifically, and it's true there — `funding_router`'s constructor pins the agent wasm hash and funding token once, permanently, with no function anywhere in the contract that can change either. The vault is a deliberate contrast: it is upgradeable, but only through a governed, time-locked path designed so an upgrade can never arrive as a surprise.

**How it works on-chain** (`soroban/contracts/autofarm_vault/src/vault.rs`): an admin-only `schedule_upgrade(new_wasm_hash)` records a pending upgrade with an eta set to the current ledger time plus a fixed **3-day timelock** (`TIMELOCK_DELAY_S = 259_200` seconds, a compile-time constant — there is no setter for it, because a settable delay would just be a bypass one call away: set it to zero, then upgrade). Calling it again before the eta overwrites the pending upgrade and resets the full 3-day delay. `execute_upgrade()` — also admin-only — checks the eta has passed, clears the pending-upgrade slot, and then swaps the contract's wasm via `update_current_contract_wasm()`. The clear happens before the swap, so on success the pending state is gone and can't re-fire, and if the swap itself traps the whole transaction reverts, leaving the pending upgrade intact either way. The swap does not re-run the constructor and preserves existing instance storage. `cancel_upgrade()` clears a pending upgrade at any time before execution. Calling `execute_upgrade()` before the eta fails with `TimelockNotElapsed`; calling `execute_upgrade()` or `cancel_upgrade()` with nothing scheduled fails with `NoPendingUpgrade`.

**How it reaches the user before it happens.** Every schedule, execution, and cancellation emits an on-chain event (`UpgradeScheduled`, `UpgradeExecuted`, `UpgradeCancelled`), and three independent surfaces watch for them so a pending upgrade is never something only the admin knows about:

- The **lifeboat radar** (`keeper/src/radar.js`) reads `pending_upgrade()` on every tick and logs a `WARN` the moment one appears — naming the wasm hash and the eta, and stating plainly that no automatic action is taken and the user should withdraw first if they want to exit. It logs once on a state change (new, modified, or cleared), not on every tick, and logs an `INFO` line when the pending upgrade clears, whether by execution or cancellation.
- The **home screen** polls `pending_upgrade()` on load and on a recurring interval, and renders a banner — "Vault upgrade scheduled," with an execution date and "Funds can be withdrawn before then" — for as long as an upgrade is pending. The read fails safe: an RPC error returns null rather than a guessed state, so a transient read failure never fabricates or hides a banner.
- The **alert feed** (`AlertCard.jsx`, routed through `app.jsx`) turns the same three events into alert cards with plain-language explanations — "Vault upgrade scheduled — executable {date}. You can withdraw before then," and equivalents for execution and cancellation. These are explicitly surface-only: no auto-derisk and no on-chain action is taken on any of the three, they only inform.

**Deployed status — precise, not implied.** The live testnet vault (`CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77`, wasm hash `24dc5ec86a8833331d285581215b715e3c2ecf6c714714af9d91ece4ecc32d84`, deployed 2026-07-14) predates this feature. It does not have `schedule_upgrade`, `execute_upgrade`, `cancel_upgrade`, or `pending_upgrade` — those functions exist only on the `iq-alter` branch as of this writing. Activating them on testnet requires a fresh wasm build, upload, and redeploy; nothing described in this section is live on the currently deployed vault yet.

## Honest caveats

This is testnet software. It has not undergone an independent third-party audit. The verified controls and residual risks are documented candidly in [SECURITY.md](../SECURITY.md) — please read it before drawing conclusions about mainnet readiness. Other caveats that carry over from the rest of the docs: worker dispatch is paced (roughly 2 seconds apart) to respect the relay's rate limit rather than firing all agents at the same instant, though the failure-isolation guarantee — one worker's failure never blocking another's — is genuinely implemented regardless of pacing; and the Base-side cross-chain leg's yield pools are honest 1:1 custody vaults on testnet, not fabricated yield, because no real lending protocol there currently accepts the bridged USDC.

## Reporting a vulnerability

Responsible-disclosure instructions are in the [security review](../SECURITY.md).
