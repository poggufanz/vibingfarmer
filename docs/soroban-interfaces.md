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
