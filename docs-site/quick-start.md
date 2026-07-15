# Try it in two minutes

Everything below runs on **Stellar testnet** — no real funds are involved.

1. Open **[vibing-farmer.pages.dev](https://vibing-farmer.pages.dev)**.
2. Create a **VF Wallet** — passkey-based, no seed phrase and no extension required. Prefer your own? Freighter, xBull, and Albedo all work on testnet too.
3. Get test USDC from VF Wallet's **built-in faucet**.
4. Go to **Strategy** → set the amount, risk level, and number of agents → review the AI's plan → sign **once**.
5. Watch your agents deposit in parallel, gas-free, and track every decision on the **Agent** dashboard.

## The happy path, step by step

If you want to follow the full demo flow the way it's meant to be shown:

1. Connect a wallet on Stellar testnet (VF Wallet, or Freighter via Friendbot for test XLM).
2. Fund the wallet with testnet USDC from the faucet.
3. Open the **Strategy** wizard and enter an amount, a risk level, and an agent count.
4. Review the AI-generated skill files and the council / eligibility verdict, then approve.
5. Sign **one** transaction: `funding_router.grant` (your budget and expiry).
6. Workers deposit gas-free using ephemeral session keys plus the fee-bump relay.
7. Check the force-graph and your positions. To stop everything, use a kill switch: revoke the allowance globally, or revoke a single agent.

## Stopping everything

There are two user-signed exits, and both work even if all of our servers are down:

- **Global:** `token.approve(router, 0)` — the allowance *is* the budget, so zeroing it stops all funding.
- **Per agent:** `agent_account.revoke()` — flips an on-chain flag that every authorization check fails closed on.

## Running it locally

Developers who want to run the app on their own machine should follow [Getting started (developers)](../GETTING_STARTED.md), which covers the `frontend` dev server, environment variables, and the optional relayer.
