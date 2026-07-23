# Feature overview

A tour of what Vibing Farmer does. For the exhaustive version — every feature with screenshots, edge cases, and judge notes — see the [Full feature guide](../FEATURES.md).

## AI strategist and council

The strategist proposes a multi-vault allocation using live DeFiLlama APY, TVL, and 7-day history, plus optional Tavily market context, all fetched in parallel under a 15-second budget so a slow data source never blocks the run. It calls an AI provider through a chain of fallbacks that never blocks: Venice x402 (a wallet-signed SIWE-style message pays for the call directly, no key needed), a user's own Venice key, a user's own DeepSeek key, the host's server-side DeepSeek proxy, and finally a deterministic equal-split allocation that needs no AI call and cannot fail. Whatever comes back is validated before it's trusted — every selected vault address must already exist in the allowlisted catalog, reasoning strings must be substantive, APY and allocation must fall in sane ranges, and allocations must sum to roughly 1.0.

A three-member council then reviews the plan. Each specialist is deterministic, rule-based logic by default, not an AI call, so the council adds no latency or cost unless they genuinely disagree:

| Specialist | Leans deposit when | Leans withdraw / hold when |
|---|---|---|
| Yield | A harvest is a free reward, or a risk-adjusted uplift is detected | No uplift found |
| Risk (hard veto) | Market is calm, no gate violations | Turbulent market or a gate violation — **vetoes outright above 0.85 confidence** |
| Market / gas | Net gain (APY minus gas) is positive | Gas cost exceeds the gain |

The risk specialist's veto needs no vote-counting: above 0.85 confidence, the strategy is rejected immediately regardless of what the other two say. When the three disagree and the vote is genuinely close, the system escalates to exactly one bounded AI call, explicitly instructed to prefer the safer outcome when unsure; if that call fails too, the result defaults to hold.

Before any protocol reaches the council, it has to clear a fail-closed eligibility gate. A yield-reality check divides claimed APY by actual protocol revenue — a ratio at or above 1.5 means the protocol is paying out more than it earns, and missing data is treated as failing, not passing. A second, weighted security score has to clear a minimum threshold:

| Component | Weight | Rule |
|---|---|---|
| Audit | Hard gate | Unaudited fails outright, regardless of the rest of the score |
| Protocol age | 30% | Scaled toward the cap the older the protocol is |
| TVL | 40% | Log-scaled between a low and high bound |
| Admin key type | 30% | Timelock plus multisig scores highest, a plain key scores zero |

A later hardening pass added four more checks specific to lending pools: curated (not community-managed) pool class, an oracle with a circuit breaker, a minimum collateral liquidity depth, and a cap on how concentrated any single supplier can be. Missing or stale facts default to rejection rather than a shrug-and-proceed.

A 200-run, 30-day Monte Carlo simulation then stress-tests the resulting allocation before it's ever shown to you. Every decision along this path — the strategist's reasoning, the council's verdict, the gate's checks — is logged and inspectable in the ops console's decision log.

## One-signature grant

A single `funding_router.grant(owner, budget, expiry_ledger, agents[])` sets your budget and expiry and deploys the agents — in one signed transaction, because the grant's own authorization check and the nested SEP-41 `token.approve()` sub-call are both satisfied by the same source-account signature. Building that call happens before you ever see a wallet prompt: for each worker the app assembles a fresh session-key public key, a random deploy salt, that worker's slice of the deposit as its cap, its target vault, a spending period, and an expiry, then simulates the whole grant once to read back the exact addresses the agents will deploy to — Soroban deploy addresses are deterministic from the salt, so the app already knows each agent's address before you've signed anything.

The SEP-41 allowance is the leash: the router can never pull more than you approved, and never after the expiry ledger, enforced by the token contract itself rather than by application code that could have a bug in it.

