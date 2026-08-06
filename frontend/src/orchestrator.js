import { WorkerAgent, makeAgentId } from './worker.js'
import { generateAgentSkills } from './strategist.js'
import { saveSkill } from './skills.js'
import { deployAgentForSession, fundAgent, registryAuthorizeAgent } from './stellar/agentSetup.js'
import {
  submitGrant,
  runAgentPull,
  readAllowance,
  AGENT_KIND_DEPOSIT,
  AGENT_KIND_BRIDGE,
} from './stellar/grant.js'
import { saveCachedAgent, takeReusableAgent } from './stellar/agentCache.js'
import { newSessionKey } from './stellar/sessionKey.js'
import { readTokenBalance, readVaultShares, runAgentDeposit } from './stellar/agentDeposit.js'
import {
  STELLAR_USDC_SAC,
  STELLAR_TOKEN_MESSENGER_MINTER,
  CCTP_BASE_DOMAIN,
  ZERO32,
  evmAddrToBytes32,
} from './stellar/cctpBurn.js'
import { deriveCctpTransferUnits, toBaseUnits } from './stellar/format.js'
import { readBaseMandate } from './wallet/baseBinding.js'
import {
  SOROBAN_TOKEN_ADDRESS,
  SOROBAN_DECIMALS,
  SOROBAN_ACTIVE_VAULT_ADDRESS,
  USE_FUNDING_ROUTER,
} from './stellar/config.js'
import { isLegacyDirectSetupAllowed } from './stellar/agentCreatorManifest.js'
import { PermissionPhaseError } from './strategy/permissionError.js'
import { buildDispatchReceipt } from './strategy/dispatchSummary.js'
import {
  activeAccountSubmissionUnknown,
  assertActiveAccountBoundary,
  assertActiveOwner,
} from './stellar/activeAccount.js'
import { getActiveAccount } from './stellar/walletKit.js'
// Task 6 chunk C1 -- the real AllocationReceiptV2 evidence producer (Chunk A) and its authenticated
// transport (Chunk B), both closed/reviewed. Neither import pulls in `./stellar/config.js` or
// `./stellar/agentCache.js` (allocationReceipt.js has NO imports at all; agentIndexReceiptClient.js
// only reaches `@stellar/stellar-sdk` + the `buffer` polyfill) -- safe against the small mocked
// export sets orchestrator.baseleg.test.js gives those two modules (this file's own note above).
import {
  createAllocationReceipt,
  appendPhase,
  confirmCustody,
} from './strategy/allocationReceipt.js'
import { postReceiptEvidence } from './stellar/agentIndexReceiptClient.js'
import { selectRecoveryAction } from '../api/agent-index/recovery.js'
// NOTE (Strategy Task 7): every OTHER new dependency this file needed for the permission-locked
// path (`./strategy/reusePreflight.js`, `./stellar/grantReceiptStore.js`, and `readConfirmedLedger`
// from `./stellar/grant.js`, plus `loadCachedAgents`/`SOROBAN_FUNDING_ROUTER_ADDRESS`) is imported
// DYNAMICALLY, inside the methods that actually use it — never at module top-level. Several
// pre-existing test files (orchestrator.baseleg.test.js, kept byte-for-byte per the worktree
// guard) mock `./stellar/agentCache.js` and `./stellar/config.js` with only the small export set
// the LEGACY path needs; a static top-level import here would pull reusePreflight.js's own
// transitive imports (agentCache's `EXPIRY_MARGIN_SECONDS`/`inspectReusableAgents`,
// grantReceiptStore's `NETWORK_PASSPHRASE`, …) into every test's module graph and break those
// mocks even though the legacy path never calls any of this code. Mirrors the file's existing
// `import('./baseLeg.js').then(...)` isolation pattern below.

// Scope window for a dispatch: agents may deposit up to their allocation, within the period.
const PERIOD_DURATION = 86400
const SCOPE_TTL_SECONDS = 3600
const BASE_UNIT = 10 ** SOROBAN_DECIMALS // 1 VFUSD = 10_000_000 (7-dp)
// Gap between serial worker dispatches — keeps the relay off its per-IP rate limit.
const DISPATCH_INTERVAL_MS = 2000
// Task 6 chunk C1 -- the only network the Stellar dispatch loops below ever run against. Mirrors
// planModel.js's own STELLAR_NETWORK_ID and executionReceipts.js's SUPPORTED_NETWORKS literal
// (the server accepts no other value) -- not invented here, just the same constant every other
// Stellar-side producer in this repo already hardcodes.
const RECEIPT_NETWORK_ID = 'stellar-testnet'

/** hex string (0x-prefixed or not) -> 32-byte Uint8Array, for a reviewed AgentInit's
 * `mintRecipient` (reusePreflight.js stores it hex-encoded via `bytesToHex`). */
function hexToBytes32(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(32)
  for (let i = 0; i < 32 && i * 2 < clean.length; i++)
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16)
  return bytes
}

/**
 * Bigint-safe per-vault unit split for the legacy `{vaults:[{allocation}]}` shape (review round 2
 * fix — `orchestrator.js`'s previous `BigInt(Math.floor(totalAmount * v.allocation * BASE_UNIT))`
 * let float multiplication corrupt the final on-chain unit value directly). Each ratio is scaled
 * to an integer numerator (parts per 1e10 — ample precision for a JS float ratio) BEFORE any
 * bigint arithmetic touches the total. `localTotalUnits` is what THIS array's own ratios
 * collectively represent (1 for a pure-Stellar run, less than 1 for the Stellar-only slice of a
 * mixed run) — shares floor-divide against it, and any rounding remainder goes to the earliest
 * indices one unit at a time, mirroring planModel.js's `splitEven` remainder rule so no unit of
 * the user's money is silently dropped to truncation.
 */
function splitUnitsByRatio(totalUnits, ratios) {
  const SCALE = 10_000_000_000n
  const scale = (r) => BigInt(Math.round(r * 1e10))
  const localTotalUnits = (totalUnits * scale(ratios.reduce((a, b) => a + b, 0))) / SCALE
  const shares = ratios.map((r) => (totalUnits * scale(r)) / SCALE)
  const remainder = localTotalUnits - shares.reduce((a, b) => a + b, 0n)
  return shares.map((s, i) => (remainder > 0n && BigInt(i) < remainder ? s + 1n : s))
}

/**
 * Task 6 chunk C1 -- per-allocation `AllocationReceiptV2` evidence, shared by
 * `dispatchPermissioned`'s plain worker loop and `dispatchConfirmedMixed`'s Stellar leg (the two
 * loops this chunk's brief scopes to; the Base leg keeps its own, separate custody handling via
 * `bindBaseLegCustodyDeps` above, untouched). Builds the receipt in-memory with allocationReceipt.js's
 * pure producer and durably posts each mutation via agentIndexReceiptClient.js's
 * `postReceiptEvidence`.
 *
 * A pre-movement intent write is write-ahead: an unverified failure throws and the immediately
 * following pull/deposit never starts. Ambiguous writes are re-read and retried once with the same
 * attempt identity; a lost response may proceed only when the authoritative row proves that exact
 * attempt committed. `.custody(evidence)` remains separate so custody is still decided only from
 * the pull/deposit's OWN on-chain evidence (`txSuccess`/`matchingEvent`), never from transport
 * acceptance. `sessionKey` is passed straight to
 * `postReceiptEvidence` as the signer (it only ever calls `.sign()` on it, per Chunk B's own
 * contract) -- never spread into the `evidence`/`intent` bodies this function builds, so a session
 * secret can never reach the wire through this path.
 *
 * Review round 1, Important 3 -- two SEPARATE id spaces, both real, neither invented here:
 *   - This receipt's `executionId` (`${runId}:exec:${allocationId}`) is a free-form TEXT primary
 *     key for the agent-index (`migrations/0005_execution_receipts.sql:5,42`) -- what Task 7's
 *     `requestRecovery({executionId,...})` keys on. Deterministic, no nonce/salt/counter, so a
 *     resend within one dispatch call stays safe.
 *   - The V3 router's OWN replay-guard id is a DIFFERENT thing: `permissionGrantV3.js`'s
 *     `makeAllocationExecution({runId,allocationId,scopeId,amountUnits})` mints a deterministic
 *     bytes32 hash that `pull_v3` itself records on-chain (only on success), passed to
 *     `buildAgentPullV3` as `{bytes32}` (`grant.js:401`). When a worker's pull runs through V3
 *     (`v3Exec` non-null in the loops below), that id is threaded into the pull attempt's evidence
 *     as `v3ExecutionId` so a V3 recovery can resend the IDENTICAL still-valid envelope rather than
 *     rebuilding one (the router replay-guard id is otherwise unrecoverable from the receipt).
 * @param {{runId:string, allocationId:string, owner:string, agentAddress:string, sessionKey:object,
 *   worker:string, amount:{token:string,units:string,decimals:number}, onEvent?:Function,
 *   beforePost?:Function, abortRecoveryConflict?:boolean}} p
 */
function createEvidenceRecorder({
  runId,
  allocationId,
  owner,
  agentAddress,
  sessionKey,
  worker,
  amount,
  onEvent,
  persistedReceipt = null,
  persistedVersion = 0,
  beforePost = null,
  abortRecoveryConflict = false,
}) {
  let receipt = createAllocationReceipt({
    networkId: RECEIPT_NETWORK_ID,
    // Deterministic per (run, allocation) -- this dispatch path never retries an allocation
    // within one call, so this is genuinely the allocation's one execution attempt for this run,
    // consistent with allocationId's own `${runId}:kind:key` convention (planModel.js). This is
    // the agent-index's own id space -- see this function's own doc comment above for why it is
    // deliberately NOT the V3 router's replay-guard id (`makeAllocationExecution`).
    executionId: `${runId}:exec:${allocationId}`,
    allocationId,
    owner,
    runId,
    worker,
    agent: agentAddress,
    intent: { allocationId, kind: 'deposit', allocation: amount },
    amount,
  })
  // Non-negative safe integer, per applyAuthenticatedReceiptMutation's own validation
  // (executionReceipts.js:212-218); 0 is the required value for the first (INSERT) write
  // (store.js:505-506's versionConflict check), incremented to whatever the server actually
  // committed after every accepted write.
  let expectedVersion = 0
  let durableReceipt = null
  let durable = true

  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical(value[key])])
      )
    }
    return value
  }

  const sameAttempt = (persisted, attempt) =>
    persisted?.attemptId === attempt.attemptId &&
    persisted.kind === attempt.kind &&
    persisted.phase === attempt.phase &&
    persisted.status === attempt.status &&
    persisted.observedAt === attempt.observedAt &&
    JSON.stringify(canonical(persisted.evidence)) === JSON.stringify(canonical(attempt.evidence))

  const writableReceipt = (persisted) => {
    if (persisted?.format !== 2 || !Number.isSafeInteger(persisted.version)) {
      throw new Error('Authoritative receipt has an invalid row/format version')
    }
    const writable = { ...persisted, version: persisted.format }
    delete writable.format
    delete writable.intentDigest
    delete writable.createdAt
    delete writable.updatedAt
    return writable
  }

  if (persistedReceipt) {
    if (
      !Number.isSafeInteger(persistedVersion) ||
      persistedVersion <= 0 ||
      persistedReceipt.version !== persistedVersion
    ) {
      throw new Error('Authoritative recovery receipt/version does not match')
    }
    const adopted = writableReceipt(persistedReceipt)
    const expectedIdentity = {
      networkId: RECEIPT_NETWORK_ID,
      executionId: `${runId}:exec:${allocationId}`,
      allocationId,
      owner,
      runId,
      worker,
      agent: agentAddress,
    }
    for (const [field, value] of Object.entries(expectedIdentity)) {
      if (adopted[field] !== value) {
        throw new Error(`Authoritative recovery receipt changed immutable field ${field}`)
      }
    }
    receipt = adopted
    durableReceipt = adopted
    expectedVersion = persistedVersion
  } else if (persistedVersion !== 0) {
    throw new Error('An absent recovery receipt must have row version 0')
  }

  const rebaseAttempt = (persisted, local, attempt) => {
    const authoritative = writableReceipt(persisted)
    for (const field of [
      'networkId',
      'executionId',
      'allocationId',
      'owner',
      'runId',
      'parentAllocationId',
      'childId',
      'worker',
      'agent',
      'intent',
    ]) {
      if (
        JSON.stringify(canonical(authoritative[field])) !== JSON.stringify(canonical(local[field]))
      ) {
        throw new Error(`Authoritative receipt changed immutable field ${field}`)
      }
    }
    if (authoritative.attempts.some((entry) => entry.attemptId === attempt.attemptId)) {
      throw new Error('Authoritative receipt has a conflicting attempt identity')
    }

    const custodyOrder = [
      'owner',
      'stellar-agent',
      'stellar-vault',
      'cctp-transit',
      'base-kernel',
      'base-vault',
    ]
    const rank = (custody) =>
      custody?.confirmed === true ? custodyOrder.indexOf(custody.location) : -1
    const authoritativeRank = rank(authoritative.custody)
    const localRank = rank(local.custody)
    let custody = authoritative.custody
    if (localRank > authoritativeRank) {
      custody = local.custody
    } else if (
      localRank === authoritativeRank &&
      localRank >= 0 &&
      authoritative.custody.location === local.custody.location
    ) {
      const authoritativeAmount = authoritative.custody.amount
      const localAmount = local.custody.amount
      if (
        authoritativeAmount != null &&
        localAmount != null &&
        JSON.stringify(canonical(authoritativeAmount)) !== JSON.stringify(canonical(localAmount))
      ) {
        throw new Error('Authoritative receipt custody amount conflicts with local evidence')
      }
      if (authoritativeAmount == null && localAmount != null) custody = local.custody
    }

    return appendPhase({ ...authoritative, custody }, attempt)
  }

  const mayHaveCommitted = (error) =>
    error?.code !== 'RECOVERY_POST_GUARD_FAILED' &&
    (error?.status === 409 ||
      error?.step == null ||
      (error.step === 'write' && ![400, 401, 403].includes(error.status)))

  const readAuthoritative = async () => {
    // Dynamic for the same reason as the permission-locked imports above: legacy orchestrator
    // tests mock a deliberately narrow agentCache module, while recoveryClient's default resolver
    // imports loadCachedAgents only when this failure path is actually reached.
    const { readRecoveryReceipt } = await import('./strategy/recoveryClient.js')
    return readRecoveryReceipt({
      networkId: RECEIPT_NETWORK_ID,
      owner,
      executionId: receipt.executionId,
      allocationId,
    })
  }

  const sameReceipt = (left, right) =>
    JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))

  const recoveryConflict = () => {
    const conflict = new Error(
      'Recovery receipt changed under this lease; authoritative evidence must be reprojected'
    )
    conflict.code = 'RECOVERY_RECEIPT_CHANGED'
    return conflict
  }

  const failWrite = (error, phase, status) => {
    durable = false
    onEvent?.('receipt-evidence-failed', {
      allocationId,
      phase,
      status,
      error: error.message,
      durable,
    })
    throw error
  }

  async function record({ phase, status, evidence }) {
    const preWriteVersion = expectedVersion
    const preWriteDurableReceipt = durableReceipt
    receipt = appendPhase(receipt, { phase, status, evidence })
    const attempt = receipt.attempts[receipt.attempts.length - 1]
    const postedReceipt = receipt
    const guardPost = async () => {
      try {
        await beforePost?.()
      } catch (cause) {
        const error = new Error(cause?.message || 'Recovery evidence POST guard failed', { cause })
        error.code = 'RECOVERY_POST_GUARD_FAILED'
        throw error
      }
    }
    const post = async () => {
      await guardPost()
      return postReceiptEvidence({
        activeAccount: owner,
        agentAddress,
        sessionKey,
        body: { expectedVersion, receipt, attempt },
        ...(beforePost ? { beforeWrite: guardPost } : {}),
      })
    }
    const adoptExactAttempt = (authoritativeResult) => {
      const authoritative = authoritativeResult.receipt
      if (!authoritative?.attempts?.some((entry) => sameAttempt(entry, attempt))) return false
      const adopted = writableReceipt(authoritative)
      if (
        abortRecoveryConflict &&
        (authoritativeResult.version !== preWriteVersion + 1 ||
          !sameReceipt(adopted, postedReceipt))
      ) {
        throw recoveryConflict()
      }
      receipt = adopted
      durableReceipt = adopted
      expectedVersion = authoritativeResult.version
      return true
    }
    const authoritativeUnchanged = (authoritativeResult) => {
      if (authoritativeResult.version !== preWriteVersion) return false
      if (preWriteVersion === 0) {
        return authoritativeResult.receipt == null && preWriteDurableReceipt == null
      }
      if (!authoritativeResult.receipt || !preWriteDurableReceipt) return false
      return sameReceipt(writableReceipt(authoritativeResult.receipt), preWriteDurableReceipt)
    }
    try {
      const result = await post()
      expectedVersion = result.version
      durableReceipt = receipt
    } catch (error) {
      if (!mayHaveCommitted(error)) failWrite(error, phase, status)
      let authoritativeResult
      try {
        authoritativeResult = await readAuthoritative()
      } catch (readError) {
        failWrite(readError, phase, status)
      }
      try {
        if (adoptExactAttempt(authoritativeResult)) return
        if (abortRecoveryConflict) {
          if (!authoritativeUnchanged(authoritativeResult)) {
            if (authoritativeResult.receipt) {
              receipt = writableReceipt(authoritativeResult.receipt)
              durableReceipt = receipt
            }
            expectedVersion = authoritativeResult.version
            failWrite(recoveryConflict(), phase, status)
          }
        } else {
          expectedVersion = authoritativeResult.version
          if (authoritativeResult.receipt) {
            durableReceipt = writableReceipt(authoritativeResult.receipt)
            receipt = rebaseAttempt(authoritativeResult.receipt, receipt, attempt)
          }
        }
      } catch (rebaseError) {
        failWrite(rebaseError, phase, status)
      }
      try {
        const result = await post()
        expectedVersion = result.version
        durableReceipt = receipt
      } catch (retryError) {
        if (!mayHaveCommitted(retryError)) failWrite(retryError, phase, status)
        try {
          authoritativeResult = await readAuthoritative()
        } catch (readError) {
          failWrite(readError, phase, status)
        }
        try {
          if (adoptExactAttempt(authoritativeResult)) return
          if (abortRecoveryConflict && !authoritativeUnchanged(authoritativeResult)) {
            failWrite(recoveryConflict(), phase, status)
          }
        } catch (rebaseError) {
          failWrite(rebaseError, phase, status)
        }
        failWrite(retryError, phase, status)
      }
    }
  }

  function custody(evidence) {
    receipt = confirmCustody(receipt, evidence)
  }

  return {
    record,
    custody,
    get receipt() {
      return receipt
    },
    get durable() {
      return durable
    },
  }
}

