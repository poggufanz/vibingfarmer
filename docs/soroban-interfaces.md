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
