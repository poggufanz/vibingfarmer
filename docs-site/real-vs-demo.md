# What's real vs. demo

Vibing Farmer runs on Stellar **testnet**, so it's worth being precise about what is genuinely on-chain, what is real but deliberately kept off-chain, and what is an honest stand-in for something that doesn't exist yet on a test network. The exhaustive breakdown, with file paths and exact contract calls, lives in [§7 of the Full feature guide](../FEATURES.md#7-whats-real-vs-whats-demo); this page is the readable version, plus the status table in one place.

## Real and on-chain

The core loop is live testnet transactions, not a simulation of one. The single wallet signature calls `funding_router.grant(owner, budget, expiry_ledger, agents[])`, which in one transaction sets a SEP-41 token allowance from the user to the router and deploys a fresh, scoped `agent_account` per worker. Each worker then signs its own `vault.deposit()` with an ephemeral session key, submitted through the app's own fee-bump relay so the user's wallet never pays a network fee for it. Deposits land in the autofarm vault and flow through the strategy contract into a real **Blend Capital v2** pool on Stellar testnet — interest and BLND emissions are genuinely accrued and harvested by `strategy.harvest()`, not credited from a fixed number. The strategy the AI proposed is hashed and written on-chain via the `attestation` contract, so the exact decision the app claims it made is independently checkable by anyone with the original strategy JSON.

Both exit paths are real contract calls, not UI-only affordances. `token.approve(router, 0)` instantly zeroes the SEP-41 allowance — it's submitted directly rather than through the relay, so revoking still works even if the relay itself is down. `emergency_derisk()`, callable only under a live, time-boxed mandate, pulls all strategy capital back to vault-idle. On the optional cross-chain leg, the CCTP burn/mint corridor between Stellar and Base Sepolia has been proven live in both directions, and the lifeboat's derisk-then-resume cycle has been run live on testnet as a "whale-attack drill."

## Real, but off-chain by design

The AI strategist, the three-specialist council, the eligibility gate's fact-checking, and the Monte Carlo simulation all run off-chain — deliberately, because none of them ever needs to be trusted on its own. The strategist only *proposes* an allocation; its output carries no spending authority until the user reviews it and signs the grant, and even after signing, every dollar that actually moves is bounded by the on-chain scope on that specific agent account, not by whatever the AI reasoned. Putting the reasoning itself on a blockchain would add cost and latency without adding any real guarantee — the guarantee comes from the SEP-41 allowance and the agent's `__check_auth` scope, both enforced by the chain regardless of what upstream decided.

Market data feeding these off-chain steps is genuinely live, not canned: vault and TVL data from DeFiLlama, market context from Tavily, both fetched fresh on every run rather than cached or hardcoded into the prompt.

## The status table

The inventory below matches FEATURES.md §7, grouped by what kind of "not quite mainnet" each item actually is.

### Live and repeatable

These five have each been run on live testnet, not just built and unit-tested:

| Component | Status | Why |
|---|---|---|
| Blend Capital lending yield | Real | Actual Blend v2 testnet pool; interest and BLND emissions are genuinely accrued and harvested |
| Circle CCTP bridge (both directions) | Real, live-proven | Burn/mint corridor between Stellar and Base Sepolia proven working in both directions |
| Fee-bump relay (gasless deposits) | Real, live-proven | User pays 0 XLM; the relay's own funded keypair covers the network fee |
| One-signature grant | Real, live-proven | `funding_router.grant()` deploys N agents and sets the SEP-41 allowance in one signed transaction |
| Lifeboat emergency derisk | Real, live-proven | A "whale-attack drill" derisk-then-resume cycle has been executed live on testnet |

### Honest stand-ins for what testnet doesn't have

The Base-side yield pools aren't a shortcut — the team specifically checked whether a real lending protocol on Base Sepolia would accept CCTP-bridged USDC and found none does (Aave's testnet deployment uses its own separate faucet token; Morpho, Moonwell, and Compound are mainnet-only on Base). So the mock vaults hold real bridged USDC 1:1 rather than invent a yield number for a market that doesn't exist on this network yet:

| Component | Status | Why |
|---|---|---|
| Base-side yield pools (MockERC4626) | Honest testnet stand-in | 1:1 custody of real CCTP-bridged USDC, no fabricated yield — verified no real lending protocol on Base Sepolia accepts Circle's bridged USDC |
| AaveV3Adapter4626 (mainnet adapter) | Built, not deployed | Unit- and fork-tested against real Aave Base-mainnet bytecode; a ready drop-in once there's something real on testnet to wrap |

### Testnet-only and fixture-only pieces

| Component | Status | Why |
|---|---|---|
| Testnet faucet | Testnet-only | Dispenses testnet USDC under per-recipient and global daily caps; meaningless on mainnet |
| Demo agent fixture | Smoke-test fixture | Seeded agent on old wasm with a fixed, constructor-only scope; kept for explorer/smoke checks, never for product flows |
| View-as dev override (`/agent?as=`) | Dev-only | Gated behind `import.meta.env.DEV`, dead-code-eliminated out of production builds |
| Registry contract | Legacy, live but unused | Still deployed and readable, but the router + agent-account flow doesn't call it |

### A precision note, not a gap

Worker dispatch is described as "parallel" in the product story. In practice, workers are dispatched in sequence, a short gap apart, to respect the relay's per-IP rate limit — not literally at the same instant. The safety property that matters for a swarm is failure isolation: one worker's failure never blocks or aborts any other worker's deposit.

### In progress or intentionally off

| Component | Status | Why |
|---|---|---|
| VF Wallet classic (ed25519) | Implemented, UI pending | Keypair generation, import, and encrypted storage exist in code; onboarding UI integration isn't finished |
| Coinbase on-ramp fallback | Stubbed | Returns `501 Not Implemented`; Transak is the working primary on-ramp |
| 1Shot (EVM-era relayer) | Removed | Decommissioned with the EVM stack; no `ONESHOT_*` environment variables remain anywhere in the codebase |

## Testnet caveats

No real funds are involved anywhere in this system. Yields are real testnet lending rates, not mainnet returns, and testnet liquidity is thin, so the numbers you see are illustrative rather than representative of what a mainnet deployment would earn.

The optional Base cross-chain leg runs on Base Sepolia, not Base mainnet. This is testnet software that has not had an independent audit — see the [Security model](security-overview.md) for the full threat model, verified controls, and the honest residual-risk picture before drawing conclusions about mainnet readiness.
