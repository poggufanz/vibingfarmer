# Soroban 1d — Compliance Guardrail (agent allocation / exposure caps)

**Date:** 2026-06-20
**Status:** Design approved → writing plan
**Sub-project:** 1d (within layer 1, contracts). Depends on 1a (registry, deployed),
1c (vault, deployed). Distinct from 1b T-REX transfer compliance.
**Master spec:** `docs/superpowers/specs/2026-06-18-stellar-soroban-rwafi-migration-design.md`
(§ guardrail #4, line 105/130/179/299).

## 1. Problem

The master spec's guardrail #4 — "on-chain compliance guardrail: alloc/exposure caps +
KYC check → REVERT (enforces Aladdin)" — is not built. Current state:

- **Registry (1a)** stores `cap_per_period`, `period_duration`, `expiry`, `revoked` per
  agent, but as **inert config** — nothing consumes it.
- **Vault (1c)** `deposit` enforces **zero** agent caps. It only gates the T-REX
  verified-holder check implicit in the mRWA token move.

So an authorized agent can deposit any amount, any number of times, into any vault it is
scoped to — the on-chain Aladdin boundary the product claims ("crypto boundary reverts bad
trades regardless of AI", master spec line 161) does not exist yet.

Acceptance bar (master spec line 299): *the guardrail provably reverts an out-of-policy
agent trade.*

## 2. Decision — scope C (full Aladdin allocation caps)

Three enforcement dimensions on each agent deposit, all O(1), no loops, no external oracle:

1. **Per-period gross spend cap** (units, per **agent**) — total deposited by a worker
   agent within a rolling period ≤ `cap_per_period` (from registry). Resets when the period
   elapses. A rate limit on each worker. EVM-parity dimension.
2. **Absolute net-exposure cap** (units, per **owner×vault**) — the owner's net position in
   a vault (deposits − redeems) ≤ `max_exposure`. New.
3. **Portfolio %-allocation cap** (value-weighted, per **owner**) — value in any single
   vault ≤ `max_pct_bps` of the owner's total portfolio value across all their vaults. New.
   This is the "max % per asset" Aladdin limit.

### Keying: agent vs owner

The registry scopes **one agent to exactly one vault** (`AgentRecord.vault` is a single
address), and the product runs **one worker agent per vault** (orchestrator dispatches N
workers across N vaults for one user). So the portfolio entity is the **owner** (`rec.owner`),
not the agent — a per-agent "portfolio" would be a single vault and its %-allocation would
trivially be 100%. Therefore: **spend** is keyed by agent (a rate limit on each worker);
**exposure** and **%-allocation** are keyed by owner (the user's real cross-vault portfolio).
Assumption: one agent per `(owner, vault)`. If two agents ever feed the same vault, they
correctly share that vault's owner-level position; only their per-agent spend rate differs.

Rejected: scope A (spend+exposure only) and scope B (spend only) — they drop the
%-allocation the master spec advertises as NEW. Scope C chosen by product owner.

### 2.1 NAV source — admin-set per-vault knob, default $1.00

The %-allocation check needs each vault's NAV to value positions. Source: an **admin-set
per-vault NAV** (`Nav(vault) -> i128`, default `1e7` = $1.00 at 7 decimals).

Rationale — this is both the **most real** and **most effective** source for this asset
class:

- **Real:** money-market RWAs (FOBXX/BENJI) are **stable-NAV by definition** ($1.00), and
  their NAV is **published by the fund administrator**, not read from a market price feed.
  An admin-set knob is exactly the real-world model. A market oracle (Reflector/SEP-40) is
  the right primitive only for volatile/market-priced assets; on a $1.00-pegged fund it
  would just read $1.00 while adding a testnet dependency + per-deposit cross-call gas +
  stale-price handling.
- **Effective:** zero external dependency, O(1). The knob doubles as the **de-peg / "break
  the buck" demo**: admin sets `nav = 0.95e7`, the %-allocation shifts, and the guardrail
  reverts the now-out-of-policy trade — the dramatic "crypto boundary reverts bad trade"
  moment, fully controllable on testnet.

Rejected: external oracle (wrong primitive for stable-NAV, testnet-fragile), constant
$1.00 with no knob (can't demo a de-peg).

## 3. Topology

New singleton contract `guardrail`. **Registry (1a) is untouched** — it is already
deployed (`CAEHOZGU…NZOQ`) and stays the agent identity/scope record. The guardrail is a
live policy + accounting layer on top of it.

```
owner ──set_policy──▶ guardrail ◀──record_of── registry (1a, deployed, untouched)
admin ──set_nav────▶ guardrail
                        ▲  ▲
            consume ────┘  └──── release
                        │            │
                  vault.deposit  vault.redeem   (vault 1c, redeployed with guardrail addr)
```

Alternatives considered and rejected:

- **Extend the registry** with spend/exposure/alloc state → requires redeploying 1a,
  breaking the immutability of an already-deployed contract; mixes identity with live
  accounting.
- **Embed caps in the vault** → a per-vault contract has no view of the agent's positions
  in *other* vaults, so it cannot compute portfolio %-allocation.

The singleton guardrail is the only topology that sees portfolio-wide totals while keeping
each check O(1) (the cross-vault total is maintained incrementally, never recomputed by
iteration).

## 4. Interface

### 4.1 State (persistent, `extend_ttl`)

```
DataKey::Admin                         // set_nav authority (protocol / issuer)
DataKey::Registry                      // registry contract address (set at construct)
DataKey::Policy(Address)               // agent -> Policy { max_exposure: i128, max_pct_bps: u32 }
DataKey::Spend(Address)                // agent -> SpendState { spent_in_period: i128, period_start: u64 }
DataKey::TotalValue(Address)           // owner -> i128            (running portfolio value)
DataKey::Position(Address, Address)    // (owner, vault) -> i128   (units held)
DataKey::Nav(Address)                  // vault -> i128            (admin-set, default 1e7)
```

`Policy` is keyed by agent (the owner sets each worker's limits); `Spend` by agent (per-worker
rate); `TotalValue`/`Position` by **owner** (the cross-vault portfolio). `consume` derives the
owner from `registry.record_of(agent).owner`.

### 4.2 Entrypoints

```
__constructor(admin: Address, registry: Address)

// owner's per-agent Aladdin limits. owner.require_auth() + owner == registry.record_of(agent).owner
set_policy(owner: Address, agent: Address, max_exposure: i128, max_pct_bps: u32)

// the de-peg knob. admin.require_auth(). default 1e7 if never set.
set_nav(vault: Address, nav: i128)

// vault-only (invoker auth). enforces the three caps; reverts out-of-policy. mutates accounting.
consume(agent: Address, vault: Address, amount: i128)

// vault-only (invoker auth). exit path, no policy checks. decrements accounting.
release(agent: Address, vault: Address, amount: i128)

// views
policy_of(agent) -> Policy
spend_of(agent) -> SpendState
total_value_of(agent) -> i128
position_of(agent, vault) -> i128
nav_of(vault) -> i128
```

### 4.3 `consume` logic (deposit path)

```
1. vault.require_auth()                         // invoker-auth: only the real vault, for itself
2. require amount > 0                            // else InvalidAmount
3. rec = registry.record_of(agent)              // panics if unknown agent = fail-closed
   owner = rec.owner
   require !rec.revoked                          // else Revoked
   require now < rec.expiry                      // now = e.ledger().timestamp(); else Expired
   require rec.vault == vault                    // else WrongVault
4. policy = Policy(agent)  or revert PolicyNotSet   // fail-closed if owner never set limits
5. SPEND (per-agent, units):
   if now - period_start >= rec.period_duration { spent_in_period = 0; period_start = now }
   require spent_in_period + amount <= rec.cap_per_period   // else SpendCapExceeded
6. EXPOSURE (per-owner×vault, units):
   pos = Position(owner, vault)
   require pos + amount <= policy.max_exposure              // else ExposureCapExceeded
7. ALLOC (per-owner, value-weighted):
   nav = Nav(vault) or 1e7
   new_pos_val = (pos + amount) * nav                       // checked_mul -> MathOverflow
   new_total   = TotalValue(owner) + amount * nav
   require new_pos_val * 10000 <= policy.max_pct_bps * new_total   // else AllocCapExceeded
8. commit:
   Position(owner,vault) = pos + amount
   TotalValue(owner)    += amount * nav
   spent_in_period      += amount
```

### 4.4 `release` logic (redeem path)

```
1. vault.require_auth()
2. owner = registry.record_of(agent).owner; nav = Nav(vault) or 1e7
3. Position(owner,vault) -= amount; TotalValue(owner) -= amount * nav   // saturating at 0, no policy checks
```

## 5. Vault wiring (1c redeploy)

- `RwaVault.__constructor` gains a `guardrail: Address` parameter, stored + exposed via a
  `guardrail()` view.
- `deposit(from, amount)`: after `from.require_auth()`, **before** the token move, call
  `GuardrailClient::consume(&from, &vault_self, &amount)`. An over-cap deposit reverts here,
  before any mint.
- `redeem(from, shares)`: after the burn, call `GuardrailClient::release(&from, &vault_self,
  &shares)` to decrement accounting.
- No double-auth: `consume`/`release` use the vault's invoker auth, not `from`'s — `from`
  is already authorized once for the deposit tree (see the 1c auth-tree note).

Crate deps: `guardrail` depends on `registry` (for `RegistryClient` + `AgentRecord`); `vault`
depends on `guardrail` (for `GuardrailClient`). No cycle (`guardrail` does not depend on
`vault`).

## 6. Known simplification (drift ceiling)

`total_value` is a running sum: deposit adds `amount * nav`, redeem subtracts
`amount * nav`. Under stable NAV (the normal case) it is exact. A mid-life `set_nav` change
introduces **bounded drift** in the %-allocation denominator (units deposited at the old
NAV are removed at the new NAV on redeem). Acceptable for a money-market mock where NAV is
stable by design and the de-peg is a transient demo scenario.

`// ponytail: running weighted total; set_nav does not retro-revalue holders (no agent`
`// iteration). Exact under stable NAV; bounded drift on mid-life NAV change. Upgrade path =`
`// store cost-basis value per (agent,vault) + pro-rata redeem -> O(1), zero drift.`

## 7. Errors

`InvalidAmount`, `Revoked`, `Expired`, `WrongVault`, `PolicyNotSet`, `SpendCapExceeded`,
`ExposureCapExceeded`, `AllocCapExceeded`, `MathOverflow`.

## 8. Testing (TDD)

Unit (`guardrail` crate):
- each cap passes exactly at the limit, reverts at limit + 1 (spend, exposure, alloc)
- period roll: spend resets after `period_duration` elapses; does not reset before
- `Revoked` / `Expired` / `WrongVault` each revert
- `PolicyNotSet` fail-closed (deposit before `set_policy`)
- non-vault caller rejected (no invoker auth)
- `release` decrements position + total; saturates at 0
- `Nav` defaults to 1e7 when unset; `set_nav` admin-gated
- `set_policy` owner-gated + owner-mismatch rejected
- overflow guards (`checked_mul`)

Integration (real registry + vault + guardrail):
- deposit within all three caps succeeds end-to-end
- over-cap deposit reverts (each dimension)
- **de-peg scenario**: a deposit that passes at `nav = 1e7` reverts after
  `set_nav(vault, 0.95e7)` shifts the %-allocation

Gates: `cargo test` green, `cargo clippy -- -D warnings` clean, wasm < 64KB.

## 9. Deploy

- Build + deploy `guardrail` (constructor: admin, registry addr).
- Redeploy `vault` with the guardrail address.
- `set_policy` for the demo agent (max_exposure, max_pct_bps).
- Wire both into `scripts/soroban/deploy-seed.sh`; update `deployments/stellar-testnet.json`.
- Re-seed the verified-holder KYC path for the redeployed vault (1c step).

## 10. Out of scope

Gasless relay (2), frontend (3), Aladdin off-chain engine / autonomous orchestration (4),
EVM decommission (6). The off-chain Aladdin engine *computes* allocations; the guardrail
only *enforces* the on-chain ceiling and reverts out-of-policy results.
