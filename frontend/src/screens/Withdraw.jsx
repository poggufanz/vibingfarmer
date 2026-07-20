// frontend/src/screens/Withdraw.jsx
// Withdraw -> Unwind screen: one tap -> owner-signed batched unwind (withdrawBatch.js) -> hand
// the tx hash to the relayer (relayerClient.js) -> poll to done. End state: USDC back at the
// user's own Stellar G-address (§6 step 8) — this screen never asks for a second signature.
// Presented as the same step-flow language the rest of the app uses: each stage is a labeled
// row with a live status, and the terminal states are explicit — 'pending' after polling gave
// up must read as "still settling", never as silence (users assumed a withdraw ran when
// nothing had reached the chain, 2026-07-20).
import { useState, useCallback } from 'react'
import { signAndSubmitUnwind } from '../base/withdrawBatch.js'
import { postUnwind, pollFarmStatus } from '../base/relayerClient.js'

const STAGES = [
  { key: 'sign', label: 'Sign unwind (passkey)' },
  { key: 'relay', label: 'Hand to relayer' },
  { key: 'bridge', label: 'Bridge back to Stellar (CCTP)' },
]

// status -> per-stage state. 'pending' = polling exhausted while the relayer still works.
const STAGE_STATE = {
  idle: {},
  signing: { sign: 'running' },
  relaying: { sign: 'done', relay: 'running' },
  polling: { sign: 'done', relay: 'done', bridge: 'running' },
  pending: { sign: 'done', relay: 'done', bridge: 'running' },
  done: { sign: 'done', relay: 'done', bridge: 'done' },
}

const dot = (st) =>
  st === 'done' ? '✓' : st === 'running' ? '●' : st === 'failed' ? '✕' : '○'

export default function Withdraw({
  ownerKernelAccount,
  publicClient,
  withdrawals,
  stellarRecipient,
  totalAssetsForBurn,
  onDone,
}) {
  const [status, setStatus] = useState('idle') // idle | signing | relaying | polling | pending | done | error
  const [errorMessage, setErrorMessage] = useState(null)
  const [failedAt, setFailedAt] = useState(null)

  const usdc = Number(totalAssetsForBurn ?? 0n) / 1e6

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
          `Relayer reported an error (job ${jobId}). The unwind tx is on Base — funds are recoverable; retry or check the dashboard.`
        )
      } else {
        setStatus('pending') // relayer still settling; funds are in flight, not lost
      }
    } catch (err) {
      setFailedAt(stage)
      setStatus('error')
      setErrorMessage(err.message)
    }
  }, [ownerKernelAccount, publicClient, withdrawals, stellarRecipient, totalAssetsForBurn, onDone])

  const stageStates = STAGE_STATE[status] || {}
  const busy = status === 'signing' || status === 'relaying' || status === 'polling'

  return (
    <section className="withdraw-screen">
      <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '4px 0 12px' }}>
        Unwinds {usdc > 0 ? `~${usdc.toFixed(2)} USDC` : 'this position'} and bridges back to{' '}
        <code style={{ fontSize: 11 }}>{stellarRecipient}</code>.
      </p>

      {status !== 'idle' && (
        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: '10px 14px',
            marginBottom: 12,
          }}
        >
          {STAGES.map((s) => {
            const st = failedAt === s.key ? 'failed' : stageStates[s.key]
            return (
              <div
                key={s.key}
                style={{
                  display: 'flex',
                  gap: 10,
                  alignItems: 'center',
                  padding: '4px 0',
                  fontSize: 13,
                  color:
                    st === 'failed'
                      ? 'var(--danger)'
                      : st
                        ? 'inherit'
                        : 'var(--text-muted)',
                }}
              >
                <span className="mono" aria-hidden="true">
                  {dot(st)}
                </span>
                <span>{s.label}</span>
                {st === 'running' && (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>working…</span>
                )}
              </div>
            )
          })}
        </div>
      )}

      {status === 'done' && (
        <p role="status" style={{ fontSize: 13 }}>
          Done — USDC is on its way to your Stellar wallet. It lands as Circle USDC within a
          minute; check your balances.
        </p>
      )}
      {status === 'pending' && (
        <p role="status" style={{ fontSize: 13 }}>
          Still settling — the relayer is finishing the bridge. Funds are in flight, not lost;
          check your Stellar balance in a few minutes.
        </p>
      )}
      {errorMessage && (
        <p
          className="withdraw-error"
          role="alert"
          style={{ color: 'var(--danger)', fontSize: 12 }}
        >
          {errorMessage}
        </p>
      )}

      {status !== 'done' && status !== 'pending' && (
        <button type="button" className="btn" onClick={startWithdraw} disabled={busy}>
          {status === 'error' ? 'Retry withdraw' : 'Withdraw'}
        </button>
      )}
    </section>
  )
}
