// frontend/src/worker.js
// Stellar Worker Agent — executes a single scoped deposit for one vault. The worker holds an
// ephemeral ed25519 session key whose pubkey is the on-chain agent custom account's signer. It
// signs the vault.deposit auth ENTRY (not a tx); the relayer fee-bumps it. The deposit cap /
// expiry / revoke are enforced on-chain by AgentAccount.__check_auth — the worker never moves the
// user's funds outside that pre-authorized, capped scope. (Funding + authorize are done up-front
// by the orchestrator; redeem/exit is the owner's owner_withdraw call.)
import { newSessionKey } from './stellar/sessionKey.js'
import { runAgentDeposit, readVaultShares } from './stellar/agentDeposit.js'
import { writeMemory, createEntry, buildLesson } from './memory.js'
import { createSubmitGate } from './strategy/submitGate.js'
import { MAX_TOKEN_AGE_MS } from './strategy/eligibilityGate.js'

export class WorkerAgent {
  /**
   * @param {object} c
   * @param {string} c.agentId @param {string} c.user @param {string} c.vault
   * @param {bigint} c.amount base-unit (7-dp) deposit amount @param {string} c.sessionId
   * @param {function} c.onEvent
   * @param {string} [c.agentAddress] deployed agent custom-account address (the on-chain "agent")
   * @param {object} [c.sessionKey] ed25519 SessionKey (rawPublicKey + sign); generated if absent
   * @param {object} [c.submitGate]
   * @param {number} [c.verifyAttempts] share-mint poll attempts (prod default 8)
   * @param {number} [c.verifyIntervalMs] share-mint poll interval (prod default 3000)
   * @param {object} [c.activeAccount] Task 6 chunk C1 -- threaded straight through to
   *   runAgentDeposit so its indeterminate-outcome check (agentDeposit.js) has a captured
   *   account to compare against. Optional/additive: omitted, `runAgentDeposit`'s own check is a
   *   no-op, identical to every caller that existed before this chunk.
   * @param {Function} [c.getCurrentActiveAccount]
   * @param {AbortSignal} [c.signal]
   */
  constructor({
    agentId,
    user,
    vault,
    amount,
    sessionId,
    onEvent,
    agentAddress,
    sessionKey,
    submitGate,
    verifyAttempts,
    verifyIntervalMs,
    eligibilityToken,
    allocationId,
    activeAccount,
    getCurrentActiveAccount,
    signal,
  }) {
    this.agentId = agentId
    this.user = user
    this.vault = vault
    this.amount = BigInt(amount)
    this.sessionId = sessionId
    this.onEvent = onEvent || (() => {})
    this.agentAddress = agentAddress || null
    this.eligibilityToken = eligibilityToken || null
    this.sessionKey = sessionKey || null
    this.submitGate = submitGate || createSubmitGate()
    this.verifyAttempts = verifyAttempts ?? 8
    this.verifyIntervalMs = verifyIntervalMs ?? 3000
    this.activeAccount = activeAccount || null
    this.getCurrentActiveAccount = getCurrentActiveAccount
    this.signal = signal
    this.memoryEntries = []
    // Strategy Task 7 (Pocket Crew redesign) — the StrategyPlan's stable per-allocation id
    // (planModel.js), carried on every emitted event alongside `agentId` so a consumer can key
    // custody state by allocationId (flowState.js's contract) without translation. Optional and
    // additive: legacy callers that never pass it get `null`, unchanged from before this field
    // existed.
    this.allocationId = allocationId || null
  }

  /** Generate the ephemeral ed25519 session key (the on-chain agent signer). Idempotent. */
  async setupKey() {
    this.emit('step', { step: 'key-setup', status: 'pending' })
    if (!this.sessionKey) this.sessionKey = newSessionKey()
    this.memoryEntries.push(
      createEntry('key-setup', 'success', { signer: this.sessionKey.publicKey })
    )
    this.emit('step', { step: 'key-setup', status: 'done', address: this.sessionKey.publicKey })
    return this.sessionKey
  }

