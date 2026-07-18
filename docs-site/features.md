# Feature overview

A tour of what Vibing Farmer does. For the exhaustive version — every feature with screenshots, edge cases, and judge notes — see the [Full feature guide](../FEATURES.md).

## AI strategist and council

The strategist proposes a multi-vault allocation using live DeFiLlama APY, TVL, and 7-day history. A three-member council (yield, risk, market) then reviews it, with disagreements resolved in a synthesis round. A 200-run Monte Carlo simulation stress-tests the plan before you ever see it. Every decision is logged and inspectable.

## One-signature grant

A single `funding_router.grant` sets your budget and expiry and deploys the agents. The SEP-41 allowance is the leash — the router can never pull more than you approved.

## Scoped agent swarm

Workers run in parallel, each inside a disposable, deposit-only agent account. One failure never aborts the batch. Each agent's powers are pinned on-chain: one vault, a per-period cap, and a hard expiry.

## Gasless execution

An own fee-bump relayer sponsors every allowlisted operation, so you pay zero XLM. Both kill switches keep working without the relayer.

## Real yield

Deposits flow through an autofarm vault into a Blend Capital v2 pool, earning real testnet lending interest — not a mock drip.

## Autonomy and safety rails

A monitor loop watches for APY drift and can propose council-reviewed rebalances. A keeper compounds on a cron. A lifeboat radar can de-risk the vault at ledger speed under a mandate you signed.

## Wallets and on-ramp

Use the passkey-based VF Wallet (no seed phrase, optional browser extension) with a built-in testnet faucet, or bring Freighter, xBull, or Albedo.

## Verifiability

The approved strategy is hashed and attested on-chain, and every contract is verifiable on Stellar Expert. See [Deployed contracts](contracts.md).

## Optional cross-chain leg

An optional cross-chain leg bridges Stellar USDC to Base via Circle CCTP v2 and a ZeroDev session key — offered inside the strategy flow while the relayer health probe passes (fail-closed), with the unwind reversing the path from a dashboard withdraw.

## App pages

| Route | Description |
|-------|-------------|
| `/` | Redirects to `/home`; landing hero shows in-app until a wallet connects |
| `/home` | Portfolio, positions, alerts, market pulse |
| `/strategy` | Wizard: input → connect → skills → permission → execute → done |
| `/agent` | Dashboard: scopes, revoke, monitor status, journal, decision log |
| `/history` | Transaction and strategy history |
| `/settings` | Wallet, permissions, agent config, language, skill source |
| `/explorer` | On-chain verification (contracts, TVL, test stats); no wallet |
| `/replay` | Timeline replay from static JSON (no RPC) |
| `/ecosystem` | Ecosystem overview; no wallet |
| `/developers` | Developer portal (docs, contracts, integration) |
