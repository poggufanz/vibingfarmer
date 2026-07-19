# How it works

Vibing Farmer turns a multi-step farming chore into a single approval followed by autonomous, bounded execution. You set an amount, a risk level, and a number of worker agents; an AI strategist and a council of specialists decide how to split the deposit; you sign one wallet transaction; disposable agent accounts do the rest, gas-free. Here is the full lifecycle, stage by stage, with the mechanics underneath each step.

## 1. Strategy

The strategist (`frontend/src/strategist.js`) is built as a chain of fallbacks that never blocks, because AI providers can be slow, unavailable, or simply refuse to answer:

1. **Venice x402** — you sign a wallet-based SIWE-style message to pay for the AI call directly, no API key needed.
2. **Venice API key (BYOK)** — a key you paste in Settings, called directly from the browser.
3. **DeepSeek API key (BYOK)** — same idea, your own DeepSeek key.
4. **Host proxy** — the app's own server-side `/api/ai` endpoint (DeepSeek, key held only in the deploy environment). On a BYOK-lockdown deploy this key is intentionally unset, so the app degrades to the next tier.
5. **Deterministic fallback** — an equal-split allocation across the static vault catalog. Zero cost, cannot hang, cannot fail.

Before any AI call happens, the strategist fetches live data with a 15-second budget: the vault catalog from DeFiLlama, market context from Tavily, and gas/position/market-signal snapshots, all concurrently. Any timeout or failure falls back to a static catalog and a null market context rather than blocking the run.

The resolved provider is called with a JSON response format and its own per-call timeout. Whatever comes back is checked by `validateStrategyResponse` before it's trusted: every selected vault address must already exist in the allowlisted catalog (no hallucinated addresses are accepted), each reasoning string must be at least 20 characters, `expected_apy` must fall in (0, 100], `allocation` in (0, 1], `risk_tier` must be low/medium/high, and allocations across vaults must sum to roughly 1.0 (within 1%). Anything that fails validation doesn't reach the user.

The decision is also framed as a small Markov Decision Process — a state (amount, risk, market turbulence, gas level), an action (the vault selection, clamped to the risk ceiling and renormalized), and a reward score — the same style of framing used in quantitative-trading research (FinRL). The final, enforced strategy JSON is hashed for later on-chain attestation and written to local history for the decision log.

Last, a seeded 200-run, 30-day Monte Carlo simulation (`frontend/src/strategy/simulation.js`) sanity-checks the resulting allocation before it's ever shown to you. If the AI call for a given agent's skill fails outright, a deterministic fallback skill (deposit-only, capped, 1-hour default expiry) is substituted — the flow never throws.

Underneath the allocation is a per-agent skill, generated for each worker: a typed JSON permission slip with a `maxAmount` (in base units), the target vault address, and an expiry timestamp, tagged with which provider generated it. That JSON is what you review in the next step, and it's also what gets hashed for on-chain attestation later — the same object travels through the whole pipeline rather than being re-derived at each stage.

## 2. AI council

Three specialists score the proposal — Yield, Risk, and Market/Gas — each deterministic and rule-based by default, so the council adds no AI latency or cost unless they genuinely disagree (`frontend/src/strategy/council.js`).

- **Yield Analyst**: a free harvest reward pushes toward DEPOSIT (0.8 confidence); a detected risk-adjusted uplift scales DEPOSIT confidence to the uplift size; no uplift defaults to HOLD.
- **Risk Analyst** (holds hard veto power): a turbulent market or a gate violation both push WITHDRAW at high confidence; calm conditions with no violations default to DEPOSIT.
- **Market/Gas Analyst**: favorable harvest timing or a positive net gain (APY minus gas) pushes DEPOSIT; gas exceeding the gain pushes HOLD.

The verdict is synthesized in order:

