// frontend/src/screens/Withdraw.jsx
// Base → Stellar unwind: one passkey sign → batched withdraw+burn → relayer CCTP mint.
// UI mirrors WithdrawModal (wd-* / grant-receipt / modal shell) so Base exit feels like
// the rest of the dashboard, not a bare step list with inline styles.
import { useState, useCallback, useEffect, useRef } from 'react'
import { signAndSubmitUnwind } from '../base/withdrawBatch.js'
import { postUnwind, pollFarmStatus } from '../base/relayerClient.js'

const STAGES = [
  { key: 'sign', label: 'Sign unwind' },
  { key: 'relay', label: 'Hand to relayer' },
  { key: 'bridge', label: 'Bridge to Stellar' },
]

// status → per-stage state. 'pending' = polling exhausted while the relayer still works.
const STAGE_STATE = {
  idle: {},
  signing: { sign: 'running' },
  relaying: { sign: 'done', relay: 'running' },
  polling: { sign: 'done', relay: 'done', bridge: 'running' },
  pending: { sign: 'done', relay: 'done', bridge: 'running' },
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
  if (raw.includes('strkey') || raw.includes('hookdata')) {
    return err.message
  }
  if (err?.message && err.message.length < 160) return err.message
  return 'Withdraw failed. Please try again.'
}

export default function Withdraw({
  ownerKernelAccount,
  publicClient,
  withdrawals,
  stellarRecipient,
  totalAssetsForBurn,
  poolName,
  onDone,
  onClose,
}) {
  const [status, setStatus] = useState('idle') // idle | signing | relaying | polling | pending | done | error
  const [errorMessage, setErrorMessage] = useState(null)
  const [failedAt, setFailedAt] = useState(null)
  const [jobId, setJobId] = useState(null)
  const confirmRef = useRef(null)

  const usdc = Number(totalAssetsForBurn ?? 0n) / 1e6
  const title = poolName || withdrawals?.[0]?.poolName || 'Base position'
  const busy = status === 'signing' || status === 'relaying' || status === 'polling'
  const finished = status === 'done' || status === 'pending'

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

  const startWithdraw = useCallback(async () => {
    setStatus('signing')
    setErrorMessage(null)
    setFailedAt(null)
    let stage = 'sign'
    try {
      const { unwindTxHash } = await signAndSubmitUnwind({
        ownerKernelAccount,
        publicClient,
        withdrawals,
        stellarRecipient,
        totalAssetsForBurn,
      })
      stage = 'relay'
      setStatus('relaying')
      const { jobId } = await postUnwind({ unwindTxHash, stellarRecipient })
      setJobId(jobId)
      stage = 'bridge'
      setStatus('polling')
      const final = await pollFarmStatus({ jobId })
      if (final.status === 'done') {
        setStatus('done')
        onDone?.()
      } else if (final.status === 'error') {
        setFailedAt('bridge')
        setStatus('error')
        setErrorMessage(
          `Relayer reported an error (job ${jobId}). The unwind is on Base; funds are recoverable. Retry or check the dashboard.`
        )
      } else {
        // Relayer still settling; funds are in flight, not lost.
        setStatus('pending')
        onDone?.()
      }
    } catch (err) {
      setFailedAt(stage)
      setStatus('error')
      setErrorMessage(friendlyError(err))
    }
  }, [ownerKernelAccount, publicClient, withdrawals, stellarRecipient, totalAssetsForBurn, onDone])

  // 'pending' only means pollFarmStatus's ~2-minute window closed before the bridge finished —
  // a standard-finality CCTP leg takes ~15-25 min. Keep re-polling slowly while the modal is
  // open so the UI actually flips to done when the mint lands (live 2026-07-20: funds arrived,
  // modal spun forever because nothing ever asked again).
  useEffect(() => {
    if (status !== 'pending' || !jobId) return
    let cancelled = false
    const t = setInterval(async () => {
      try {
        const last = await pollFarmStatus({ jobId, maxTries: 1 })
        if (cancelled) return
        if (last.status === 'done') {
          setStatus('done')
          onDone?.()
        } else if (last.status === 'error') {
          setFailedAt('bridge')
          setStatus('error')
          setErrorMessage(
            `Relayer reported an error (job ${jobId}). The unwind is on Base; funds are recoverable.`
          )
        }
      } catch {
        // transient poll failure: keep waiting, next tick retries
      }
    }, 10_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [status, jobId, onDone])

  const stageStates = STAGE_STATE[status] || {}
  const showStages = status !== 'idle'

  const busyCopy = {
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
    if (status === 'signing') return 'Signing…'
    if (status === 'relaying') return 'Relaying…'
    if (status === 'polling') return 'Bridging…'
    if (status === 'error') return 'Retry withdraw'
    if (status === 'done') return 'Done'
    if (status === 'pending') return 'Close'
    return usdc > 0 ? `Withdraw ${usdc.toFixed(2)} USDC` : 'Withdraw'
  }

  const onPrimary = () => {
    if (finished) {
      onClose?.()
      return
    }
    if (!busy) startWithdraw()
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
            Withdraw from {title}
          </h3>
        </div>

        <div className="modal-scroll-content">
          <div className="wd-body">
            <div className="wd-hero">
              <span className="wd-hero-k">Position</span>
              <span className="wd-hero-v mono tnum">{usdc > 0 ? usdc.toFixed(2) : '-'}</span>
              <span className="wd-hero-unit">USDC</span>
            </div>
            <p className="wd-lede">
              Exit this Base pool and bridge USDC home to your Stellar wallet via CCTP.
            </p>

            <div className="wd-callout">
              One passkey signature starts the unwind. The relayer sponsors Base gas and completes
              the bridge; no second wallet popup.
            </div>

            <div className="grant-receipt wd-receipt" role="region" aria-label="Unwind summary">
              <div className="grant-receipt-row">
                <span className="grant-receipt-k">You receive</span>
                <span className="grant-receipt-v mono tnum">
                  ~{usdc > 0 ? usdc.toFixed(2) : '0.00'} USDC
                </span>
              </div>
              <div className="grant-receipt-row">
                <span className="grant-receipt-k">Destination</span>
                <span className="grant-receipt-v mono" title={stellarRecipient || undefined}>
                  {shortAddr(stellarRecipient)}
                </span>
              </div>
              <div className="grant-receipt-row">
                <span className="grant-receipt-k">Route</span>
                <span className="grant-receipt-v">Base → Stellar (CCTP)</span>
              </div>
              <div className="grant-receipt-row">
                <span className="grant-receipt-k">Signatures</span>
                <span className="grant-receipt-v mono">1 (passkey)</span>
              </div>
              <div className="grant-receipt-row">
                <span className="grant-receipt-k">Network fee</span>
                <span className="grant-receipt-v grant-receipt-v--ok">0, sponsored</span>
              </div>
              <div className="grant-receipt-row">
                <span className="grant-receipt-k">Estimated time</span>
                <span className="grant-receipt-v mono">~1 minute</span>
              </div>
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

            {status === 'done' && (
              <div className="wd-callout wd-callout--ok" role="status">
                Unwind complete. Circle USDC lands in your Stellar wallet within about a minute.
                Check balances if it is not there yet.
              </div>
            )}
            {status === 'pending' && (
              <div className="wd-callout" role="status">
                Still settling. The relayer is finishing the bridge. Funds are in flight, not lost;
                check your Stellar balance in a few minutes.
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
            disabled={busy || (status === 'idle' && usdc <= 0 && !totalAssetsForBurn)}
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
