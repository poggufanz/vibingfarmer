// frontend/src/screens/Withdraw.jsx
// Base → Stellar unwind: one passkey sign → batched withdraw+burn → relayer CCTP mint.
// The overlay's presentation belongs to this route and its Pocket Crew money stylesheet; the
// execution state and data flow below remain the same.
import { useState, useCallback, useEffect, useRef } from 'react'
import { Dialog, VenueTruth } from '../components/pocket/Primitives.jsx'
import { NetworkRoute } from '../components/pocket/NetworkIdentity.jsx'
import { signAndSubmitUnwind } from '../base/withdrawBatch.js'
import { reserveUnwind, postUnwindAttach, pollUnwindStatus } from '../base/relayerClient.js'
import { createCctpTransfer, checkpointCctpTransfer } from '../cctp/transferJournal.js'
import { BASE_CROSS_CHAIN_AVAILABLE, BASE_CROSS_CHAIN_UNAVAILABLE_REASON } from '../base/config.js'

const DEFAULT_WITHDRAW_ADAPTERS = Object.freeze({
  reserveUnwind,
  signAndSubmitUnwind,
  postUnwindAttach,
  pollUnwindStatus,
})
const WITHDRAW_ADAPTER_KEYS = Object.freeze([
  'reserveUnwind',
  'signAndSubmitUnwind',
  'postUnwindAttach',
  'pollUnwindStatus',
])

function resolveWithdrawAdapters(withdrawAdapters) {
  if (withdrawAdapters === undefined) return DEFAULT_WITHDRAW_ADAPTERS
  if (!withdrawAdapters || typeof withdrawAdapters !== 'object') return null
  return WITHDRAW_ADAPTER_KEYS.every((key) => typeof withdrawAdapters[key] === 'function')
    ? withdrawAdapters
    : null
}

const STAGES = [
  { key: 'sign', label: 'Sign unwind' },
  { key: 'relay', label: 'Hand to relayer' },
  { key: 'bridge', label: 'Bridge to Stellar' },
]

// status → per-stage state. 'pending' = polling exhausted while the relayer still works.
const STAGE_STATE = {
  idle: {},
  reserving: { sign: 'running' },
  signing: { sign: 'running' },
  relaying: { sign: 'done', relay: 'running' },
  polling: { sign: 'done', relay: 'done', bridge: 'running' },
  pending: { sign: 'done', relay: 'done', bridge: 'running' },
  submission_unknown: {},
  reconcile: { sign: 'done' },
  terminal: { sign: 'done', relay: 'done' },
  done: { sign: 'done', relay: 'done', bridge: 'done' },
}

