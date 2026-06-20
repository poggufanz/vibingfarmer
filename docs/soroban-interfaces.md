# Soroban inter-layer interfaces (pinned by sub-project 1a)

> Consumed by 1b (token), 1c (vault), 2 (relay), 3 (frontend), 4 (orchestrator).
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
unvalidated, spec §9). Revisit when 1b/1c land. Registry + AgentScope stable either way.

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

## RWA token (`rwa_token`, struct `MockRwaToken`) — pinned by sub-project 1b
- Standard: SEP-57 / ERC-3643 (T-REX) via OpenZeppelin RWA module `0.7.2` (audited).
- Decimals: **7**. Symbol `mRWA`. Yield does NOT live here (see 1c vault).
- Constructor: `__constructor(name: String, symbol: String, admin: Address,
  manager: Address, compliance: Address, identity_verifier: Address)`
- Mint (manager-gated): `mint(to: Address, amount: i128, operator: Address)`
- SEP-41 surface (consumed by 1c/3/4): `transfer(from, to, amount: i128)`,
  `transfer_from(spender, from, to, amount: i128)`, `balance(id) -> i128`,
  `approve(from, spender, amount, expiration_ledger)`, `allowance`, `decimals`,
  `name`, `symbol`. Every state-changing call runs identity verification +
  compliance hooks + the pause guard.
- Regulatory (RWAToken): address/partial freeze, recovery — admin/manager gated.

### KYC gate (who may hold/transfer)
A wallet may hold/receive `mRWA` only if `identity_verifier.verify_identity`
passes: the wallet is in the IRS (`add_identity` with ≥1 country profile) AND has
a valid topic-1 (KYC) claim from an issuer currently trusted in CTI (the
zkPass-fed backend, ADR-B1; claims are Ed25519 scheme 101). Unverified wallets
revert. The on-chain trust anchor is the CTI trusted-issuer registry
(see `docs/soroban-kyc-seam.md`).

### CONSEQUENCE FOR 1c (vault) — load-bearing
1a pinned the vault deposit as `deposit(from: Address, amount: i128) -> i128`.
When the vault moves `mRWA` (pull from `from`, hold as vault assets), the
transfer is T-REX-gated. Therefore **the vault contract address MUST itself be a
verified identity** (registered in IRS + holding a KYC claim from a trusted
issuer) OR a compliance module must whitelist the vault as a permitted
counterparty. 1c MUST register the vault as a verified holder at deploy time, or
`deposit` reverts at the token move.