1. **Hard veto** — if the Risk Analyst signals WITHDRAW with confidence above **0.85**, the strategy is rejected immediately, no vote-counting needed.
2. **Unanimous** — if all three agree on DEPOSIT, it's kept (confidence = their average); if all three agree on HOLD/WITHDRAW, it's discarded.
3. **Weighted majority** — confidence scores are tallied by signal; if one side's total exceeds the other's by more than a **0.25 margin**, that side wins.
4. **Genuine split** — only when the vote is truly close does the system escalate to a single bounded AI call, explicitly instructed to be safety-first (prefer HOLD/WITHDRAW when unsure). If that call fails too, the result defaults to HOLD.

The returned verdict carries the resolution path (`veto` / `unanimous` / `weighted` / `ai-conflict`), each specialist's signal and cited rules, and the overall confidence — all logged so you can see exactly why a strategy was kept or discarded.

A second, deeper council (`frontend/src/strategy/councilLoop.js`) runs alongside this per-deposit gate: a bounded (max 2 rounds) proposer / risk-compliance / validator debate over VaR/CVaR tail-risk metrics, sanity-checking a proposed strategy's simulated risk against a compliance corpus before it converges, no-consensuses, or fails outright. Both councils are deterministic-first with a single bounded AI call as tie-breaker.

**Before any of this, a fail-closed eligibility gate ("F8") has already screened every candidate protocol.** It requires ten facts per protocol (claimed APY, actual protocol revenue, audit status, age, TVL, admin-key type, oracle type, collateral liquidity depth, pool class, supplier concentration), none older than 30 days — missing or stale data means rejection, not a shrug-and-proceed. Two tests decide eligibility:

- **Yield-reality (anti-Ponzi)**: `ratio = annualizedDistributed / protocolRevenue`. Below 1.5 passes as "real"; at or above 1.5 it's flagged "ponzi" (paying more than it earns); if either number is missing the verdict is "unknown" — and unknown is rejected, not trusted.
- **Security score**: a weighted 0–100 score (age 30%, TVL 40% log-scaled, admin-key type 30%) must clear **60**, and an unaudited protocol is auto-rejected regardless of score — audit status is a hard gate, not a weighted input. A lifeboat extension added after a real February-2026 oracle exploit further requires a curated (not community-managed) pool, an oracle with a circuit breaker, at least $250,000 of collateral liquidity depth, and no single supplier holding more than 40%.

An eligibility token is minted for a passing verdict, valid for 15 minutes, and re-checked just before the actual deposit executes — a defense-in-depth assertion, not the real security boundary (that boundary is the on-chain scope on the agent account itself, described in step 5). An earlier, lighter pre-check (`frontend/src/strategy/gates.js`, four gates: turbulence, gas, capital, universe) runs even before this and specifically blocks *offensive* actions like deposit or rebalance in bad conditions, while always letting *defensive* actions like withdraw or harvest through — the system is built to make it easy to pull money out and hard to push more in when conditions look wrong.

## 3. Review

Every generated skill — one per worker agent — opens in the Skills Drawer as an editable card: target vault, allocation percentage, expected APY, and a plain-language reason for the pick. You can adjust caps, expiries, or targets before anything executes. Nothing runs until you click approve; up to this point, no wallet interaction has happened at all.

## 4. One signature

You sign exactly one transaction: `funding_router.grant(owner, budget, expiry_ledger, agents[])` on the `funding_router` contract. That single signature does two things at once:

- Sets a SEP-41 token allowance from you to the router — a spending budget with an expiry, enforced by the token contract itself, not by app code.
- Deploys one fresh `agent_account` contract per worker, each pre-scoped at deploy time to its own vault, spending cap, period, and expiry.

**Why one signature covers two on-chain actions:** the transaction's source account is you, the owner. Both the `owner.require_auth()` check inside `grant` and the nested `token.approve(owner, router, budget, expiry_ledger)` sub-call are satisfied by that same source-account credential — so one wallet signature authorizes the deploy and the allowance together, instead of needing a separate approve step.

`funding_router` is a factory with no admin and zero custody — it never holds your funds. Its constructor pins the agent-account code hash and the funding token immutably at deploy time; `pull(agent, amount)` can only be called by an agent the router itself deployed, and only pulls through the SEP-41 allowance you already granted.

