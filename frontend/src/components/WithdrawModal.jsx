// WithdrawModal.jsx
// Manual withdraw from a single active position. Reuses the app's modal tokens.
import React, { useState, useEffect, useRef } from 'react'
import { withdrawFromVault } from '../agents/agentController.js'
import { saveTransaction } from '../history.js'
import { readVaultDepositTimestamp } from '../wallet.js'
import { loadSettings, t } from '../settingsStore.js'

const fmtDur = (secAgo) => {
  if (!secAgo || secAgo <= 0) return '-'
  const d = Math.floor(secAgo / 86400), h = Math.floor((secAgo % 86400) / 3600), m = Math.floor((secAgo % 3600) / 60)
  if (d > 0) return `${d} day${d === 1 ? '' : 's'} ${h} hour${h === 1 ? '' : 's'}`
  return h > 0 ? `${h} hour${h === 1 ? '' : 's'} ${m} min` : `${m} min`
}

const Row = ({ k, v, color }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, padding: '3px 0' }}>
    <span style={{ color: 'var(--text-muted)' }}>{k}</span>
    <span className="mono" style={{ textAlign: 'right', color: color || 'inherit' }}>{v}</span>
  </div>
)

const pctBtn = { appearance: 'none', flex: 1, border: '.5px solid rgba(255,255,255,.18)', borderRadius: 5, background: 'rgba(255,255,255,.06)', color: 'inherit', font: 'inherit', fontSize: 11, padding: '5px 0', cursor: 'pointer' }

// Map raw ethers/relayer errors to a short, human-readable line.
// Avoids dumping the full ACTION_REJECTED / sendTransaction payload into the UI.
const friendlyError = (err) => {
  const code = err?.code || err?.info?.error?.code
  const raw = (err?.shortMessage || err?.message || '').toLowerCase()
  if (code === 'ACTION_REJECTED' || code === 4001 || raw.includes('user rejected') || raw.includes('user denied')) {
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

export default function WithdrawModal({ vault, balance, unclaimedRewards = 0, userAddress, onClose, onSuccess }) {
  const { language: lang } = loadSettings()
  const balUsdc = Number(balance || 0) / 1e6
  const rewardsUsdc = Number(unclaimedRewards || 0) / 1e6
  const [amount, setAmount] = useState(balUsdc.toFixed(2))
  const [status, setStatus] = useState('idle') // idle | loading | done
  const [error, setError] = useState(null)
  const [depositedAgoSec, setDepositedAgoSec] = useState(0)
  const confirmRef = useRef(null)

  useEffect(() => {
    const prev = document.activeElement
    confirmRef.current?.focus()
    const onKey = (e) => { if (e.key === 'Escape' && status !== 'loading') onClose() }
    window.addEventListener('keydown', onKey)
    readVaultDepositTimestamp(vault.address, userAddress).then((ts) => {
      if (ts > 0) setDepositedAgoSec(Math.floor(Date.now() / 1000) - ts)
    })
    return () => { window.removeEventListener('keydown', onKey); prev?.focus?.() }
  }, [])

  const parsed = parseFloat(amount)
  const valid = parsed > 0 && parsed <= balUsdc + 1e-9
  const setPct = (p) => setAmount((balUsdc * p).toFixed(2))

  const handleConfirm = async () => {
    if (!valid || status !== 'idle') return
    setStatus('loading'); setError(null)
    const units = BigInt(Math.floor(parsed * 1e6)).toString()
    try {
      const result = await withdrawFromVault(vault.address, units, userAddress)
      saveTransaction({ txHash: result.txHash, vaultName: vault.name, vaultAddress: vault.address, protocol: vault.protocol, amountUsdc: parsed, apy: vault.apy, type: 'withdraw', network: 'sepolia' })
      setStatus('done')
      onSuccess(vault.address, units)
      setTimeout(onClose, 700)
    } catch (err) {
      setError(friendlyError(err)); setStatus('idle')
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => status !== 'loading' && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="withdraw-title" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-eyebrow">withdraw · 1Shot relayer</div>
        <h3 className="modal-title" id="withdraw-title">{t(lang, 'withdraw')} from {vault.name}</h3>

        <div className="act-meta" style={{ fontSize: 11, margin: '8px 0 6px' }}>Available: <span className="mono">{balUsdc.toFixed(2)} USDC</span></div>

        <label htmlFor="wd-amount" style={{ fontSize: 10, opacity: .6 }}>Amount</label>
        <div style={{ display: 'flex', alignItems: 'center', border: '.5px solid rgba(255,255,255,.18)', borderRadius: 6, padding: '0 10px', marginTop: 3 }}>
          <input id="wd-amount" className="mono" type="number" min="0.01" max={balUsdc} step="0.01" value={amount}
            onChange={(e) => setAmount(e.target.value)} disabled={status !== 'idle'}
            style={{ flex: 1, background: 'transparent', border: 0, color: 'inherit', font: 'inherit', fontSize: 14, padding: '8px 0', outline: 'none' }} />
          <span style={{ opacity: .6, fontSize: 12 }}>USDC</span>
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          {[['25%', .25], ['50%', .5], ['75%', .75], ['Max', 1]].map(([l, p]) => <button key={l} style={pctBtn} onClick={() => setPct(p)} disabled={status !== 'idle'}>{l}</button>)}
        </div>
        {!valid && <div style={{ color: 'var(--danger)', fontSize: 10.5, marginTop: 5 }}>Enter an amount between 0.01 and {balUsdc.toFixed(2)} USDC.</div>}

        <div style={{ borderTop: '.5px solid rgba(255,255,255,.08)', margin: '10px 0' }} />
        <Row k="Time deposited" v={fmtDur(depositedAgoSec)} />
        <Row k="Total earned" v={`+${rewardsUsdc.toFixed(2)} USDC`} color="var(--ok)" />
        <div style={{ fontSize: 9.5, opacity: .5, textAlign: 'right', marginTop: -2 }}>earned · preserved on withdraw (claimable)</div>

        <div style={{ borderTop: '.5px solid rgba(255,255,255,.08)', margin: '10px 0' }} />
        <Row k="You receive" v={`~${(valid ? parsed : 0).toFixed(2)} USDC`} />
        <Row k="+ Rewards" v={`+${rewardsUsdc.toFixed(2)} USDC (preserved)`} color="var(--ok)" />
        <Row k="Gas" v="~0 · 1Shot relayer" />
        <Row k="Permission" v="active" />
        <Row k="Est. time" v="~30 seconds" />

        {error && (
          <div role="alert" style={{ display: 'flex', gap: 7, alignItems: 'flex-start', color: 'var(--danger)', fontSize: 11, lineHeight: 1.4, marginTop: 8, padding: '7px 9px', background: 'rgba(255,80,80,.08)', border: '.5px solid rgba(255,80,80,.25)', borderRadius: 6, overflowWrap: 'anywhere' }}>
            <span aria-hidden="true" style={{ flexShrink: 0 }}>⚠</span>
            <span>{error}</span>
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose} disabled={status === 'loading'}>Cancel</button>
          <button ref={confirmRef} className="btn btn-primary" onClick={handleConfirm} disabled={!valid || status !== 'idle'}>
            {status === 'idle' ? t(lang, 'withdraw') : status === 'loading' ? 'Withdrawing…' : 'Done ✓'}
          </button>
        </div>
      </div>
    </div>
  )
}