Additionally, the token MUST be bound to both the IRS and the compliance
contract via `bind_token(token, operator)` before any mint/transfer (compliance
reverts with `TokenNotBound` #363 otherwise). The 1b deploy script does this for
the demo token; 1c must do the same for any token it serves.

### Compliance vs agent caps (do not conflate)
`compliance` here governs *who may hold/transfer* (T-REX). The *agent
allocation/exposure caps* (Aladdin limits) are sub-project **1d**, a separate
guardrail. 1d may be added as a `compliance_allow`-style module (implementing the
audited `ComplianceModule` trait: `can_transfer`/`can_create`/`on_transfer`/
`on_created`/`on_destroyed`) OR enforced in the vault — that decision is 1d's,
not 1b's.

## RWA vault (`rwa_vault`, struct `RwaVault`) — pinned by sub-project 1c

> **Primitive decision (Task 0):** yield model **(b)** is LOCKED (stable $1.00 NAV +
> daily dividend). ERC-4626 / the OZ "vault module" implements model **(a)** (share-price
> growth) — the spec's explicitly-rejected option — so the position ledger is built on the
> audited OZ `fungible::Base` (per-holder balance + total supply + 7-dp metadata) with
> deposit/redeem (1:1) + a cumulative-dividend-per-share index hand-rolled on top.

- Model: **FOBXX-faithful (spec §6.1 (b), LOCKED)** — stable $1.00 NAV (shares 1:1 with
  principal) + daily dividend (new mRWA units distributed pro-rata). NOT ERC-4626
  share-growth. Position ledger built on OZ `fungible::Base`; yield on a cumulative-
  dividend-per-share index (O(1) per holder, claim-on-interaction).
- Share token: decimals **7**, symbol `vfmRWA`, **non-transferable** (no transfer/approve
  exposed — positions move only via deposit/redeem; keeps the dividend index sound).
- Constructor: `__constructor(admin: Address, token: Address, guardrail: Address, name: String, symbol: String)`
  where `token` = the 1b mRWA SEP-41 token and `guardrail` = the 1d compliance guardrail this
  vault routes every deposit/redeem through. Read via `guardrail() -> Address`.
- `deposit(from: Address, amount: i128) -> i128` (shares) — **1a-pinned** fn-symbol
  `deposit`, amount = args[1]. Pause-gated. 1:1 shares. Pulls mRWA via
  `transfer_from(spender = vault, from, to = vault, amount)` (consumes `allowance[from][vault]`).
- `redeem(from: Address, shares: i128) -> i128` (assets) — NOT pause-gated. 1:1 principal.
  Auth: `Base::burn` enforces `from.require_auth()` (do not double-auth `from`).
- `drip(amount: i128)` — admin-only mock yield source; pulls mRWA from the admin treasury
  and bumps the dividend index. Pause-gated. (Autonomous cadence = sub-project 4.)
- `claim(holder: Address) -> i128` — permissionless; pays the holder their accrued mRWA
  dividend. NOT pause-gated.
- `claimable(holder: Address) -> i128` — view.
- Reads: `admin`, `token`, `decimals`(=7), `balance(id)`, `total_shares`, `total_principal`,
  `acc_div_per_share`, `drip_epoch`.
- Events: `vault_deposit`, `vault_redeem`, `vault_drip`, `vault_claim` (force-graph monitor
  subscribes via RPC getEvents).
- Admin is stored in OZ access-control storage (`AccessControlStorageKey::Admin`), NOT a
  custom `DataKey::Admin` — a unit variant `Admin` encodes to the identical
  `Vec[Symbol("Admin")]` storage key and would collide (→ `AdminAlreadySet` #2006).

### CONSEQUENCE — vault is a verified mRWA holder (load-bearing)
The vault holds/moves mRWA, so it MUST be a KYC-verified identity (IRS + topic-1 claim
from a trusted issuer) or whitelisted by a compliance module — registered at deploy time
(deploy-seed.sh). Otherwise deposit/drip/redeem/claim revert at the token transfer. Holders
(users/agents) and the admin treasury must likewise be verified mRWA holders.

### Agent-deposit auth-tree consequence (for 2/4 — NOT solved in 1c)
1a's `__check_auth` permits a single `deposit@vault` context. The vault deliberately pulls
via `transfer_from` (vault = spender, self-authorized) so a 1a agent `from` authorizes ONLY
`deposit@vault` — no nested `transfer@token` context (which `token.transfer(from,..)` would
add and 1a would reject). The open question — who grants `allowance[*][vault]` (the agent
cannot self-`approve` under 1a; the spec's "approve once" implies the OWNER grants it, and
the beneficial holder/shares question follows) — is an auth-tree assembly decision owned by
sub-project **2 (relay)** + **4 (orchestrator)**. 1c tests use a plain verified holder as
`from` with a pre-set allowance.

### Yield vs principal vs agent caps vs T-REX (do not conflate)
- Vault **principal** (1:1 shares, stable NAV) and vault **dividend** (cumulative index)
  are vault-internal accounting only.
- The **agent allocation/exposure caps** (Aladdin limits) are sub-project **1d** — distinct.
- The **T-REX transfer compliance** (who may hold/transfer mRWA) is sub-project **1b** —
  distinct; the vault is a holder subject to it (see consequence above).

## Compliance Guardrail (`guardrail`) — pinned by sub-project 1d

Singleton Aladdin-cap enforcer over the 1a registry. Deployed addr in
`deployments/stellar-testnet.json` → `guardrail`. The 1c vault is redeployed with this
address and routes every deposit/redeem through it (deposit→`consume` before mint,
redeem→`release` after burn).

### Entrypoints
- `__constructor(admin: Address, registry: Address)` — admin = set_nav authority; registry = 1a registry addr.
- `set_nav(vault: Address, nav: i128)` — admin-auth. Per-vault NAV (7-dp; default 1e7 = $1.00). The de-peg lever.
- `set_policy(owner, agent, max_exposure: i128, max_pct_bps: u32)` — owner-auth; owner must equal the agent's registry-record owner. `max_pct_bps` ≤ 10000.
- `consume(agent, vault, amount: i128)` — VAULT-ONLY (invoker auth). Enforces spend (per-agent, from registry `cap_per_period`) + exposure (per-owner×vault `max_exposure`) + %-allocation (per-owner, NAV-valued `max_pct_bps`). Reverts out-of-policy BEFORE the mint. Called by `rwa_vault.deposit`.
- `release(agent, vault, amount: i128)` — VAULT-ONLY. Decrements accounting on redeem (no checks). Called by `rwa_vault.redeem`.
- Views: `policy_of(agent)`, `spend_of(agent)`, `total_value_of(agent)`, `position_of(agent, vault)`, `nav_of(vault)`, `admin()`, `registry()`.

### Errors
`InvalidAmount, Revoked, Expired, WrongVault, PolicyNotSet, SpendCapExceeded, ExposureCapExceeded, AllocCapExceeded, MathOverflow, NotOwner`.

### Keying + known simplification
Spend keyed by agent (per-worker rate); exposure/total-value/position keyed by owner
(cross-vault portfolio). `total_value` is a running weighted sum: `set_nav` does not
retro-revalue holders (no agent iteration) — exact under stable NAV, bounded drift on a
mid-life NAV change. The first deposit into an owner's empty portfolio (`total_value == 0`)
is exempt from the %-alloc check (a sole asset is trivially 100%); the cap binds once any
value exists. For sub-projects 2/4: an agent deposit needs the agent (a) authorized in the
1a registry scoped to the CURRENT vault address and (b) policed via `set_policy`; `consume`
is invoker-auth, so the agent's signature covers only `deposit@vault`.
