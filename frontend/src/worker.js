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
    this.memoryEntries = []
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
        reason: 'deposit-only agent — no swap on Stellar',
      })
      // Enforcement B (hardening) — internal fail-closed assertion. NOT a security boundary; the
      // on-chain scope already bounds a malicious client. Blocks accidental code-path skips of the gate.
      const t = this.eligibilityToken
      if (!t || t.eligible !== true || Date.now() - t.asOf > MAX_TOKEN_AGE_MS) {
        throw new Error('eligibility assertion failed — no valid pass token for this deposit')
      }
      await this.setupKey()
      if (!this.agentAddress)
        throw new Error(
          'agentAddress missing — orchestrator must deploy + authorize the agent first'
        )

      // Pre-submit circuit breaker. The relayer pays the fee, so gas is always "fresh" on this
      // path (no EVM gasFeeProvider) — pass a current timestamp so only the rate-anomaly guard
      // (don't spam the relay for one owner) remains meaningful.
      const gate = this.submitGate.check({ owner: this.user, gasSnapshotAt: Date.now() })
      if (!gate.ok) {
        this.memoryEntries.push(createEntry('deposit', 'skipped', { reason: gate.reason }))
        writeMemory(this.agentId, this.sessionId, this.vault, this.memoryEntries)
        this.emit('failed', {
          agentId: this.agentId,
          vault: this.vault,
          error: `submit-gate blocked: ${gate.reason}`,
          skipped: true,
        })
        return { success: false, status: 'skipped', reason: gate.reason }
      }

      // Snapshot shares BEFORE — the only honest success signal.
      const baseline = await readVaultShares(this.agentAddress)

      this.emit('step', { step: 'deposit', status: 'pending' })
      const res = await runAgentDeposit({
        agentAddress: this.agentAddress,
        amount: this.amount,
        sessionKey: this.sessionKey,
      })
      if (!res) throw new Error('relay unconfigured — cannot submit gasless deposit')
      if (res.status !== 'SUCCESS') throw new Error(`relay reported ${res.status}`)

      // A relayer accepting a job is not a deposit. Confirm shares actually minted.
      const { minted, shares: sharesMinted } = await this.verifyMinted(baseline)
      if (!minted)
        throw new Error(
          'deposit not confirmed on-chain: vault shares did not increase (likely __check_auth/cap reject)'
        )

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
      this.memoryEntries.push(
        createEntry('deposit', 'failed', {}, buildLesson(this.vault, { error: err.message }))
      )
      writeMemory(this.agentId, this.sessionId, this.vault, this.memoryEntries)
      this.emit('failed', { agentId: this.agentId, vault: this.vault, error: err.message })
      return { success: false, error: err.message }
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
    this.onEvent(eventName, { ...data, agentId: this.agentId })
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
