// frontend/src/screens/Withdraw.jsx
// Base → Stellar unwind: one passkey sign → batched withdraw+burn → relayer CCTP mint.
// UI mirrors WithdrawModal (wd-* / grant-receipt / modal shell) so Base exit feels like
// the rest of the dashboard, not a bare step list with inline styles.
import { useState, useCallback, useEffect, useRef } from 'react'
import { signAndSubmitUnwind } from '../base/withdrawBatch.js'
import { reserveUnwind, postUnwindAttach, pollUnwindStatus } from '../base/relayerClient.js'
import { createCctpTransfer, checkpointCctpTransfer } from '../cctp/transferJournal.js'
import { BASE_CROSS_CHAIN_AVAILABLE, BASE_CROSS_CHAIN_UNAVAILABLE_REASON } from '../base/config.js'

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
  if (!addr || addr.length < 10) return addr || '-'
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`
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
}) {
  const [status, setStatus] = useState('idle')
  const [errorMessage, setErrorMessage] = useState(null)
  const [failedAt, setFailedAt] = useState(null)
  const [jobId, setJobId] = useState(null)
  const [outcome, setOutcome] = useState(null) // { burned, exited, skipped } once settled
  const [deadlineMinutes, setDeadlineMinutes] = useState(10)
  const confirmRef = useRef(null)
  // In-memory continuation state only. Task 13 owns a reload-safe journal; raw capability
  // authority never enters React state or browser storage in this task.
  const attemptRef = useRef(null)

  // Sum of what the positions are WORTH plus idle. Never minAssets: that is a
  // slippage floor, and using it as the amount is what stranded 0.5% of every
  // withdraw on Base.
  const totalUnits = positions.reduce((a, p) => a + (p.assets ?? 0n), 0n) + idleUsdc
  const usdc = Number(totalUnits) / 1e6
  const settledUsdc = outcome?.burned != null ? Number(outcome.burned) / 1e6 : null
  const nothingToDo = totalUnits === 0n
  const busy =
    status === 'reserving' || status === 'signing' || status === 'relaying' || status === 'polling'
  const finished =
    status === 'done' ||
    status === 'pending' ||
    status === 'submission_unknown' ||
    status === 'reconcile' ||
    status === 'terminal'

  useEffect(() => {
    const prev = document.activeElement
    confirmRef.current?.focus()
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) onClose?.()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      prev?.focus?.()
    }
  }, [busy, onClose])

  const applyProjection = useCallback(
    (projection, id) => {
      if (projection.status === 'done') {
        setStatus('done')
        setErrorMessage(null)
        setFailedAt(null)
        onDone?.()
        return true
      }
      if (['blocked', 'uncertain', 'expired'].includes(projection.status)) {
        setFailedAt('bridge')
        setStatus('terminal')
        setErrorMessage(
          `Unwind job ${id} is ${projection.status}. The Base burn will not be repeated; check status before taking another action.`
        )
        return true
      }
      return false
    },
    [onDone]
  )

  const continueAfterSend = useCallback(
    async (attempt) => {
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
          const attached = await postUnwindAttach({
            jobId: attempt.jobId,
            userOpHash: attempt.evidence.userOpHash,
            unwindTxHash: attempt.evidence.unwindTxHash,
          })
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
          if (applyProjection(attached, attempt.jobId)) return
        }
        stage = 'bridge'
        setStatus('polling')
        const final = await pollUnwindStatus({ jobId: attempt.jobId })
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
        if (!applyProjection(final, attempt.jobId)) setStatus('pending')
      } catch (error) {
        setFailedAt(stage)
        setStatus('error')
        setErrorMessage(friendlyError(error))
      }
    },
    [applyProjection]
  )

  const startWithdraw = useCallback(async () => {
    if (!BASE_CROSS_CHAIN_AVAILABLE) return

    setStatus('reserving')
    setErrorMessage(null)
    setFailedAt(null)
    setOutcome(null)
    setJobId(null)
    attemptRef.current = null
    let stage = 'sign'
    try {
      const reservation = await reserveUnwind({
        kernelAddress: ownerKernelAccount.address,
        recipientHint: stellarRecipient,
      })
      const attempt = {
        jobId: reservation.jobId,
        owner: stellarRecipient,
        userOpHash: null,
        evidence: null,
        attached: false,
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
      const evidence = await signAndSubmitUnwind({
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
      if (!attempt.userOpHash || evidence.userOpHash !== attempt.userOpHash) {
        throw new Error('submitted unwind identity requires reconciliation')
      }
      setOutcome({
        burned: evidence.burned,
        exited: evidence.exited != null ? Number(evidence.exited) : null,
        skipped: evidence.skipped != null ? Number(evidence.skipped) : null,
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
    publicClient,
    positions,
    stellarRecipient,
    idleUsdc,
    deadlineMinutes,
    continueAfterSend,
  ])

  // 'pending' only means pollUnwindStatus's bounded window closed before the bridge finished —
  // a standard-finality CCTP leg takes ~15-25 min. Keep re-polling slowly while the modal is
  // open so the UI actually flips to done when the mint lands (live 2026-07-20: funds arrived,
  // modal spun forever because nothing ever asked again).
  useEffect(() => {
    if (status !== 'pending' || !jobId) return
    let cancelled = false
    const t = setInterval(async () => {
      try {
        const last = await pollUnwindStatus({ jobId, maxTries: 1 })
        if (cancelled) return
        applyProjection(last, jobId)
      } catch {
        // transient poll failure: keep waiting, next tick retries
      }
    }, 10_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [status, jobId, applyProjection])

  const stageStates = STAGE_STATE[status] || {}
  const showStages = status !== 'idle'

  const busyCopy = {
    reserving: 'Preparing a protected unwind reservation…',
    signing: 'Confirm the passkey prompt to sign the unwind…',
    relaying: 'Handing the transaction to the relayer…',
    polling: 'Bridging USDC back to Stellar via CCTP…',
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
    if (!BASE_CROSS_CHAIN_AVAILABLE) return 'Base unavailable'
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
    if (!BASE_CROSS_CHAIN_AVAILABLE) return
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

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose?.()}>
      <div
        className="modal withdraw-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="base-withdraw-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="wd-head">
          <div className="modal-eyebrow">Base to Stellar, one passkey</div>
          <h3 className="modal-title" id="base-withdraw-title">
            Withdraw everything from Base
          </h3>
        </div>

        <div className="modal-scroll-content">
          <div className="wd-body">
            <div className="wd-hero">
              <span className="wd-hero-k">Total</span>
              <span className="wd-hero-v mono tnum" data-testid="base-withdraw-total">
                {usdc > 0 ? usdc.toFixed(2) : '-'}
              </span>
              <span className="wd-hero-unit">USDC</span>
            </div>
            <p className="wd-lede">
              Exit every Base position in one signature and bridge the USDC home to your Stellar
              wallet via CCTP.
            </p>

            <div className="wd-callout">
              One passkey signature starts the unwind. Base network fee sponsored by relay; the
              bridge completes with no second wallet popup.
            </div>

            {!BASE_CROSS_CHAIN_AVAILABLE && (
              <div className="wd-callout" role="status" data-testid="base-unavailable-notice">
                {BASE_CROSS_CHAIN_UNAVAILABLE_REASON} Your historical Base balances remain visible.
              </div>
            )}

            <div className="grant-receipt wd-receipt" role="region" aria-label="Unwind summary">
              {positions.map((p) => (
                <div className="grant-receipt-row" key={p.pool}>
                  <span className="grant-receipt-k">{p.poolName || p.pool}</span>
                  <span className="grant-receipt-v mono tnum">
                    {(Number(p.assets ?? 0n) / 1e6).toFixed(2)}
                  </span>
                </div>
              ))}
              {idleUsdc > 0n && (
                <div className="grant-receipt-row">
                  <span className="grant-receipt-k">Idle USDC</span>
                  <span className="grant-receipt-v mono tnum">
                    {(Number(idleUsdc) / 1e6).toFixed(2)}
                  </span>
                </div>
              )}
              <div className="grant-receipt-row">
                <span className="grant-receipt-k">Destination</span>
                <span className="grant-receipt-v mono" title={stellarRecipient || undefined}>
                  {shortAddr(stellarRecipient)}
                </span>
              </div>
              <div className="grant-receipt-row">
                <span className="grant-receipt-k">Signatures</span>
                <span className="grant-receipt-v mono">1 (passkey)</span>
              </div>
              <div className="grant-receipt-row">
                <span className="grant-receipt-k">Base network fee</span>
                <span className="grant-receipt-v grant-receipt-v--ok">Sponsored by relay</span>
              </div>
              {BASE_CROSS_CHAIN_AVAILABLE && (
                <div className="grant-receipt-row">
                  <label className="grant-receipt-k" htmlFor="base-unwind-deadline">
                    Authorization expires
                  </label>
                  <select
                    id="base-unwind-deadline"
                    className="grant-receipt-v"
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
              <div className="wd-loading" role="status" aria-live="polite" aria-busy="true">
                <div className="wd-loading-row">
                  <span className="think-spin wd-loading-spin" aria-hidden="true" />
                  <span className="wd-loading-text mono">
                    {busyLabel || 'Still settling with the relayer…'}
                  </span>
                </div>
                <div className="wd-loading-track" aria-hidden="true">
                  <div
                    className={`wd-loading-fill${busy ? ' is-active' : ''}`}
                    style={{ width: `${Math.round(stageProgress * 100)}%` }}
                  />
                </div>
              </div>
            )}

            {showStages && (
              <ol className="wd-stages" aria-label="Unwind progress">
                {STAGES.map((s) => {
                  const st = failedAt === s.key ? 'failed' : stageStates[s.key] || 'idle'
                  return (
                    <li
                      key={s.key}
                      className={`wd-stage wd-stage--${st}`}
                      aria-current={st === 'running' ? 'step' : undefined}
                    >
                      {st === 'running' ? (
                        <span className="think-spin wd-stage-spin" aria-hidden="true" />
                      ) : (
                        <span className="wd-stage-dot" aria-hidden="true" />
                      )}
                      <span className="wd-stage-label">{s.label}</span>
                      {st === 'running' && <span className="wd-stage-hint">working…</span>}
                      {st === 'done' && (
                        <span className="wd-stage-hint wd-stage-hint--ok">done</span>
                      )}
                      {st === 'failed' && (
                        <span className="wd-stage-hint wd-stage-hint--err">failed</span>
                      )}
                    </li>
                  )
                })}
              </ol>
            )}

            {status === 'done' && outcome?.skipped > 0 && (
              <div className="wd-callout" role="status" data-testid="base-withdraw-partial">
                Exited {outcome.exited} of {outcome.exited + outcome.skipped} pools.{' '}
                {outcome.skipped} pool{outcome.skipped === 1 ? '' : 's'} could not be exited right
                now and {outcome.skipped === 1 ? 'its' : 'their'} funds are still on Base,
                untouched. Try again later.
              </div>
            )}
            {status === 'done' && !outcome?.skipped && (
              <div className="wd-callout wd-callout--ok" role="status">
                Unwind complete.{' '}
                {settledUsdc != null ? `${settledUsdc.toFixed(2)} USDC` : 'Your USDC'} lands in your
                Stellar wallet within about a minute. Check balances if it is not there yet.
              </div>
            )}
            {status === 'pending' && (
              <div className="wd-callout" role="status">
                Still settling. The relayer is finishing the bridge. Funds are in flight, not lost;
                check your Stellar balance in a few minutes.
              </div>
            )}
            {status === 'reconcile' && (
              <div className="wd-callout" role="status" data-testid="base-withdraw-reconcile">
                The Base operation landed, but its exact burn event needs reconciliation. It will
                not be attached or signed again from this screen. Check status before taking another
                action.
              </div>
            )}
            {status === 'submission_unknown' && (
              <div className="wd-callout" role="status" data-testid="base-withdraw-reconcile">
                The Base operation may have been submitted, but no canonical operation hash was
                returned. It will not be signed again from this screen. Check status before taking
                another action.
              </div>
            )}

            {errorMessage && (
              <div className="wd-error" role="alert">
                <span>{errorMessage}</span>
              </div>
            )}

            <p className="wd-footnote">
              Recipient {shortAddr(stellarRecipient)} · full address in your connected wallet
            </p>
            {/* Full recipient kept for tests / assistive tech without cluttering the hero. */}
            <span className="sr-only" data-testid="base-withdraw-recipient">
              {stellarRecipient}
            </span>
          </div>
        </div>

        <div className="modal-actions">
          {!finished && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => onClose?.()}
              disabled={busy}
            >
              Cancel
            </button>
          )}
          <button
            ref={confirmRef}
            type="button"
            className={`btn btn-primary${busy ? ' is-loading' : ''}`}
            onClick={onPrimary}
            disabled={!BASE_CROSS_CHAIN_AVAILABLE || busy || (status === 'idle' && nothingToDo)}
            aria-busy={busy || undefined}
          >
            {busy && <span className="think-spin wd-btn-spin" aria-hidden="true" />}
            {primaryLabel()}
          </button>
        </div>
      </div>
    </div>
  )
}
