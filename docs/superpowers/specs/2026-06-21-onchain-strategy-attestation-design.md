# On-Chain Strategy Attestation (Soroban) — Design Spec

> **Status:** APPROVED — ready for plan. (Was DEFERRED; brainstormed + approved 2026-06-28 → next: writing-plans.)
> **Date:** 2026-06-21 · **Refreshed:** 2026-06-28 · **Branch context:** `iq` · **Numbering:** additive feature (NOT SP5; SP5 = ZK-KYC, cancelled).
> **Planning files are gitignored** (CLAUDE.md) — this spec is local-only.
>
> **Decisions locked (2026-06-28 brainstorm):**
> 1. **Gas model = user-signed inner tx + relayer fee-bump (gasless).** The earlier "user-signed vs gasless" dichotomy in §6 was false: a Stellar fee-bump pays only the *fee*, so the user remains the inner-tx signer (`attester` = user → genuine user-provenance) **and** pays 0 XLM. See rewritten §6.
> 2. **Storage = model A (event-primary):** per-attester `u32` counter only; full record lives in the emitted event. No storage bloat. See §4.
> 3. **Re-confirmed 2026-06-28:** `frontend/src/attestation.js` is still off-chain only (verified) — §1 current state stands. The Blend real-yield cutover (28 Jun) is unrelated and does not touch this path; `hashStrategy` semantics unchanged.

## 1. Why (and the honest current state)

Today (after `a55b0e9`) attestation is **off-chain only**: `frontend/src/attestation.js` `hashStrategy()` computes a deterministic sha256 over the AI strategy JSON and `attestStrategyOnChain()` returns `{ strategyHash, txHash: null }`. Anyone can reproduce the hash from the strategy JSON → tamper-**evident**, but there is **no public ledger anchor** (no tx, no timestamp, no block-explorer proof).

This spec adds the missing anchor: a tiny Soroban contract that records the strategy hash on-chain and emits an event, so "this AI produced exactly this strategy at this ledger time" is publicly, immutably verifiable. This is the real version of the "tamper-proof AI reasoning / ERC-8004-aligned" claim the UI copy gestures at.

**If never built:** nothing breaks; you keep off-chain-verifiable hashes and lose only the on-chain provenance. Building it later requires **zero rework** of the current hash path — `hashStrategy` stays the pure source of truth.

## 2. Goal / Non-goals

**Goal:** record `strategyHash` (+ minimal metadata) on Stellar testnet via a deposit-pattern-free, single-purpose attestation contract; surface the resulting tx in the UI and the Explorer event feed.

**Non-goals:**
- No ZK / privacy (that was the cancelled SP5).
- No storing the full strategy on-chain — only the 32-byte hash (cheap, privacy-safe; the JSON stays off-chain and re-derives the hash).
- No change to `hashStrategy` semantics — it remains the deterministic sha256 already shipped.
- No gating of strategy execution on attestation success — attestation stays **non-blocking** (current behavior).

## 3. Architecture

```
Venice/DeepSeek strategy  ──hashStrategy()──►  strategyHash (sha256, already shipped, unchanged)
                                                     │
                          (new) stellar/attestation.js: buildInvokeTx(attest)
                                                     │
                              user wallet signs inner tx (walletKit.signTxXdr) — attester = user
                                                     │
                              submitViaRelay → server fee-bumps (relayer = fee source, §6) → user pays 0
                                                     │
                                                     ▼
                            Soroban `attestation` contract: store + emit StrategyAttested
                                                     │
                                                     ▼
                              stellar/events.js decode → ExplorerPage feed (StrategyAttested table)
```

## 4. Contract design (`soroban/contracts/attestation/`)

Mirror the existing `soroban/contracts/agent_account` crate layout (soroban-sdk 26.1.0, `wasm32v1-none`, `lib.rs` + `types.rs` + `test.rs`). Keep it **minimal** — events are the audit trail; storage is optional.

### Storage model — pick A (recommended)
- **A (event-primary, cheap):** store only a per-attester `u32` counter (so the UI can show "N attestations") and emit the full record as an event. Soroban events are the queryable log; no per-hash storage bloat.
- **B (storage-backed):** also persist `Map<(attester, index) → AttestationRecord>` for on-chain reads. Heavier; only if you need contract-side reads beyond event indexing. Default to A.

### Interface (Rust)
```rust
// pseudo — match agent_account style; no OZ access-control needed (anyone may attest their own)
pub struct AttestationRecord {
    pub attester: Address,
    pub strategy_hash: BytesN<32>,
    pub ledger: u32,         // env.ledger().sequence()
    pub label: Symbol,       // e.g. provider name ("venice"/"deepseek"/"fallback")
}

#[contractimpl]
impl Attestation {
    // attester.require_auth(); bump counter; emit event. Returns the attester's new count.
    pub fn attest(env: Env, attester: Address, strategy_hash: BytesN<32>, label: Symbol) -> u32;

    // view: how many attestations an address has made
    pub fn count_of(env: Env, attester: Address) -> u32;
}
```
Event: `env.events().publish((symbol_short!("attested"), attester), record)` →
topic `StrategyAttested`, data `AttestationRecord`.

