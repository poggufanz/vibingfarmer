# What's real vs. demo

Vibing Farmer runs on Stellar **testnet**, so it's worth being precise about what is genuinely on-chain versus what is simulated for the demo. The exhaustive breakdown lives in the [Full feature guide](../FEATURES.md); this is the short version.

## Real and on-chain

The core loop is real. The `funding_router.grant` signature, the deployment of scoped agent accounts, the session-key-signed deposits, and the fee-bump relay are all live testnet transactions you can verify on Stellar Expert. Deposits flow through the autofarm vault into a real Blend Capital v2 pool and earn actual testnet lending interest. The strategy hash is genuinely attested on-chain. Both kill switches are real contract calls.

## Real, but off-chain by design

The AI strategist, the council review, and the Monte Carlo simulation run off-chain — that's intentional, because the model only ever *proposes*. Its output carries no authority until you approve and sign, and even then execution is bounded by on-chain scope. Market data comes live from DeFiLlama.

## Testnet caveats

No real funds are involved anywhere. Yields are real testnet lending rates, not mainnet returns, and testnet liquidity is thin, so numbers are illustrative. The optional Base cross-chain leg runs on Base Sepolia. This is testnet software and has not had an independent audit — see the [Security model](security-overview.md) for the honest residual-risk picture.
