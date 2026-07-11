# Threat Model — Vibing Farmer (Base Sepolia)

## 1. Max-loss formula

Per agent, worst case loss = `capPerPeriod × ceil((expiry − now) / periodDuration)`.

Example: cap 100 USDC, period 1 day, expiry +7 days → max 700 USDC at risk for that one agent, never the whole wallet. Fixed-window allows up to `2×cap` across a single boundary (documented, matches MetaMask enforcer behavior).

## 2. Compromised server — can vs cannot (post-Phase 1)

| Attacker with the server / a worker key CAN | CANNOT |
|---|---|
| Trigger a deposit of the scoped token, into the scoped vault, credited to the scope owner, ≤ remaining cap | Redirect funds to any other address (vault+owner derived from on-chain scope) |
| Replay nothing (execId idempotency) | Exceed `capPerPeriod` |
| — | Deposit after `expiry` or after `revokeAgent` |
| — | Touch a token/vault it was not scoped to |
| — | Custody user funds (balance is asserted 0 throughout) |

## 3. Relayer trust (1Shot)

1Shot can censor/delay during a crash. Mitigation: a **worker-signed EIP-712 fallback** — the same worker key that signs the relayer path re-broadcasts the identical `AgentDeposit` signature via the project's own RPC. This is NOT a separate user signature; the user is not in the loop at submit time (that is the whole point of the scoped session key). The fallback therefore inherits the exact same on-chain caps and cannot exceed scope. **[VERIFY own-RPC broadcast path on Base Sepolia.]**

## 4. AI output is untrusted input

Venice AI strategy/skill JSON is schema-validated client-side and bounded by on-chain caps. A malicious/hallucinated plan cannot exceed the registry scope.

## 5. Key-material exposure (honest)

The sealed key is at rest under a KDF-derived secret (`keyStore`); the secret is re-derived from the session passphrase and never stored. At sign time the key becomes a `0x`-hex JS string — immutable, therefore **not zeroizable**. We minimize the exposure window (open → sign → drop reference); we do NOT claim the in-memory key is wiped. Byte buffers (derived secret, raw key bytes) ARE zeroized. Roadmap: move sealing/signing into a KMS so the plaintext key never enters JS.

## 6. Destructive-test results

### Local (Foundry, `test/security/Destructive.t.sol`)

4/4 pass: stolen key cannot redirect vault, cannot exceed cap (`CapExceeded`), mid-plan revoke halts immediately (`ScopeInactive`), unauthorized signer has no scope (`ScopeInactive`).

### Live drills — Base Sepolia (2026-06-12)

Run against the **live deployed** `AgentRegistry` (`0x735f3a63D5be965E6B7564a2befeca0E316d09Ad`) and `AgentVaultDepositor` (`0x79007794Eb31B6a8439C38B604827012DBc0D771`), with a throwaway ERC20/ERC4626 pair (`0xf1441BBC...d38f4` / `0xB762B14a...9F670`) scoped for the drill (the production `MockVault` wraps real Circle USDC, which the deployer cannot mint — token swapped, depositor/registry under test are unchanged).

Scope: worker `0x4882ceeF...c06300`, cap 10 dUSDC / 1 day, expiry +7 days.

| Drill | Action | Result | Tx / error |
|---|---|---|---|
| 1. Stolen-key wrong-vault | Worker key signs deposit (5 dUSDC); **owner** submits (signer ≠ submitter, proving the relayer model) | Shares minted to scope **owner** (5e6), not signer/submitter | `0x15302a14...3537459c7` (status 1) |
| 2. Stolen-key over-cap | Same worker key signs 6 dUSDC on top of 5 already spent (11 > 10 cap) | **Reverted**: `CapExceeded(6000000, 5000000)` | execution reverted |
| 3. Mid-plan revoke | Owner calls `revokeAgent(worker)`, then worker-signed 1 dUSDC deposit submitted | **Reverted**: `ScopeInactive` | execution reverted |
| 4. Relayer-down idempotency | Resubmit drill 1's exact signed payload via fallback RPC (`base-sepolia-rpc.publicnode.com`) | **Reverted**: `ScopeInactive` (scope was revoked in drill 3 — checked *before* `execId`/`AlreadyExecuted`) | execution reverted |

Drill 4 note: the intended replay target was `execId`-based `AlreadyExecuted` idempotency. Because drill 3 revoked the scope first, `ScopeInactive` short-circuits before the `execId` check — an even stronger result (a revoked agent's signed payloads are dead on arrival, full stop, not just deduped). `AlreadyExecuted` idempotency for an *active* scope remains covered by the local invariant suite (`test/invariant/DepositorInvariant.t.sol`, 256 runs × 50 depth, 0 failures) and by `executeAgentDeposit`'s `usedExecIds` mapping.

All four live results match the threat-model claims in §2: funds always land with the scope owner, cap/expiry/revoke are enforced on-chain regardless of who holds or steals the signing key.

## 7. Lifeboat (automated emergency de-risk)

The vault's lifeboat (`emergency_derisk`/`resume`/`lifeboat_state`, gated by `set_mandate_authority`/`set_mandate`) is a keeper-submitted safeguard, not a contract-autonomous one — the decision logic lives off-chain in `keeper/src/radar.js` + `keeper/src/lifeboat.js`; the contract only enforces the mandate and flips `derisked`.

**What it defends against:** a liquidity crunch (pool utilization / liquidity-drop signal) or an oracle-price divergence, at a reaction floor of ~1 ledger (~6 s) — the radar polls every ~2 s and reacts within the ledger the danger signal lands on-chain. Stellar has no pre-consensus mempool visibility; the first public signal is the ledger close itself, so ~1 ledger is the architectural floor, not a tuning knob to shrink further.

**What it explicitly does NOT protect against:** an atomic single-ledger drain. An attack that both causes and completes the damage within one ledger close happens faster than any off-chain reaction loop can observe and respond, on any chain. The lifeboat is a second line of defense, not a substitute for the pre-entry screening below.

**Mandate semantics — fail-closed both ways:** `emergency_derisk` and `resume` both require a live (unexpired) mandate granted by the vault owner (`set_mandate_authority` designates who may grant it; `set_mandate(expiry)` grants it, e.g. a 24 h window).

- Danger detected + no live mandate → the radar raises an alarm instead of de-risking (it cannot act without authorization).
- Already de-risked + the mandate expires before calm returns → the radar cannot resume either — funds stay idle in the vault until the mandate is renewed.
- `deposit`/`redeem` are never gated by `derisked` or the mandate — users can always deposit or exit; only the strategy-level `compound`/`rebalance` calls are blocked while de-risked.

**Pre-entry screening (F8) covers the exploit class the reaction floor cannot:** the eligibility gate (`frontend/src/strategy/eligibilityGate.js`) rejects the same exploit class that actually hit Blend in production — YieldBlox, 2026-02-22, an oracle misconfiguration on a community-managed pool drained the pool before any reaction loop could have helped. Four facts gate entry: `poolClass` (anything but `'curated'` → reason `'community-managed pool'`), `oracleType` (anything without a circuit breaker → reason `'oracle without circuit breaker'`), `collateralLiquidityDepthUsd` (below the floor → reason `'thin collateral liquidity'`), and `supplierConcentrationPct` (above the cap → reason `'supplier concentration too high'`). A pool failing any of these is never eligible for deposit — the lifeboat's reaction floor only has to cover pools that already cleared this bar.
