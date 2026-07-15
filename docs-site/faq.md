# FAQ

Common questions from judges and new users. A longer judge-focused FAQ lives in the [Full feature guide](../FEATURES.md#9-faq-for-judges).

**Is my money ever controlled by the AI?**
No. The AI only proposes a plan. Authority to move funds comes entirely from on-chain scope — a deposit-only agent account, pinned to one vault, capped, and expiring. The model's output is inert until you approve and sign, and even then it can't exceed what the contracts allow.

**What exactly am I signing?**
One `funding_router.grant` transaction that sets a budget and an expiry. That SEP-41 allowance is the leash: the router can never pull more than you approved.

**How do I pay gas?**
You don't. An own fee-bump relayer sponsors every allowlisted operation, so you spend zero XLM. Both kill switches still work even if the relayer is down.

**How do I stop everything?**
Two ways, both user-signed and both server-independent: zero the allowance globally with `token.approve(router, 0)`, or revoke a single agent with `agent_account.revoke()`.

**Is the yield real?**
Yes — deposits supply into a real Blend Capital v2 pool and earn actual testnet lending interest. It's testnet, so rates are illustrative and no real funds are involved. See [What's real vs. demo](real-vs-demo.md).

**Which wallets are supported?**
The passkey-based VF Wallet (no seed phrase, optional extension, built-in faucet), plus Freighter, xBull, and Albedo on testnet.

**Which chains does it use?**
Stellar / Soroban is the primary and only required chain. There's an optional cross-chain leg to Base Sepolia via Circle CCTP v2 and ZeroDev.

**Has it been audited?**
No independent audit yet. This is testnet software. The honest control-and-residual-risk picture is in [SECURITY.md](../SECURITY.md).

**Do I need AI API keys to run it?**
No. Keys are optional — bring a Venice key, set a server-side DeepSeek key, or use neither and rely on the deterministic fallback. See [Getting started (developers)](../GETTING_STARTED.md).
