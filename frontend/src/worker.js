import { ethers } from 'ethers'
import {
  relayRedeem,
  relayDepositHeld,
  computeExecId,
  DEPOSIT_DOMAIN,
  HELD_DEPOSIT_TYPES,
} from './relay.js'
import { authorizeSessionKeyOnChain } from './wallet.js'
import { writeMemory, createEntry, buildLesson } from './memory.js'
import {
  generateWorkerKey,
  newSalt,
  deriveSecret,
  sealKey,
  openKey,
  zeroize,
} from './strategy/keyVault.js'
import { createKeyStore } from './strategy/keyStore.js'
import { createGasSnapshotProvider } from './strategy/gasFeeProvider.js'
import { createSubmitGate } from './strategy/submitGate.js'
import { getReadProvider } from './readProvider.js'
import { SEPOLIA_CHAIN_ID, AGENT_VAULT_DEPOSITOR_ADDRESS, USDC_SEPOLIA } from './config.js'

// Rough upper bound for executeAgentDeposit gas cost; refined once real estimateGas is wired.
const EST_DEPOSIT_GAS = 150_000n

/**
 * Worker Agent — executes a single scoped deposit for one vault.
 *
 * Roadmap v2 model: the worker holds an ephemeral KEY (the on-chain "agent"). It signs an
 * EIP-712 AgentDeposit; the depositor recovers the signer and reads its scope from
 * AgentRegistry. The scope itself is granted up-front (user-signed authorizeSessionKey,
 * batched by the orchestrator) — the worker NEVER moves the user's funds without that
 * pre-authorized, capped, expiring scope.
 */
export class WorkerAgent {
  /**
   * @param {object} config
   * @param {string} config.user - scope owner (the user) address
   * @param {string} config.vault - vault address
   * @param {bigint} config.amount - deposit amount (uint256 units)
   * @param {string} config.sessionId
   * @param {function} config.onEvent
   * @param {number} config.planId - numeric plan id (execId determinism)
   * @param {number} config.step - this worker's step index (execId uniqueness)
   * @param {bigint} [config.minAmount] - received-delta floor (defaults to amount: USDC→USDC, no fee)
   * @param {boolean} [config.scopeAuthorized] - true when the orchestrator already batched authorizeSessionKey
   * @param {bigint} [config.capPerPeriod] - uint96 cap for the self-authorize fallback
   * @param {number} [config.periodDuration] - uint32 seconds for the self-authorize fallback
   * @param {number} [config.expiry] - uint40 expiry for the self-authorize fallback
   * @param {string} [config.agentAddress] - pre-generated worker key address (skip key gen)
   * @param {string} [config.sessionPassphrase] - seals the ephemeral key at rest (keyVault)
   * @param {bigint} [config.expectedBenefitWei] - per-step yield estimate for the economic gate
   * @param {object} [config.keyStore] @param {object} [config.submitGate] @param {object} [config.gasSnapshot]
   */
  constructor({
    agentId,
    user,
    vault,
    amount,
    sessionId,
    onEvent,
    planId,
    step,
    minAmount,
    minShares,
    scopeAuthorized,
    capPerPeriod,
    periodDuration,
    expiry,
    agentAddress,
    sessionPassphrase,
    expectedBenefitWei,
    keyStore,
    submitGate,
    gasSnapshot,
    permissionContext,
    delegationManager,
  }) {
    this.agentId = agentId
    this.user = user
    this.vault = vault
    this.amount = BigInt(amount)
    // ERC-7715 grant (one AP shared by all workers). The worker redeems its slice into the
    // depositor, then deposits the now-held USDC. delegationManager is kept for the self-gas
    // session fallback; the managed relay path uses only permissionContext.
    this.permissionContext = permissionContext || null
    this.delegationManager = delegationManager || null
    this.minAmount = minAmount != null ? BigInt(minAmount) : BigInt(amount)
    // minShares: floor on ERC-4626 shares minted to the owner (adversarial-vault guard).
    // Defaults to 0 (opt out) — MockVault is 1:1 so no client-side preview is needed yet.
    this.minShares = minShares != null ? BigInt(minShares) : 0n
    this.sessionId = sessionId
    this.onEvent = onEvent || (() => {})
    this.planId = planId ?? 0
    this.step = step ?? 0
    this.scopeAuthorized = scopeAuthorized || false
    this.capPerPeriod = capPerPeriod != null ? BigInt(capPerPeriod) : this.amount
    this.periodDuration = periodDuration ?? 86400
    this.expiry = expiry ?? Math.floor(Date.now() / 1000) + 3600
    this.memoryEntries = []

    // Ops-security wiring: per-worker ephemeral key + pre-submit circuit breaker.
    this.sessionPassphrase = sessionPassphrase || null
    this.expectedBenefitWei = expectedBenefitWei ?? null
    this.keyStore = keyStore || createKeyStore()
    this.submitGate = submitGate || createSubmitGate()
    this.gasSnapshot = gasSnapshot || createGasSnapshotProvider({ provider: getReadProvider() })
    this.keyAddress = agentAddress || null
    this._ephemeralKey = null // in-memory pk when no passphrase store is configured
  }