Building the grant transaction happens in a few concrete steps: for each worker, the client builds an `AgentInit` struct (a fresh session-key public key, a random salt, that worker's spending cap, its target vault, a period duration, and an expiry), assembles the single `router.grant(owner, totalBudget, expiryLedger, agentInits[])` call, and simulates it first to read back the `Vec<Address>` of agents that will be deployed — Soroban deploy addresses are deterministic from the salt, so the app knows each agent's address before you've even signed. Only then does your wallet prompt for the one signature, and the transaction is submitted through the fee-bump relay when it's available, falling back to a direct user-paid submission if the relay is down, so the flow never gets stuck waiting on relay infrastructure.

**Repeat runs can cost zero signatures.** If the router is already deployed and enabled, your local agent cache has agents for this (owner, vault, network) combination, each cached agent's on-chain scope — re-read fresh from the chain, not trusted from cache — still has headroom, hasn't expired or been revoked, and the SEP-41 allowance still covers the new run's total, the orchestrator skips the grant entirely and funds agents via a relayed `router.pull()` with no wallet interaction at all.

## 5. Parallel deposit

Each worker signs its own deposit authorization with an ephemeral ed25519 **session key** — generated fresh for the run, distinct from your wallet key. That key can only authorize a deposit into the one vault the agent was scoped to at deploy time, up to its cap; it has no power over your real wallet or any other agent's funds.

Every transaction is fee-bumped by the app's own relay (`POST /api/stellar-relay`): you or the agent signs the inner transaction normally, and the relay wraps it in a Stellar fee-bump transaction where the relay's own funded keypair pays the network fee. Only the fee-paying source account changes; the inner transaction's logic and authorization are untouched. The relay only fee-bumps a short allowlist — vault deposit/redeem on the configured vault, token transfers from an allowlisted agent, `router.grant`/`router.pull` on the configured router, and contract deploys matching a pinned wasm hash. Anything else, including admin functions like upgrading the vault or changing the keeper, is refused; if the vault address isn't configured at all, the guard is skipped entirely rather than relaying everything. The endpoint also sits behind an origin allowlist and a per-IP rate limit, and caches each inner-transaction hash for 30 minutes so an in-flight resubmission can't double-spend the same signed transaction. You pay zero XLM.

Each worker signs a Soroban authorization entry rather than a plain transaction, which requires a two-pass build: a first simulation runs in recording mode to work out what the transaction will touch, the session key signs the resulting authorization hash, and the transaction is then re-simulated with that signature attached to capture the final footprint. The signature covers only the authorization preimage hash, so this second pass doesn't invalidate it — it's what lets a purpose-built smart-contract account sign like a regular key without knowing its own execution footprint in advance.

**Honest note on dispatch:** workers are not submitted at the exact same instant. The orchestrator dispatches them serially with a **2-second gap between each submission**, specifically to stay under the relay's own per-IP rate limit — this is a rate-limit accommodation, not simultaneous execution. What the design does guarantee is **failure isolation**: each worker's execution is wrapped so that one worker's error never aborts or rolls back any other worker. The orchestrator collects completed, failed, and full results across all workers regardless of individual failures. (Some earlier steps, like generating all N agents' skill files, genuinely do run concurrently via `Promise.allSettled` — it's specifically the on-chain submissions that are paced.)

Per worker, before declaring success, `worker.js` reads a baseline of the agent's vault shares before depositing, then polls the vault balance up to 8 times, 3 seconds apart, until shares are confirmed to have increased — because a transaction being accepted on-chain doesn't by itself guarantee the state changed as expected.

## 6. Attestation

The exact strategy JSON you reviewed and approved — after any council adjustments and the action-space clamp — is hashed and written on-chain via the `attestation` contract's `attest(attester, strategy_hash, label)`, which bumps a per-attester counter and emits a `StrategyAttested` event. Because the hashing function is deterministic and the input is exactly the JSON you saw, anyone holding that original strategy file can recompute the same hash locally and compare it against what's on-chain, turning "the AI decided X" into a checkable claim instead of a trust-me screenshot.

## 7. Autonomy

Two independent automated systems keep the vault healthy after deposit, with very different permission models.

**The Worker keeper** runs on roughly a 15-minute cadence, using an identity kept deliberately separate from the relayer's so the two roles can't be confused or reused. It compounds — harvesting each strategy's realized interest and BLND emissions and sweeping them back into the vault, which is what raises the vault's price-per-share over time — and it rebalances capital between strategies when the APR gap crosses a threshold. Both actions are capped per move and cooldown-gated, and neither needs your permission or any time-boxed mandate: they're routine maintenance, bounded by hard caps rather than an expiring authorization. Compounding is also automatically blocked while the vault is in a derisked emergency state, so routine optimization can't fight an emergency exit.

**The lifeboat radar** is a separate process (`keeper/src/radar-runner.mjs`) that evaluates pool health roughly once per Stellar ledger — about every 6 seconds, polled every 2 seconds so no ledger is missed. It watches three signals and degrades gracefully to "off" for any it can't read, rather than false-triggering on missing data:

| Signal | Engage threshold | Resume threshold |
|---|---|---|
| Pool utilization | ≥ 95% | < 85% |
| Liquidity drop | ≥ 30% | same |
| Oracle price divergence | ≥ 2.5% | < 0.5% |

If a signal breaches its engage threshold, whether the radar can actually act depends entirely on a **live, time-boxed mandate** you granted separately (a "renew 24h mandate" button that signs `set_mandate(now + 24h)`, one signature by a dedicated mandate-authority role). With a live mandate, danger triggers `emergency_derisk()`, draining every strategy back to vault-idle. Without one, the radar only logs an alarm — it never acts on its own initiative. This is the fail-closed core of the design: danger without a live mandate produces a loud log line and zero fund movement, and once the mandate expires the radar reverts to alarm-only until you renew it.

Resuming works the same way in reverse, and deliberately with more friction than engaging: the vault must show an all-clear across **100 consecutive ledgers** (roughly 10 minutes) at the stricter resume thresholds above before `resume()` clears the derisked flag — and again, only if the mandate is still live. This hysteresis (stricter resume threshold, plus a sustained all-clear streak) exists specifically so the radar doesn't flap in and out of the emergency state on a noisy signal. Both `emergency_derisk()` and `resume()` also require the keeper's own signature; an already-derisked call is idempotent and safely returns without re-draining anything.

## 8. Kill switches

Two user-signed exits work even if every server Vibing Farmer runs is down, because neither depends on the app's own infrastructure to take effect — they resolve entirely inside the Stellar network's own state:

- **Global:** `token.approve(router, 0)` — a direct, user-signed submission, deliberately *not* routed through the relay, so it works even if the relay itself is offline. It zeroes the SEP-41 allowance, and every future `router.pull()` for every agent fails at the token contract level, regardless of what any off-chain process does or doesn't do next.
- **Per agent:** `agent_account.revoke()` flips an on-chain flag that `__check_auth` reads on every subsequent authorization attempt for that agent. Because the check happens inside the account contract itself — not in a server that could be paused, censored, or compromised — a revoked agent fails closed on every future call regardless of anything the app's own backend does.

## Why the AI can't run off with your money

The model's job ends at *proposing* a plan. Execution authority comes entirely from on-chain scope, not from anything the AI is trusted to respect: each agent account is deposit-only, pinned to one vault at deploy time, capped per rolling period, and dead after a hard expiry. Approve, transfer to an arbitrary address, or any action outside that scope simply fails the `__check_auth` check — the limits are contract-enforced, not prompt-enforced, so a malicious or simply wrong AI response can propose something unsafe but can never make it execute.

The same reasoning bounds the worst case of a leaked session key. If an attacker obtained one, the absolute worst they could do is push the remaining allowance for *that one agent* into the vault it was already scoped to — funds land in your own vault position, not anywhere an attacker controls, and they can't touch your real wallet or any other agent's cap. The blast radius of a compromised session key is bounded to exactly one agent's remaining headroom, into a destination you already approved.