> **Pin-at-impl (from prior Soroban drift, memory):**
> - `env.events().publish` keeps only the **last invocation's** events when cross-contract — fine here (attest is a leaf call).
> - `require_auth()` on `attester`: caller signs (user wallet via walletKit, OR the relayer if gasless — see §6). No constructor self-approve / no vault cross-call, so the de-peg/allowance traps that bit `agent_account` do NOT apply.
> - Don't reuse `DataKey::Admin` symbol name (collided with OZ `AccessControlStorageKey::Admin`, #2006) — this contract needs no admin at all.
> - 32-byte hash: frontend currently emits `0x`+hex sha256; strip `0x` and pass as `BytesN<32>` (see §5 encoding).

## 5. Frontend (`frontend/src/stellar/attestation.js` — new, mirrors `exit.js`/`agentSetup.js`)

```js
// buildInvokeTx(attest) + user-sign + relayer fee-bump. hashStrategy stays in src/attestation.js (pure).
import { buildInvokeTx, readContract } from './client.js'
import { submitViaRelay } from './relay.js'          // gasless: relayer = fee source only
import { signTxXdr } from './walletKit.js'
import { SOROBAN_ATTESTATION_ADDRESS } from './config.js'

export async function attestOnChain({ attester, strategyHash, label }) {
  const hashBytes = hexToBytes32(strategyHash) // strip 0x, 32-byte BytesN
  const { xdr } = await buildInvokeTx({
    source: attester,                          // inner-tx source = user → require_auth(attester) via source-account auth
    contract: SOROBAN_ATTESTATION_ADDRESS,
    method: 'attest',
    args: [{ addr: attester }, { bytes32: hashBytes }, { sym: label || 'strategy' }],
  })
  const signed = await signTxXdr(xdr)          // user wallet (Freighter) signs the inner tx
  return submitViaRelay({ xdr: signed })       // server wraps in fee-bump, pays XLM → { hash, status } | null
}
export async function readAttestationCount(attester, { server } = {}) {
  try { return Number(await readContract({ contract: SOROBAN_ATTESTATION_ADDRESS, method: 'count_of', args: [{ addr: attester }], server })) }
  catch { return null }
}
```
> **Gasless wiring note:** `submitViaRelay` returns `null` when the relay is unconfigured or the POST fails — caller (`attestStrategyOnChain`) treats null as "no on-chain anchor this run" and keeps the off-chain hash. Because the inner-tx source is the user, the user's testnet account must already exist (fee-bump pays the fee, not account creation) — true for any connected wallet. The relayer's `STELLAR_RELAYER_SECRET` keypair must be funded (same key the Blend deposit relay already uses).

**Encoder note:** confirm `buildInvokeTx`'s `encodeArgs` in `client.js` supports a `{bytes32}` / `{sym}` tag; if not, add them (or pass `nativeToScVal(buf, {type:'bytes'})` / `nativeToScVal(s, {type:'symbol'})`). `scval.js` is where the codec lives.

### Wiring changes (small)
- `src/attestation.js` `attestStrategyOnChain(strategy, { attester })`: keep computing `strategyHash` (pure), then `const r = await attestOnChain(...)` and return `{ strategyHash, txHash: r.hash }`. Stay wrapped in try/catch → **non-blocking** (a failed attest must never abort strategy exec).
- `formatAttestation`: restore an explorer link → `explorerUrl = https://stellar.expert/explorer/testnet/tx/${txHash}` (replaces the removed basescan URL); label back to "Strategy attested on-chain".
- `app.jsx` attestation effect (~`attestStrategyOnChain(rawStrategy)`, near the old line 402): pass `{ attester: realAddress }`. No structural change — it already `.then(setStrategyAttestation)`.
- `agents.jsx` attestation chip: re-add the explorer link + "attested on-chain" wording (reverse of the `a55b0e9` UI de-claim).
- `components/ExplorerPage.jsx`: read `StrategyAttested` events via `stellar/events.js` for the attestations table (replaces the EVM `getReadProvider` event read — this also clears one of the SP6 `ethers` importers, bonus).

## 6. Gas model — RESOLVED: user-signed inner tx + relayer fee-bump (gasless)

The earlier draft framed this as user-signed (user pays gas) **vs** gasless-via-relayer (relayer becomes `attester`, losing user-provenance). **That dichotomy was wrong.** A Stellar fee-bump transaction wraps a fully-signed *inner* transaction and only replaces the **fee source** — it does not touch the inner tx's source account or its signatures. So:

- The **inner `attest` tx source = the user**, signed by the user's wallet (`walletKit.signTxXdr`). Because `attester` == inner-tx source, `require_auth(attester)` is satisfied by **source-account auth** — no separate `SorobanAuthorizationEntry` needed. The on-chain record genuinely attests *the user* produced this strategy.
- The **relayer is only the fee source.** `frontend/api/stellar-relay.js:121` already does `TransactionBuilder.buildFeeBumpTransaction(kp, baseFee, inner, passphrase)` where `kp` = the funded `STELLAR_RELAYER_SECRET` keypair. The user pays **0 XLM**.