  /**
   * Full agent flow. Key is generated at plan time (setupKey), opened only at the sign site.
   * @returns {Promise<{success: boolean, txHash?: string, error?: string, status?: string, step?: string, reason?: string}>}
   */
  async execute() {
    try {
      this.emit('started', { agentId: this.agentId, vault: this.vault })

      // Step 0: per-worker ephemeral key — generated + (optionally) sealed at plan time.
      await this.setupKey()

      // Step 1: ensure the worker key is scoped on-chain. Normally the orchestrator
      // batched authorizeSessionKey into ONE user popup; if not, fall back to a single
      // user-signed authorize for this key.
      if (!this.scopeAuthorized) {
        this.emit('step', { agentId: this.agentId, step: 'authorize-scope', status: 'pending' })
        const txHash = await authorizeSessionKeyOnChain(
          this.keyAddress,
          this.vault,
          USDC_SEPOLIA,
          this.capPerPeriod,
          this.periodDuration,
          this.expiry
        )
        this.memoryEntries.push(
          createEntry('authorize', 'success', { txHash, agent: this.keyAddress })
        )
        this.emit('step', {
          agentId: this.agentId,
          step: 'authorize-scope',
          status: 'done',
          txHash,
        })
      }

      // Step 2: Swap — USDC→USDC MockVault has no token conversion. Honestly skipped.
      this.emit('step', { agentId: this.agentId, step: 'swap', status: 'pending' })
      this.memoryEntries.push(
        createEntry('swap', 'skipped', { reason: 'USDC→USDC: no swap required' })
      )
      this.emit('step', {
        agentId: this.agentId,
        step: 'swap',
        status: 'skipped',
        reason: 'USDC→USDC: no swap required',
      })

      // Step 3.5: Pre-submit circuit breaker — gas freshness + economic + rate-anomaly gate.
      const gateResult = await this.checkSubmitGate()
      if (!gateResult.ok) {
        this.memoryEntries.push(createEntry('deposit', 'skipped', { reason: gateResult.reason }))
        this.emit('step', {
          agentId: this.agentId,
          step: 'deposit',
          status: 'skipped',
          reason: gateResult.reason,
        })
        writeMemory(this.agentId, this.sessionId, this.vault, this.memoryEntries)
        this.emit('failed', {
          agentId: this.agentId,
          vault: this.vault,
          error: `submit-gate blocked deposit: ${gateResult.reason} (safe to retry)`,
          skipped: true,
          reason: gateResult.reason,
        })
        return { success: false, status: 'skipped', step: 'deposit', reason: gateResult.reason }
      }

      // Step 4: fund + deposit. (a) Redeem this worker's slice of the ONE ERC-7715 AP — the
      // 1Shot server wallet (= the grant grantee) broadcasts USDC.transfer → depositor, capped
      // by the on-chain period enforcer; user pays 0 gas. (b) Sign AgentHeldDeposit + relay
      // depositHeld, which deposits the now-held USDC under the AgentRegistry scope.
      const execId = computeExecId({
        owner: this.user,
        vault: this.vault,
        planId: this.planId,
        step: this.step,
      })

      this.emit('step', { agentId: this.agentId, step: 'redeem-permission', status: 'pending' })
      if (!this.permissionContext)
        throw new Error('missing ERC-7715 permission context — cannot fund deposit')
      const redeem = await relayRedeem({
        permissionContext: this.permissionContext,
        recipient: AGENT_VAULT_DEPOSITOR_ADDRESS,
        amount: this.amount,
      })
      if (!redeem) throw new Error('ERC-7715 redeem failed (1Shot relay) — cannot fund deposit')
      this.memoryEntries.push(
        createEntry('redeem-permission', 'success', {
          txHash: redeem.txHash,
          amount: this.amount.toString(),
        })
      )
      this.emit('step', {
        agentId: this.agentId,
        step: 'redeem-permission',
        status: 'done',
        txHash: redeem.txHash,
      })

      this.emit('step', { agentId: this.agentId, step: 'sign', status: 'pending' })
      const sig = await this.signAtSubmitSite(execId)
      this.memoryEntries.push(createEntry('sign', 'done', { execId }))
      this.emit('step', { agentId: this.agentId, step: 'sign', status: 'done', execId })

      this.emit('step', { agentId: this.agentId, step: 'deposit', status: 'pending' })
      // Snapshot the user's vault shares BEFORE submitting — the only honest success signal.
      const baselineShares = await this.readShares()
      const depositResult = await relayDepositHeld({
        amount: this.amount,
        minAmount: this.minAmount,
        minShares: this.minShares,
        execId,
        sig,
      })
      if (!depositResult)
        throw new Error('depositHeld relay failed — funds redeemed but not deposited')
      const gasMethod = 'relayer'

      // A relayer that ACCEPTS a job is not a deposit. depositHeld can still revert (e.g. the
      // redeem under-funded the contract). Confirm the vault actually minted shares before
      // declaring success, otherwise the UI seeds a phantom position the chain never holds.
      const minted = await this.verifyDepositMined(baselineShares)
      if (!minted) {
        throw new Error(
          'deposit not confirmed on-chain: vault shares did not increase (tx likely reverted)'
        )
      }

      const lesson = buildLesson(this.vault, { shares: this.amount.toString() })
      this.memoryEntries.push(
        createEntry('deposit', 'success', { txHash: depositResult.txHash, gasMethod }, lesson)
      )
      this.emit('step', {
        agentId: this.agentId,
        step: 'deposit',
        status: 'done',
        txHash: depositResult.txHash,
        gasMethod,
        relayer: depositResult.relayer || null,
      })

      writeMemory(this.agentId, this.sessionId, this.vault, this.memoryEntries)
      this.emit('completed', {
        agentId: this.agentId,
        vault: this.vault,
        txHash: depositResult.txHash,
        gasMethod,
        relayer: depositResult.relayer || null,
      })

      return { success: true, txHash: depositResult.txHash }
    } catch (err) {
      const lesson = buildLesson(this.vault, { error: err.message })
      this.memoryEntries.push(createEntry('deposit', 'failed', {}, lesson))
      writeMemory(this.agentId, this.sessionId, this.vault, this.memoryEntries)
      this.emit('failed', { agentId: this.agentId, vault: this.vault, error: err.message })
      return { success: false, error: err.message }
    }
  }

