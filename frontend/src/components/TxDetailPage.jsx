// TxDetailPage.jsx — transaction detail route (/tx/:txHash)
import React, { useState } from 'react'
import { useParams } from 'react-router-dom'
import { getTransactions } from '../history.js'
import { useNavigateTo } from '../router.js'

const shortHash = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-8)}` : '')

function formatAbs(ts) {
  return new Date(ts).toLocaleString('en-US', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
}
function formatRel(ts) {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60_000)
  const h = Math.floor(diff / 3_600_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  if (h < 24) return `${h} hr ago`
  return `${Math.floor(h / 24)}d ago`
}

const backBtn = { appearance: 'none', border: 0, background: 'transparent', font: 'inherit', fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer', padding: 0, textDecoration: 'underline' }
const divider = { borderTop: '1px solid var(--border)', margin: '20px 0' }
const sectionLabel = { fontSize: 11, color: 'var(--text-muted)', textTransform: 'capitalize', letterSpacing: '0.01em', fontWeight: 500 }
const extLink = { color: 'var(--text-muted)', fontSize: 11, textDecoration: 'underline' }
const ghostBtn = { appearance: 'none', border: '.5px solid rgba(255,255,255,.18)', borderRadius: 5, background: 'rgba(255,255,255,.06)', color: 'inherit', font: 'inherit', fontSize: 11, padding: '6px 12px', cursor: 'pointer' }

export default function TxDetailPage() {
  const { txHash } = useParams()
  const navigateTo = useNavigateTo()
  const [copied, setCopied] = useState(false)
  const tx = getTransactions().find((t) => t.txHash === txHash)

  const handleCopy = () => {
    navigator.clipboard?.writeText(txHash).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleFarmAgain = () => {
    if (tx) {
      sessionStorage.setItem('yv_prefill_protocol', tx.protocol)
      sessionStorage.setItem('yv_prefill_name', tx.vaultName)
      sessionStorage.setItem('yv_prefill_apy', String(tx.apy))
    }
    navigateTo('strategy')
  }

  if (!tx) {
    return (
      <div className="stage enter" style={{ maxWidth: 520, margin: '0 auto', padding: 32 }}>
        <button onClick={() => { if (window.history.length > 1) window.history.back(); else navigateTo('history'); }} style={backBtn}>← Back</button>
        <div className="mono" style={{ marginTop: 28, color: 'var(--text-muted)', fontSize: 14 }}>transaction not found</div>
        <div style={{ marginTop: 16, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <a href={`https://sepolia.basescan.org/tx/${txHash}`} target="_blank" rel="noopener noreferrer" style={extLink}>
            View on Basescan ↗
          </a>
          <button onClick={() => { if (window.history.length > 1) window.history.back(); else navigateTo('history'); }} style={{ ...backBtn, textDecoration: 'none' }}>← Back</button>
        </div>
      </div>
    )
  }

  const isWithdraw = tx.type === 'withdraw'

  const details = [
    { label: 'Type',        value: tx.type || 'deposit' },
    { label: 'Vault',       value: tx.vaultName },
    { label: 'Protocol',    value: tx.protocol },
    { label: 'Amount',      value: `${tx.amountUsdc} USDC` },
    { label: 'APY',         value: tx.apy ? `${tx.apy}%` : '-' },
    { label: 'Worker',      value: tx.workerId || '-' },
    { label: 'Gas paid by', value: tx.gasPayedBy || '1shot-relayer', highlight: true },
    { label: 'Network',     value: `${tx.network || 'base sepolia'} testnet` },
  ]

  return (
    <div className="stage enter" style={{ maxWidth: 520, margin: '0 auto', padding: 32 }}>
      <button onClick={() => { if (window.history.length > 1) window.history.back(); else navigateTo('history'); }} style={backBtn}>← Back</button>

      <div style={{ marginTop: 22, display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ color: 'var(--ok)', fontSize: 15, lineHeight: 1 }}>✓</span>
        <span style={{ fontSize: 14, fontWeight: 600 }}>
          {isWithdraw ? 'Withdraw confirmed' : 'Deposit confirmed'}
        </span>
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>
          {formatRel(tx.timestamp)}
        </span>
      </div>
      <div className="mono" style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 4, paddingLeft: 25 }}>
        {formatAbs(tx.timestamp)}
      </div>

      <div style={divider} />

      {/* TX hash */}
      <div>
        <div style={sectionLabel}>TRANSACTION</div>
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span className="mono" style={{ fontSize: 11.5 }}>{shortHash(txHash)}</span>
          <button style={{ ...backBtn, fontSize: 11, color: copied ? 'var(--ok)' : 'var(--text-muted)' }} onClick={handleCopy}>
            {copied ? 'copied!' : '[copy]'}
          </button>
          <a href={`https://sepolia.basescan.org/tx/${txHash}`} target="_blank" rel="noopener noreferrer" style={extLink}>
            View on Base Sepolia Basescan ↗
          </a>
        </div>
      </div>

      <div style={divider} />

      {/* Details grid */}
      <div>
        <div style={sectionLabel}>DETAILS</div>
        <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 20px' }}>
          {details.map(({ label, value, highlight }) => (
            <div key={label}>
              <div className="mono" style={{ fontSize: 9, color: 'var(--text-faint)', textTransform: 'lowercase', letterSpacing: '-0.01em', marginBottom: 3 }}>
                {label}
              </div>
              <div style={{ fontSize: 12.5, color: highlight ? 'var(--ok)' : 'inherit', fontWeight: highlight ? 500 : 400 }}>
                {value}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={divider} />

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        {tx.protocol && (
          <button style={ghostBtn} onClick={() => navigateTo('vault', tx.protocol)}>
            View vault →
          </button>
        )}
        <button className="btn btn-primary" onClick={handleFarmAgain}>
          Farm this vault again →
        </button>
      </div>
    </div>
  )
}
