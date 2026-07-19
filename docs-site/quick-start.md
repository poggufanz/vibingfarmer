# Try it in two minutes

Everything below runs on **Stellar testnet** — no real funds are involved.

1. Open **[vibing-farmer.pages.dev](https://vibing-farmer.pages.dev)**.
2. Create a **VF Wallet** — passkey-based, no seed phrase and no extension required. Prefer your own? Freighter, xBull, and Albedo all work on testnet too.
3. Get test USDC from VF Wallet's **built-in faucet**.
4. Go to **Strategy** → set the amount, risk level, and number of agents → review the AI's plan → sign **once**.
5. Watch your agents deposit in parallel, gas-free, and track every decision on the **Agent** dashboard.

## The happy path, step by step

If you want to follow the full demo flow the way it's meant to be shown, here's what happens behind the scenes at each stage.

### 1. Connect a wallet on Stellar testnet

Connecting a wallet (VF Wallet, or Freighter via Friendbot for test XLM) only gets your Stellar address — it's an identity handshake, not a spending permission. No allowance, no contract call, no signature is requested at this step. Nothing you own can move yet.

### 2. Fund the wallet with testnet USDC from the faucet

The in-wallet "Get test USDC" button calls `/api/faucet`, a server endpoint that holds a funded treasury key (`VF_FAUCET_SECRET`) and never exposes it to the browser. A single dispense is capped at 100 USDC server-side, and the default tap (if you don't ask for a specific amount) sends 10. Requesting more than 100 in one go — for example the wallet's "top up 300" shortcut — is handled client-side by looping the same 100-cap call three times in sequence, not by asking the server to bend its cap. On top of the per-call cap, the server also tracks two rolling daily ceilings: 300 USDC per recipient address and 5,000 USDC globally across everyone, both reset roughly 24 hours after first use. Hit either one and the endpoint returns HTTP 429 and stops dispensing — the client-side loop treats that as a normal stop, not an error, and reports back however much it managed to send before the cap kicked in.

### 3. Open the Strategy wizard and enter an amount, a risk level, and an agent count

These three numbers seed everything downstream: the AI prompt, the risk ceiling applied to the allocation, and the per-agent spending caps that eventually get written on-chain. The wizard itself moves through five stages — input, thinking, council, grant, execute — and you can watch it progress through each one live rather than staring at a single spinner.

### 4. Review the AI-generated skill files and the council / eligibility verdict, then approve

"Thinking" is the strategist stage: it fetches live vault data and market context in parallel, calls an AI provider (Venice, then a DeepSeek proxy, then a deterministic equal-split if every provider is unavailable — see the troubleshooting section below), and returns one allocation per vault plus a plain-language reason for each pick. "Council" is the review stage: three rule-based specialists (Yield, Risk, Market) vote on that allocation, the Risk specialist holds a hard veto, and only a genuine three-way split escalates to a single bounded AI tie-break call.

Underneath both stages, a fail-closed eligibility gate checks each candidate protocol's audit status, TVL, and yield-to-revenue ratio against live facts, and drops anything that doesn't qualify — rejecting on missing or stale data rather than assuming it's safe. Every field in the result (cap, vault, expiry, reasoning) is editable in a drawer before you approve. Nothing has executed yet; this whole stage is read-and-edit only.

### 5. Sign one transaction: `funding_router.grant` (your budget and expiry)

This is the one signature the whole product is built around. It does two things in a single wallet pop-up: it sets a SEP-41 token allowance from you to the router (a budget capped at what you approved, with a hard expiry ledger), and it deploys one fresh `agent_account` per worker, each pre-scoped at creation to its own vault, its own spending cap, and that same expiry. Both effects come from the same signed transaction because your wallet is the source account for both the router's `require_auth()` and the nested token `approve()` call underneath it — there's no second signature hiding behind the first.

### 6. Workers deposit gas-free using ephemeral session keys plus the fee-bump relay

Each worker agent signs its own deposit with a throwaway ed25519 session key generated just for it — not your wallet key, and not reusable outside that agent's scope. The signed transaction goes to the app's own fee-bump relay, which wraps it in a Stellar fee-bump transaction and pays the network fee from its own funded keypair, so your wallet never spends XLM. The relay only fee-bumps a short allowlist of operation types (vault deposit/redeem, router grant/pull, pinned-wasm deploys) — anything else is refused before it's signed. Workers are dispatched one after another with a short gap between each (to stay under the relay's rate limit, not literally all at once), but one worker's failure never blocks or rolls back the others.

### 7. Check the force-graph and your positions

The `/agent` console shows every worker, its status, and the vault it landed in, updating live as each deposit confirms. To stop everything, use a kill switch: revoke the allowance globally, or revoke a single agent.

## Repeat runs can be free of signatures

Farming again with the same wallet, vault, and network doesn't always need a new grant. The orchestrator first checks whether it can fill every worker slot from a local cache of previously deployed agents. A cached agent is only reused if its **on-chain** scope — read fresh, not trusted from local storage — still isn't expired or revoked and still has spending headroom for the new amount, and only if the live SEP-41 allowance still covers the run's total. When every worker can be filled that way, the orchestrator skips the grant signature entirely and funds agents through a relayed `router.pull()` instead — zero wallet interaction. If even one worker can't be matched to a valid cached agent, the whole run falls back to a fresh grant signature rather than mixing partial reuse with a partial grant.

## Troubleshooting

**The strategy step seems to skip the AI, or feels instant.** That's the deterministic fallback, not a bug. If every AI provider is down, rate-limited, or unreachable within its timeout, the strategist steps down through Venice, a DeepSeek proxy, and finally a fallback that does an equal split across the vault catalog with no AI call at all. It cannot fail and cannot hang — you'll still get a valid, capped strategy to review, just without AI-written reasoning behind each pick.

**The grant signature seems to cost gas, or takes longer than expected.** The relay is preferred for `funding_router.grant` so you pay 0 XLM, but if the relay is unavailable, the flow falls back to submitting the signed transaction directly, with your wallet paying the network fee — the run isn't blocked waiting on relay infrastructure, it just stops being gas-free for that one transaction. Revoking (`token.approve(router, 0)`) is deliberately *never* routed through the relay in the first place, precisely so the kill switch keeps working even when the relay is down.

**Farming again didn't ask for a signature.** This is expected — see "Repeat runs can be free of signatures" above. If you'd rather force a fresh grant every time, revoke your existing allowance first (Settings → Wallet), which clears the headroom that repeat runs depend on.

**The faucet stopped dispensing.** You've hit either the per-recipient (300 USDC/24h) or global (5,000 USDC/24h) daily cap. Wait for the rolling window to reset, or use a different test wallet.

## Stopping everything

There are two user-signed exits, and both work even if all of our servers are down:

- **Global:** `token.approve(router, 0)` — the allowance *is* the budget, so zeroing it stops all funding.
- **Per agent:** `agent_account.revoke()` — flips an on-chain flag that every authorization check fails closed on.

## Running it locally

Developers who want to run the app on their own machine should follow [Getting started (developers)](../GETTING_STARTED.md), which covers the `frontend` dev server, environment variables, and the optional relayer.
