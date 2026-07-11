# Soroban inter-layer interfaces (pinned by sub-project 1a)

> Consumed by 1c (vault), 2 (relay), 3 (frontend), 4 (orchestrator).
> Changing anything here is a breaking change across layers.
> Built against `soroban-sdk = "26.1.0"` (current max-stable at impl time; plan
> originally drafted against 25.x — see Implementation notes).

## Agent account (`agent_account`)
- Constructor: `__constructor(owner: Address, signer: BytesN<32>, scope: AgentScope)`
- `scope_of() -> AgentScope`
- `signer() -> BytesN<32>`
- Implements `CustomAccountInterface::__check_auth(payload: Hash<32>, signature: BytesN<64>, contexts: Vec<Context>)`:
  ed25519 over payload + scope enforcement. `type Signature = BytesN<64>`, `type Error = AccountError`.

### AgentScope
`{ owner, vault, token, cap_per_period: i128, period_duration: u64,
   spent_in_period: i128, period_start: u64, expiry: u64, revoked: bool }`

### Enforcement contract (what __check_auth allows)
For EVERY auth context the agent signs:
- context MUST be `Context::Contract`
- `contract == scope.vault`
- `fn_name == "deposit"`
- amount = `args[1]` (i128) ; `0 < amount`, cumulative `spent_in_period + amount <= cap_per_period`
- `now < expiry`, `!revoked`
- period rolls when `now >= period_start + period_duration`

## Vault deposit (implemented by 1c — pinned signature)
`deposit(from: Address, amount: i128) -> i128 (shares)`
- fn-name symbol: `deposit`
- `amount` is the 2nd arg (index 1). 1c MUST keep this ordering or 1a cap accounting breaks.

## Registry (`registry`)
- `__constructor(admin: Address)`
- `authorize(owner, agent, vault, token, cap_per_period: i128, period_duration: u64, expiry: u64)` — owner-auth
- `revoke(owner, agent)` — owner-auth, owner must match record
- `record_of(agent) -> AgentRecord`
- `is_revoked(agent) -> bool` (unknown agent ⇒ true, fail-closed)
- Events: `agent_authorized`, `agent_revoked` (force-graph monitor subscribes via RPC getEvents)

## Signer-backend decision (Task 1)
Hand-rolled `__check_auth` chosen over OZ Smart Accounts module (testnet-readiness
unvalidated, spec §9). Revisit when 1c lands. Registry + AgentScope stable either way.

## Implementation notes (SDK 26.1.0 — verified against live crate)
Facts that differ from the plan's 25.x draft; record so layers 2/3/4 and 1c don't
re-discover them:
- `Hash<32>` has no public constructor (`from_bytes` is `pub(crate)`). A `Hash<32>`
  comes from the host (`env.crypto().sha256(&Bytes) -> Hash<32>`). Inside
  `__check_auth`, convert payload to `Bytes` via `From<Hash<32>>`
  (`let m: Bytes = payload.into();`) for `env.crypto().ed25519_verify(pk, &m, &sig)`.
- `__check_auth` (and any `__`-prefixed fn) is NOT exposed on the generated client —
  the Soroban Env reserves it. Test/exercise it via
  `env.try_invoke_contract_check_auth::<AccountError>(&id, &payload: &BytesN<32>, sig: Val, &contexts)`.
- `Val -> i128` uses `val.try_into_val(&env)` (`TryIntoVal` in scope).
- `auth::Context::Contract(ContractContext { contract: Address, fn_name: Symbol, args: Vec<Val> })`.
- `env.events().all()` returns only the LAST invocation's events (not cumulative);
  `.events()` yields the `&[ContractEvent]` slice. Assert event counts right after
  the emitting call.
- A trait `#[contractimpl]` placed in a separate module (e.g. `account.rs`) must
  `use crate::{AgentAccountArgs, AgentAccountClient}` (generated at the crate root by
  the inherent `#[contractimpl]`).
- Events declared with `#[contractevent(topics = [...])]`; emit via `Ev { .. }.publish(&env)`.

## Yield-farming asset (SEP-41 / SAC token)
The vault accepts and pays dividends in a single **plain fungible token** — any
SEP-41 token or Stellar Asset Contract. Decimals **7**. The testnet demo uses a
plain SAC `VFUSD` (`CAJSGONIIU4QPLNIVVOO7QCYC2LWGYMGXTD7BXSSNIQWWDHWFQTSAEB4`).
No KYC / identity / compliance gating — any holder may deposit. SEP-41 surface
consumed by 1c/3/4: `transfer(from, to, amount)`, `transfer_from(spender, from, to,
amount)`, `balance(id)`, `approve(from, spender, amount, expiration_ledger)`,
`allowance`, `decimals`, `name`, `symbol`.