  /**
   * Generate the ephemeral worker key (the on-chain agent identity). With a session
   * passphrase the key is sealed at rest (keyVault + keyStore) and re-opened only at the
   * sign site; without one it stays in memory for this page-load only (same ephemeral
   * rationale as the ERC-7710 session key). Idempotent if agentAddress was pre-supplied.
   */
  async setupKey() {
    this.emit('step', { agentId: this.agentId, step: 'key-setup', status: 'pending' })
    if (this.keyAddress && (this._ephemeralKey || this.sessionPassphrase)) {
      this.emit('step', {
        agentId: this.agentId,
        step: 'key-setup',
        status: 'done',
        address: this.keyAddress,
      })
      return this.keyAddress
    }

    const { privateKey, address } = await generateWorkerKey()
    this.keyAddress = address

    if (this.sessionPassphrase) {
      const salt = await newSalt()
      const secret = await deriveSecret(this.sessionPassphrase, salt)
      const sealed = await sealKey(privateKey, secret)
      await this.keyStore.put(address, { sealed, salt })
      zeroize(secret)
    } else {
      // No passphrase → no at-rest store. Hold the key in memory for this session only.
      this._ephemeralKey = privateKey
    }

    this.memoryEntries.push(createEntry('key-setup', 'success', { address }))
    this.emit('step', { agentId: this.agentId, step: 'key-setup', status: 'done', address })
    return address
  }