Repeat runs after the first can cost zero signatures. If the router is enabled, your cached agents for that owner/vault/network combination still show on-chain headroom when re-checked fresh (never trusted from a stale cache), and the allowance still covers the new total, the orchestrator skips the grant entirely and funds agents through a relayed `router.pull()` with no wallet interaction at all. Revoking is one more signature — `token.approve(router, 0)` — submitted directly rather than through the relay, so it works even if the relay itself is down.

## Scoped agent swarm

Workers run in parallel, each inside a disposable, deposit-only agent account deployed fresh for the run. Its scope is pinned on-chain at deploy time — one vault, a per-period spending cap, and a hard expiry — and enforced on every authorization check: the deposit session key can only trigger a deposit within cap or a router pull, and a separate exit signer (if one is set) can only send funds back to the owner. A compromised session key can, at worst, push the remaining allowance into the vault it was already scoped to; it cannot reach the owner's real wallet or another agent's funds, and the owner can sweep an agent's shares out immediately at any time, no cooldown.

One failure never aborts the batch. Dispatch generates every worker's skill in parallel, then submits deposits in sequence with a short gap between each one to stay under the relay's own rate limit — not literally simultaneous, but the property that matters holds regardless: each worker's execution is isolated, so one agent's error never blocks or rolls back another's.

## Gasless execution

An own fee-bump relayer sponsors every allowlisted operation, so you pay zero XLM: it wraps your already-signed inner transaction inside a Stellar fee-bump transaction, paying the network fee from its own funded keypair without touching the inner transaction's logic or authorization. The relay only sponsors what's on a short, explicit allowlist:

- Vault deposit or redeem, on the configured vault address only
- Router grant or pull, on the configured router
- Token transfers where the sender is on an explicit agent allowlist
- Contract deploys, but only when the wasm hash matches one already pinned

Anything else — including admin calls like changing the keeper or upgrading the vault — is refused. An unconfigured vault address disables the guard rather than defaulting to permissive, and a missing relayer key returns an explicit error rather than silently failing open. The relay also rate-limits per IP and caches each inner-transaction hash for half an hour as a replay guard, rejecting a duplicate submission outright. Both kill switches keep working without the relayer, because revoking the allowance and an agent's own emergency exit are deliberately submitted directly rather than routed through it.

## Real yield

Deposits flow through an autofarm vault into a Blend Capital v2 pool, earning real testnet lending interest, not a mock drip. Price per share is total vault assets divided by total shares, and it rises as interest compounds in, so every existing share is worth more USDC over time.

A keeper-only, cooldown-gated compound call is what raises that price. On every registered strategy it:

1. Withdraws the full Blend position, which is what realizes the accrued interest
2. Claims BLND emissions on a best-effort basis, so a failed claim never blocks the harvest
3. Swaps the claimed BLND to USDC, or holds it for a future harvest if no minimum payout is set, so nothing is ever stranded at a bad rate
4. Re-supplies the original principal back into Blend
5. Forwards the interest and swap proceeds to the vault

The vault currently runs a single Blend strategy — a self-deployed second pool couldn't reach active status without seeding real backstop capital — so rebalancing today falls back to moving capital to idle rather than between two live pools; when more than one strategy exists, moves between them are capped per call and cooldown-gated.

## Autonomy and safety rails

Two separate automated systems keep the vault healthy, with a hard line around what's allowed to happen without your explicit, time-boxed permission. A dedicated worker keeper, running on its own identity separate from the relayer, compounds and rebalances on roughly a 15-minute cadence, bounded by its own caps and cooldowns rather than a mandate, and blocked automatically while the vault is in a derisked state.

A separate lifeboat radar process evaluates pool health about once per Stellar ledger, roughly every 6 seconds, watching three signals, each with a stricter resume threshold than its engage threshold so the radar doesn't flap in and out of the emergency state on a noisy signal:

| Signal | Engages derisk at | Clears back to normal at |
|---|---|---|
| Pool utilization | ≥ 95% | < 85% |
| Liquidity drop | ≥ 30% | Same threshold, no separate resume gap |
| Oracle price divergence | ≥ 2.5% | < 0.5% |