**This is not new infrastructure — it is the exact rail the Blend deposit already rides.** The only difference vs deposit: the inner tx is signed by the user's Freighter wallet (provenance) instead of the ephemeral agent session key. Verified live: `relay.js` `submitViaRelay({ xdr })` + `stellar-relay.js` fee-bump path (2026-06-28).

This unifies both VF values — **user holds control** (user signature on-chain) **and** **user pays 0** (gasless) — with zero contradiction. `attest` stays non-blocking (relay null → off-chain hash fallback, §5).

> **Why no relayer-as-attester variant:** rejected. It would record "the app's relayer logged this", not "the user authored this strategy" — directly contradicting the VF thesis. We accept the requirement that the attester have a funded testnet account (any connected wallet does).

## 7. Config / deploy
- New crate `soroban/contracts/attestation/` → add to `soroban/Cargo.toml` workspace members.
- Build/deploy via WSL stellar-cli (per memory: `vf-deployer` funded identity, `--network testnet`, stellar-cli 27, `bash -lc`). Add to `deploy-seed.sh` so it doesn't orphan existing contracts.
- Record address in `deployments/stellar-testnet.json` + `frontend/src/stellar/config.js` as `SOROBAN_ATTESTATION_ADDRESS`.

## 8. Test plan
- **Contract (TDD, mirror agent_account/test.rs):** `attest` emits `StrategyAttested` with the exact hash+ledger+attester; `count_of` increments per attest; negative: missing `require_auth` (`set_auths(&[])`) rejects. Target wasm < 64KB, clippy `--all-targets` clean.
- **Frontend (vitest, offline, injected server):** `attestOnChain` builds the right invoke (source=attester, method `attest`, hash arg = 32 bytes), calls `signTxXdr` then `submitUserTx`; `readAttestationCount` decodes the u32 via a fake server (mirror `agentDeposit.test.js` `readVaultShares` shape). `hashStrategy` unchanged → existing determinism holds.
- **Live smoke (the real proof, mirror `stellar-deposit-smoke.mjs`):** attest a known hash on testnet, assert the tx `SUCCESS` and `count_of` rose; print the stellar.expert URL.
  - **Attester identity:** the smoke runs headless (no Freighter), so it uses a **funded testnet keypair as `attester`** — it signs the inner `attest` tx with that key, then submits through the same fee-bump relay (`STELLAR_RELAYER_SECRET` pays). This exercises the exact prod path (user-signed inner + relayer fee-bump); only the signer source differs (script key vs browser wallet). Reuse the existing CLI demo identity per `deploy-seed.sh` rather than minting a new one. The relayer key and the attester key must both be funded on testnet.

## 9. File manifest
```
ADD:    soroban/contracts/attestation/{Cargo.toml, src/lib.rs, src/types.rs, src/test.rs}
EDIT:   soroban/Cargo.toml                         (workspace member)
EDIT:   soroban/deploy-seed.sh                      (deploy + record address)
EDIT:   deployments/stellar-testnet.json            (SOROBAN_ATTESTATION_ADDRESS)
ADD:    frontend/src/stellar/attestation.js + .test.js
ADD:    frontend/scripts/stellar-attest-smoke.mjs   (live proof)
EDIT:   frontend/src/stellar/config.js              (export address)
EDIT:   frontend/src/stellar/client.js or scval.js  (only if {bytes32}/{sym} encoders missing)
EDIT:   frontend/src/attestation.js                 (call attestOnChain; restore txHash + explorerUrl)
EDIT:   frontend/src/agents.jsx                      (re-add on-chain chip + explorer link)
EDIT:   frontend/src/components/ExplorerPage.jsx     (read StrategyAttested via stellar/events.js)
EDIT:   frontend/src/app.jsx                         (pass attester to the attestation effect)
```

## 10. Effort / sequencing
~½–1 day. Order: contract (TDD) → deploy testnet → `stellar/attestation.js` (+test) → live smoke → frontend wiring (attestation.js/app.jsx/agents.jsx) → ExplorerPage event read. Each its own commit. The ExplorerPage event-read step **also removes a `readProvider` (ethers) importer**, so it overlaps usefully with the SP6-prep reads re-point (see `[[sp4-execution-repoint-pending]]` TODO B).

## 11. Open questions
- **RESOLVED (2026-06-28):** gas model → user-signed + relayer fee-bump (§6); storage → model A (§4). No longer open.
- Label taxonomy: free `Symbol` (provider name) vs a fixed enum. Default: provider name symbol, ≤9 chars (Soroban `symbol_short!` limit) — truncate/validate in `stellar/attestation.js`.
- Keep both off-chain hash AND on-chain attest, or on-chain only? **Keep both** (decided): off-chain hash is instant + free; on-chain is the durable anchor. They share the same `strategyHash`.
```
```