function assertRecoveryText(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Recovery ${field} is required`)
  }
  return value
}

function assertRecoveryLease(claim, phase) {
  const lease = claim?.lease
  if (
    claim?.ok !== true ||
    claim.phase !== phase ||
    !lease ||
    lease.phase !== phase ||
    typeof lease.holder !== 'string' ||
    lease.holder.length === 0 ||
    typeof lease.leaseToken !== 'string' ||
    lease.leaseToken.length === 0 ||
    !Number.isSafeInteger(lease.expiresAt) ||
    lease.expiresAt <= Date.now()
  ) {
    throw new Error(`Recovery lease for ${phase} is missing, mismatched, or expired`)
  }
  return lease
}

function recoveryAmount(value, field = 'allocation mapping') {
  const amount = value?.amount ?? value
  if (
    !amount ||
    typeof amount.token !== 'string' ||
    amount.token.length === 0 ||
    typeof amount.units !== 'string' ||
    !/^\d+$/.test(amount.units) ||
    !Number.isInteger(amount.decimals) ||
    amount.decimals < 0
  ) {
    throw new Error(
      `Recovery ${field} amount must preserve exact token, integer-string units, and decimals`
    )
  }
  return { token: amount.token, units: amount.units, decimals: amount.decimals }
}

function sameRecoveryAmount(left, right) {
  return (
    left.token === right.token && left.units === right.units && left.decimals === right.decimals
  )
}

function recoveryPermissionAmount(permissionEvidence, allocationId) {
  if (permissionEvidence == null) return null
  const matches = Array.isArray(permissionEvidence.reviewedAgentInits)
    ? permissionEvidence.reviewedAgentInits.filter((entry) => entry?.allocationId === allocationId)
    : []
  if (matches.length !== 1) {
    throw new Error('Recovery permission must contain exactly one reviewed allocation amount')
  }
  const reviewed = matches[0]
  return recoveryAmount(
    {
      token: reviewed.token,
      units: reviewed.cap?.units,
      decimals: reviewed.cap?.decimals,
    },
    'permission'
  )
}

function resolveRecoveryAmount({ mapping, receipt, permissionEvidence, allocationId }) {
  const mapped = recoveryAmount(mapping, 'allocation mapping')
  const durable = receipt
    ? recoveryAmount(receipt.intent?.allocation, 'durable receipt intent')
    : mapped
  const supplied = [
    ['allocation mapping', mapped],
    ['permission', recoveryPermissionAmount(permissionEvidence, allocationId)],
    ['durable receipt custody', receipt?.custody?.amount ?? null],
  ]
  for (const [field, candidateValue] of supplied) {
    if (candidateValue == null) continue
    const candidate = recoveryAmount(candidateValue, field)
    if (!sameRecoveryAmount(durable, candidate)) {
      throw new Error(`Recovery ${field} amount conflicts with durable receipt intent`)
    }
  }
  return durable
}

function lastRecoveryAttempt(receipt, phase) {
  const attempts = Array.isArray(receipt?.attempts) ? receipt.attempts : []
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    if (attempts[index]?.phase === phase) return attempts[index]
  }
  return null
}

function recoveryManualReviewError(code, phase, message) {
  const error = new Error(message)
  error.code = code
  error.phase = phase
  return error
}

async function recoveryRelayError(result, operation) {
  if (result == null || result.status === 'FAILED') {
    return new Error(
      result
        ? `The ${operation} relay returned ${result.status}.`
        : 'The Stellar relay is unavailable before submission.'
    )
  }
  const { RelaySubmissionUnknownError } = await import('./stellar/relay.js')
  return new RelaySubmissionUnknownError(
    `The ${operation} relay returned an unproved outcome (${result.status || 'malformed'}).`,
    result
  )
}

/** Bind the two Stellar custody mutations inside baseLeg.js to the same owner capability as the
 * parent run. Quote/mandate work may settle after cancellation, but neither pull nor burn can
 * start on a stale owner. A change after transport dispatch is surfaced as uncertain custody and
 * the burn wrapper will not start a later mutation. */
export function bindBaseLegCustodyDeps({
  activeAccount,
  getCurrentActiveAccount = getActiveAccount,
  signal,
  runAgentPullFn = runAgentPull,
  loadRunAgentBurn = async () => (await import('./stellar/agentBurn.js')).runAgentBurn,
}) {
  let epochCustody = null
  const rememberUnknownCustody = (error) => {
    epochCustody = error?.custody || { location: 'unknown', confirmed: false }
  }
  const check = () =>
    assertActiveAccountBoundary({
      captured: activeAccount,
      getCurrent: getCurrentActiveAccount,
      signal,
    })
  return {
    runAgentPull: async (args) => {
      check()
      let result
      try {
        result = await runAgentPullFn({
          ...args,
          activeAccount,
          getCurrentActiveAccount,
          signal,
        })
      } catch (error) {
        // Relay SUCCESS is confirmed custody evidence. Let baseLeg record fundsPulled=true, then
        // its next (burn) wrapper fails at the pre-dispatch check for the stale account.
        if (error?.code === 'VF_SUBMISSION_UNKNOWN' && error.result?.status === 'SUCCESS')
          return error.result
        if (error?.code === 'VF_SUBMISSION_UNKNOWN') rememberUnknownCustody(error)
        throw error
      }
      try {
        check()
      } catch (cause) {
        if (result?.status === 'SUCCESS') return result
        const error = activeAccountSubmissionUnknown({ stage: 'pull', cause, result })
        rememberUnknownCustody(error)
        throw error
      }
      return result
    },
    runAgentBurn: async (args) => {
      check()
      const runAgentBurn = await loadRunAgentBurn()
      check()
      let result
      try {
        result = await runAgentBurn(args)
      } catch (error) {
        if (error?.code === 'VF_SUBMISSION_UNKNOWN') rememberUnknownCustody(error)
        throw error
      }
      try {
        check()
      } catch (cause) {
        // A burnHash is confirmation that the irreversible burn completed. Continue the bridge
        // recovery path; UI callbacks remain epoch-filtered by the parent run.
        if (result?.burnHash) return result
        const error = activeAccountSubmissionUnknown({ stage: 'burn', cause, result })
        rememberUnknownCustody(error)
        throw error
      }
      return result
    },
    getEpochCustody: () => epochCustody,
  }
}

/** baseLeg.js predates epoch-bound account cancellation and assumes every pre-pull failure means
 * funds are confirmed at the owner. Correct that projection when the account-bound dependency
 * recorded an actually-unknown transport outcome. */
export function reconcileBaseLegEpochCustody(result, deps) {
  const custody = deps?.getEpochCustody?.()
  if (!result || !custody) return result
  return {
    ...result,
    custody,
    allocations: Array.isArray(result.allocations)
      ? result.allocations.map((allocation) => ({ ...allocation, custody }))
      : result.allocations,
  }
}

/**
 * Orchestrator Agent — receives the AI plan, authorizes + funds each agent on Stellar (one
 * user-signed step per agent via the wallet kit), then dispatches Worker Agents that each run a
 * gasless session-key deposit through the relay.
 */
export class OrchestratorAgent {
  /**
   * @param {object} config
   * @param {string} config.user - user G... address
   * @param {string|null} config.veniceAuth - base64 SIWE header for Venice x402
   * @param {string|null} config.devApiKey - DeepSeek API key for dev mode
   * @param {string} config.sessionId
   * @param {function} config.onEvent - (eventName, data) => void
   * @param {object|null} config.baseLegContext - { connectedAddress, signTx } — required only when
   *   strategy.vaults contains a chain:'base' entry (only .connectedAddress is read; signTx is
   *   unused since the grant-covers-burn rework — the Base leg's bridge agent is authorized by the
   *   SAME single funding_router grant as the Stellar deposit workers, signed once via the default
   *   wallet-kit path in grantFreshAgents, never through this context).
   */
  constructor({
    user,
    veniceAuth,
    devApiKey,
    sessionId,
    onEvent,
    registryAuthorize = false,
    grantBudgetUnits = null,
    grantDurationSeconds = null,
    baseLegContext = null,
    activeAccount = null,
    getCurrentActiveAccount = getActiveAccount,
    signal,
  }) {
    this.user = user
    this.veniceAuth = veniceAuth || null
    this.devApiKey = devApiKey || null
    this.activeAccount = activeAccount
    this.getCurrentActiveAccount = getCurrentActiveAccount
    this.signal = signal
    this.assertCurrentAccount = () =>
      assertActiveAccountBoundary({
        captured: this.activeAccount,
        getCurrent: this.getCurrentActiveAccount,
        signal: this.signal,
      })
    const observer = typeof onEvent === 'function' ? onEvent : null
    this.onEvent = (name, data) => {
      this.assertCurrentAccount()
      try {
        observer?.(name, data)
      } catch {
        // UI/telemetry observers are outside the custody operation boundary. Their exceptions
        // must never erase confirmed permission or settled sibling evidence.
      }
    }
    this.sessionId = sessionId || `session-${Date.now()}`
    this.baseLegContext = baseLegContext
    // Single-signature grant knobs (router path only). Budget defaults to the run total; a larger budget
    // buys headroom for signature-free repeat runs. Duration defaults to SCOPE_TTL_SECONDS. The UI's grant
    // step supplies both; null = use defaults.
    this.grantBudgetUnits = grantBudgetUnits != null ? BigInt(grantBudgetUnits) : null
    this.grantDurationSeconds = grantDurationSeconds || null
    // Registry.authorize is record-keeping only (deposits are enforced by the agent account's
    // OWN constructor-pinned scope; nothing on the deposit path reads the Registry). Default
    // off: it would cost one extra wallet signature per agent. Flip on to also write the on-chain
    // Registry record (feeds stellar/events.js indexer + the Registry.revoke kill-switch demo).
    this.registryAuthorize = registryAuthorize
  }

  /**
   * Execute full orchestration: generate skills → authorize+fund each agent → dispatch → aggregate.
   * Splits strategy.vaults by chain FIRST: chain:'base' vaults run through executeBaseLeg (Task 7)
   * as a settled sibling of the Stellar worker pipeline — one leg failing never aborts the other.
   * @param {object} strategy - { vaults: [{ address, allocation, chain? }], ... } — chain defaults
   *   to the Stellar path when absent (regression-safe for every pre-Task-3 strategy).
   * @param {number} totalAmount - total asset amount (human-readable VFUSD)
   * @returns {Promise<{completed:number, failed:number, results:Array, sessionId:string, baseLeg:object|null}>}
   */
  async dispatch(strategyOrPlan, totalAmountOrOptions) {
    this.assertCurrentAccount()
    // Strategy Task 7 (Pocket Crew redesign, Wave 1) — dispatch is overloaded by the SHAPE of its
    // second argument, never by an explicit flag, so every pre-Task-7 call site (a plain
    // human-readable `totalAmount` number) is untouched byte-for-byte and keeps taking the legacy
    // path below. A reviewed StrategyPlan + PermissionDecisionV1 always passes an OBJECT
    // (`{ permissionDecision }`) as the second argument — that shape is the discriminator.
    if (totalAmountOrOptions != null && typeof totalAmountOrOptions === 'object') {
      return this.dispatchPermissioned(strategyOrPlan, totalAmountOrOptions)
    }
    return this.dispatchLegacy(strategyOrPlan, totalAmountOrOptions)
  }

  /**
   * Execute the single action authorized by one fresh, server-leased recovery verdict. This path
   * deliberately reuses the ordinary AllocationReceipt writer and the original cached signer;
   * it never creates a WorkerAgent, signer, execution id, or second receipt journal.
   */
  async recoverAllocation({ claim, credential, allocationMapping, permissionEvidence = null }) {
    let actionError = null
    let identity = null
    try {
      this.assertCurrentAccount()
      const mapping = allocationMapping
      if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
        throw new Error('Recovery requires an authoritative allocation mapping')
      }
      identity = {
        networkId: assertRecoveryText(mapping.networkId, 'networkId'),
        owner: assertRecoveryText(mapping.owner, 'owner'),
        executionId: assertRecoveryText(mapping.executionId, 'executionId'),
        allocationId: assertRecoveryText(mapping.allocationId, 'allocationId'),
      }
      if (
        identity.networkId !== RECEIPT_NETWORK_ID ||
        identity.owner !== this.user ||
        identity.executionId !== `${mapping.runId}:exec:${identity.allocationId}` ||
        mapping.childId !== null
      ) {
        throw new Error('Recovery allocation mapping does not match this Stellar execution')
      }
      const agentAddress = assertRecoveryText(mapping.agentAddress, 'agent address')
      if (
        credential?.agentAddress !== agentAddress ||
        typeof credential?.publicKey !== 'string' ||
        typeof credential?.sign !== 'function'
      ) {
        throw new Error('Recovery credential does not match the original agent')
      }
      if (!Number.isSafeInteger(claim?.version) || claim.version < 0) {
        throw new Error('Recovery claim carries an invalid row version')
      }
      if ((claim.version === 0) !== (claim.receipt == null)) {
        throw new Error('Recovery claim receipt/version is inconsistent')
      }
      if (claim.receipt) {
        for (const field of ['networkId', 'owner', 'executionId', 'allocationId']) {
          if (claim.receipt[field] !== identity[field]) {
            throw new Error(`Recovery receipt ${field} does not match the allocation mapping`)
          }
        }
        if (
          claim.receipt.agent !== agentAddress ||
          claim.receipt.worker !== credential.publicKey ||
          (claim.receipt.childId ?? null) !== null ||
          claim.receipt.version !== claim.version
        ) {
          throw new Error('Recovery receipt does not match the original agent, signer, or child')
        }
      }
      const amount = resolveRecoveryAmount({
        mapping,
        receipt: claim.receipt,
        permissionEvidence,
        allocationId: identity.allocationId,
      })
      const selected = selectRecoveryAction(claim.receipt)
      for (const field of ['action', 'phase', 'reasonCode']) {
        if (claim?.[field] !== selected[field]) {
          throw new Error(`Recovery claim ${field} does not match durable receipt evidence`)
        }
      }
      if (selected.phase == null) {
        if (claim.lease !== null) throw new Error('A no-action recovery claim cannot carry a lease')
        return await this.readRecoveryAllocation(identity)
      }
      assertRecoveryLease(claim, selected.phase)

      const recorder = createEvidenceRecorder({
        runId: mapping.runId,
        allocationId: identity.allocationId,
        owner: identity.owner,
        agentAddress,
        sessionKey: credential,
        worker: credential.publicKey,
        amount,
        onEvent: this.onEvent,
        persistedReceipt: claim.receipt,
        persistedVersion: claim.version,
        beforePost: () => {
          assertRecoveryLease(claim, selected.phase)
          this.assertCurrentAccount()
        },
        abortRecoveryConflict: true,
      })
      const write = async (attempt) => {
        assertRecoveryLease(claim, selected.phase)
        this.assertCurrentAccount()
        await recorder.record(attempt)
        this.assertCurrentAccount()
      }
      const move = async (operation) => {
        assertRecoveryLease(claim, selected.phase)
        this.assertCurrentAccount()
        const result = await operation()
        this.assertCurrentAccount()
        return result
      }
      const amountUnits = BigInt(amount.units)

      const recordSubmissionFailure = async (error, phase, extraEvidence = {}) => {
        const unknown = error?.code === 'VF_SUBMISSION_UNKNOWN'
        await write({
          phase,
          status: unknown ? 'unknown' : 'failed',
          evidence: {
            reason: error?.message || String(error),
            ...(error?.result?.hash ? { txHash: error.result.hash } : {}),
            ...extraEvidence,
          },
        })
      }

      const executePull = async ({ v3 = null } = {}) => {
        const v3Evidence = v3 ? { v3ExecutionId: v3.executionId } : {}
        await write({ phase: 'pull', status: 'submitted', evidence: v3Evidence })
        let result
        try {
          result = await move(() =>
            v3
              ? this.runAgentPullV3({
                  permissionId: v3.permissionId,
                  executionId: v3.executionId,
                  agentAddress,
                  amount: amountUnits,
                  sessionKey: credential,
                  router: v3.router,
                })
              : runAgentPull({
                  agentAddress,
                  amount: amountUnits,
                  sessionKey: credential,
                  activeAccount: this.activeAccount,
                  getCurrentActiveAccount: this.getCurrentActiveAccount,
                  signal: this.signal,
                })
          )
        } catch (error) {
          await recordSubmissionFailure(error, 'pull', v3Evidence)
          throw error
        }
        if (!result || result.status !== 'SUCCESS') {
          const error = await recoveryRelayError(result, 'funding router')
          await recordSubmissionFailure(error, 'pull', v3Evidence)
          throw error
        }
        recorder.custody({ location: 'stellar-agent', txSuccess: true, amount })
        await write({
          phase: 'pull',
          status: 'confirmed',
          evidence: { txHash: result.hash ?? null, ...v3Evidence },
        })
      }

      if (selected.action === 'pull') {
        if (permissionEvidence?.version === 3) {
          throw new Error('A V3 permission cannot be recovered through the V2 pull primitive')
        }
        await executePull()
      } else if (selected.action === 'resubmit-identical-envelope') {
        const durableId = lastRecoveryAttempt(claim.receipt, 'pull')?.evidence?.v3ExecutionId
        const exactExecution = permissionEvidence?.executions?.find(
          (entry) => entry?.allocationId === identity.allocationId
        )
        if (
          permissionEvidence?.version !== 3 ||
          permissionEvidence?.mode !== 'reuse' ||
          typeof permissionEvidence.router !== 'string' ||
          permissionEvidence.router.length === 0 ||
          typeof permissionEvidence.permissionId !== 'string' ||
          permissionEvidence.permissionId.length === 0 ||
          !/^0x[0-9a-f]{64}$/.test(durableId || '') ||
          exactExecution?.executionId !== durableId ||
          exactExecution?.agentAddress !== agentAddress ||
          String(exactExecution?.amountUnits) !== amount.units
        ) {
          throw new Error('V3 recovery evidence does not match the durable execution envelope')
        }
        await executePull({
          v3: {
            permissionId: permissionEvidence.permissionId,
            executionId: durableId,
            router: permissionEvidence.router,
          },
        })
      } else if (selected.action === 'deposit') {
        const preShares = await move(() => readVaultShares(agentAddress))
        if (preShares == null) {
          throw new Error('Vault share baseline is unavailable; deposit recovery is blocked')
        }
        await write({
          phase: 'stellar_deposit',
          status: 'submitted',
          evidence: { preShareUnits: preShares.toString() },
        })
        let result
        try {
          result = await move(() =>
            runAgentDeposit({
              agentAddress,
              amount: amountUnits,
              sessionKey: credential,
              activeAccount: this.activeAccount,
              getCurrentActiveAccount: this.getCurrentActiveAccount,
              signal: this.signal,
            })
          )
        } catch (error) {
          await recordSubmissionFailure(error, 'stellar_deposit', {
            preShareUnits: preShares.toString(),
          })
          throw error
        }
        if (!result || result.status !== 'SUCCESS') {
          const error = await recoveryRelayError(result, 'vault')
          await recordSubmissionFailure(error, 'stellar_deposit', {
            preShareUnits: preShares.toString(),
          })
          throw error
        }
        const postShares = await move(() => readVaultShares(agentAddress))
        if (postShares != null && postShares > preShares) {
          recorder.custody({
            location: 'stellar-vault',
            txSuccess: true,
            matchingEvent: true,
            amount,
          })
          await write({
            phase: 'stellar_deposit',
            status: 'confirmed',
            evidence: {
              txHash: result.hash ?? null,
              preShareUnits: preShares.toString(),
              postShareUnits: postShares.toString(),
            },
          })
        } else {
          await write({
            phase: 'stellar_deposit',
            status: 'unknown',
            evidence: {
              txHash: result.hash ?? null,
              preShareUnits: preShares.toString(),
              postShareUnits: postShares?.toString() ?? null,
              reason: 'The relay succeeded but no vault-share increase was proven.',
            },
          })
        }
      } else if (selected.action === 'poll') {
        const attempt = lastRecoveryAttempt(claim.receipt, selected.phase)
        const txHash = attempt?.evidence?.txHash
        if (typeof txHash !== 'string' || txHash.length === 0) {
          throw recoveryManualReviewError(
            'RECOVERY_POLL_TX_HASH_REQUIRED',
            selected.phase,
            `Recovery poll for ${selected.phase} has no durable transaction hash`
          )
        }
        const preShareUnits =
          selected.phase === 'stellar_deposit' ? attempt?.evidence?.preShareUnits : null
        if (
          selected.phase === 'stellar_deposit' &&
          (typeof preShareUnits !== 'string' || !/^\d+$/.test(preShareUnits))
        ) {
          throw recoveryManualReviewError(
            'RECOVERY_POLL_SHARE_BASELINE_REQUIRED',
            selected.phase,
            'Deposit poll has no durable pre-submission share baseline'
          )
        }
        let confirmation
        try {
          const { readConfirmedLedger } = await import('./stellar/grant.js')
          confirmation = await move(() => readConfirmedLedger({ hash: txHash }))
        } catch (error) {
          if (/not confirmed|not found/i.test(error?.message || ''))
            return await this.readRecoveryAllocation(identity)
          throw error
        }
        if (selected.phase === 'pull') {
          recorder.custody({ location: 'stellar-agent', txSuccess: true, amount })
          await write({
            phase: 'pull',
            status: 'confirmed',
            evidence: { txHash, ...confirmation },
          })
        } else {
          const postShares = await move(() => readVaultShares(agentAddress))
          if (postShares != null && postShares > BigInt(preShareUnits)) {
            recorder.custody({
              location: 'stellar-vault',
              txSuccess: true,
              matchingEvent: true,
              amount,
            })
            await write({
              phase: 'stellar_deposit',
              status: 'confirmed',
              evidence: {
                txHash,
                preShareUnits,
                postShareUnits: postShares.toString(),
                ...confirmation,
              },
            })
          }
        }
      } else {
        throw new Error(`Recovery action ${selected.action} is not executable`)
      }
    } catch (error) {
      actionError = error
    }

    if (!identity) {
      throw actionError
    }
    try {
      const authoritative = await this.readRecoveryAllocation(identity)
      return actionError ? { ...authoritative, error: actionError } : authoritative
    } catch (readError) {
      if (actionError) {
        const aggregate = new AggregateError(
          [actionError, readError],
          'Recovery action and authoritative reread failed',
          { cause: actionError }
        )
        aggregate.primaryError = actionError
        if (actionError.code != null) aggregate.code = actionError.code
        if (actionError.phase != null) aggregate.phase = actionError.phase
        throw aggregate
      }
      throw readError
    }
  }

  async readRecoveryAllocation(identity) {
    const { readRecoveryReceipt } = await import('./strategy/recoveryClient.js')
    return readRecoveryReceipt(identity)
  }

  /**
   * Strategy Task 7 (Pocket Crew redesign, Wave 1) — the permission-locked dispatch path. Consumes
   * an already-reviewed StrategyPlan (planModel.js) plus the PermissionDecisionV1 that Task 5's
   * `preflightPermission` produced for it. Every fact the plan was reviewed against — cap, expiry,
   * period, budget — is taken verbatim from `permissionDecision`, never regenerated here: this
   * method's whole job is refusing to move any fund on anything but that exact reviewed decision.
   *
   * Fresh mode: builds ONE grant strictly from `permissionDecision.reviewedBudgets` /
   * `reviewedAgentInits`, saves + fingerprints the resulting GrantReceiptV1, THEN emits
   * 'grant-confirmed' — before any worker movement. Never touches the agent-reuse cache.
   * Reuse mode: never builds or submits a grant, never calls the wallet/provider. It re-runs
   * Task 5's own `preflightPermission` one more time (a fresh latest-ledger capture, a fresh
   * no-later-mutation proof, a fresh per-agent on-chain scope re-check) immediately before the
   * first pull; any drift from what was reviewed is `PermissionPhaseError`
   * (`phase:'reuse-revalidation', code:'VF_REUSE_EVIDENCE_CHANGED'`) — never a silent fallback to
   * a wallet signature.
   * Both modes reject a stale plan/AgentInit pairing before doing anything else
   * (`phase:'preflight'`).
   *
   * Bridge (Base) allocations are out of scope here — Task 8 owns the mixed-branch custody
   * receipt that will fold them into this path; a plan's `kind:'bridge'` agents are ignored by
   * this method (Task 7 covers Stellar deposit workers only).
   * @param {object} strategyPlan canonical StrategyPlan (planModel.js normalizeStrategyPlan/toDispatchStrategy)
   * @param {{permissionDecision: object}} options
   * @returns {Promise<{completed:number, failed:number, results:Array, sessionId:string, permission:object}>}
   */
  async dispatchPermissioned(strategyPlan, { permissionDecision }) {
    const planAgents = strategyPlan.agents || []
    const bridgeAgents = planAgents.filter((agent) => agent.kind === 'bridge')
    const depositAgents = planAgents.filter((agent) => agent.kind !== 'bridge')
    if (bridgeAgents.length > 1) {
      throw new PermissionPhaseError({
        phase: 'preflight',
        code: 'VF_MULTIPLE_BRIDGE_AGENTS',
        message: 'A reviewed execution may contain exactly one Base bridge agent.',
      })
    }
    if (bridgeAgents.length > 0 && permissionDecision?.mode === 'reuse') {
      throw new PermissionPhaseError({
        phase: 'preflight',
        code: 'VF_BASE_REQUIRES_FRESH_GRANT',
        message: 'Base bridge allocations require a fresh reviewed grant.',
      })
    }
    try {
      this.assertPermissionMatchesPlan(strategyPlan, permissionDecision, planAgents)
      const ids = new Set()
      const validatedAmounts = new Map()
      const canonicalAmount = (amount, allocationId) => {
        if (
          !amount ||
          typeof amount.token !== 'string' ||
          amount.token.trim().length === 0 ||
          !/^[0-9]+$/.test(String(amount.units)) ||
          !Number.isInteger(amount.decimals) ||
          amount.decimals < 0
        ) {
          throw new Error(`Invalid canonical amount for ${allocationId}.`)
        }
        return {
          token: amount.token,
          units: BigInt(amount.units),
          decimals: amount.decimals,
        }
      }
      const sameAmount = (left, right) =>
        left.token === right.token && left.units === right.units && left.decimals === right.decimals

      for (const agent of planAgents) {
        const allocations = agent.kind === 'bridge' ? [agent, ...(agent.children || [])] : [agent]
        for (const allocation of allocations) {
          if (
            typeof allocation.allocationId !== 'string' ||
            allocation.allocationId.trim().length === 0 ||
            ids.has(allocation.allocationId)
          ) {
            throw new Error(`Invalid or duplicate allocationId ${allocation.allocationId}.`)
          }
          ids.add(allocation.allocationId)
          const amount = canonicalAmount(
            allocation.allocation || allocation.cap,
            allocation.allocationId
          )
          validatedAmounts.set(allocation, amount)
          if (allocation.cap && allocation.allocation) {
            const cap = canonicalAmount(allocation.cap, allocation.allocationId)
            const allocationAmount = canonicalAmount(allocation.allocation, allocation.allocationId)
            if (!sameAmount(cap, allocationAmount)) {
              throw new Error(`Cap and allocation do not reconcile for ${allocation.allocationId}.`)
            }
          }
        }
        if (agent.kind === 'bridge') {
          const parent = validatedAmounts.get(agent)
          const children = agent.children || []
          if (
            parent.token !== STELLAR_USDC_SAC ||
            parent.decimals !== SOROBAN_DECIMALS ||
            children.some((child) => {
              const amount = validatedAmounts.get(child)
              return amount.token !== 'USDC' || amount.decimals !== 6
            })
          ) {
            throw new Error(`Bridge token/decimal pairing is invalid for ${agent.allocationId}.`)
          }
          const childrenTotal = children.reduce((sum, child) => {
            const amount = validatedAmounts.get(child)
            return sum + amount.units * 10n ** BigInt(parent.decimals - amount.decimals)
          }, 0n)
          if (parent.units !== childrenTotal) {
            throw new Error(`Bridge child amounts do not reconcile for ${agent.allocationId}.`)
          }
        }
      }
      const expectedBudgets = new Map()
      for (const agent of planAgents) {
        const cap = canonicalAmount(agent.cap, `${agent.allocationId} cap`)
        const existing = expectedBudgets.get(cap.token)
        if (existing && existing.decimals !== cap.decimals) {
          throw new Error(`Agent cap decimals disagree for token ${cap.token}.`)
        }
        expectedBudgets.set(cap.token, {
          token: cap.token,
          units: (existing?.units || 0n) + cap.units,
          decimals: cap.decimals,
        })
      }
      const reviewedBudgets = permissionDecision?.reviewedBudgets
      if (!Array.isArray(reviewedBudgets) || reviewedBudgets.length !== expectedBudgets.size) {
        throw new Error('The reviewed budget set does not match the immutable plan.')
      }
      const reviewedTokens = new Set()
      for (const [index, budget] of reviewedBudgets.entries()) {
        const reviewed = canonicalAmount(budget, `reviewed budget ${index}`)
        if (reviewedTokens.has(reviewed.token)) {
          throw new Error(`Duplicate reviewed budget for token ${reviewed.token}.`)
        }
        reviewedTokens.add(reviewed.token)
        const expected = expectedBudgets.get(reviewed.token)
        if (
          !expected ||
          expected.units !== reviewed.units ||
          expected.decimals !== reviewed.decimals
        ) {
          throw new Error(`Reviewed budget does not match plan scopes for token ${reviewed.token}.`)
        }
      }
    } catch (cause) {
      if (cause instanceof PermissionPhaseError) throw cause
      throw new PermissionPhaseError({
        phase: 'preflight',
        code: 'VF_CANONICAL_AMOUNT_INVALID',
        message: cause.message,
        cause,
      })
    }
    let baseMandate = null
    if (bridgeAgents.length > 0) {
      if (!this.baseLegContext) {
        throw new PermissionPhaseError({
          phase: 'preflight',
          code: 'VF_BASE_CONTEXT_MISSING',
          message: 'Base bridge allocations require an owner-bound Base context.',
        })
      }
      try {
        this.assertCurrentAccount()
        baseMandate = readBaseMandate(this.user)
      } catch (cause) {
        throw new PermissionPhaseError({
          phase: 'preflight',
          code: 'VF_BASE_MANDATE_UNREADABLE',
          message: 'The owner-bound Base mandate could not be read safely.',
          cause,
        })
      }
      if (!baseMandate?.kernelAddress) {
        throw new PermissionPhaseError({
          phase: 'preflight',
          code: 'VF_BASE_MANDATE_MISSING',
          message: 'No owner-bound Base mandate is available for this bridge allocation.',
        })
      }
      let reviewedBridge
      let expectedRecipient
      let actualRecipient
      try {
        reviewedBridge = (permissionDecision.reviewedAgentInits || []).find(
          (init) => init.allocationId === bridgeAgents[0].allocationId
        )
        expectedRecipient = evmAddrToBytes32(baseMandate.kernelAddress)
        actualRecipient =
          typeof reviewedBridge?.mintRecipient === 'string'
            ? hexToBytes32(reviewedBridge.mintRecipient)
            : reviewedBridge?.mintRecipient
      } catch (cause) {
        throw new PermissionPhaseError({
          phase: 'preflight',
          code: 'VF_BASE_KERNEL_INVALID',
          message: 'The owner-bound Base kernel is malformed.',
          cause,
        })
      }
      const recipientMatches =
        actualRecipient instanceof Uint8Array &&
        actualRecipient.length === expectedRecipient.length &&
        actualRecipient.every((byte, index) => byte === expectedRecipient[index])
      if (
        !reviewedBridge ||
        reviewedBridge.target !== STELLAR_TOKEN_MESSENGER_MINTER ||
        reviewedBridge.destinationDomain !== CCTP_BASE_DOMAIN ||
        !recipientMatches
      ) {
        throw new PermissionPhaseError({
          phase: 'preflight',
          code: 'VF_BRIDGE_SCOPE_MISMATCH',
          message: 'The reviewed bridge scope no longer matches the owner-bound Base mandate.',
        })
      }
    }

    let workers
    let confirmed
    // Task 5 chunk B — set only for a V3 reuse dispatch: the permissionId + per-allocation proven
    // execution the serial pull loop below threads into `buildAgentPullV3`, instead of the
    // untouched V2 `runAgentPull` call. null for every V2/fresh path (unchanged behavior).
    let v3Pull = null
    if (permissionDecision.mode === 'reuse') {
      // Minor fix round 1 -- closes report-concern 4 cheaply: `postReceiptEvidence`'s owner guard
      // is fed the SAME `this.user` variable on both sides at this file's evidence-posting call
      // site, so it is currently a tautology there (see the chunk C1 report's identity-question
      // section). This is the one place on the reuse-mode path that can independently assert
      // `this.activeAccount.address === this.user` BEFORE any evidence is built from it. A
      // divergence still fails closed at the server's on-chain re-read either way; this just moves
      // the failure earlier and local. A no-op for every existing caller that never sets
      // `activeAccount` (defaults to null; `assertActiveOwner` only checks a version:1 capability).
      assertActiveOwner({ owner: this.user, activeAccount: this.activeAccount })
      const { revalidated, credentialByAllocation } = await this.revalidateReuse(
        strategyPlan,
        permissionDecision,
        planAgents
      )
      this.assertCurrentAccount()
      workers = this.buildReuseWorkers(depositAgents, revalidated, credentialByAllocation)
      if (revalidated.version === 3) {
        v3Pull = {
          permissionId: revalidated.permissionId,
          // The router this permission was actually proven against — never the global config
          // default. If they ever diverge, the pull must follow the proof, not fall back.
          router: revalidated.router,
          executionsByAllocation: new Map(revalidated.executions.map((e) => [e.allocationId, e])),
        }
        confirmed = {
          version: 1,
          runId: strategyPlan.runId,
          mode: 'reuse',
          planFingerprint: strategyPlan.planFingerprint,
          // V2-only identity fields have no V3 equivalent — null rather than fabricated. The V3
          // identity (permissionId/scopeId) is carried on its own fields below instead of forced
          // into a V2-shaped field.
          agentInitFingerprint: null,
          grantReceiptFingerprint: null,
          confirmationCount: (permissionDecision.confirmationCount ?? 0) + 1,
          txHash: null,
          // The reviewed absolute ledger expiry the permission itself carries — not a V2-style
          // approvals[] lookup, which doesn't exist on a V3 decision.
          expiryLedger: revalidated.liveUntilLedger ?? null,
          agentAddresses: workers.map((w) => w.agentAddress),
          confirmedAt: Math.floor(Date.now() / 1000),
          routerVersion: 3,
          permissionId: revalidated.permissionId,
          scopeId: revalidated.scopeId,
        }
      } else {
        // Matched by the actual budgeted token, never approvals[0] — a multi-token receipt's first
        // approval is not guaranteed to be the one this run's deposit budget cares about.
        const primaryToken = permissionDecision.reviewedBudgets?.[0]?.token
        const matchingApproval = revalidated.allowanceExpiryProof?.approvals?.find(
          (a) => a.amount?.token === primaryToken
        )
        const expiryLedger = matchingApproval?.expiryLedger ?? null
        confirmed = {
          version: 1,
          runId: strategyPlan.runId,
          mode: 'reuse',
          planFingerprint: strategyPlan.planFingerprint,
          agentInitFingerprint: permissionDecision.agentInitFingerprint,
          grantReceiptFingerprint: revalidated.grantReceiptFingerprint,
          confirmationCount: (permissionDecision.confirmationCount ?? 0) + 1,
          txHash: null,
          expiryLedger,
          agentAddresses: workers.map((w) => w.agentAddress),
          confirmedAt: Math.floor(Date.now() / 1000),
        }
      }
      this.onEvent('reuse-confirmed', {
        runId: strategyPlan.runId,
        confirmed,
        agentAddresses: confirmed.agentAddresses,
      })
    } else if (permissionDecision.mode === 'fresh') {
      // Task 5 chunk B — fresh-mode V3 fails closed. grant.js exports only `buildGrantV3Tx`
      // (build-only; no submitGrant-equivalent wallet/relay orchestration exists for V3, and
      // grant.js is out of this chunk's file scope to add one) — silently routing a V3 fresh
      // decision through V2's `submitGrant` would invoke the router's `grant`/grant_v2 entry
      // point, not `grant_v3`. See the task report for this scope line.
      if (permissionDecision.version === 3) {
        throw new PermissionPhaseError({
          phase: 'fresh-grant',
          code: 'VF_V3_FRESH_GRANT_UNSUPPORTED',
          message: 'A fresh Router V3 permission grant is not yet supported by this dispatch path.',
        })
      }
      workers = this.buildFreshWorkers(planAgents)
      const granted = await this.grantFreshFromDecision(strategyPlan, workers, permissionDecision)
      this.assertCurrentAccount()
      confirmed = {
        version: 1,
        runId: strategyPlan.runId,
        mode: 'fresh',
        planFingerprint: strategyPlan.planFingerprint,
        agentInitFingerprint: permissionDecision.agentInitFingerprint,
        grantReceiptFingerprint: granted.grantReceiptFingerprint,
        confirmationCount: 1,
        txHash: granted.txHash,
        expiryLedger: granted.expiryLedger,
        agentAddresses: granted.agentAddresses,
        confirmedAt: granted.confirmedAt,
      }
      this.onEvent('grant-confirmed', {
        runId: strategyPlan.runId,
        confirmed,
        budgets: permissionDecision.reviewedBudgets,
        agentAddresses: granted.agentAddresses,
      })
    } else {
      throw new PermissionPhaseError({
        phase: 'preflight',
        code: 'VF_UNKNOWN_PERMISSION_MODE',
        message: `Unknown permission mode: ${permissionDecision?.mode}`,
      })
    }

    if (bridgeAgents.length > 0) {
      return this.dispatchConfirmedMixed({
        strategyPlan,
        confirmed,
        workers,
        bridgeAgent: bridgeAgents[0],
        baseMandate,
      })
    }

    // Queue events fire for EVERY eligible worker up front, real index, before any turn begins —
    // then the SAME 2,000ms relay-safe serial dispatcher (unchanged from the legacy path) runs
    // pull + deposit per worker, isolating one worker's pull/deposit failure from the rest.
    workers.forEach((w, i) => {
      this.onEvent('worker-queued', {
        allocationId: w.allocationId,
        agentId: w.agentId,
        agent: w.agentAddress,
        queueIndex: i,
      })
    })

    const workerResults = []
    for (let i = 0; i < workers.length; i++) {
      const w = workers[i]
      this.onEvent('worker-started', {
        allocationId: w.allocationId,
        agentId: w.agentId,
        agent: w.agentAddress,
        queueIndex: i,
      })
      // Task 6 chunk C1 -- one AllocationReceiptV2 per worker, opened BEFORE either submission so
      // even a pre-pull failure journals against a real receipt (custody stays at owner/confirmed,
      // every phase stays not_started) rather than the evidence never existing at all. Constructed
      // INSIDE the try block (not before it) so even a malformed-input throw from
      // createAllocationReceipt itself isolates to THIS worker, never the whole loop -- the same
      // per-worker isolation guarantee every other step in this loop already gets.
      let pullTxHash = null
      let evidenceRecorder = null
      try {
        const receiptAmount = {
          token: SOROBAN_TOKEN_ADDRESS,
          units: w.amount.toString(),
          decimals: SOROBAN_DECIMALS,
        }
        evidenceRecorder = createEvidenceRecorder({
          runId: strategyPlan.runId,
          allocationId: w.allocationId,
          owner: this.user,
          agentAddress: w.agentAddress,
          sessionKey: w.sessionKey,
          worker: w.sessionKey?.publicKey,
          amount: receiptAmount,
          onEvent: this.onEvent,
        })
        // Fund only the shortfall case (a reused/aborted agent may already hold the asset) — same
        // rule as the legacy router path. The pull is relayed: the agent's own session key signs
        // the pull auth entry, the relay fee-bumps — zero further wallet signatures either mode.
        const agentBal = await readTokenBalance(w.agentAddress)
        this.assertCurrentAccount()
        if (agentBal == null || agentBal < w.amount) {
          // Task 5 chunk B — a V3 reuse dispatch pulls through the proven permissionId +
          // executionId (revalidateReuse's canonical re-read), matched to THIS allocation; every
          // other dispatch (V2 reuse, V2/fresh) is byte-identical to before: v3Pull stays null.
          const v3Exec = v3Pull ? v3Pull.executionsByAllocation.get(w.allocationId) : null
          // Fix round 1, Important 2: a V3 dispatch with no matching execution must abort, never
          // silently fall through to a V2 pull (no permissionId, no executionId, no per-execution
          // accounting — exactly the defensive-silence shape this chunk's brief bans on a money
          // path). Unreachable today because buildReuseWorkers already throws first for a missing
          // pick, but the pull loop must not depend on that as its only guard.
          if (v3Pull && !v3Exec) {
            throw new PermissionPhaseError({
              phase: 'reuse-revalidation',
              code: 'VF_REUSE_EVIDENCE_CHANGED',
              message: `No proven execution for allocation ${w.allocationId}.`,
            })
          }
          // Review round 1, Important 3 -- the V3 router's own replay-guard id
          // (`v3Exec.executionId`, distinct from this receipt's own `executionId` -- see
          // createEvidenceRecorder's doc comment) must be recoverable from the receipt, not just
          // from the live in-memory `v3Exec` this loop iteration happens to hold.
          const v3EvidenceExtra = v3Exec ? { v3ExecutionId: v3Exec.executionId } : {}
          // Persist intent BEFORE submission (brief) -- a crash/reload between this line and the
          // pull's own outcome still leaves a durable "we were about to pull" fact behind.
          await evidenceRecorder.record({
            phase: 'pull',
            status: 'submitted',
            evidence: { ...v3EvidenceExtra },
          })
          let res
          try {
            res = v3Exec
              ? await this.runAgentPullV3({
                  permissionId: v3Pull.permissionId,
                  executionId: v3Exec.executionId,
                  agentAddress: w.agentAddress,
                  amount: w.amount,
                  sessionKey: w.sessionKey,
                  router: v3Pull.router,
                })
              : await runAgentPull({
                  agentAddress: w.agentAddress,
                  amount: w.amount,
                  sessionKey: w.sessionKey,
                  activeAccount: this.activeAccount,
                  getCurrentActiveAccount: this.getCurrentActiveAccount,
                  signal: this.signal,
                })
            this.assertCurrentAccount()
            if (!res)
              throw new Error(
                'The Stellar relay is unavailable. Funds could not be sent to the agent.'
              )
            if (res.status !== 'SUCCESS')
              throw new Error(`The funding router returned ${res.status}.`)
            pullTxHash = res.hash || null
            // Every FORWARD confirmCustody must pass amount (brief) -- an exact successful pull
            // IS the movement to stellar-agent, the one location confirmable on txSuccess alone.
            await evidenceRecorder.record({
              phase: 'pull',
              status: 'confirmed',
              evidence: { txHash: pullTxHash, ...v3EvidenceExtra },
            })
            evidenceRecorder.custody({
              location: 'stellar-agent',
              txSuccess: true,
              amount: receiptAmount,
            })
          } catch (pullError) {
            // runAgentPull's own indeterminate-outcome signal (grant.js) -- never reported as a
            // clean failure; custody stays wherever it already was (owner, since the pull was
            // never proven), the ambiguity lands in custody.reason.
            if (pullError?.code === 'VF_SUBMISSION_UNKNOWN') {
              await evidenceRecorder.record({
                phase: 'pull',
                status: 'unknown',
                evidence: {
                  reason: pullError.message,
                  txHash: pullError.result?.hash ?? null,
                  ...v3EvidenceExtra,
                },
              })
              evidenceRecorder.custody({ location: 'unknown', reason: pullError.message })
            } else {
              await evidenceRecorder.record({
                phase: 'pull',
                status: 'failed',
                evidence: { reason: pullError.message, ...v3EvidenceExtra },
              })
            }
            throw pullError
          }
        } else {
          // CRITICAL fix round 1 -- the agent already holds the funds (the pull was skipped
          // above); the balance READ just performed IS the proof of stellar-agent custody, the
          // same fact an exact successful pull would establish, observed by a different route.
          // Without this call the receipt opens at owner/confirmed with pull:not_started even
          // though the money is provably at the agent -- if the deposit then fails, a recovery
          // reading that receipt would authorize a duplicate pull of funds already there. Money
          // would move twice.
          evidenceRecorder.custody({
            location: 'stellar-agent',
            txSuccess: true,
            amount: receiptAmount,
          })
        }
        await evidenceRecorder.record({
          phase: 'stellar_deposit',
          status: 'submitted',
          evidence: {},
        })
        const res = await w.execute()
        this.assertCurrentAccount()
        if (res?.success) {
          await evidenceRecorder.record({
            phase: 'stellar_deposit',
            status: 'confirmed',
            evidence: { txHash: res.txHash },
          })
          // stellar-vault requires final transaction success PLUS a matching share/deposit event
          // (brief) -- a confirmed worker.execute() genuinely proved both (verifyMinted polled a
          // real share increase), never transport acceptance alone.
          evidenceRecorder.custody({
            location: 'stellar-vault',
            txSuccess: true,
            matchingEvent: true,
            amount: receiptAmount,
          })
        } else if (res?.status === 'unknown') {
          // worker.js's own indeterminate-outcome signal (Task 6 chunk C1) -- never success, never
          // a clean failure; custody stays at its last proven location (stellar-agent, if the pull
          // above confirmed).
          await evidenceRecorder.record({
            phase: 'stellar_deposit',
            status: 'unknown',
            evidence: { reason: res.error, txHash: res.txHash ?? null },
          })
          evidenceRecorder.custody({ location: 'unknown', reason: res.error })
        } else {
          await evidenceRecorder.record({
            phase: 'stellar_deposit',
            status: 'failed',
            evidence: { reason: res?.error, txHash: res?.txHash ?? null },
          })
          // The deposit tx itself may still have SUCCEEDED even though worker.execute() reports a
          // failure (shares never minted) -- exercise the ambiguous path honestly (txSuccess:true,
          // matchingEvent:false) rather than pretending no evidence exists. confirmCustody's own
          // ladder guarantees this can never advance custody to stellar-vault on transaction
          // success alone (allocationReceipt.js) -- it only records the ambiguity.
          if (res?.txSuccess) {
            // Minor fix round 1 -- pass `amount` for uniformity with every other custody call.
            // Harmless today (the bar already fails on matchingEvent:false, routing to the
            // ambiguous path regardless of amount), but keeps this call from being the one place
            // an accidental future `matchingEvent:true` flip would trip the brief's
            // confirmed-amount-drop guard.
            evidenceRecorder.custody({
              location: 'stellar-vault',
              txSuccess: true,
              matchingEvent: false,
              amount: receiptAmount,
            })
          }
        }
        workerResults.push({
          status: 'fulfilled',
          value: {
            ...res,
            pullTxHash,
            receipt: evidenceRecorder.receipt,
            receiptEvidenceDurable: evidenceRecorder.durable,
          },
        })
      } catch (e) {
        workerResults.push({
          status: 'rejected',
          reason: e,
          // evidenceRecorder can genuinely be null here -- createEvidenceRecorder itself is what
          // threw (a malformed-input edge case, never observed in production; every input it
          // takes is already validated earlier in this method).
          value: {
            pullTxHash,
            receipt: evidenceRecorder?.receipt ?? null,
            receiptEvidenceDurable: evidenceRecorder?.durable ?? false,
          },
        })
      }
      if (i < workers.length - 1) await new Promise((r) => setTimeout(r, DISPATCH_INTERVAL_MS))
      this.assertCurrentAccount()
    }

    const results = workerResults.map((r, i) => ({
      agentId: workers[i].agentId,
      allocationId: workers[i].allocationId,
      vault: workers[i].vault,
      agentAddress: workers[i].agentAddress,
      success: r.status === 'fulfilled' && r.value?.success === true,
      txHash: r.value?.txHash ?? null,
      pullTxHash: r.value?.pullTxHash ?? null,
      custody: r.value?.receipt?.custody ?? null,
      receipt: r.value?.receipt ?? null,
      // False only when a bounded write/read/retry could not prove the evidence durable; the
      // following movement has already been aborted for write-ahead intent failures.
      receiptEvidenceDurable: r.value?.receiptEvidenceDurable ?? null,
      error: r.reason?.message || r.value?.error,
    }))
    const completed = results.filter((r) => r.success).length
    const failed = results.length - completed

    return { completed, failed, results, sessionId: this.sessionId, permission: confirmed }
  }

  /** After the shared fresh grant confirms, both execution branches are settled data. A Base
   * failure must therefore never erase completed Stellar deposits (and vice versa). */
  async dispatchConfirmedMixed({ strategyPlan, confirmed, workers, bridgeAgent, baseMandate }) {
    const mandate = baseMandate
    const bridgeWorker = workers.find((worker) => worker.allocationId === bridgeAgent.allocationId)
    const bridgeMaterialError =
      !bridgeWorker?.agentAddress || !bridgeWorker.sessionKey
        ? 'The confirmed grant did not return the reviewed bridge agent material.'
        : null
    const stellarWorkers = workers.filter((worker) => worker !== bridgeWorker)
    stellarWorkers.forEach((worker, index) => {
      this.onEvent('worker-queued', {
        allocationId: worker.allocationId,
        agentId: worker.agentId,
        agent: worker.agentAddress,
        queueIndex: index,
      })
    })
    const runStellar = async () => {
      const settled = []
      for (let index = 0; index < stellarWorkers.length; index++) {
        const worker = stellarWorkers[index]
        this.onEvent('worker-started', {
          allocationId: worker.allocationId,
          agentId: worker.agentId,
          agent: worker.agentAddress,
          queueIndex: index,
        })
        let pullTxHash = null
        let movedToAgent = false
        // Task 6 chunk C1 -- one AllocationReceiptV2 per worker, opened BEFORE either
        // submission, constructed INSIDE the try block (not before it) so even a malformed-input
        // throw from createAllocationReceipt isolates to THIS worker, never the whole loop. Same
        // reasoning as dispatchPermissioned's plain loop above. `custody` below (CustodyV1:
        // {location,confirmed,checkedAt}) is the PRE-EXISTING legacy vocabulary
        // dispatchSummary.js's buildDispatchReceipt already consumes -- left completely
        // untouched. `allocationReceipt` is the NEW evidence, added alongside it under its own
        // name so nothing downstream collides.
        let evidenceRecorder = null
        try {
          const receiptAmount = {
            token: SOROBAN_TOKEN_ADDRESS,
            units: worker.amount.toString(),
            decimals: SOROBAN_DECIMALS,
          }
          evidenceRecorder = createEvidenceRecorder({
            runId: strategyPlan.runId,
            allocationId: worker.allocationId,
            owner: this.user,
            agentAddress: worker.agentAddress,
            sessionKey: worker.sessionKey,
            worker: worker.sessionKey?.publicKey,
            amount: receiptAmount,
            onEvent: this.onEvent,
          })
          const balance = await readTokenBalance(worker.agentAddress)
          this.assertCurrentAccount()
          movedToAgent = balance != null && balance >= worker.amount
          if (balance == null || balance < worker.amount) {
            await evidenceRecorder.record({ phase: 'pull', status: 'submitted', evidence: {} })
            let pulled
            try {
              pulled = await runAgentPull({
                agentAddress: worker.agentAddress,
                amount: worker.amount,
                sessionKey: worker.sessionKey,
                activeAccount: this.activeAccount,
                getCurrentActiveAccount: this.getCurrentActiveAccount,
                signal: this.signal,
              })
              this.assertCurrentAccount()
              if (!pulled) throw new Error('The Stellar relay is unavailable.')
              if (pulled.status !== 'SUCCESS')
                throw new Error(`The funding router returned ${pulled.status}.`)
              pullTxHash = pulled.hash || null
              movedToAgent = true
              await evidenceRecorder.record({
                phase: 'pull',
                status: 'confirmed',
                evidence: { txHash: pullTxHash },
              })
              evidenceRecorder.custody({
                location: 'stellar-agent',
                txSuccess: true,
                amount: receiptAmount,
              })
            } catch (pullError) {
              if (pullError?.code === 'VF_SUBMISSION_UNKNOWN') {
                await evidenceRecorder.record({
                  phase: 'pull',
                  status: 'unknown',
                  evidence: { reason: pullError.message, txHash: pullError.result?.hash ?? null },
                })
                evidenceRecorder.custody({ location: 'unknown', reason: pullError.message })
              } else {
                await evidenceRecorder.record({
                  phase: 'pull',
                  status: 'failed',
                  evidence: { reason: pullError.message },
                })
              }
              throw pullError
            }
          } else {
            // CRITICAL fix round 1 -- same reasoning as dispatchPermissioned's plain loop above:
            // the agent already holds the funds, so the balance READ just performed IS the proof
            // of stellar-agent custody. Without this, a receipt whose pull was skipped opens at
            // owner/confirmed with pull:not_started -- if the deposit then fails, recovery
            // reading that receipt would authorize a duplicate pull of funds already at the
            // agent. Money would move twice.
            evidenceRecorder.custody({
              location: 'stellar-agent',
              txSuccess: true,
              amount: receiptAmount,
            })
          }
          await evidenceRecorder.record({
            phase: 'stellar_deposit',
            status: 'submitted',
            evidence: {},
          })
          const deposited = await worker.execute()
          this.assertCurrentAccount()
          if (deposited?.success) {
            await evidenceRecorder.record({
              phase: 'stellar_deposit',
              status: 'confirmed',
              evidence: { txHash: deposited.txHash },
            })
            evidenceRecorder.custody({
              location: 'stellar-vault',
              txSuccess: true,
              matchingEvent: true,
              amount: receiptAmount,
            })
          } else if (deposited?.status === 'unknown') {
            await evidenceRecorder.record({
              phase: 'stellar_deposit',
              status: 'unknown',
              evidence: { reason: deposited.error, txHash: deposited.txHash ?? null },
            })
            evidenceRecorder.custody({ location: 'unknown', reason: deposited.error })
          } else {
            await evidenceRecorder.record({
              phase: 'stellar_deposit',
              status: 'failed',
              evidence: { reason: deposited?.error, txHash: deposited?.txHash ?? null },
            })
            if (deposited?.txSuccess) {
              // Minor fix round 1 -- pass `amount` for uniformity; see the plain loop's identical
              // comment above.
              evidenceRecorder.custody({
                location: 'stellar-vault',
                txSuccess: true,
                matchingEvent: false,
                amount: receiptAmount,
              })
            }
          }
          settled.push({
            status: 'fulfilled',
            value: {
              ...deposited,
              agentAddress: worker.agentAddress,
              pullTxHash,
              depositTxHash: deposited?.txHash || null,
              custody: deposited?.custody || {
                location: 'unknown',
                confirmed: false,
                checkedAt: null,
              },
              allocationReceipt: evidenceRecorder.receipt,
              receiptEvidenceDurable: evidenceRecorder.durable,
            },
          })
        } catch (reason) {
          settled.push({
            status: 'rejected',
            reason,
            value: {
              agentAddress: worker.agentAddress,
              pullTxHash,
              custody: movedToAgent
                ? { location: 'agent', confirmed: true, checkedAt: null }
                : { location: 'unknown', confirmed: false, checkedAt: null },
              allocationReceipt: evidenceRecorder?.receipt ?? null,
              receiptEvidenceDurable: evidenceRecorder?.durable ?? false,
            },
          })
        }
        if (index < stellarWorkers.length - 1)
          await new Promise((resolve) => setTimeout(resolve, DISPATCH_INTERVAL_MS))
        this.assertCurrentAccount()
      }
      return settled.map((entry, index) => ({
        allocationId: stellarWorkers[index].allocationId,
        agentId: stellarWorkers[index].agentId,
        vault: stellarWorkers[index].vault,
        success: entry.status === 'fulfilled' && entry.value?.success,
        txHash: entry.value?.depositTxHash || entry.value?.txHash,
        pullTxHash: entry.value?.pullTxHash || null,
        depositTxHash: entry.value?.depositTxHash || null,
        agentAddress: entry.value?.agentAddress || stellarWorkers[index].agentAddress,
        custody: entry.value?.custody,
        allocationReceipt: entry.value?.allocationReceipt,
        // See the plain loop's identical field for the bounded durability contract.
        receiptEvidenceDurable: entry.value?.receiptEvidenceDurable ?? null,
        error: entry.reason?.message || entry.value?.error,
      }))
    }
    const bridgeChildren = bridgeAgent.children || []
    const runBase = async () => {
      if (bridgeMaterialError) {
        return {
          success: false,
          runId: strategyPlan.runId,
          grantTxHash: confirmed.txHash,
          error: bridgeMaterialError,
          allocations: bridgeChildren.map((child) => ({
            allocationId: child.allocationId,
            amount: child.allocation,
            error: bridgeMaterialError,
            custody: { location: 'unknown', confirmed: false, checkedAt: null },
          })),
        }
      }
      const baseVaults = bridgeChildren.map((child) => ({
        address: child.address,
        allocationId: child.allocationId,
        allocationAmount: child.allocation,
        amountBaseUnits: BigInt(child.allocation.units),
        allocation: 1,
      }))
      const { executeBaseLeg } = await import('./baseLeg.js')
      this.assertCurrentAccount()
      const baseCustodyDeps = bindBaseLegCustodyDeps({
        activeAccount: this.activeAccount,
        getCurrentActiveAccount: this.getCurrentActiveAccount,
        signal: this.signal,
      })
      const result = await executeBaseLeg({
        connectedAddress: this.baseLegContext.connectedAddress,
        bridgeAgentAddress: bridgeWorker.agentAddress,
        bridgeSessionKey: bridgeWorker.sessionKey,
        kernelAddress: mandate.kernelAddress,
        baseVaults,
        totalAmount: 0,
        runId: strategyPlan.runId,
        grantTxHash: confirmed.txHash,
        onEvent: (name, data) => this.onEvent(name, data),
        deps: baseCustodyDeps,
      })
      return reconcileBaseLegEpochCustody(result, baseCustodyDeps)
    }
    const [stellarSettled, baseSettled] = await Promise.allSettled([runStellar(), runBase()])
    this.assertCurrentAccount()
    const stellarResults =
      stellarSettled.status === 'fulfilled'
        ? stellarSettled.value
        : stellarWorkers.map((worker) => ({
            allocationId: worker.allocationId,
            success: false,
            error: stellarSettled.reason?.message || String(stellarSettled.reason),
          }))
    const baseLeg =
      baseSettled.status === 'fulfilled'
        ? baseSettled.value
        : {
            success: false,
            runId: strategyPlan.runId,
            grantTxHash: confirmed.txHash,
            bridgeAgent: bridgeWorker?.agentAddress || null,
            kernelAddress: mandate.kernelAddress,
            error: baseSettled.reason?.message || String(baseSettled.reason),
            allocations: bridgeChildren.map((child) => ({
              allocationId: child.allocationId,
              amount: child.allocation,
              success: false,
              bridgeAgentAddress: bridgeWorker?.agentAddress || null,
              kernelAddress: mandate.kernelAddress,
              recovery: { kind: 'base-branch-rejected' },
              custody: { location: 'unknown', confirmed: false, checkedAt: null },
              error: baseSettled.reason?.message || String(baseSettled.reason),
            })),
          }
    const receipt = buildDispatchReceipt({
      plan: strategyPlan,
      permission: confirmed,
      branches: {
        stellar: { results: stellarResults },
        base: {
          status: baseLeg.success === false ? 'failed' : undefined,
          results: baseLeg.allocations || [],
        },
      },
    })
    const completed = stellarResults.filter((result) => result.success).length
    return {
      completed,
      failed: stellarResults.length - completed,
      results: stellarResults,
      sessionId: this.sessionId,
      permission: confirmed,
      baseLeg,
      receipt,
    }
  }

  /**
   * Task 5 chunk B — V3 mirror of `runAgentPull` (grant.js): resolve the relayer, build the
   * agent-signed `pull_v3` envelope, submit via the SAME gasless relay, with the SAME
   * active-account boundary checks around every await. `permissionId`/`executionId` come from the
   * decision `revalidateReuse` just canonically re-proved — this method never mints or
   * recomputes either (Controller ruling 1: `executionId` is deterministic; a minted id would move
   * real funds twice on an indeterminate-submission retry). `buildAgentPullV3` itself throws
   * unless the router resolves to version 3 (grant.js's own `assertRouterV3`), so this method can
   * only ever move funds once a real V3 router is registered — THE DORMANCY CONTRACT, unaffected
   * by anything in this file.
   * @returns {Promise<{hash:string, status:string, relayer?:string}|null>}
   */
  async runAgentPullV3({ permissionId, executionId, agentAddress, amount, sessionKey, router }) {
    const check = () =>
      assertActiveAccountBoundary({
        captured: this.activeAccount,
        getCurrent: this.getCurrentActiveAccount,
        signal: this.signal,
      })
    check()
    const { getRelayerAddress, submitViaRelay } = await import('./stellar/relay.js')
    const relayer = await getRelayerAddress()
    check()
    if (!relayer) return null
    const { buildAgentPullV3 } = await import('./stellar/grant.js')
    const { xdr } = await buildAgentPullV3({
      permissionId,
      executionId,
      agentAddress,
      amount,
      relayer,
      sessionKey,
      // Fix round 1, Important 1: pin to the router THIS permission was proven against
      // (revalidated.router), never the global config default — the two must never silently
      // diverge on the money path.
      router,
    })
    check()
    let result
    try {
      result = await submitViaRelay({ xdr, ...(this.signal ? { signal: this.signal } : {}) })
    } catch (error) {
      try {
        check()
      } catch (cause) {
        throw activeAccountSubmissionUnknown({ stage: 'pull', cause, result })
      }
      throw error
    }
    try {
      check()
    } catch (cause) {
      throw activeAccountSubmissionUnknown({ stage: 'pull', cause, result })
    }
    return result
  }

  /** Both modes: reject before any wallet/provider/movement when the reviewed decision no longer
   * describes THIS exact plan — a stale planFingerprint, or a reviewed agent whose cap/expiry/
   * period/target drifted from what the plan now says. `PermissionPhaseError(phase:'preflight')`.
   * Deliberately excludes signer/salt from this STRUCTURAL comparison — that verification is
   * mode-specific and happens separately, immediately before either mode's material actually gets
   * used: fresh mode's `grantFreshFromDecision` fetches + fingerprint-verifies the prepared
   * execution material (`fetchPreparedExecutionMaterial`, never regenerates it); reuse mode's
   * `revalidateReuse` re-proves signer continuity on-chain. */
  assertPermissionMatchesPlan(strategyPlan, permissionDecision, planAgents) {
    if (
      !permissionDecision ||
      strategyPlan.planFingerprint !== permissionDecision.planFingerprint
    ) {
      throw new PermissionPhaseError({
        phase: 'preflight',
        code: 'VF_PLAN_FINGERPRINT_MISMATCH',
        message: 'The reviewed permission decision no longer matches this plan.',
      })
    }
    const reviewed = permissionDecision.reviewedAgentInits || []
    const matches =
      planAgents.length === reviewed.length &&
      planAgents.every((agent, i) => {
        const r = reviewed[i]
        return (
          r &&
          r.allocationId === agent.allocationId &&
          r.kind === (agent.kind === 'bridge' ? AGENT_KIND_BRIDGE : AGENT_KIND_DEPOSIT) &&
          (agent.kind === 'bridge' || r.target === SOROBAN_ACTIVE_VAULT_ADDRESS) &&
          r.token === agent.cap.token &&
          r.cap?.token === agent.cap.token &&
          String(r.cap?.units) === String(agent.cap.units) &&
          Number(r.cap?.decimals) === Number(agent.cap.decimals) &&
          Number(r.periodSeconds) === Number(agent.periodSeconds) &&
          Number(r.expiry) === Number(agent.expiry)
        )
      })
    if (!matches) {
      throw new PermissionPhaseError({
        phase: 'preflight',
        code: 'VF_AGENT_INIT_FINGERPRINT_MISMATCH',
        message: 'The reviewed agent set no longer matches this plan.',
      })
    }
  }

  /**
   * Reuse mode's ONE revalidation gate, run immediately before the first pull. Never builds or
   * submits a grant, never touches the wallet/provider — it re-runs Task 5's own
   * `preflightPermission` (a fresh latest-ledger capture, a fresh no-later-mutation proof, a fresh
   * per-agent on-chain scope re-check) against the SAME reviewed agent set. Signer/salt are
   * deliberately OMITTED from the structural agentInits passed in — `preflightPermission` resolves
   * them itself from the SAME prepared-execution material this candidate's original fresh review
   * generated (reusePreflight.js), reproducing the review-time fingerprint exactly instead of this
   * method reconstructing (and hoping to match) it. Session-key AVAILABILITY (can we still sign
   * with the deployed agent?) is a separate, explicit check against agentCache.js, read exactly
   * once here and returned as `credentialByAllocation` so `buildReuseWorkers` never re-reads it.
   * Any drift — mode flips away from reuse, the receipt/agent-init fingerprint changes, a picked
   * address or its scope fingerprint changes, or a session key is no longer cached — is evidence
   * the world moved since review: `PermissionPhaseError(phase:'reuse-revalidation',
   * code:'VF_REUSE_EVIDENCE_CHANGED')`, never a silent fallback to a fresh wallet signature.
   * @returns {Promise<{revalidated:object, credentialByAllocation:Map}>}
   */
  async revalidateReuse(strategyPlan, permissionDecision, planAgents) {
    const { loadCachedAgents } = await import('./stellar/agentCache.js')
    // Task 5 chunk B: a V3 decision (permissionGrantV3.proveReusablePermission's shape) carries
    // its originally-picked set as `executions[]`, not V2's `agents[]` — there is no `agents`
    // field on a V3 decision at all. Both shapes carry `{allocationId, agentAddress, ...}`, so
    // everything below reads through the SAME `pickedByAllocation` map regardless of version.
    const pickedList =
      permissionDecision.version === 3 ? permissionDecision.executions : permissionDecision.agents
    const pickedByAllocation = new Map((pickedList || []).map((a) => [a.allocationId, a]))
    const cachedByAddress = new Map(
      loadCachedAgents({ owner: this.user, vault: SOROBAN_ACTIVE_VAULT_ADDRESS }).map((e) => [
        e.agentAddress,
        e,
      ])
    )

    const credentialByAllocation = new Map()
    const agentInits = planAgents.map((agent) => {
      const picked = pickedByAllocation.get(agent.allocationId)
      const cached = picked ? cachedByAddress.get(picked.agentAddress) : null
      if (!picked || !cached || !cached.secret) {
        throw new PermissionPhaseError({
          phase: 'reuse-revalidation',
          code: 'VF_REUSE_EVIDENCE_CHANGED',
          message: `The session key for allocation ${agent.allocationId} is no longer available.`,
        })
      }
      credentialByAllocation.set(agent.allocationId, { agentAddress: picked.agentAddress, cached })
      return {
        allocationId: agent.allocationId,
        cap: { token: agent.cap.token, units: agent.cap.units, decimals: agent.cap.decimals },
        token: agent.cap.token,
        target: SOROBAN_ACTIVE_VAULT_ADDRESS,
        kind: AGENT_KIND_DEPOSIT,
        mintRecipient: ZERO32,
        destinationDomain: 0,
        periodSeconds: agent.periodSeconds,
        expiry: agent.expiry,
      }
    })

    const { preflightPermission } = await import('./strategy/reusePreflight.js')
    let revalidated
    try {
      revalidated = await preflightPermission({
        runId: permissionDecision.runId,
        owner: this.user,
        planFingerprint: strategyPlan.planFingerprint,
        agentInits,
        reviewedBudgets: permissionDecision.reviewedBudgets,
        durationSeconds: permissionDecision.durationSeconds,
        // Task 5 chunk B — V3-only inputs, read straight off the reviewed decision (never
        // reconstructed). `preflightPermission`'s V2 branch (the block above this comment in
        // reusePreflight.js) reads none of these, so passing them on a V2 decision — where
        // they're simply undefined — is inert. `resolveSchema` is deliberately left unset so it
        // keeps its real default (`resolveRouterSchema`): THE DORMANCY CONTRACT means this call
        // can only ever reach permissionGrantV3.proveReusablePermission the day a V3 router
        // address is actually registered in ROUTER_SCHEMAS, never by anything this file does.
        // `currentLedger` and the five V3 chain-read seams have no production source yet (see the
        // task report) and are deliberately left unset rather than guessed — inert under
        // dormancy, not silently wrong.
        router: permissionDecision.router,
        permissionId: permissionDecision.permissionId,
        approval: permissionDecision.approval,
        activeAccount: this.activeAccount,
        getCurrentActiveAccount: this.getCurrentActiveAccount,
      })
    } catch (err) {
      throw new PermissionPhaseError({
        phase: 'reuse-revalidation',
        code: 'VF_REUSE_EVIDENCE_CHANGED',
        message: `Reuse revalidation failed: ${err.message}`,
        cause: err,
      })
    }

    // Evidence-changed gate: V3's identity/drift signals (permissionId, scopeId, the per-
    // allocation executionId — deterministic over {runId, allocationId, scopeId, amountUnits}, so
    // any of those drifting changes it) have no V2 equivalent, and vice versa
    // (agentInitFingerprint/grantReceiptFingerprint/scopeFingerprint don't exist on a V3
    // decision) — hence the version-gated branch below. A version flip between the reviewed
    // decision and the fresh re-read (i.e. the router generation itself changed under us) is
    // ALSO evidence-changed, never a silent shape-mix.
    const evidenceMatches =
      revalidated.mode === 'reuse' &&
      revalidated.version === permissionDecision.version &&
      (revalidated.version === 3
        ? revalidated.scopeId === permissionDecision.scopeId &&
          revalidated.permissionId === permissionDecision.permissionId &&
          Array.isArray(revalidated.executions) &&
          revalidated.executions.length > 0 &&
          revalidated.executions.length === (permissionDecision.executions || []).length &&
          revalidated.executions.every((e) => {
            const before = pickedByAllocation.get(e.allocationId)
            return (
              before &&
              before.agentAddress === e.agentAddress &&
              before.executionId === e.executionId
            )
          })
        : revalidated.agentInitFingerprint === permissionDecision.agentInitFingerprint &&
          revalidated.grantReceiptFingerprint === permissionDecision.grantReceiptFingerprint &&
          Array.isArray(revalidated.agents) &&
          revalidated.agents.length === (permissionDecision.agents || []).length &&
          revalidated.agents.every((a) => {
            const before = pickedByAllocation.get(a.allocationId)
            return (
              before &&
              before.agentAddress === a.agentAddress &&
              before.scopeFingerprint === a.scopeFingerprint
            )
          }))

    if (!evidenceMatches) {
      throw new PermissionPhaseError({
        phase: 'reuse-revalidation',
        code: 'VF_REUSE_EVIDENCE_CHANGED',
        message: 'Reuse evidence changed since it was reviewed.',
      })
    }

    return { revalidated, credentialByAllocation }
  }

  /** Task 2's `toDispatchStrategy` already narrows a StrategyPlan to eligible-only allocations
   * before it ever reaches dispatch — this worker-level check (worker.js "Enforcement B") is
   * defense-in-depth against an accidental code-path skip, not a second gate. A synthetic, freshly
   * timestamped pass token honestly reflects that upstream guarantee without re-plumbing Task 3's
   * eligibilityGate.js verdict objects through the plan/permission-decision contract.
   * // ponytail: synthetic pass token — revisit if a future task needs a real per-allocation
   * // eligibility verdict at this exact seam. */
  reviewedEligibilityToken() {
    return {
      protocolSlug: null,
      planIndex: 0,
      eligible: true,
      verdictHash: 'plan-reviewed',
      asOf: Date.now(),
    }
  }

  /** Reuse-mode worker construction: EXACTLY the credentials `revalidateReuse` just re-proved and
   * already read once (`credentialByAllocation`) — never a fresh deploy, never a different cache
   * pick, and never a SECOND cache read (a race between the two reads could otherwise disagree
   * with what was just revalidated). A credential missing here — it was already checked once in
   * `revalidateReuse`, so this is belt-and-braces, not the primary gate — is a typed
   * `PermissionPhaseError`, never a raw `TypeError` from indexing into `undefined`. */
  buildReuseWorkers(planAgents, revalidated, credentialByAllocation) {
    // Same version-gated shape as revalidateReuse's pickedByAllocation above — a V3 `revalidated`
    // has `executions[]`, not `agents[]`.
    const pickedList = revalidated.version === 3 ? revalidated.executions : revalidated.agents
    const pickedByAllocation = new Map((pickedList || []).map((a) => [a.allocationId, a]))
    return planAgents.map((agent) => {
      const picked = pickedByAllocation.get(agent.allocationId)
      const credential = credentialByAllocation.get(agent.allocationId)
      if (!picked || !credential) {
        throw new PermissionPhaseError({
          phase: 'reuse-revalidation',
          code: 'VF_REUSE_EVIDENCE_CHANGED',
          message: `No validated credential for allocation ${agent.allocationId}.`,
        })
      }
      return new WorkerAgent({
        agentId: agent.allocationId,
        allocationId: agent.allocationId,
        user: this.user,
        vault: SOROBAN_ACTIVE_VAULT_ADDRESS,
        // The plan's own bigint unit string, never a float re-multiplication of a decimal amount —
        // the validated plan and the executed units must be the exact same number.
        amount: BigInt(agent.cap.units),
        sessionId: this.sessionId,
        onEvent: this.onEvent,
        agentAddress: credential.agentAddress,
        sessionKey: newSessionKey(credential.cached.secret),
        eligibilityToken: this.reviewedEligibilityToken(),
        // Review round 1, Important 2 -- without this, runAgentDeposit's indeterminate-outcome
        // check (agentDeposit.js) is a permanent no-op on the deposit leg (captured==null), even
        // though the pull leg is armed with these same three fields everywhere it runs. Threading
        // them here is what makes VF_SUBMISSION_UNKNOWN reachable on the deposit leg at all.
        activeAccount: this.activeAccount,
        getCurrentActiveAccount: this.getCurrentActiveAccount,
        signal: this.signal,
      })
    })
  }

  /** Fresh-mode worker construction — no `agentAddress` yet (the grant deploys it). */
  buildFreshWorkers(planAgents) {
    return planAgents.map(
      (agent) =>
        new WorkerAgent({
          agentId: agent.allocationId,
          allocationId: agent.allocationId,
          user: this.user,
          vault: SOROBAN_ACTIVE_VAULT_ADDRESS,
          // Same bigint-units rule as buildReuseWorkers above — see its comment.
          amount: BigInt(agent.cap.units),
          sessionId: this.sessionId,
          onEvent: this.onEvent,
          agentAddress: null,
          eligibilityToken: this.reviewedEligibilityToken(),
          // Review round 1, Important 2 -- see buildReuseWorkers' identical comment above.
          activeAccount: this.activeAccount,
          getCurrentActiveAccount: this.getCurrentActiveAccount,
          signal: this.signal,
        })
    )
  }

  /**
   * Fresh mode's ONE grant. Builds AgentInits strictly from `permissionDecision.reviewedAgentInits`
   * — cap/token/target/kind/period/expiry/mintRecipient/destinationDomain are never regenerated
   * from the plan or a fresh `Date.now()` expiry. Critical fix (review round 2): the signer/salt
   * are ALSO never regenerated here — `w.setupKey()` and grant.js's random-salt fallback used to
   * mint UNREVIEWED material at dispatch time, poisoning the saved receipt's fingerprint forever
   * (a later preflight could never reproduce it, so `mode:'reuse'` became permanently
   * unreachable). Instead this fetches the material `preflightPermission` generated + persisted at
   * REVIEW time (reusePreflight.js's `fetchPreparedExecutionMaterial`) and VERIFIES it still
   * matches `reviewedAgentInits[].signerFingerprint`/`.saltFingerprint` before using it. Missing or
   * mismatched material invalidates the reviewed run — `PermissionPhaseError(phase:'fresh-grant',
   * code:'VF_PREPARED_MATERIAL_MISSING')` — never a silent re-generation. Any wallet rejection,
   * build/simulation failure, submission failure, or unconfirmed on-chain deployment is also
   * `PermissionPhaseError(phase:'fresh-grant')` — no worker ever starts. Calls `submitGrant`
   * exactly once; never touches the reuse cache reads.
   */
  async grantFreshFromDecision(strategyPlan, workers, permissionDecision) {
    const reviewedByAllocation = new Map(
      (permissionDecision.reviewedAgentInits || []).map((r) => [r.allocationId, r])
    )
    const { fetchPreparedExecutionMaterial } = await import('./strategy/reusePreflight.js')
    this.assertCurrentAccount()

    const agentInits = workers.map((w) => {
      const r = reviewedByAllocation.get(w.allocationId)
      const material = fetchPreparedExecutionMaterial({
        owner: this.user,
        planFingerprint: strategyPlan.planFingerprint,
        allocationId: w.allocationId,
        reviewedAgentInit: r,
      })
      if (!material) {
        throw new PermissionPhaseError({
          phase: 'fresh-grant',
          code: 'VF_PREPARED_MATERIAL_MISSING',
          message: `No prepared execution material for allocation ${w.allocationId} matches the reviewed decision. This run must be re-reviewed.`,
        })
      }
      w.sessionKey = newSessionKey(material.signerSecret)
      return {
        signer: material.signer,
        salt: material.salt,
        cap: BigInt(r.cap.units),
        token: r.cap.token,
        target: r.target,
        kind: r.kind,
        mintRecipient: r.mintRecipient ? hexToBytes32(r.mintRecipient) : ZERO32,
        destinationDomain: r.destinationDomain ?? 0,
        periodDuration: r.periodSeconds,
        expiry: r.expiry,
      }
    })
    const budgets = (permissionDecision.reviewedBudgets || []).map((b) => ({
      budget: BigInt(b.units),
      token: b.token,
    }))

    let submitted
    try {
      submitted = await submitGrant({
        owner: this.user,
        ...(this.activeAccount ? { activeAccount: this.activeAccount } : {}),
        getCurrentActiveAccount: this.getCurrentActiveAccount,
        signal: this.signal,
        budgets,
        durationSeconds: permissionDecision.durationSeconds,
        agentInits,
      })
      this.assertCurrentAccount()
    } catch (err) {
      throw new PermissionPhaseError({
        phase: 'fresh-grant',
        code: err instanceof PermissionPhaseError ? err.code : 'VF_GRANT_FAILED',
        message: err.message,
        cause: err,
      })
    }
    if (
      !submitted?.hash ||
      !Array.isArray(submitted.agentAddresses) ||
      submitted.agentAddresses.length !== workers.length ||
      submitted.agentAddresses.some(
        (address) => typeof address !== 'string' || address.length === 0
      )
    ) {
      throw new PermissionPhaseError({
        phase: 'fresh-grant',
        code: 'VF_GRANT_EVIDENCE_MISSING',
        message: 'The grant did not return a complete reviewed agent deployment record.',
      })
    }

    const { readConfirmedLedger } = await import('./stellar/grant.js')
    let confirmedLedger
    let confirmedAt
    try {
      ;({ confirmedLedger, confirmedAt } = await readConfirmedLedger({ hash: submitted.hash }))
      this.assertCurrentAccount()
    } catch (err) {
      throw new PermissionPhaseError({
        phase: 'fresh-grant',
        code: 'VF_GRANT_UNCONFIRMED',
        message: `The grant did not confirm on-chain: ${err.message}`,
        cause: err,
      })
    }

    workers.forEach((w, i) => {
      this.assertCurrentAccount()
      w.agentAddress = submitted.agentAddresses[i]
      saveCachedAgent({
        owner: this.user,
        vault: SOROBAN_ACTIVE_VAULT_ADDRESS,
        entry: {
          agentAddress: w.agentAddress,
          secret: w.sessionKey.secret,
          signerPub: w.sessionKey.publicKey,
          cap: String(w.amount),
          expiry: reviewedByAllocation.get(w.allocationId).expiry,
          createdAt: Date.now(),
        },
      })
    })

    // Save + fingerprint the GrantReceiptV1 BEFORE dispatchPermissioned emits 'grant-confirmed' —
    // that event IS the "permission is now active" signal a caller (app.jsx) waits on, so the
    // receipt must already be durable when it fires.
    const { buildGrantReceiptV1, saveGrantReceipt, fingerprintGrantReceipt } =
      await import('./stellar/grantReceiptStore.js')
    this.assertCurrentAccount()
    const { SOROBAN_FUNDING_ROUTER_ADDRESS } = await import('./stellar/config.js')
    this.assertCurrentAccount()
    const receipt = buildGrantReceiptV1({
      runId: strategyPlan.runId,
      owner: this.user,
      router: SOROBAN_FUNDING_ROUTER_ADDRESS,
      txHash: submitted.hash,
      confirmedLedger,
      expiryLedger: submitted.expiryLedger,
      allowanceBudgets: permissionDecision.reviewedBudgets,
      agentInitFingerprint: permissionDecision.agentInitFingerprint,
      agentAddresses: submitted.agentAddresses,
      confirmedAt,
    })
    this.assertCurrentAccount()
    saveGrantReceipt({ receipt })

    return {
      agentAddresses: submitted.agentAddresses,
      txHash: submitted.hash,
      expiryLedger: submitted.expiryLedger,
      confirmedLedger,
      confirmedAt,
      grantReceiptFingerprint: fingerprintGrantReceipt(receipt),
    }
  }

  async dispatchLegacy(strategy, totalAmount) {
    const allVaults = strategy.vaults || []
    const receiptRunId = strategy.runId || this.sessionId
    const baseVaults = allVaults
      .filter((v) => v.chain === 'base')
      .map((vault, index) => ({
        ...vault,
        allocationId: vault.allocationId || `${receiptRunId}:bridge:${index}`,
      }))
    const stellarVaults = allVaults.filter((v) => v.chain !== 'base')
    if (baseVaults.length > 0 && !this.baseLegContext) {
      throw new Error('strategy contains base vaults but no base leg context was provided')
    }

    // Base-leg balance preflight — the burn spends STELLAR_USDC_SAC, a DIFFERENT asset from
    // SOROBAN_TOKEN_ADDRESS (VFUSD, checked below for the Stellar leg), so it can't be folded into
    // that total; it needs its own read. Mirrors the Stellar preflight's behavior: throw here and
    // dispatch aborts entirely, before either leg does any work (same fail-fast contract as the
    // pre-existing VFUSD check inside runStellarLegs).
    if (baseVaults.length > 0) {
      const legAmount = baseVaults.reduce((sum, v) => sum + totalAmount * v.allocation, 0)
      const { burnUnits7 } = deriveCctpTransferUnits(legAmount)
      const burnBal = await readTokenBalance(this.user, { token: STELLAR_USDC_SAC })
      this.assertCurrentAccount()
      if (burnBal != null && burnBal < burnUnits7) {
        throw new Error(
          `Insufficient USDC for the cross-chain leg: have ${(Number(burnBal) / BASE_UNIT).toFixed(2)}, need ${(Number(burnUnits7) / BASE_UNIT).toFixed(2)} to burn via CCTP.`
        )
      }
    }
    const stellarStrategy = { ...strategy, vaults: stellarVaults }
    const scopeTtl = this.grantDurationSeconds || SCOPE_TTL_SECONDS
    const expiry = Math.floor(Date.now() / 1000) + scopeTtl

    // Grant-covers-burn (docs/superpowers/specs/2026-07-21-grant-covers-burn-design.md §4-5): a
    // mixed run's bridge agent joins the SAME single grant as the Stellar deposit workers — never
    // a second signature ("Run campuran: 1 ttd grant, 0 passkey"). mint_recipient is pinned to the
    // ALREADY-valid stored Base mandate's kernel address; app.jsx's preflight
    // (checkStoredBaseMandate) guarantees one exists before Base is ever offered as a strategy
    // option, so this is a read, never a fresh ceremony.
    let bridgeInit = null
    let bridgeSessionKey = null
    // Threaded into executeBaseLeg below (never re-read from storage there) — the exact
    // kernelAddress this grant pinned as mint_recipient, so a mid-run mandate rotation can't
    // desync the runtime burn arg from what's actually on-chain (see baseLeg.js's own doc).
    let bridgeKernelAddress = null
    if (baseVaults.length > 0) {
      // Owner-scoped v3 record only — never the removed global vf_base_mandate reader, so a
      // wallet switch can never pin another owner's kernel as this grant's mint_recipient.
      const mandate = readBaseMandate(this.user)
      if (!mandate) {
        throw new Error('No durable Base mandate is stored for the cross-chain leg.')
      }
      bridgeKernelAddress = mandate.kernelAddress
      const legAmount = baseVaults.reduce((sum, v) => sum + totalAmount * v.allocation, 0)
      const { burnUnits7: bridgeCap } = deriveCctpTransferUnits(legAmount)
      bridgeSessionKey = newSessionKey()
      bridgeInit = {
        signer: bridgeSessionKey.rawPublicKey,
        cap: bridgeCap,
        token: STELLAR_USDC_SAC,
        target: STELLAR_TOKEN_MESSENGER_MINTER,
        kind: AGENT_KIND_BRIDGE,
        mintRecipient: evmAddrToBytes32(bridgeKernelAddress),
        destinationDomain: CCTP_BASE_DOMAIN,
        periodDuration: PERIOD_DURATION,
        expiry,
      }
    }

    // Resolves once the run's grant (or the no-grant-needed/legacy path) names the bridge agent.
    // The Base leg branch below awaits this before doing any work, so Promise.allSettled still
    // fires both branches immediately, but the Base leg's real work blocks on the SAME grant the
    // Stellar branch triggers inside setupViaRouter — one signature covers both legs. `finally`
    // (in runStellarLegs below) guarantees this always settles even if the Stellar branch throws
    // before ever reaching setup (e.g. the VFUSD preflight) — otherwise the Base leg would hang.
    let resolveBridgeAgent
    const bridgeAgentReady = new Promise((resolve) => {
      resolveBridgeAgent = resolve
    })
    // Captured at the setup boundary before either execution branch moves funds. Keeping it
    // outside the Stellar closure preserves confirmed permission truth if execution later rejects.
    let legacyPermissionEvidence = null

    // Stellar leg — MOVED verbatim from the pre-Task-8 dispatch body (only `strategy` →
    // `stellarStrategy` at the vaultPlans line changed) into a local closure so it can run as one
    // settled branch of Promise.allSettled alongside the Base leg below.
    const runStellarLegs = async () => {
      try {
        // Review round 2 fix: the per-vault ON-CHAIN unit amount is derived via
        // decimalToUnits(totalAmount) + a bigint-exact ratio split (splitUnitsByRatio above) —
        // never `Math.floor(totalAmount * v.allocation * BASE_UNIT)`, whose float multiplication
        // landed directly in the deploy/fund/deposit amount. `amountVfusd` stays float — it is
        // display-only (skill-gen prompt text), never converted to an on-chain unit itself.
        const runTotalUnits = toBaseUnits(totalAmount)
        const perVaultUnits = splitUnitsByRatio(
          runTotalUnits,
          stellarStrategy.vaults.map((v) => v.allocation)
        )
        const vaultPlans = stellarStrategy.vaults.map((v, i) => ({
          index: i,
          agentId: makeAgentId(i, this.sessionId),
          allocationId: v.allocationId || `${receiptRunId}:deposit:${i}`,
          vault: v.address,
          protocolSlug: v.protocolSlug || null,
          eligibilityToken: v.eligibilityToken || null,
          amountVfusd: totalAmount * v.allocation,
          amountUnits: perVaultUnits[i],
        }))

        this.onEvent('orchestrator-started', {
          sessionId: this.sessionId,
          totalAgents: vaultPlans.length,
          vaults: vaultPlans.map((p) => p.vault),
        })

        // Generate skills for all agents (parallel).
        this.onEvent('orchestrator-step', { step: 'generating-skills', status: 'pending' })
        const skillsResults = await Promise.allSettled(
          vaultPlans.map((plan) =>
            generateAgentSkills({
              agentId: plan.agentId,
              vault: plan.vault,
              amount: plan.amountVfusd,
              veniceAuth: this.veniceAuth,
              devApiKey: this.devApiKey,
            }).then((skill) => {
              saveSkill(plan.agentId, skill)
              return { agentId: plan.agentId, skill }
            })
          )
        )
        this.assertCurrentAccount()
        this.onEvent('orchestrator-step', { step: 'generating-skills', status: 'done' })

        // Surface skill-gen failures (e.g. Venice 401/402) — fallback still lets the agent run.
        skillsResults.forEach((r, i) => {
          const skill = r.value?.skill
          if (skill?.error) {
            this.onEvent('skill-gen-failed', { agentId: vaultPlans[i].agentId, error: skill.error })
          }
        })

        const totalUnits = vaultPlans.reduce((acc, p) => acc + p.amountUnits, 0n)

        // Pre-flight: block BEFORE any wallet signature if the asset balance can't cover the total.
        const bal = await readTokenBalance(this.user)
        this.assertCurrentAccount()
        if (bal != null && bal < totalUnits) {
          const msg = `Insufficient VFUSD: have ${(Number(bal) / BASE_UNIT).toFixed(2)}, need ${(Number(totalUnits) / BASE_UNIT).toFixed(2)} for this deposit.`
          this.onEvent('orchestrator-step', {
            step: 'authorizing-scope',
            status: 'error',
            error: msg,
          })
          throw new Error(msg)
        }

        // Option B (fresh agent per run): each worker gets its OWN agent_account instance, deployed
        // below with that worker's fresh session-key pubkey as the constructor-pinned signer. The
        // shared pre-deployed demo agent only accepts ITS constructor-pinned key — depositing with
        // any fresh key failed __check_auth ed25519 verification (Error(Auth, InvalidAction)).
        const workers = vaultPlans.map(
          (p) =>
            new WorkerAgent({
              agentId: p.agentId,
              allocationId: p.allocationId,
              user: this.user,
              vault: p.vault,
              amount: p.amountUnits,
              sessionId: this.sessionId,
              onEvent: this.onEvent,
              agentAddress: null, // set right after the per-worker deploy below
              eligibilityToken: p.eligibilityToken,
              // Review round 1, Important 2 -- same reasoning as buildReuseWorkers/buildFreshWorkers.
              activeAccount: this.activeAccount,
              getCurrentActiveAccount: this.getCurrentActiveAccount,
              signal: this.signal,
            })
        )

        // Agent setup — the funding router is MANDATORY in production (My Money Task 1): the
        // router path is the only one that ever creates a production agent, and a missing/
        // unhealthy router fails HERE, before any wallet signature or fund movement, rather than
        // silently sliding into a legacy deploy. `setupLegacy` survives ONLY as an explicit
        // dev/test compatibility seam — never a production fallback — gated by
        // `isLegacyDirectSetupAllowed`: production can never enable it through a client flag
        // (Vite bakes VITE_ vars into the client bundle; trusting one for a production
        // authorization decision would let anyone flip it via devtools), dev/test must opt in
        // EXPLICITLY via VITE_ENABLE_LEGACY_AGENT_SETUP=true. Both paths isolate a single agent's
        // setup failure (that worker fails, the run continues) and abort only when EVERY agent
        // failed. The pending/error/done step events are emitted HERE so every reachable path
        // reports identically.
        this.onEvent('orchestrator-step', { step: 'authorizing-scope', status: 'pending' })
        if (USE_FUNDING_ROUTER) {
          legacyPermissionEvidence = await this.setupViaRouter(
            workers,
            expiry,
            bridgeInit,
            resolveBridgeAgent
          )
          this.assertCurrentAccount()
        } else if (
          isLegacyDirectSetupAllowed({
            mode: import.meta.env.MODE,
            explicitFlag: import.meta.env.VITE_ENABLE_LEGACY_AGENT_SETUP,
          })
        ) {
          legacyPermissionEvidence = await this.setupLegacy(workers, expiry)
          this.assertCurrentAccount()
        } else {
          throw new Error('Pocket Crew requires the funding router; no transaction was submitted.')
        }
        if (workers.length > 0 && workers.every((w) => w.setupFailed)) {
          const msg = `Agent setup failed for all ${workers.length} agents: ${workers[0].setupError}`
          this.onEvent('orchestrator-step', {
            step: 'authorizing-scope',
            status: 'error',
            error: msg,
          })
          throw new Error(msg)
        }
        this.onEvent('orchestrator-step', { step: 'authorizing-scope', status: 'done' })

        // Dispatch workers SERIALLY — one completes before the next starts; the gap keeps the relay
        // off its per-IP rate limit. Promise.allSettled-equivalent: a thrown worker is captured, not
        // propagated, so one agent's failure never aborts the others.
        this.onEvent('orchestrator-step', { step: 'dispatching-agents', status: 'pending' })
        const workerResults = []
        for (let i = 0; i < workers.length; i++) {
          // A worker whose setup failed was already surfaced ('failed' event) — record and move on.
          if (workers[i].setupFailed) {
            workerResults.push({ status: 'rejected', reason: new Error(workers[i].setupError) })
            continue
          }
          try {
            const res = await workers[i].execute()
            this.assertCurrentAccount()
            workerResults.push({ status: 'fulfilled', value: res })
          } catch (e) {
            workerResults.push({ status: 'rejected', reason: e })
          }
          if (i < workers.length - 1) await new Promise((r) => setTimeout(r, DISPATCH_INTERVAL_MS))
          this.assertCurrentAccount()
        }
        this.onEvent('orchestrator-step', { step: 'dispatching-agents', status: 'done' })

        const results = workerResults.map((r, i) => ({
          agentId: vaultPlans[i].agentId,
          allocationId: vaultPlans[i].allocationId,
          vault: vaultPlans[i].vault,
          success: r.status === 'fulfilled' && r.value?.success,
          txHash: r.value?.txHash,
          error: r.reason?.message || r.value?.error,
        }))

        const completed = results.filter((r) => r.success).length
        const failed = results.length - completed

        this.onEvent('orchestrator-completed', {
          sessionId: this.sessionId,
          completed,
          failed,
          results,
        })

        return {
          completed,
          failed,
          results,
          sessionId: this.sessionId,
          agentAddresses: workers.map((w) => w.agentAddress).filter(Boolean),
        }
      } finally {
        // Guarantees bridgeAgentReady always settles, even when this closure throws before ever
        // reaching setupViaRouter (e.g. the VFUSD preflight above) — a no-op if setupViaRouter
        // already resolved it (resolving an already-settled promise is a safe no-op in JS).
        resolveBridgeAgent(null)
      }
    }

    // Base leg (Task 7's executeBaseLeg) never throws — it resolves { success:false, stage, error }
    // on failure. Dynamic import KEPT INSIDE the baseVaults.length>0 branch — gating it here (not
    // just the call) keeps the Base-only dependency chain (passkey bridge, mandate, relayer
    // client, ZeroDev farm flow) out of the Stellar-only path's load AND out of its failure mode:
    // a Base dep-chain resolution error now settles into the baseLeg-rejection mapping below
    // instead of ever reaching a pure-Stellar dispatch. Run as a settled sibling: one leg's
    // failure can never abort the other. The Base branch first awaits bridgeAgentReady — the
    // Stellar branch's grant (or its finally-guaranteed null) — so both branches start together
    // but the Base leg's real work only begins once the shared grant has actually resolved.
    const [stellarSettled, baseSettled] = await Promise.allSettled([
      runStellarLegs(),
      baseVaults.length > 0
        ? bridgeAgentReady.then((bridgeAgentAddress) => {
            if (!bridgeAgentAddress) {
              // Either the grant itself failed (see the Stellar branch's own error/event for that
              // case) or USE_FUNDING_ROUTER is off — a bridge agent can only be deployed via the
              // router's kind:Bridge AgentInit, never the legacy per-agent deploy path.
              throw new Error(
                'No bridge agent was deployed for the cross-chain leg (either the grant failed, or the funding router is unavailable — Base legs require it).'
              )
            }
            return import('./baseLeg.js').then(({ executeBaseLeg }) => {
              this.assertCurrentAccount()
              const baseCustodyDeps = bindBaseLegCustodyDeps({
                activeAccount: this.activeAccount,
                getCurrentActiveAccount: this.getCurrentActiveAccount,
                signal: this.signal,
              })
              return executeBaseLeg({
                connectedAddress: this.baseLegContext.connectedAddress,
                bridgeAgentAddress,
                bridgeSessionKey,
                kernelAddress: bridgeKernelAddress,
                baseVaults,
                totalAmount,
                onEvent: (name, data) => this.onEvent(name, data),
                deps: baseCustodyDeps,
              }).then((result) => reconcileBaseLegEpochCustody(result, baseCustodyDeps))
            })
          })
        : Promise.resolve(null),
    ])
    this.assertCurrentAccount()

    // Stellar-only strategies must behave byte-identically to pre-Task-8 dispatch — including
    // rejecting with the SAME error (insufficient balance / all-agents-setup-failed). Re-throw
    // rather than let allSettled swallow it.
    // Base leg contract says it never rejects — this is belt-and-braces in case a future change
    // (or a bug) breaks that contract; map to the same shape executeBaseLeg would have returned.
    const baseLeg =
      baseSettled.status === 'fulfilled'
        ? baseSettled.value
        : { success: false, stage: 'dispatch', error: baseSettled.reason?.message }
    if (
      stellarSettled.status === 'rejected' &&
      (baseVaults.length === 0 || /No bridge agent was deployed/.test(baseLeg?.error || ''))
    ) {
      throw stellarSettled.reason
    }
    const stellarSummary =
      stellarSettled.status === 'fulfilled'
        ? stellarSettled.value
        : {
            completed: 0,
            failed: stellarVaults.length,
            results: stellarVaults.map((vault, index) => ({
              allocationId: vault.allocationId || `${receiptRunId}:deposit:${index}`,
              success: false,
              custody: { location: 'unknown', confirmed: false, checkedAt: null },
              error: stellarSettled.reason?.message || String(stellarSettled.reason),
            })),
            sessionId: this.sessionId,
            agentAddresses: [],
          }

    // Legacy callers have not yet migrated to StrategyPlan/PermissionConfirmedV1, but a mixed
    // execution still deserves the exact same custody receipt. Its synthetic plan is derived
    // solely from the integer amounts used by this dispatch; it never converts display floats.
    const stellarPlan = stellarSummary.results.map((result, index) => ({
      allocationId: result.allocationId,
      kind: 'deposit',
      allocation: {
        token: SOROBAN_TOKEN_ADDRESS,
        units: String(
          // vaultPlans is local to runStellarLegs, so the worker amount is reflected in the
          // result only indirectly. Recompute with the same exact splitter used above.
          splitUnitsByRatio(
            toBaseUnits(totalAmount),
            stellarStrategy.vaults.map((vault) => vault.allocation)
          )[index] || 0n
        ),
        decimals: SOROBAN_DECIMALS,
      },
    }))
    const baseEvidence =
      baseLeg?.allocations?.length > 0
        ? baseLeg.allocations
        : baseVaults.map((vault, index) => {
            const { baseTargetUnits6 } = deriveCctpTransferUnits(totalAmount * vault.allocation)
            return {
              amount: { token: 'USDC', units: String(baseTargetUnits6), decimals: 6 },
              success: baseLeg?.success === true,
              finalStatus: baseLeg?.finalStatus || (baseLeg?.success ? 'done' : 'error'),
              error: baseLeg?.error || null,
              custody: { location: 'unknown', confirmed: false, checkedAt: null },
              ...baseLeg,
              allocationId: vault.allocationId,
            }
          })
    const receiptPlan = {
      runId: receiptRunId,
      planFingerprint: strategy.planFingerprint || null,
      agents: [
        ...stellarPlan,
        ...(baseVaults.length
          ? [
              {
                allocationId: `${receiptRunId}:bridge`,
                kind: 'bridge',
                children: baseEvidence.map((entry) => ({
                  allocationId: entry.allocationId,
                  allocation: entry.amount,
                })),
              },
            ]
          : []),
      ],
    }
    // A legacy all-Base grant failure historically settles as branch data. With no confirmed
    // permission, omit the receipt rather than synthesizing a confirmation that never happened.
    if (!legacyPermissionEvidence) {
      return { ...stellarSummary, baseLeg, receipt: null }
    }
    const receipt = buildDispatchReceipt({
      plan: receiptPlan,
      permission: legacyPermissionEvidence,
      branches: {
        stellar: { results: stellarSummary.results },
        base: {
          status: baseLeg?.success === false ? 'failed' : undefined,
          results: baseEvidence,
        },
      },
    })
    return { ...stellarSummary, baseLeg, receipt }
  }

  /**
   * LEGACY setup: per-agent deploy + fund, each a user signature, STRICTLY SEQUENTIAL across
   * agents — load-bearing: every setup tx is sourced from the SAME user account, so each build must
   * fetch the sequence AFTER the previous tx confirmed (parallel setup = txBadSeq races + a stack of
   * queued wallet signatures). Each helper in agentSetup.js builds its tx immediately before signing
   * (never pre-built) and hard-checks the submit status; wallet signs are 120s-timeout-capped there.
   * Signature budget per agent: reuse-cache hit = 0 (deploy skipped; fund skipped too when the agent
   * still holds enough) · fresh agent = 2 (deploy + fund) · +1 when registryAuthorize is on.
   */
  async setupLegacy(workers, expiry) {
    const nowSec = Math.floor(Date.now() / 1000)
    const takenThisRun = new Set() // one cached agent must not serve two workers of this run
    let allReused = workers.length > 0
    for (const w of workers) {
      try {
        // Reuse a cached agent when its ON-CHAIN scope still allows this deposit (expiry,
        // revoked, cap headroom via scope_of()) — restores that agent's pinned session key.
        const cached = await takeReusableAgent({
          owner: this.user,
          vault: SOROBAN_ACTIVE_VAULT_ADDRESS,
          amount: w.amount,
          nowSec,
          exclude: takenThisRun,
        })
        if (cached) {
          w.sessionKey = newSessionKey(cached.secret) // signer is constructor-pinned to this key
          await w.setupKey() // idempotent — keeps the restored key, emits the key-setup step
          w.agentAddress = cached.agentAddress
        } else {
          allReused = false
          await w.setupKey() // fresh ed25519 session key (the on-chain agent signer)
          // Deploy BEFORE fund — it needs the fresh agent's address. User-signed and user-paid:
          // the relay's allowlist only fee-bumps vault-deposit invokes, never a deploy.
          w.agentAddress = await deployAgentForSession({
            owner: this.user,
            sessionKey: w.sessionKey,
            cap: w.amount,
            periodDuration: PERIOD_DURATION,
            expiry,
          })
          saveCachedAgent({
            owner: this.user,
            vault: SOROBAN_ACTIVE_VAULT_ADDRESS,
            entry: {
              agentAddress: w.agentAddress,
              secret: w.sessionKey.secret,
              signerPub: w.sessionKey.publicKey,
              cap: String(w.amount),
              expiry,
              createdAt: Date.now(),
            },
          })
        }
        takenThisRun.add(w.agentAddress)
        this.onEvent('AgentDeployed', {
          agentId: w.agentId,
          agent: w.agentAddress,
          signer: w.sessionKey.publicKey,
          reused: Boolean(cached),
        })
        if (this.registryAuthorize) {
          // The hardened registry derives every record field from the agent contract's own
          // scope_of() — pass ONLY the agent address; scope/cap/expiry come from the chain.
          await registryAuthorizeAgent({ owner: this.user, agentAddress: w.agentAddress })
        }
        // Fund only the shortfall case: a reused agent may still hold the asset from a run
        // that failed before its deposit. null (read failed) funds anyway — the safe side.
        const agentBal = await readTokenBalance(w.agentAddress)
        this.assertCurrentAccount()
        if (agentBal == null || agentBal < w.amount) {
          await fundAgent({ owner: this.user, agentAddress: w.agentAddress, amount: w.amount })
        }
        w.scopeAuthorized = true
        this.onEvent('AgentScopeAuthorized', {
          agentId: w.agentId,
          agent: w.agentAddress,
          vault: w.vault,
          token: SOROBAN_TOKEN_ADDRESS,
          capPerPeriod: w.amount,
          periodDuration: PERIOD_DURATION,
          expiry,
          authorized: true,
          registryRecorded: this.registryAuthorize,
        })
      } catch (err) {
        // Surface + isolate: THIS worker is out (drives the tile/log 'failed' state), the rest
        // of the run continues. No infinite "started" limbo, no all-or-nothing abort.
        w.setupFailed = true
        allReused = false
        w.setupError = `Setup failed: ${err.message}`
        this.onEvent('failed', { agentId: w.agentId, vault: w.vault, error: w.setupError })
      }
    }
    return {
      mode: allReused ? 'reuse' : 'fresh',
      txHash: null,
      grantReceiptFingerprint: null,
      expiryLedger: allReused ? null : expiry,
      agentAddresses: workers.map((worker) => worker.agentAddress).filter(Boolean),
    }
  }

  /**
   * ROUTER setup (single-signature grant flow). Fresh agents can ONLY be created BY a grant (grant deploys
   * them), so the only signature-free path is reusing STILL-VALID cached agents. Sequence:
   *   1. Try to fill EVERY worker from cache with the router's allowance still covering the run
   *      total → 0 further signatures (tryReuseAllCached). Skipped entirely when a bridge agent is
   *      needed — it can NEVER be served from cache (never cached, by design — see baseLeg.js's
   *      grant-covers-burn note), so a grant is unavoidable whenever `bridgeInit` is present, and
   *      it may as well cover every Stellar worker too rather than leave some half-cached.
   *   2. Otherwise a single grant signature deploys a fresh agent per worker (+ the bridge agent,
   *      when present) and (re)sets the budget(s) (grantFreshAgents). A grant failure marks every
   *      worker failed (no agents deployed) and resolves the bridge agent as null.
   *   3. Fund each worker via a RELAYED router.pull (agent session-key signed; 0 further signatures), unless it
   *      already holds enough of the asset. One worker's pull failure isolates that worker.
   * @param {Array} workers
   * @param {number} expiry
   * @param {object|null} [bridgeInit] - a Bridge-kind AgentInit to fold into the SAME grant
   * @param {(bridgeAgentAddress:string|null)=>void} [resolveBridgeAgent] - settles once the bridge
   *   agent's address is known (or null, when no grant ran or it failed)
   */
  async setupViaRouter(workers, expiry, bridgeInit = null, resolveBridgeAgent = () => {}) {
    const nowSec = Math.floor(Date.now() / 1000)
    const totalUnits = workers.reduce((acc, w) => acc + w.amount, 0n)

    const reuseEvidence = bridgeInit
      ? null
      : await this.tryReuseAllCached(workers, totalUnits, nowSec)
    let permissionEvidence
    if (!reuseEvidence) {
      for (const w of workers) await w.setupKey() // fresh keys the grant pins as agent signers
      let granted
      try {
        granted = await this.grantFreshAgents(workers, totalUnits, expiry, nowSec, bridgeInit)
      } catch (err) {
        // A grant covers ALL workers (+ the bridge agent) under one signature — its failure
        // (dismissed signature request, sim error) leaves NOTHING deployed, so the whole run's
        // setup failed. Mark every worker; dispatch's all-failed check then emits the error step +
        // throws, exactly like legacy. The bridge leg settles separately (null -> Base leg fails).
        for (const w of workers) {
          w.setupFailed = true
          w.setupError = `Setup failed: ${err.message}`
          this.onEvent('failed', { agentId: w.agentId, vault: w.vault, error: w.setupError })
        }
        resolveBridgeAgent(null)
        return null
      }
      permissionEvidence = {
        mode: 'fresh',
        txHash: granted.txHash,
        grantReceiptFingerprint: null,
        expiryLedger: granted.expiryLedger,
        agentAddresses: granted.agentAddresses,
      }
      resolveBridgeAgent(granted.bridgeAgentAddress)
    } else {
      permissionEvidence = {
        mode: 'reuse',
        txHash: null,
        grantReceiptFingerprint: null,
        expiryLedger: reuseEvidence.expiryLedger,
        agentAddresses: workers.map((worker) => worker.agentAddress),
      }
      resolveBridgeAgent(null) // cache-reuse path never grants — never reached when bridgeInit is set
    }

    for (const w of workers) {
      if (w.setupFailed) continue
      try {
        // Fund only the shortfall case (a reused/aborted agent may already hold the asset). The
        // pull is relayed: the agent's session key signs the pull auth entry, the relay fee-bumps
        // (router.pull is now allowlisted) — 0 further signatures.
        const agentBal = await readTokenBalance(w.agentAddress)
        this.assertCurrentAccount()
        if (agentBal == null || agentBal < w.amount) {
          const res = await runAgentPull({
            agentAddress: w.agentAddress,
            amount: w.amount,
            sessionKey: w.sessionKey,
            activeAccount: this.activeAccount,
            getCurrentActiveAccount: this.getCurrentActiveAccount,
            signal: this.signal,
          })
          this.assertCurrentAccount()
          if (!res)
            throw new Error(
              'The Stellar relay is unavailable. Funds could not be sent to the agent.'
            )
          if (res.status !== 'SUCCESS')
            throw new Error(`The funding router returned ${res.status}.`)
        }
        w.scopeAuthorized = true
        this.onEvent('AgentScopeAuthorized', {
          agentId: w.agentId,
          agent: w.agentAddress,
          vault: w.vault,
          token: SOROBAN_TOKEN_ADDRESS,
          capPerPeriod: w.amount,
          periodDuration: PERIOD_DURATION,
          expiry,
          authorized: true,
          registryRecorded: false,
        })
      } catch (err) {
        w.setupFailed = true
        w.setupError = `Setup failed: ${err.message}`
        this.onEvent('failed', { agentId: w.agentId, vault: w.vault, error: w.setupError })
      }
    }
    return permissionEvidence
  }

  /**
   * signature-free fast path: reuse a still-valid cached agent for EVERY worker. Two load-bearing gates:
   * (a) the owner→router SEP-41 allowance must still cover this run's total (budget left to pull),
   * and (b) each worker must find a cached agent whose ON-CHAIN cap still has headroom for its
   * deposit. The common case — an agent whose cap == its already-spent first deposit — fails (b)
   * and rolls to a fresh grant signature. All-or-nothing: partial cache reuse still needs a grant (a
   * grant is the only way to make the missing agents), so we commit the reuse only once EVERY
   * worker has one. Returns true iff all workers were assigned a cached agent.
   */
  async tryReuseAllCached(workers, totalUnits, nowSec) {
    const allowance = await readAllowance({ owner: this.user })
    if (!allowance || allowance.amount < totalUnits) return null
    const taken = new Set()
    const picks = []
    for (const w of workers) {
      const cached = await takeReusableAgent({
        owner: this.user,
        vault: SOROBAN_ACTIVE_VAULT_ADDRESS,
        amount: w.amount,
        nowSec,
        exclude: taken,
      })
      if (!cached) return null // can't fill every worker from cache → a grant is required
      picks.push([w, cached])
      taken.add(cached.agentAddress)
    }
    for (const [w, cached] of picks) {
      w.sessionKey = newSessionKey(cached.secret) // restore the constructor-pinned session key
      await w.setupKey() // idempotent — keeps the restored key, emits the key-setup step
      w.agentAddress = cached.agentAddress
      this.onEvent('AgentDeployed', {
        agentId: w.agentId,
        agent: w.agentAddress,
        signer: w.sessionKey.publicKey,
        reused: true,
      })
    }
    return { expiryLedger: allowance.liveUntilLedger ?? null }
  }

  /**
   * THE ONE SIGNATURE: an owner-signed grant that deploys one fresh agent per worker — PLUS the
   * run's bridge agent, when `bridgeInit` is present (folded into the SAME agentInits/budgets, per
   * the grant-covers-burn design: a mixed run costs exactly one grant, never two) — and (re)sets
   * the SEP-41 budget(s). The Stellar-deposit budget is run total (or a larger user-chosen budget
   * for signature-free repeat headroom), clamped up so it can never be below the run total; the
   * bridge budget is always exact (never inflated — a bridge agent is spent once, never reused).
   * The returned Vec<Address> maps by input order: workers first, the bridge agent last (if any) —
   * grant.js's own `bridgeAgentAddress` field already names that last entry, reused verbatim here.
   * @returns {Promise<string|null>} the deployed bridge agent's address, or null when none was requested
   */
  async grantFreshAgents(workers, totalUnits, expiry, nowSec, bridgeInit = null) {
    const budget =
      this.grantBudgetUnits != null && this.grantBudgetUnits > totalUnits
        ? this.grantBudgetUnits
        : totalUnits
    const durationSeconds = Math.max(1, expiry - nowSec)
    // v2 AgentInit (funding_router/src/types.rs): kind 0 = Deposit, target = the vault the agent
    // deposits into. mintRecipient/destinationDomain are Bridge-only fields — a Deposit agent's
    // scope never reads them, so they're pinned to the same harmless zero/none the Rust side
    // ignores for this kind (ZERO32 imported from cctpBurn.js, never redeclared).
    const agentInits = workers.map((w) => ({
      signer: w.sessionKey.rawPublicKey,
      cap: w.amount,
      token: SOROBAN_TOKEN_ADDRESS,
      target: SOROBAN_ACTIVE_VAULT_ADDRESS,
      kind: AGENT_KIND_DEPOSIT,
      mintRecipient: ZERO32,
      destinationDomain: 0,
      periodDuration: PERIOD_DURATION,
      expiry,
    }))
    // budgets carries one entry per distinct token spent by this grant — omitted entirely when
    // there are no Stellar deposit workers (an all-Base strategy grants the bridge init only).
    const budgets = []
    if (workers.length > 0) budgets.push({ budget, token: SOROBAN_TOKEN_ADDRESS })
    if (bridgeInit) {
      agentInits.push(bridgeInit)
      budgets.push({ budget: bridgeInit.cap, token: bridgeInit.token })
    }
    const { hash, agentAddresses, bridgeAgentAddress, expiryLedger } = await submitGrant({
      owner: this.user,
      ...(this.activeAccount ? { activeAccount: this.activeAccount } : {}),
      getCurrentActiveAccount: this.getCurrentActiveAccount,
      signal: this.signal,
      budgets,
      durationSeconds,
      agentInits,
    })
    this.assertCurrentAccount()
    if (
      typeof hash !== 'string' ||
      hash.length === 0 ||
      !Array.isArray(agentAddresses) ||
      agentAddresses.length !== agentInits.length
    ) {
      throw new Error('The funding router did not return complete confirmed grant evidence.')
    }
    workers.forEach((w, i) => {
      w.agentAddress = agentAddresses[i]
      saveCachedAgent({
        owner: this.user,
        vault: SOROBAN_ACTIVE_VAULT_ADDRESS,
        entry: {
          agentAddress: w.agentAddress,
          secret: w.sessionKey.secret,
          signerPub: w.sessionKey.publicKey,
          cap: String(w.amount),
          expiry,
          createdAt: Date.now(),
        },
      })
      this.onEvent('AgentDeployed', {
        agentId: w.agentId,
        agent: w.agentAddress,
        signer: w.sessionKey.publicKey,
        reused: false,
      })
    })
    return { bridgeAgentAddress, agentAddresses, txHash: hash, expiryLedger: expiryLedger ?? null }
  }
}
