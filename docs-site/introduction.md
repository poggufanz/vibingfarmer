# What is Vibing Farmer?

> **Set once. Vibe forever.** An AI agent swarm that farms yield for you on Stellar — under limits you sign once, enforced on-chain.

## The chore this replaces

"Yield farming" in DeFi is usually the same loop, repeated once per protocol you want exposure to: find a vault, check the protocol isn't a rug, approve a token, deposit, wait, come back, harvest, redeposit. Every one of those steps is its own wallet pop-up, its own gas fee, and its own chance to approve the wrong contract or fat-finger an amount.

> Bridge, swap, find the right vault, deposit — and hope you didn't miss a step.

Most people start the flow and abandon it partway through. The yield is worth it; the process to get there is too easy to mess up or give up on.

The industry's usual answer to the tedium — hand a bot full wallet access and let it act for you — trades one problem for a worse one: unlimited custody. If the bot misbehaves, or the model behind it is talked into something it shouldn't do, nothing stands between it and everything in your wallet.

## The one-sentence solution

Vibing Farmer lets you state intent once — an amount, a risk level, a number of agents — and enforces every boundary of what happens next in smart-contract code, not in a promise from a bot: a spending allowance with a hard expiry and a single pinned destination vault, decided by an AI strategist and a council of risk specialists, executed gas-free by infrastructure the project runs itself.

## What decides the plan before you sign anything

Three checks run before you ever see an allocation to approve: an AI strategist picks vaults using live market data and proposes an allocation. A three-specialist council — yield, risk, and market — reviews that proposal, and the risk specialist can veto it outright if conditions look turbulent. A fail-closed eligibility check then screens every candidate protocol against its own on-chain numbers and rejects anything it can't verify as safe, rather than assuming safety by default. None of this has any authority to move money — it only decides what you're shown to approve. [How it works](how-it-works.md) covers the full sequence.

## Why limits live on-chain, not in a prompt

The plan an AI writes is only ever a proposal. What actually moves funds is a Soroban smart contract, and its rules aren't something a clever prompt can talk it out of:

- **The allowance is a SEP-41 token approval**, enforced by the token contract itself — it caps how much can ever move, regardless of what the rest of the app's code does.
- **The expiry is a ledger timestamp.** Once it passes, the allowance is dead; no code path can renew it without another signature from you.
- **The vault is pinned per agent, at deploy time.** Each worker's on-chain account can only ever deposit into the one vault it was scoped to — even a fully compromised session key can't redirect funds elsewhere, and can't reach your main wallet at all.

That's the real difference from "the AI promises to behave": a system prompt is advice to a model, and a model can be reasoned with or tricked. A SEP-41 allowance and an on-chain expiry are enforced by the protocol itself, independent of whether the AI, the frontend, or even the project's own servers are working correctly. Both exits — zeroing the allowance for everything at once, or revoking a single agent — are plain user-signed transactions that keep working even if every server the project runs goes offline.

## Who this is for

You are probably reading this as a hackathon judge, a curious user, or a developer sizing up the project. This documentation is written product-first: it explains what the app does and how to try it before diving into the contracts and internals.

Everything runs on **Stellar testnet**, so you can try the full flow with no real funds at risk.

## What you'll find in these docs

| Section | Covers |
|---|---|
| **Get started** — [Try it in two minutes](quick-start.md), [How it works](how-it-works.md) | The fastest path to a running demo, then the full step-by-step lifecycle from input to kill switch |
| **Product** — [Feature overview](features.md), [The skill system](skill-system.md), [What's real vs. demo](real-vs-demo.md), [FAQ](faq.md) | What each feature does, the shape of the per-agent permission file, an honest split of what's live on-chain versus a disclosed testnet stand-in, and answers to common questions |
| **Under the hood** — [Architecture](architecture.md), [Security model](security-overview.md), [Deployed contracts](contracts.md) | How the pieces fit together, the trust model and kill switches in detail, and the live testnet contract addresses you can verify yourself |
| **Reference docs** — [PRD](../prd.md), [Full feature guide](../FEATURES.md), [Security review](../SECURITY.md), [Getting started (developers)](../GETTING_STARTED.md), [Design system](../DESIGN.md) | The source-of-truth documents: product requirements, the exhaustive feature-by-feature writeup, the internal security hardening review, developer setup, and the visual design system |

If you only read one more page, make it [How it works](how-it-works.md) for the mechanics, or [Security model](security-overview.md) for the trust model.

Live app: [vibing-farmer.pages.dev](https://vibing-farmer.pages.dev)