If any signal breaches its engage threshold and you have an active, unexpired mandate (one signature, renewed in the ops console, typically for 24 hours), the radar can call `emergency_derisk()` to pull every strategy back to vault-idle. Without a live mandate it only logs an alarm and takes no action at all — funds are never moved autonomously without a permission you granted and can let lapse. Resuming also requires the all-clear to hold for roughly 10 minutes straight (100 consecutive ledgers), plus a still-live mandate.

## Vault upgrade timelock

A pending change to the vault's own contract code has to clear a public delay before it can take effect, the same protection a multisig timelock gives a protocol's admin. All four moves are admin-only:

| Function | What it does |
|---|---|
| Schedule | Records the target wasm hash and sets an eta 3 days out; scheduling again before that eta resets the full delay |
| Execute | Fails outright if called before the eta — the timelock is enforced on-chain, not just in the UI — and otherwise swaps the contract's code without re-running its constructor, so existing vault storage (shares, strategies, keeper config) survives the upgrade |
| Cancel | Clears the pending schedule at any point before it executes |
| Pending view | Read-only; lets anyone check what's queued and when, with no signature required |

The frontend and the lifeboat radar both surface a pending upgrade without acting on it. The homepage polls for one on a periodic interval and shows a banner naming the eta and reminding you that funds can be withdrawn before it lands; the same schedule, execution, and cancellation events populate the alert feed with plain-language explanations. The radar logs a one-time warning the first time a schedule appears or changes, and an info line once it clears, but never derisks or otherwise reacts to an upgrade on its own — an upgrade is surfaced as information, and withdrawing ahead of one you don't like remains your decision.

This feature is live on the deployed testnet vault as of the 2026-07-20 in-place upgrade: `schedule_upgrade`, `execute_upgrade`, `cancel_upgrade`, and `pending_upgrade` are all callable today, the old instant upgrade is gone, and the dedicated smoke test proved the schedule, the timelock block, the cancel path, and the 2-of-3 multisig admin proof against the real vault.

## Wallets and on-ramp

Use the passkey-based VF Wallet (no seed phrase, optional browser extension) with a built-in testnet faucet, or bring Freighter, xBull, or Albedo through a shared wallet-kit interface.

The passkey wallet is a Soroban smart account secured by a WebAuthn credential — Face ID, Windows Hello, a hardware key — on the secp256r1 curve. The signature it produces is converted and normalized into the exact form Soroban's verifier expects, and the WebAuthn challenge is built directly from the transaction's own authorization hash, so the passkey signature is the on-chain authorization with no separate re-hashing step to get wrong. A separate Base-side passkey account, used only for the optional cross-chain leg, is authorized by a different WebAuthn credential — a second signing prompt — even when the same physical authenticator is doing the signing. A classic seed-phrase wallet exists in code (key generation, import, encrypted storage) but its onboarding flow into the main app isn't wired up yet. The browser extension runs its actual signing ceremony in a separate tab bound to the extension's own origin, since WebAuthn credentials are bound to the origin that created them, and can act as the signing wallet for other Stellar apps, not just this one.

A card on-ramp session lets a new user buy USDC directly, pre-locked server-side to their own Stellar address so the destination can't be changed inside the widget.

## Risk-aware wallet

The same fail-closed eligibility gate that screens the AI strategist's picks also runs inside VF Wallet's own signing layer, so an unsafe deposit is refused even if you reach the wallet through a path that skipped the strategy flow entirely. The vault-deposit function calls the eligibility gate before it builds a transaction at all — if the verdict is ineligible, the unsigned transaction is never constructed, let alone presented for a signature. The general-purpose send flow applies the same gate whenever the destination resolves to a recognized vault; sends to any other address aren't gated, since the gate has nothing meaningful to say about a destination outside the product.