  /**
   * Refresh the gas snapshot and run the pre-submit circuit breaker.
   * @returns {Promise<{ok: boolean, reason: string}>}
   */
  async checkSubmitGate() {
    this.emit('step', { agentId: this.agentId, step: 'submit-gate', status: 'pending' })
    const snap = await this.gasSnapshot.refresh()
    const result = this.submitGate.check({
      owner: this.user,
      gasSnapshotAt: snap?.at ?? null,
      estGasCostWei: snap?.maxFeePerGas != null ? snap.maxFeePerGas * EST_DEPOSIT_GAS : null,
      expectedBenefitWei: this.expectedBenefitWei,
    })
    this.emit('step', {
      agentId: this.agentId,
      step: 'submit-gate',
      status: result.ok ? 'done' : 'skipped',
      reason: result.reason,
    })
    return result
  }

  /**
   * Open the sealed (or in-memory) ephemeral key, sign the EIP-712 AgentDeposit digest, and
   * drop the key reference. The signature — not msg.sender — is the on-chain authorization.
   * @param {string} execId
   * @returns {Promise<string>} 0x signature
   */
  async signAtSubmitSite(execId) {
    let pk = this._ephemeralKey
    if (!pk && this.sessionPassphrase) {
      const { sealed, salt } = await this.keyStore.get(this.keyAddress)
      const secret = await deriveSecret(this.sessionPassphrase, salt)
      pk = await openKey(sealed, secret)
      zeroize(secret)
    }
    if (!pk) throw new Error('worker key unavailable — setupKey did not run')

    const wallet = new ethers.Wallet(pk)
    // ethers v6 signTypedData(domain, types, value) — types must NOT include EIP712Domain.
    // AgentHeldDeposit (depositHeld) — distinct struct from AgentDeposit so the signature is
    // non-interchangeable with the legacy transferFrom path.
    const sig = await wallet.signTypedData(
      DEPOSIT_DOMAIN(SEPOLIA_CHAIN_ID, AGENT_VAULT_DEPOSITOR_ADDRESS),
      HELD_DEPOSIT_TYPES,
      { amount: this.amount, minAmount: this.minAmount, minShares: this.minShares, execId }
    )
    pk = null // immutable hex string — drop the reference immediately
    return sig
  }

  /** Read the user's current ERC-4626 share balance in this worker's vault, or null on RPC failure. */
  async readShares() {
    try {
      const c = new ethers.Contract(
        this.vault,
        ['function balanceOf(address) view returns (uint256)'],
        getReadProvider()
      )
      return await c.balanceOf(this.user)
    } catch {
      return null
    }
  }

  /**
   * Poll the vault until the user's shares exceed the pre-deposit baseline — proof the deposit
   * actually minted. Returns false if no increase appears within the window (revert/failed relay).
   * Degrades to true only when the baseline could not be read (RPC down), to avoid false negatives.
   * @param {bigint|null} baseline shares before the deposit
   */
  async verifyDepositMined(baseline, { attempts = 8, intervalMs = 3000 } = {}) {
    if (baseline == null) return true // couldn't snapshot → can't verify; don't falsely fail
    for (let i = 0; i < attempts; i++) {
      const cur = await this.readShares()
      if (cur != null && cur > baseline) return true
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, intervalMs))
    }
    return false
  }

  emit(eventName, data) {
    this.onEvent(eventName, { ...data, agentId: this.agentId })
  }
}

/**
 * Generate a deterministic bytes32 agentId from index + session (UI/graph identity).
 * @param {number} index @param {string} sessionId
 * @returns {string} 0x... bytes32 hex
 */
export function makeAgentId(index, sessionId) {
  const raw = `agent-${index}-${sessionId}`
  const bytes = new TextEncoder().encode(raw)
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return '0x' + hex.slice(0, 64).padEnd(64, '0')
}

/** Deterministic numeric planId from a sessionId — stable across retries for execId. */
export function makePlanId(sessionId) {
  const h = ethers.id(String(sessionId))
  return BigInt(h) % 1_000_000_007n
}