  async execute() {
    // Task 6 chunk C1 -- declared OUTSIDE the try block so the catch handler below can still see
    // the deposit tx's own outcome (hash/status) even when a LATER step (verifyMinted) is what
    // actually threw. Without this, "the deposit tx succeeded but shares never minted" is
    // indistinguishable from every other failure once caught -- exactly the kind of evidence loss
    // this task exists to stop (mirrors the pull/deposit hash-collapse defect in orchestrator.js,
    // one layer down).
    let depositResult = null
    try {
      this.emit('started', { agentId: this.agentId, vault: this.vault })
      // ROOT CAUSE of the "stuck at 6/9" run: the UI progress counts 3 steps per agent
      // (swap/approve/deposit — app.jsx WORKER_STEP_MAP). 'completed' marks approve+deposit, but
      // 'swap' is only ever set by a worker step event — and this deposit-only Stellar worker
      // (unlike the old EVM worker) never emitted one, so every agent topped out at 2/3 and the
      // run froze at 6/9 "waiting for relayer" forever. Emit it as SKIPPED so 3/3 is reachable.
      this.emit('step', {
        step: 'swap',
        status: 'skipped',
        reason: 'Deposit-only agent. No swap is required on Stellar.',
      })
      // Enforcement B (hardening) — internal fail-closed assertion. NOT a security boundary; the
      // on-chain scope already bounds a malicious client. Blocks accidental code-path skips of the gate.
      const t = this.eligibilityToken
      if (!t || t.eligible !== true || Date.now() - t.asOf > MAX_TOKEN_AGE_MS) {
        throw new Error(
          'Eligibility check failed. This deposit does not have a valid approval token.'
        )
      }
      await this.setupKey()
      if (!this.agentAddress)
        throw new Error(
          'Agent address is missing. The orchestrator must deploy and authorize the agent first.'
        )

      // Pre-submit circuit breaker. The relayer pays the fee, so gas is always "fresh" on this
      // path (no EVM gasFeeProvider) — pass a current timestamp so only the rate-anomaly guard
      // (don't spam the relay for one owner) remains meaningful.
      const gate = this.submitGate.check({ owner: this.user, gasSnapshotAt: Date.now() })
      if (!gate.ok) {
        const reason =
          {
            stale_gas: 'Gas data is outdated.',
            uneconomic: 'Estimated fees exceed the expected return.',
            rate_anomaly: 'Too many deposit attempts. Try again in one minute.',
          }[gate.reason] || 'The deposit was paused by a safety check.'
        this.memoryEntries.push(createEntry('deposit', 'skipped', { reason }))
        writeMemory(this.agentId, this.sessionId, this.vault, this.memoryEntries)
        this.emit('failed', {
          agentId: this.agentId,
          vault: this.vault,
          error: reason,
          skipped: true,
        })
        return { success: false, status: 'skipped', reason }
      }

      // Snapshot shares BEFORE — the only honest success signal.
      const baseline = await readVaultShares(this.agentAddress)

      this.emit('step', { step: 'deposit', status: 'pending' })
      depositResult = await runAgentDeposit({
        agentAddress: this.agentAddress,
        amount: this.amount,
        sessionKey: this.sessionKey,
        activeAccount: this.activeAccount,
        getCurrentActiveAccount: this.getCurrentActiveAccount,
        signal: this.signal,
      })
      const res = depositResult
      if (!res)
        throw new Error(
          'The Stellar relay is unavailable. The gasless deposit could not be submitted.'
        )
      if (res.status !== 'SUCCESS') throw new Error(`The Stellar relay returned ${res.status}.`)

      // Strategy Task 13 (Pocket Crew redesign, decision log #22 obligation B): the funding_router
      // pull and the vault deposit are ONE atomic Soroban invocation here (the deposit's signed
      // auth entry authorizes a sub-invocation that pulls from the owner's allowance) -- there is
      // no separate off-chain "pull" call to hang an event on. The relayer reporting SUCCESS is
      // exactly the moment that atomic tx landed on-chain, which is real, non-speculative evidence
      // the pull sub-invocation executed (Soroban auth trees are all-or-nothing: shares could not
      // mint below without it). Emitted BEFORE verifyMinted below on purpose -- share-mint
      // confirmation is a slower, separate poll that answers "did the DEPOSIT really work," not
      // "did funds leave the owner," and PULL_CONFIRMED only ever claims the latter. This is the
      // real producer flowState.js's PULL_CONFIRMED event needed (previously zero producers
      // existed in the tree for it, so a receipt could never legitimately complete a pull leg).
      this.emit('pull-confirmed', {})

      // A relayer accepting a job is not a deposit. Confirm shares actually minted.
      const { minted, shares: sharesMinted } = await this.verifyMinted(baseline)
      if (!minted)
        throw new Error('The deposit was not confirmed because vault shares did not increase.')

      // Real minted-shares delta (cur - baseline), not the deposited amount. LOAD-BEARING since
      // the cutover: the deposit target is the exchange-rate autofarm vault
      // (SOROBAN_ACTIVE_VAULT_ADDRESS, price_per_share != 1:1 after compounding), so shares
      // received legitimately differ from assets deposited. Fall back to the requested
      // amount only when the baseline read itself failed (verifyMinted couldn't measure a delta).
      const lesson = buildLesson(this.vault, {
        shares: (sharesMinted ?? this.amount).toString(),
      })
      this.memoryEntries.push(
        createEntry('deposit', 'success', { txHash: res.hash, gasMethod: 'relayer' }, lesson)
      )
      writeMemory(this.agentId, this.sessionId, this.vault, this.memoryEntries)
      this.emit('completed', {
        agentId: this.agentId,
        vault: this.vault,
        txHash: res.hash,
        gasMethod: 'relayer',
        relayer: res.relayer || null,
      })
      return { success: true, txHash: res.hash }
    } catch (err) {
      // Task 6 chunk C1 -- three distinguishable outcomes, never collapsed into one:
      //  - indeterminate (active account changed mid-submission, agentDeposit.js's new path):
      //    never success, never a plain failure -- status:'unknown', custody carried through
      //    verbatim from the error so the caller can hold custody at its last proven location.
      //  - a tx that itself SUCCEEDED but the confirming event (shares minting) never showed up:
      //    a real failure, but one whose txHash/txSuccess must survive so the caller can prove
      //    custody correctly stops short of stellar-vault rather than silently having no evidence
      //    to reason about at all.
      //  - every other failure: unchanged from before this chunk.
      const isUnknown = err?.code === 'VF_SUBMISSION_UNKNOWN'
      const txHash = depositResult?.hash ?? err?.result?.hash ?? null
      const txSuccess = depositResult?.status === 'SUCCESS'
      this.memoryEntries.push(
        createEntry(
          'deposit',
          isUnknown ? 'unknown' : 'failed',
          {},
          buildLesson(this.vault, { error: err.message })
        )
      )
      writeMemory(this.agentId, this.sessionId, this.vault, this.memoryEntries)
      this.emit('failed', { agentId: this.agentId, vault: this.vault, error: err.message })
      return {
        success: false,
        error: err.message,
        ...(txHash ? { txHash } : {}),
        ...(txSuccess ? { txSuccess: true } : {}),
        ...(isUnknown ? { status: 'unknown', custody: err.custody } : {}),
      }
    }
  }