const shortAddr = (addr) => {
  if (!addr || addr.length < 10) return addr || 'Unavailable'
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`
}

function safeMoneyCopy(value) {
  return typeof value === 'string' ? value.replace(/\s*(?:--|—|–)\s*/g, '. ') : value
}

const EVM_HASH = /^(?:0x)?[0-9a-f]{64}$/i
const BASE_USDC_DECIMALS = 6

function exactUnits(value) {
  if (typeof value === 'bigint') return value >= 0n ? value : null
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    try {
      return BigInt(value)
    } catch {
      return null
    }
  }
  return null
}

function exactCount(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  return exactUnits(value)
}

function hasVerifiedBurnEvidence(evidence) {
  return evidence?.evidenceStatus === 'verified' && EVM_HASH.test(evidence?.unwindTxHash || '')
}

function basePositionDecimals(position) {
  if (
    !position ||
    typeof position !== 'object' ||
    Array.isArray(position) ||
    typeof position.pool !== 'string' ||
    !position.pool.trim()
  ) {
    return null
  }
  const hasExplicitToken = Object.prototype.hasOwnProperty.call(position, 'token')
  const hasExplicitDecimals = Object.prototype.hasOwnProperty.call(position ?? {}, 'decimals')
  const token = hasExplicitToken ? position.token : 'USDC'
  const decimals = hasExplicitDecimals ? position?.decimals : BASE_USDC_DECIMALS
  if (decimals !== BASE_USDC_DECIMALS || (hasExplicitToken && token !== 'USDC')) {
    return null
  }
  return decimals
}

function sumBaseUnits(positions, idleUsdc) {
  if (!Array.isArray(positions)) return null
  const idle = exactUnits(idleUsdc)
  if (idle == null) return null
  let total = idle
  const pools = new Set()
  for (const position of positions) {
    if (basePositionDecimals(position) == null) return null
    if (pools.has(position.pool)) return null
    pools.add(position.pool)
    const units = exactUnits(position?.assets)
    if (units == null) return null
    total += units
  }
  return total
}

function formatBaseUnits(value, decimals = 6) {
  const units = exactUnits(value)
  if (units == null || !Number.isInteger(decimals) || decimals < 0 || decimals > 38) {
    return 'Unavailable'
  }
  const scale = 10n ** BigInt(decimals)
  const whole = (units / scale).toString()
  const fraction = (units % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  if (!fraction) return `${whole}.00`
  return `${whole}.${fraction.padEnd(2, '0')}`
}

function formatCount(value) {
  const count = exactCount(value)
  return count == null ? 'Unavailable' : count.toString()
}

function hasReceiptAndReconciliation(evidence, projection) {
  return (
    hasVerifiedBurnEvidence(evidence) &&
    projection?.status === 'done' &&
    EVM_HASH.test(projection?.unwindTxHash || '') &&
    projection.unwindTxHash.toLowerCase() === evidence.unwindTxHash.toLowerCase() &&
    /^[0-9a-f]{64}$/i.test(projection?.mintTxHash || '')
  )
}

const friendlyError = (err) => {
  const raw = (err?.message || err?.shortMessage || '').toLowerCase()
  if (
    raw.includes('user rejected') ||
    raw.includes('user denied') ||
    raw.includes('cancelled') ||
    raw.includes('canceled')
  ) {
    return 'You cancelled the passkey prompt.'
  }
  if (raw.includes('timeout') || raw.includes('timed out')) {
    return 'The relayer timed out. Retry in a moment.'
  }
  return 'Withdraw failed. Please try again.'
}

export default function Withdraw({
  ownerKernelAccount,
  publicClient,
  positions = [],
  idleUsdc = 0n,
  stellarRecipient,
  onDone,
  onClose,
  // Optional deterministic seam for the visual atlas. Production callers omit it and retain
  // the concrete clients above; an invalid supplied contract fails closed instead of falling
  // back to a live client.
  withdrawAdapters,
  baseCrossChainAvailable = BASE_CROSS_CHAIN_AVAILABLE,
}) {
  const [status, setStatus] = useState('idle')
  const [errorMessage, setErrorMessage] = useState(null)
  const [failedAt, setFailedAt] = useState(null)
  const [jobId, setJobId] = useState(null)
  const [outcome, setOutcome] = useState(null) // { burned, exited, skipped } once settled
  const [deadlineMinutes, setDeadlineMinutes] = useState(10)
  const adapters = resolveWithdrawAdapters(withdrawAdapters)
  // In-memory continuation state only. Task 13 owns a reload-safe journal; raw capability
  // authority never enters React state or browser storage in this task.
  const attemptRef = useRef(null)

  // Sum of what the positions are WORTH plus idle. Never minAssets: that is a
  // slippage floor, and using it as the amount is what stranded 0.5% of every
  // withdraw on Base.
  const totalUnits = sumBaseUnits(positions, idleUsdc)
  const nothingToDo = totalUnits === 0n
  const totalUnavailable = totalUnits == null
  const idleUnits = exactUnits(idleUsdc)
  const busy =
    status === 'reserving' || status === 'signing' || status === 'relaying' || status === 'polling'
  const finished =
    status === 'done' ||
    status === 'pending' ||
    status === 'submission_unknown' ||
    status === 'reconcile' ||
    status === 'terminal'

  const ownerIdentity = ownerKernelAccount?.address?.toLowerCase() || null
  const ownerIdentityRef = useRef(ownerIdentity)
  useEffect(() => {
    if (ownerIdentityRef.current === ownerIdentity) return
    ownerIdentityRef.current = ownerIdentity
    attemptRef.current = null
    setStatus('idle')
    setErrorMessage(null)
    setFailedAt(null)
    setJobId(null)
    setOutcome(null)
  }, [ownerIdentity])

  const isCurrentAttempt = useCallback(
    (attempt) =>
      Boolean(
        attempt &&
        attemptRef.current === attempt &&
        attempt.ownerIdentity === ownerIdentityRef.current
      ),
    []
  )

  const applyProjection = useCallback(
    (projection, attempt) => {
      if (!isCurrentAttempt(attempt)) return true
      if (
        projection?.status === 'done' &&
        hasReceiptAndReconciliation(attempt?.evidence, projection)
      ) {
        setStatus('done')
        setErrorMessage(null)
        setFailedAt(null)
        onDone?.()
        return true
      }
      if (projection?.status === 'done') {
        setFailedAt('bridge')
        setStatus('reconcile')
        setErrorMessage(
          'The Base receipt arrived without complete reconciliation evidence. Check status before taking another action.'
        )
        return true
      }
      if (['blocked', 'uncertain', 'expired'].includes(projection?.status)) {
        setFailedAt('bridge')
        setStatus('terminal')
        setErrorMessage(
          `The Base withdrawal is ${projection.status}. The burn will not be repeated. Check status before taking another action.`
        )
        return true
      }
      return false
    },
    [isCurrentAttempt, onDone]
  )

  const continueAfterSend = useCallback(
    async (attempt) => {
      if (!adapters) return
      let stage = attempt.attached ? 'bridge' : 'relay'
      setErrorMessage(null)
      setFailedAt(null)
      try {
        if (!attempt.attached) {
          if (attempt.journalState === 'unwind_confirmed') {
            checkpointCctpTransfer(
              {
                owner: attempt.owner,
                requestId: attempt.jobId,
                from: 'unwind_confirmed',
                to: 'relay_pending',
              },
              attempt.journalOptions
            )
            attempt.journalState = 'relay_pending'
          }
          setStatus('relaying')
          const attached = await adapters.postUnwindAttach({
            jobId: attempt.jobId,
            userOpHash: attempt.evidence.userOpHash,
            unwindTxHash: attempt.evidence.unwindTxHash,
          })
          if (!isCurrentAttempt(attempt)) return
          attempt.attached = true
          if (attempt.journalState === 'relay_pending') {
            checkpointCctpTransfer(
              {
                owner: attempt.owner,
                requestId: attempt.jobId,
                from: 'relay_pending',
                to: 'settling',
              },
              attempt.journalOptions
            )
            attempt.journalState = 'settling'
          }
          if (applyProjection(attached, attempt)) return
        }
        stage = 'bridge'
        setStatus('polling')
        const final = await adapters.pollUnwindStatus({ jobId: attempt.jobId })
        if (!isCurrentAttempt(attempt)) return
        if (
          ['done', 'error', 'uncertain', 'blocked', 'expired'].includes(final?.status) &&
          attempt.journalState === 'settling'
        ) {
          checkpointCctpTransfer(
            {
              owner: attempt.owner,
              requestId: attempt.jobId,
              from: 'settling',
              to: final.status === 'expired' ? 'blocked' : final.status,
              patch: {
                reasonCode:
                  final.status === 'expired'
                    ? 'authorization_unavailable'
                    : final.status === 'done'
                      ? 'job_error'
                      : `job_${final.status}`,
              },
            },
            attempt.journalOptions
          )
          attempt.journalState = final.status
        }
        if (!applyProjection(final, attempt)) setStatus('pending')
      } catch (error) {
        if (!isCurrentAttempt(attempt)) return
        setFailedAt(stage)
        setStatus('error')
        setErrorMessage(friendlyError(error))
      }
    },
    [adapters, applyProjection, isCurrentAttempt]
  )

  const startWithdraw = useCallback(async () => {
    if (!adapters || !baseCrossChainAvailable || totalUnits == null || totalUnits === 0n) return

    setStatus('reserving')
    setErrorMessage(null)
    setFailedAt(null)
    setOutcome(null)
    setJobId(null)
    attemptRef.current = null
    let stage = 'sign'
    try {
      const reservation = await adapters.reserveUnwind({
        kernelAddress: ownerKernelAccount.address,
        recipientHint: stellarRecipient,
      })
      if (ownerIdentityRef.current !== ownerIdentity) return
      const attempt = {
        jobId: reservation.jobId,
        owner: stellarRecipient,
        userOpHash: null,
        evidence: null,
        attached: false,
        ownerIdentity,
        journalState: 'userop_submitting',
        journalOptions: { storage: window.localStorage },
      }
      // The reserve response may contain a one-time capability. It is deliberately not copied
      // into attempt, React state, the journal, or any later request.
      createCctpTransfer(
        {
          version: 1,
          direction: 'reverse',
          owner: stellarRecipient,
          requestId: reservation.jobId,
          state: 'userop_submitting',
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
          reasonCode: null,
          terminalFrom: null,
          transfer: {
            jobId: reservation.jobId,
            kernelAddress: ownerKernelAccount.address.toLowerCase(),
            recipientHint: stellarRecipient,
            userOpHash: null,
            unwindTxHash: null,
          },
        },
        attempt.journalOptions
      )
      attemptRef.current = attempt
      setJobId(reservation.jobId)

      setStatus('signing')
      const nowSeconds = BigInt(Math.floor(Date.now() / 1000))
      const deadline = nowSeconds + BigInt(deadlineMinutes) * 60n
      const evidence = await adapters.signAndSubmitUnwind({
        jobId: reservation.jobId,
        ownerKernelAccount,
        publicClient,
        positions,
        stellarRecipient,
        idleUsdc,
        deadline,
        nowSeconds,
        onSubmitted: async (userOpHash) => {
          // Capture the canonical returned identity before the durable checkpoint. If storage
          // rejects, withdrawBatch converts that into submitted-but-checkpoint-failed; the UI
          // must treat it as potentially sent and never offer a second signing attempt.
          attempt.userOpHash = userOpHash
          checkpointCctpTransfer(
            {
              owner: attempt.owner,
              requestId: attempt.jobId,
              from: 'userop_submitting',
              to: 'userop_submitted',
              patch: { userOpHash },
            },
            attempt.journalOptions
          )
          attempt.journalState = 'userop_submitted'
        },
      })
      if (ownerIdentityRef.current !== ownerIdentity || attemptRef.current !== attempt) return
      if (!attempt.userOpHash || evidence.userOpHash !== attempt.userOpHash) {
        throw new Error('submitted unwind identity requires reconciliation')
      }
      setOutcome({
        burned: exactUnits(evidence.burned),
        exited: exactCount(evidence.exited),
        skipped: exactCount(evidence.skipped),
      })
      attempt.evidence = evidence
      if (evidence.evidenceStatus !== 'verified') {
        setFailedAt('relay')
        setStatus('reconcile')
        return
      }
      checkpointCctpTransfer(
        {
          owner: attempt.owner,
          requestId: attempt.jobId,
          from: 'userop_submitted',
          to: 'unwind_confirmed',
          patch: { unwindTxHash: evidence.unwindTxHash },
        },
        attempt.journalOptions
      )
      attempt.journalState = 'unwind_confirmed'
      await continueAfterSend(attempt)
    } catch (error) {
      if (ownerIdentityRef.current !== ownerIdentity) return
      if (
        error?.code === 'submission_unknown' ||
        error?.code === 'submitted-but-checkpoint-failed'
      ) {
        setFailedAt(null)
        setStatus('submission_unknown')
        setErrorMessage(null)
        return
      }
      const submitted = attemptRef.current?.userOpHash
      if (submitted && !attemptRef.current?.evidence) {
        setFailedAt('relay')
        setStatus('reconcile')
        setErrorMessage(null)
        return
      }
      setFailedAt(stage)
      setStatus('error')
      setErrorMessage(friendlyError(error))
    }
  }, [
    ownerKernelAccount,
    adapters,
    ownerIdentity,
    publicClient,
    positions,
    stellarRecipient,
    idleUsdc,
    deadlineMinutes,
    continueAfterSend,
    totalUnits,
    baseCrossChainAvailable,
  ])

  // 'pending' only means pollUnwindStatus's bounded window closed before the bridge finished —
  // a standard-finality CCTP leg takes ~15-25 min. Keep re-polling slowly while the modal is
  // open so the UI actually flips to done when the mint lands (live 2026-07-20: funds arrived,
  // modal spun forever because nothing ever asked again).
  useEffect(() => {
    if (status !== 'pending' || !jobId) return
    let cancelled = false
    const t = setInterval(async () => {
      const attempt = attemptRef.current
      if (!attempt || attempt.jobId !== jobId) return
      try {
        const last = await adapters.pollUnwindStatus({ jobId, maxTries: 1 })
        if (cancelled || !isCurrentAttempt(attempt)) return
        applyProjection(last, attempt)
      } catch {
        // transient poll failure: keep waiting, next tick retries
      }
    }, 10_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [status, jobId, adapters, applyProjection, isCurrentAttempt])

  const stageStates = STAGE_STATE[status] || {}
  const showStages = status !== 'idle'

  const busyCopy = {
    reserving: 'Preparing a protected unwind reservation.',
    signing: 'Confirm the passkey prompt to sign the unwind.',
    relaying: 'Handing the transaction to the relayer.',
    polling: 'Bridging USDC back to Stellar via CCTP.',
  }
  const busyLabel = busyCopy[status] || null

  // 0 / 1 / 2 of 3 stages complete while in flight (for the progress fill).
  const stageProgress =
    status === 'signing'
      ? 0.12
      : status === 'relaying'
        ? 0.45
        : status === 'polling'
          ? 0.78
          : status === 'pending'
            ? 0.9
            : status === 'done'
              ? 1
              : 0

  const primaryLabel = () => {
    if (!adapters) return 'Unavailable'
    if (!baseCrossChainAvailable) return 'Base unavailable'
    if (status === 'idle' && totalUnavailable) return 'Unavailable'
    if (status === 'reserving') return 'Preparing...'
    if (status === 'signing') return 'Signing...'
    if (status === 'relaying') return 'Relaying...'
    if (status === 'polling') return 'Bridging...'
    if (status === 'error') {
      if (attemptRef.current?.evidence) {
        return attemptRef.current.attached ? 'Retry status' : 'Retry attach'
      }
      return 'Retry withdraw'
    }
    if (status === 'done') return 'Done'
    if (
      status === 'pending' ||
      status === 'submission_unknown' ||
      status === 'reconcile' ||
      status === 'terminal'
    ) {
      return 'Close'
    }
    // Deliberately short: a multi-pool total is wide enough to wrap the button
    // to a second line at desktop, which is a hard fail. The number lives in the hero.
    return nothingToDo ? 'Nothing to withdraw' : 'Withdraw all'
  }

  const onPrimary = () => {
    if (!adapters || !baseCrossChainAvailable) return
    if (finished) {
      onClose?.()
      return
    }
    if (busy) return
    if (status === 'error' && attemptRef.current?.evidence) {
      void continueAfterSend(attemptRef.current)
      return
    }
    void startWithdraw()
  }

  const closeIfSafe = () => {
    if (!busy) onClose?.()
  }
  const totalDisplay = totalUnavailable
    ? 'Unavailable'
    : nothingToDo
      ? 'No balance yet'
      : formatBaseUnits(totalUnits)
  const partialExited = exactCount(outcome?.exited)
  const partialSkipped = exactCount(outcome?.skipped)
  const partialTotal =
    partialExited != null && partialSkipped != null ? partialExited + partialSkipped : null
  const settledDisplay =
    outcome?.burned == null ? 'Your USDC' : `${formatBaseUnits(outcome.burned)} USDC`
  // A verified unwind receipt proves that funds left Base, but only a reconciled mint receipt
  // proves arrival on Stellar. Keep the route conservative for relay, polling, retry, and
  // partial-result states so the destination label never doubles as a custody claim.
  const hasVerifiedBurn = hasVerifiedBurnEvidence(attemptRef.current?.evidence)
  const routeArrived = hasVerifiedBurn && status === 'done' && partialSkipped === 0n
  const custodyNetworkId = routeArrived
    ? 'stellar-testnet'
    : hasVerifiedBurn
      ? 'unknown'
      : 'base-sepolia'
  const transitState = routeArrived
    ? 'arrived'
    : hasVerifiedBurn && ['relaying', 'polling', 'pending'].includes(status)
      ? 'burning'
      : hasVerifiedBurn
        ? 'unknown'
        : status === 'terminal'
          ? 'failed'
          : status === 'submission_unknown' || status === 'reconcile'
            ? 'unknown'
            : status === 'polling' || status === 'pending'
              ? 'burning'
              : 'none'

  return (
    <Dialog
      open
      title="Withdraw everything from Base"
      description="Review every Base custody position before you confirm. One signed request starts the unwind."
      onClose={closeIfSafe}
      className="pc-money-dialog"
      actions={
        <>
          {!finished && (
            <button
              type="button"
              className="pc-button pc-button--secondary"
              onClick={closeIfSafe}
              disabled={busy}
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            className="pc-button pc-button--primary"
            onClick={onPrimary}
            disabled={
              !baseCrossChainAvailable ||
              !adapters ||
              busy ||
              (status === 'idle' && (nothingToDo || totalUnavailable))
            }
            aria-busy={busy || undefined}
          >
            {busy && <span className="pc-base-withdraw-status-mark" aria-hidden="true" />}
            {primaryLabel()}
          </button>
        </>
      }
    >
      <div className="pc-base-withdraw-head">
        <div className="pc-base-withdraw-eyebrow">Base to Stellar, one passkey</div>
      </div>

      <div className="pc-base-withdraw-scroll">
        <div className="pc-base-withdraw-body">
          <div className="pc-base-withdraw-hero">
            <span className="pc-base-withdraw-hero-label">Total</span>
            <span className="pc-base-withdraw-hero-value" data-testid="base-withdraw-total">
              {totalDisplay}
            </span>
            <span className="pc-base-withdraw-hero-unit">USDC</span>
          </div>
          <p className="pc-base-withdraw-lede">
            Review every Base position. One signed request starts an unwind and bridges USDC toward
            your Stellar wallet through CCTP. Receipt and reconciliation prove completion.
          </p>

          <div className="pc-base-withdraw-callout">
            One passkey signature starts the unwind request. Base network fee sponsored by relay. No
            second wallet popup.
          </div>

          {!baseCrossChainAvailable && (
            <div
              className="pc-base-withdraw-callout"
              role="status"
              data-testid="base-unavailable-notice"
            >
              {safeMoneyCopy(BASE_CROSS_CHAIN_UNAVAILABLE_REASON)} Your historical Base balances
              remain visible.
            </div>
          )}

          <div className="pc-base-withdraw-receipt" role="region" aria-label="Unwind summary">
            {positions.map((p, index) => (
              <div
                className="pc-base-withdraw-receipt-row"
                key={`${p?.pool || 'base-position'}-${index}`}
              >
                <span className="pc-base-withdraw-receipt-key">
                  {p?.poolName || p?.pool || 'Unavailable'}
                </span>
                <span className="pc-base-withdraw-receipt-value">
                  {formatBaseUnits(p?.assets, basePositionDecimals(p))}
                </span>
              </div>
            ))}
            {idleUnits != null && idleUnits > 0n && (
              <div className="pc-base-withdraw-receipt-row">
                <span className="pc-base-withdraw-receipt-key">Idle USDC</span>
                <span className="pc-base-withdraw-receipt-value">{formatBaseUnits(idleUnits)}</span>
              </div>
            )}
            <div className="pc-base-withdraw-receipt-row">
              <span className="pc-base-withdraw-receipt-key">Destination</span>
              <span
                className="pc-base-withdraw-receipt-value"
                title={stellarRecipient || undefined}
              >
                {shortAddr(stellarRecipient)}
              </span>
            </div>
            <VenueTruth kind="base-proxy" />
            <NetworkRoute
              context={{
                sourceNetworkId: 'base-sepolia',
                destinationNetworkId: 'stellar-testnet',
                custodyNetworkId,
                transitState,
              }}
              compact
            />
            <div className="pc-base-withdraw-receipt-row">
              <span className="pc-base-withdraw-receipt-key">Signatures</span>
              <span className="pc-base-withdraw-receipt-value">1 (passkey)</span>
            </div>
            <div className="pc-base-withdraw-receipt-row">
              <span className="pc-base-withdraw-receipt-key">Base network fee</span>
              <span className="pc-base-withdraw-receipt-value pc-base-withdraw-receipt-value--ok">
                Sponsored by relay
              </span>
            </div>
            {baseCrossChainAvailable && (
              <div className="pc-base-withdraw-receipt-row">
                <label className="pc-base-withdraw-receipt-key" htmlFor="base-unwind-deadline">
                  Authorization expires
                </label>
                <select
                  id="base-unwind-deadline"
                  className="pc-base-withdraw-receipt-value"
                  value={deadlineMinutes}
                  onChange={(event) => setDeadlineMinutes(Number(event.target.value))}
                  disabled={busy}
                >
                  <option value={5}>5 minutes</option>
                  <option value={10}>10 minutes</option>
                  <option value={15}>15 minutes</option>
                </select>
              </div>
            )}
          </div>

          {(busy || status === 'pending') && (
            <div
              className="pc-base-withdraw-loading"
              role="status"
              aria-live="polite"
              aria-busy="true"
            >
              <div className="pc-base-withdraw-loading-row">
                <span className="pc-base-withdraw-status-mark" aria-hidden="true" />
                <span className="pc-base-withdraw-loading-text">
                  {busyLabel || 'Still settling with the relayer.'}
                </span>
              </div>
              <div className="pc-base-withdraw-loading-track" aria-hidden="true">
                <div
                  className="pc-base-withdraw-loading-fill"
                  data-progress={Math.round(stageProgress * 100)}
                />
              </div>
            </div>
          )}

          {showStages && (
            <ol className="pc-base-withdraw-stage-list" aria-label="Unwind progress">
              {STAGES.map((s) => {
                const st = failedAt === s.key ? 'failed' : stageStates[s.key] || 'idle'
                return (
                  <li
                    key={s.key}
                    className={`pc-base-withdraw-stage pc-base-withdraw-stage--${st}`}
                    aria-current={st === 'running' ? 'step' : undefined}
                  >
                    <span className="pc-base-withdraw-stage-mark" aria-hidden="true" />
                    <span className="pc-base-withdraw-stage-label">{s.label}</span>
                    {st === 'running' && (
                      <span className="pc-base-withdraw-stage-hint">working...</span>
                    )}
                    {st === 'done' && (
                      <span className="pc-base-withdraw-stage-hint pc-base-withdraw-stage-hint--ok">
                        done
                      </span>
                    )}
                    {st === 'failed' && (
                      <span className="pc-base-withdraw-stage-hint pc-base-withdraw-stage-hint--err">
                        failed
                      </span>
                    )}
                  </li>
                )
              })}
            </ol>
          )}

          {status === 'done' && partialSkipped != null && partialSkipped > 0n && (
            <div
              className="pc-base-withdraw-callout"
              role="status"
              data-testid="base-withdraw-partial"
            >
              Exited {formatCount(partialExited)} of {formatCount(partialTotal)} pools.{' '}
              {formatCount(partialSkipped)} pool{partialSkipped === 1n ? '' : 's'} could not be
              exited right now. Its funds are still on Base, untouched. Try again later.
            </div>
          )}
          {status === 'done' && (partialSkipped == null || partialSkipped === 0n) && (
            <div className="pc-base-withdraw-callout pc-base-withdraw-callout--ok" role="status">
              Receipt and reconciliation confirm the Base unwind. {settledDisplay} arrived in your
              Stellar wallet. Check your balance.
            </div>
          )}
          {status === 'pending' && (
            <div className="pc-base-withdraw-callout" role="status">
              Still settling. The relayer is finishing the bridge. Funds are in flight, not lost.
              Check your Stellar balance in a few minutes.
            </div>
          )}
          {status === 'reconcile' && (
            <div
              className="pc-base-withdraw-callout"
              role="status"
              data-testid="base-withdraw-reconcile"
            >
              The Base operation landed, but its exact receipt needs reconciliation. It will not be
              attached or signed again from this screen. Check status before taking another action.
            </div>
          )}
          {status === 'submission_unknown' && (
            <div
              className="pc-base-withdraw-callout"
              role="status"
              data-testid="base-withdraw-reconcile"
            >
              The Base operation may have been submitted, but no canonical operation hash was
              returned. It will not be signed again from this screen. Check status before taking
              another action.
            </div>
          )}

          {errorMessage && (
            <div className="pc-base-withdraw-error" role="alert">
              <span>{errorMessage}</span>
            </div>
          )}

          <p className="pc-base-withdraw-footnote">
            Recipient {shortAddr(stellarRecipient)}. Full address is in your connected wallet.
          </p>
          <span className="pc-base-withdraw-visually-hidden" data-testid="base-withdraw-recipient">
            {stellarRecipient}
          </span>
        </div>
      </div>
    </Dialog>
  )
}
