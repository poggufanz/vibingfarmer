// WithdrawModal.jsx
// Manual withdraw from a single active position. Reuses the app's modal tokens.
import React, { useState, useEffect, useRef } from 'react'
import { withdrawAllFromVault } from '../agents/agentController.js'
import { saveTransaction } from '../history.js'
import { loadSettings, t } from '../settingsStore.js'
import { toDisplay } from '../stellar/format.js'

// The v2 vault exposes no per-deposit timestamp, so "time deposited" is unknown (renders "-").
// Kept as a 0-stub so the modal effect below is unchanged. ponytail: no chain read to wire here.
const readVaultDepositTimestamp = async () => 0

const fmtDur = (secAgo) => {
  if (!secAgo || secAgo <= 0) return '-'
  const d = Math.floor(secAgo / 86400),
    h = Math.floor((secAgo % 86400) / 3600),
    m = Math.floor((secAgo % 3600) / 60)
  if (d > 0) return `${d} day${d === 1 ? '' : 's'} ${h} hour${h === 1 ? '' : 's'}`
  return h > 0 ? `${h} hour${h === 1 ? '' : 's'} ${m} min` : `${m} min`
}

const Row = ({ k, v, color }) => (
  <div
    style={{
      display: 'flex',
      justifyContent: 'space-between',
      gap: 12,
      fontSize: 12,
      padding: '3px 0',
    }}
  >
    <span style={{ color: 'var(--text-muted)' }}>{k}</span>
    <span className="mono" style={{ textAlign: 'right', color: color || 'inherit' }}>
      {v}
    </span>
  </div>
)

// Map raw ethers/relayer errors to a short, human-readable line.
// Avoids dumping the full ACTION_REJECTED / sendTransaction payload into the UI.
const friendlyError = (err) => {
  const code = err?.code || err?.info?.error?.code
  const raw = (err?.shortMessage || err?.message || '').toLowerCase()
  if (
    code === 'ACTION_REJECTED' ||
    code === 4001 ||
    raw.includes('user rejected') ||
    raw.includes('user denied')
  ) {
    return 'You rejected the transaction in your wallet.'
  }
  if (raw.includes('insufficient funds') || raw.includes('insufficient balance')) {
    return 'Insufficient balance to cover this withdrawal.'
  }
  if (raw.includes('timeout') || raw.includes('timed out')) {
    return 'The relayer timed out. Please try again.'
  }
  if (raw.includes('expired') || raw.includes('permission')) {
    return 'Agent permission is no longer active. Re-grant and retry.'
  }
  // Fall back to the wallet's own short message when present, else a generic line.
  const short = err?.shortMessage || err?.reason
  if (short && short.length < 120) return short
  return 'Withdraw failed. Please try again.'
}

