# Security model

Scope in Vibing Farmer is enforced by contracts, not promises. The AI proposes; the chain constrains. This page is the product-level summary — the full internal hardening review, with threat model, verified controls, test evidence, and honest residual risks, is in [SECURITY.md](../SECURITY.md).

## The core guarantees

Agent accounts are **deposit-only**. Each one is pinned to a single vault, capped per period, and given a hard expiry. Approve, transfer, or any other operation fails closed.

The **router holds no funds** and has no admin or upgrade path. It can only pull within the SEP-41 allowance you signed.

The **vault is hardened** with a share-inflation guard, untrusted-strategy NAV clamps, balance-delta verification, and emergency de-risk and quarantine hatches.

The **fee-bump relayer** only sponsors an allowlisted set of operations — and, critically, both kill switches work without it.

## Two kill switches that always work

Even if every server we run is offline, you retain two user-signed exits:

- **Global:** `token.approve(router, 0)` zeroes the allowance, and since the allowance *is* the budget, funding stops.
- **Per agent:** `agent_account.revoke()` flips an on-chain flag that every authorization check fails closed on.

## Honest caveats

This is testnet software. It has not undergone an independent third-party audit. The verified controls and residual risks are documented candidly in [SECURITY.md](../SECURITY.md) — please read it before drawing conclusions about mainnet readiness.

## Reporting a vulnerability

Responsible-disclosure instructions are in the [security review](../SECURITY.md).