> **History:** earlier drafts pinned a KYC-gated T-REX `rwa_token` (`mRWA`,
> OpenZeppelin RWA module) here, plus an identity/claim/compliance stack. That
> RWA-Fi layer was **dropped 2026-06-20** (commit 52bf9a5) — the vault now farms a
> plain token with no on-chain compliance.

## Yield vault (`rwa_vault`, struct `RwaVault`) — pinned by sub-project 1c

> **Crate still named `rwa_vault`** for deploy continuity, but it is a **plain DeFi
> yield vault**, not RWA. Yield model **(b)** stays LOCKED (stable $1.00 NAV + daily
> dividend) — built on the audited OZ `fungible::Base` (per-holder balance + total
> supply + 7-dp metadata) with deposit/redeem (1:1) + a cumulative-dividend-per-share
> index on top. NOT ERC-4626 share-growth.

- Model: **stable-NAV daily-dividend** (spec §6.1 (b), LOCKED) — shares 1:1 with
  principal + a pro-rata dividend in the underlying asset. Position ledger on OZ
  `fungible::Base`; yield on a cumulative-dividend-per-share index (O(1) per holder,
  claim-on-interaction).
- Share token: decimals **7**, symbol `vfVLT`, **non-transferable** (no transfer/approve
  exposed — positions move only via deposit/redeem; keeps the dividend index sound).
- Constructor: `__constructor(admin: Address, token: Address, name: String, symbol: String)`
  where `token` = the SEP-41/SAC yield-farming asset. Read via `token() -> Address`.
  **No guardrail/compliance param** — the dropped 1d compliance guardrail is gone.
- `deposit(from: Address, amount: i128) -> i128` (shares) — **1a-pinned** fn-symbol
  `deposit`, amount = args[1]. Pause-gated. 1:1 shares. Pulls the asset via
  `transfer_from(spender = vault, from, to = vault, amount)` (consumes `allowance[from][vault]`).
- `redeem(from: Address, shares: i128) -> i128` (assets) — NOT pause-gated. 1:1 principal.
  Auth: `Base::burn` enforces `from.require_auth()` (do not double-auth `from`).
- `drip(amount: i128)` — admin-only mock yield source; pulls the asset from the admin
  treasury and bumps the dividend index. Pause-gated. (Autonomous cadence = sub-project 4.)
- `claim(holder: Address) -> i128` — permissionless; pays the holder their accrued asset
  dividend. NOT pause-gated.
- `claimable(holder: Address) -> i128` — view.
- Reads: `admin`, `token`, `decimals`(=7), `balance(id)`, `total_shares`, `total_principal`,
  `acc_div_per_share`, `drip_epoch`.
- Events: `vault_deposit`, `vault_redeem`, `vault_drip`, `vault_claim` (force-graph monitor
  subscribes via RPC getEvents).
- Admin is stored in OZ access-control storage (`AccessControlStorageKey::Admin`), NOT a
  custom `DataKey::Admin` — a unit variant `Admin` encodes to the identical
  `Vec[Symbol("Admin")]` storage key and would collide (→ `AdminAlreadySet` #2006).

### Agent-deposit auth-tree consequence (for 2/4 — NOT solved in 1c)
1a's `__check_auth` permits a single `deposit@vault` context. The vault deliberately pulls
via `transfer_from` (vault = spender, self-authorized) so a 1a agent `from` authorizes ONLY
`deposit@vault` — no nested `transfer@token` context (which `token.transfer(from,..)` would
add and 1a would reject). The open question — who grants `allowance[*][vault]` (the agent
cannot self-`approve` under 1a; the spec's "approve once" implies the OWNER grants it, and
the beneficial holder/shares question follows) — is an auth-tree assembly decision owned by
sub-project **2 (relay)** + **4 (orchestrator)**. 1c tests use a plain holder as `from` with
a pre-set allowance.

### Yield vs principal vs agent caps (do not conflate)
- Vault **principal** (1:1 shares, stable NAV) and vault **dividend** (cumulative index)
  are vault-internal accounting only.
- Per-agent **spend caps** are enforced by the **1a registry** `AgentScope`
  (`cap_per_period` / `spent_in_period`), checked in `__check_auth` before any deposit.
- The separate Aladdin-style allocation/exposure **compliance guardrail** was sub-project
  **1d** — **dropped 2026-06-20** with the RWA-Fi layer. No on-chain exposure/%-alloc cap
  remains; the vault accepts any in-scope agent deposit.