export default function WithdrawModal({
  vault,
  balance,
  unclaimedRewards = 0,
  userAddress,
  agentAddresses = [],
  onClose,
  onSuccess,
}) {
  const { language: lang } = loadSettings()
  const balUsdc = toDisplay(balance)
  const rewardsUsdc = toDisplay(unclaimedRewards)
  const [status, setStatus] = useState('idle') // idle | loading | done
  const [error, setError] = useState(null)
  const [progress, setProgress] = useState(null)
  const [depositedAgoSec, setDepositedAgoSec] = useState(0)
  const confirmRef = useRef(null)

  useEffect(() => {
    const prev = document.activeElement
    confirmRef.current?.focus()
    const onKey = (e) => {
      if (e.key === 'Escape' && status !== 'loading') onClose()
    }
    window.addEventListener('keydown', onKey)
    readVaultDepositTimestamp(vault.address, userAddress).then((ts) => {
      if (ts > 0) setDepositedAgoSec(Math.floor(Date.now() / 1000) - ts)
    })
    return () => {
      window.removeEventListener('keydown', onKey)
      prev?.focus?.()
    }
  }, [])

  // owner_withdraw sweeps an agent's ENTIRE position — there is no partial-amount form of it — and
  // a position is the sum over every agent, so a withdraw is N sweeps of 100%. The old amount input
  // and 25/50/75% buttons never reached the chain: the typed value was passed to a parameter the
  // controller ignores. Showing the real, unsplittable amount beats offering a choice we can't honour.
  const canWithdraw = balUsdc > 0 && agentAddresses.length > 0

  const handleConfirm = async () => {
    if (!canWithdraw || status !== 'idle') return
    setStatus('loading')
    setError(null)
    setProgress(null)
    try {
      const results = await withdrawAllFromVault(
        vault.address,
        userAddress,
        agentAddresses,
        setProgress
      )
      const failed = results.filter((r) => !r.ok)

      if (failed.length) {
        // Partial sweep: some USDC moved, some did not, and the per-agent split is not readable
        // from here — so claim no amount rather than a wrong one. Reconcile shows what is left.
        // ponytail: the successful legs get no history row on this branch; add per-agent amounts
        // if the vault ever exposes a per-sweep event to size them from.
        setError(
          `Swept ${results.length - failed.length} of ${results.length} agents. ` +
            `${failed.length} failed: ${failed[0].error}`
        )
        setStatus('idle')
        setProgress(null)
        onSuccess(vault.address, '0') // reconcile from chain, but never a false zero
        return
      }

      saveTransaction({
        txHash: results[0].txHash,
        vaultName: vault.name,
        vaultAddress: vault.address,
        protocol: vault.protocol,
        amountUsdc: balUsdc,
        apy: vault.apy,
        type: 'withdraw',
        network: 'stellar-testnet',
      })
      setStatus('done')
      onSuccess(vault.address, balance)
      setTimeout(onClose, 700)
    } catch (err) {
      setError(friendlyError(err))
      setStatus('idle')
      setProgress(null)
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => status !== 'loading' && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="withdraw-title"
        style={{ maxWidth: 420 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-eyebrow">Full exit, signed in your wallet</div>
        <h3 className="modal-title" id="withdraw-title">
          {t(lang, 'withdraw')} from {vault.name}
        </h3>

        <div className="act-meta" style={{ fontSize: 11, margin: '8px 0 6px' }}>
          Withdrawing <span className="mono">{balUsdc.toFixed(2)} USDC</span> — your whole position.
        </div>

        {agentAddresses.length === 0 ? (
          <div style={{ color: 'var(--danger)', fontSize: 10.5, marginTop: 5 }}>
            No active agent holds this position, so there is nothing to sweep. If you just made a
            deposit, wait for agent permissions to load and reopen this.
          </div>
        ) : (
          <div style={{ fontSize: 10.5, opacity: 0.6, marginTop: 5, lineHeight: 1.45 }}>
            This position is held by {agentAddresses.length}{' '}
            {agentAddresses.length === 1 ? 'agent' : 'agents'}. Each is swept by its own
            transaction, so your wallet asks you to sign{' '}
            {agentAddresses.length === 1 ? 'once' : `${agentAddresses.length} times`}.
          </div>
        )}

        {progress && (
          <div
            className="mono"
            style={{ fontSize: 10.5, marginTop: 6, color: 'var(--text-muted)' }}
          >
            Sweeping agent {progress.index + 1} of {progress.total} — confirm in your wallet…
          </div>
        )}

        <div style={{ borderTop: '.5px solid rgba(255,255,255,.08)', margin: '10px 0' }} />
        <Row k="Time deposited" v={fmtDur(depositedAgoSec)} />
        <Row k="Total earned" v={`+${rewardsUsdc.toFixed(2)} USDC`} color="var(--ok)" />
        <div style={{ fontSize: 9.5, opacity: 0.5, textAlign: 'right', marginTop: -2 }}>
          Earnings remain claimable after withdrawal.
        </div>

        <div style={{ borderTop: '.5px solid rgba(255,255,255,.08)', margin: '10px 0' }} />
        <Row k="You receive" v={`~${balUsdc.toFixed(2)} USDC`} />
        <Row k="Rewards" v={`+${rewardsUsdc.toFixed(2)} USDC (preserved)`} color="var(--ok)" />
        <Row k="Signatures" v={`${agentAddresses.length} (one per agent)`} />
        <Row k="Network fee" v="Paid by you, in XLM" />
        <Row k="Estimated time" v={`~${Math.max(30, agentAddresses.length * 20)} seconds`} />

        {error && (
          <div
            role="alert"
            style={{
              display: 'flex',
              gap: 7,
              alignItems: 'flex-start',
              color: 'var(--danger)',
              fontSize: 11,
              lineHeight: 1.4,
              marginTop: 8,
              padding: '7px 9px',
              background: 'rgba(255,80,80,.08)',
              border: '.5px solid rgba(255,80,80,.25)',
              borderRadius: 6,
              overflowWrap: 'anywhere',
            }}
          >
            <span>{error}</span>
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose} disabled={status === 'loading'}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            className="btn btn-primary"
            onClick={handleConfirm}
            disabled={!canWithdraw || status !== 'idle'}
          >
            {status === 'idle'
              ? t(lang, 'withdraw')
              : status === 'loading'
                ? progress
                  ? `Sweeping ${progress.index + 1}/${progress.total}…`
                  : 'Withdrawing…'
                : 'Done'}
          </button>
        </div>
      </div>
    </div>
  )
}
