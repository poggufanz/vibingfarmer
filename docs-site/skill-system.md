# The skill system

Each worker agent gets exactly one typed skill file — a small JSON permission slip generated for that specific agent before it ever touches a vault. It is deposit-only (no swap, no withdraw, no admin calls), and every amount in it is expressed in 7-decimal base units, the same denomination the underlying USDC token contract uses on-chain.

```json
{
  "agentId": "worker-agent-1",
  "vaultAddress": "CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77",
  "skills": {
    "deposit": {
      "maxAmount": "1000000000",
      "vaultAddress": "CDWHNHIH…KM77",
      "expiresAt": 1749686400
    }
  },
  "generatedBy": "venice-ai",
  "approvedByUser": true
}
```

## How a skill gets generated

`generateAgentSkills({ agentId, vault, amount, ... })` (`frontend/src/strategist.js`) runs once per worker, after the strategist has already picked that worker's vault and allocation. It first builds a deterministic **fallback** skill in memory — deposit-only, capped to the worker's exact allocation converted to base units, expiring one hour from generation time — before it ever calls an AI provider. That fallback is what ships if anything goes wrong.

It then resolves an AI provider through the same priority chain the strategist uses (Venice x402 → Venice key → DeepSeek key → host proxy), and asks it to fill in the same JSON shape, with the fallback's `expiresAt` value already baked into the prompt as the default. If the call fails, times out, or returns invalid JSON, the function catches the error and returns the fallback skill (tagged with an `error` field) instead of throwing — a single agent's skill generation can never abort the run. The AI-generated schema also offers an optional `swap` block, but nothing downstream ever reads `skills.swap`; the only skill any agent actually executes is `deposit`.

## Reading the fields

`maxAmount` is in 7-decimal base units, so `1000000000` means 100 USDC (`amount × 10,000,000`, via `toBaseUnits()`). `vaultAddress` pins the one vault this agent may deposit into — it appears twice, once at the top level and once nested under `skills.deposit`, and both must match the vault the router will actually scope the agent to. `expiresAt` is a Unix timestamp; past that moment the skill is dead. `generatedBy` records which provider produced the plan (`venice-ai`, a DeepSeek variant, or `fallback`), and `approvedByUser` starts `false` and only flips to `true` once you approve the run — it is not a security control, just a record of consent for the UI and history log.

## What already cleared before a skill is generated

By the time `generateAgentSkills` runs for a worker, its target vault has already survived two upstream checks on the strategist's output, not on the skill file itself: response validation (`validateStrategyResponse`) rejects any AI-selected vault address that isn't already in the allowlisted catalog, any `reasoning` string shorter than 20 characters, any `expected_apy` outside `(0, 100]`, and any set of allocations that doesn't sum to roughly 1.0; and the fail-closed eligibility gate separately rejects protocols on yield-reality and security-score grounds. A skill file's `vaultAddress` is only ever drawn from a vault that passed both.

## The file is intent, the scope is enforcement

The skill file is a proposal, not an authority. Even a perfectly-formed skill file can't move funds on its own — execution is gated by the on-chain `agent_account` contract, which pins its own scope at deploy time and checks it on every authorization, independently of whatever the JSON claims:

| Scope field | What it enforces |
|---|---|
| `owner` | The human's Stellar address — where exit funds can ever go |
| `vault` | The one vault this agent may deposit into |
| `token` | The funding asset — can't be redirected to spend a different token |
| `cap_per_period` | Max spend per rolling period (this is where the file's `maxAmount` ends up) |
| `period_duration` | Length of that rolling period, in seconds |
| `expiry` | Absolute expiry timestamp — dead after this, no matter what the file says |
| `revoked` | Instant kill flag |

Two details the JSON file doesn't show: `cap_per_period` isn't a one-shot lifetime cap — the contract also tracks `spent_in_period` and `period_start`, and resets the running total each time a rolling period elapses, as long as the agent is neither expired nor revoked. And the router sets these on-chain fields once, at deploy time, from the same numbers the file displayed for your review — after that, enforcement reads only the contract's scope, never the file again.

## Editing before approval

Every field is editable before you sign. A per-agent editor (opened from the strategy review screen) lets you tighten the deposit cap, pick a validity window (1 hour, 24 hours, or 7 days, or a custom value), and adjust risk profile — the values you set there become the exact `cap_per_period` and `expiry` the router bakes into that agent's on-chain scope. Nothing executes until you approve.

Separately, from **Settings**, you can swap out the AI's own vault-advisor instructions — the system prompt that decides *which* vaults get proposed in the first place — for a custom Markdown file you paste or upload. That's a different lever from editing an individual agent's cap or expiry: it changes what the strategist considers, not what any single agent is allowed to spend.

## What happens at expiry

`expiry` is a hard wall, not a warning. Once the ledger closes past that timestamp, the agent's own `__check_auth` refuses to authorize a deposit signed with its session key — the transaction fails, it isn't silently ignored. On a repeat run, the orchestrator re-reads each cached agent's on-chain scope fresh (never trusting the local cache's copy of the numbers); if it's expired or revoked, that agent isn't reused, and a fresh `funding_router.grant()` — one more signature — deploys a new one in its place. There's no auto-renewal: an expired skill just stops being usable, exactly like a revoked one.

## Why this shape matters

The skill file is what you review and approve; the on-chain scope is what actually stops money from moving. Even if the file were wrong, malicious, or tampered with after generation, the agent account enforces the same deposit-only, vault-pinned, capped, expiring scope independently of whatever the file claims.
