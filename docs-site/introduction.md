# What is Vibing Farmer?

> **Set once. Vibe forever.** An AI agent swarm that farms yield for you on Stellar — under limits you sign once, enforced on-chain.

Yield farming is the same handful of clicks repeated over and over: find a vault, approve the token, deposit, then do it all again for the next protocol. Vibing Farmer collapses that whole loop into **one signature**.

An AI strategist picks the vaults and writes a per-agent instruction file. A swarm of worker agents executes the deposits in parallel. You pay **zero gas**. And the AI is never trusted with your money — every agent runs inside a disposable on-chain account whose powers are pinned by contract: how much it can deposit, into which vault, and until when.

The key idea is that limits live **on-chain** — as a token allowance, an expiry, and a vault pin — not inside a prompt that a model could be talked out of.

## Who this is for

You are probably reading this as a hackathon judge, a curious user, or a developer sizing up the project. This documentation is written product-first: it explains what the app does and how to try it before diving into the contracts and internals.

Everything runs on **Stellar testnet**, so you can try the full flow with no real funds at risk.

## The one-signature idea in a sentence

You approve a budget and an expiry once. From that single `funding_router.grant` signature, the router deploys fresh, scoped agent accounts that can only ever pull within what you approved — and both emergency kill switches keep working even if every server we run goes offline.

## Where to go next

If you want to try it, jump to [Try it in two minutes](quick-start.md). If you want the mechanics, read [How it works](how-it-works.md). If you care about the trust model, see the [Security model](security-overview.md).

Live app: [vibing-farmer.pages.dev](https://vibing-farmer.pages.dev)
