# How it works

Vibing Farmer turns a multi-step farming chore into a single approval followed by autonomous, bounded execution. Here is the full lifecycle.

## 1. Strategy

You set the deposit amount, a risk level, and how many vaults to spread across. The AI strategist returns an allocation plan plus one skill file per agent, backed by live DeFiLlama market data. Before anything runs, a Monte Carlo simulation stress-tests the allocation across 200 scenarios.

## 2. AI council

Three specialists — yield, risk, and market — score the proposal independently. When they disagree, the conflict goes to a synthesis round. The verdict, the playbook rules it cited, and how conflicts were resolved are all logged for you to inspect.

## 3. Review

Every skill file is open in the Skills Drawer. You can edit caps, expiries, or targets. Nothing runs until you approve.

## 4. One signature

You sign `funding_router.grant` with a budget and an expiry. A SEP-41 token allowance *is* the leash: the router deploys a fresh, scoped `agent_account` per worker and can only ever pull within what you approved.

## 5. Parallel deposit

Workers sign their deposits with ephemeral ed25519 session keys, and a fee-bump relayer sponsors every transaction. If one worker fails, it never aborts the others. You pay zero gas.

## 6. Attestation

The strategy JSON is hashed and written on-chain. Anyone holding the original file can later verify exactly what was approved.

## 7. Autonomy

A monitor loop polls positions, flags APY drift, and can propose rebalances — each cycle re-reviewed by the council. A keeper compounds yield on a cron, and a lifeboat radar can de-risk the vault at ledger speed under a mandate you signed.

## 8. Kill switch

Two user-signed exits that work even if every server is down:

- **Global:** `token.approve(router, 0)` — zero the allowance and funding stops.
- **Per agent:** `agent_account.revoke()` — flips an on-chain flag every authorization check fails closed on.

## Why the AI can't run off with your money

The model's job ends at *proposing* a plan. Execution authority comes entirely from on-chain scope: a deposit-only agent account, pinned to one vault, capped per period, with a hard expiry. Approve, transfer, or anything else simply fails closed. The limits are contract-enforced, not prompt-enforced.