  /**
   * Poll vault shares until they exceed the pre-deposit baseline.
   * @param {bigint|null} baseline pre-deposit share balance
   * @returns {Promise<{minted: boolean, shares: bigint|null}>} `shares` is the REAL minted
   *   delta (cur - baseline) — the vault is exchange-rate priced, so this can differ from the
   *   deposited amount. null baseline → can't verify → minted true, shares null (caller falls
   *   back to the requested amount, the only honest guess available).
   */
  async verifyMinted(baseline) {
    if (baseline == null) return { minted: true, shares: null }
    const attempts = this.verifyAttempts
    for (let i = 0; i < attempts; i++) {
      const cur = await readVaultShares(this.agentAddress)
      if (cur != null && cur > baseline) return { minted: true, shares: cur - baseline }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, this.verifyIntervalMs))
    }
    return { minted: false, shares: null }
  }

  emit(eventName, data) {
    this.onEvent(eventName, { ...data, agentId: this.agentId, allocationId: this.allocationId })
  }
}

/** bytes32-style agentId from index + session (UI/graph identity). Unchanged from the EVM worker. */
export function makeAgentId(index, sessionId) {
  const raw = `agent-${index}-${sessionId}`
  const bytes = new TextEncoder().encode(raw)
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return '0x' + hex.slice(0, 64).padEnd(64, '0')
}

/** Deterministic numeric planId from a sessionId (stable across retries). Pure JS — no ethers. */
export function makePlanId(sessionId) {
  let h = 0
  const s = String(sessionId)
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return BigInt(h)
}