Before every approval, the wallet renders a plain-language explanation of what's actually being signed — the operation, the amounts, the destination, and any honest caveat labels — instead of an unreadable transaction blob, so you can read what you're authorizing in sentences, not hex.

## Verifiability

The approved strategy is hashed and attested on-chain, and every contract is verifiable on Stellar Expert. See [Deployed contracts](contracts.md). The hash is computed from the exact strategy JSON you reviewed and approved, after any council adjustments, so anyone holding that JSON can reproduce the same hash and compare it against the on-chain attestation event — a mismatch means the strategy that ran isn't the one that was shown to you.

## Optional cross-chain leg

An optional cross-chain leg bridges Stellar USDC to Base via Circle CCTP v2 and a ZeroDev session key, offered inside the strategy flow while the relayer health probe passes (fail-closed), with the unwind reversing the path from a dashboard withdraw. The session key is scoped to exactly two call signatures on the Base router — deposit and withdraw into whitelisted pools only — so owner-only actions like changing the pool list or the fee can never be delegated to it. The router itself never takes custody, since funds pass straight through in one transaction, and it charges no fee at all today, on yield or on principal. The pools currently whitelisted on testnet are honest 1:1-custody vaults rather than fabricated-yield contracts: a dedicated on-chain check found that no real lending protocol on Base Sepolia currently accepts Circle's bridged USDC, so a mainnet-ready adapter sits built and tested but undeployed until there's a real venue to point it at.

## Developer API

A separate API gateway exposes the same core building blocks — market data, transaction building, AI strategy — to external developers, authenticated by bearer API keys rather than a wallet session. Getting a key starts with a SEP-10 challenge-response login that proves control of a Stellar address and returns a session token, which can then issue, list, or revoke keys. Each key is scoped to one or more capabilities, and usage is rate-limited per key and per scope:

| Scope | Covers |
|---|---|
| Market | Vault facts, live prices, and the eligibility check as a callable API |
| Tx | Building, simulating, and inspecting an unsigned deposit transaction |
| Submit | The same fee-bump relay, keyed to the caller |
| Strategy | The AI allocation, or its deterministic fallback, under a short timeout so it can never hang a caller's request |

## Operations console

The `/agent` dashboard is organized into eight zones on a shared clock, each reading from the same live data rather than its own separate poll:

1. **Command strip** — running status, cycle count, total earned, blended APY.
2. **Swarm graph** — a live force-directed view of orchestrator, workers, and vault, with flow animation on active edges only.
3. **Council log** — a paginated log of past decisions, each with its per-specialist verdict and how it was resolved.
4. **Positions** — current vault shares, projected USD value, and a withdraw action.
5. **Keeper feed** — a running log of compound and rebalance events as they land.
6. **Monitor journal** — the background monitor loop's cycle-by-cycle keep/hold/discard tally and next-tick countdown.
7. **Lifeboat zone** — armed/engaged/disarmed state, recent derisk activity, and the mandate-renewal action.
8. **Mandate zone** — each agent's live allowance scope (budget, expiry, issued or revoked), with a per-agent revoke button.

## App pages

| Route | Description |
|-------|-------------|
| `/` | Redirects to `/home`; landing hero shows in-app until a wallet connects |
| `/home` | Portfolio, positions, alerts, market pulse (always visible, not collapsible) |
| `/strategy` | Wizard: input → connect → skills → permission → execute → done |
| `/agent` | Dashboard: scopes, revoke, monitor status, journal, decision log |
| `/vault/:protocol` | Single-vault metrics and history |
| `/farm` | Cross-chain CCTP burn/relay/deposit flow |
| `/history`, `/tx/:txHash` | Transaction and strategy history, with per-transaction detail |
| `/settings` | Wallet, permissions, agent config, language, skill source |
| `/explorer` | On-chain verification (contracts, TVL, test stats); no wallet |
| `/replay` | Timeline replay from static JSON (no RPC) |
| `/ecosystem` | Ecosystem overview; no wallet |
| `/developers` | Developer portal (docs, contracts, integration) |
