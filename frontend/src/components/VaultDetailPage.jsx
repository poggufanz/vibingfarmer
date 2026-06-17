// VaultDetailPage.jsx — vault detail route (/vault/:protocol)
import React, { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { VAULT_CATALOG } from '../config.js'
import { fetchDeFiLlamaVaults } from '../defiLlama.js'
import { fetchApyHistory } from '../apyHistory.js'
import { generateSparkline, calcApyStats } from '../sparkline.js'
import { useNavigateTo } from '../router.js'

const short = (a) => (a ? `${a.slice(0, 10)}…${a.slice(-8)}` : '')

const backBtn = { appearance: 'none', border: 0, background: 'transparent', font: 'inherit', fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer', padding: 0, textDecoration: 'underline' }
const divider = { borderTop: '1px solid var(--border)', margin: '20px 0' }
const sectionLabel = { fontSize: 11, color: 'var(--text-muted)', textTransform: 'capitalize', letterSpacing: '0.01em', fontWeight: 500 }
const metricCard = { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '10px 12px' }
const pillBtn = { appearance: 'none', border: '.5px solid rgba(255,255,255,.18)', borderRadius: 5, background: 'rgba(255,255,255,.06)', color: 'inherit', font: 'inherit', fontSize: 10.5, padding: '4px 9px', cursor: 'pointer' }
const extLink = { color: 'var(--text-muted)', fontSize: 11, textDecoration: 'underline' }

export default function VaultDetailPage({ positions = {} }) {
  const { protocol } = useParams()
  const navigateTo = useNavigateTo()
  const catalog = VAULT_CATALOG.find((v) => v.protocol === protocol)
  const [liveData, setLiveData] = useState(null)
  const [apyStats, setApyStats] = useState(null)

  useEffect(() => {
    fetchDeFiLlamaVaults()
      .then((vaults) => {
        const match = vaults.find((v) => v.protocol === protocol)
        if (match) setLiveData(match)
      })
      .catch(() => {})
  }, [protocol])

  // APY 7d history — fetch once live pool ID is known. Non-blocking, cached.
  useEffect(() => {
    const pid = liveData?.poolId
    if (!pid) return
    let alive = true
    fetchApyHistory(pid).then((h) => { if (alive && h) setApyStats(calcApyStats(h)) })
    return () => { alive = false }
  }, [liveData?.poolId])

  if (!catalog) {
    return (
      <div className="stage enter" style={{ maxWidth: 600, margin: '0 auto', padding: 32 }}>
        <button onClick={() => { if (window.history.length > 1) window.history.back(); else navigateTo('home'); }} style={backBtn}>← Back</button>
        <div className="mono" style={{ marginTop: 28, color: 'var(--text-muted)', fontSize: 14 }}>vault not found</div>
        <div className="mono" style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 6 }}>
          No vault data for protocol: {protocol}
        </div>
        <button onClick={() => { if (window.history.length > 1) window.history.back(); else navigateTo('home'); }} style={{ ...backBtn, marginTop: 18 }}>← Back</button>
      </div>
    )
  }

  const apy = liveData?.apy ?? catalog.apy
  const tvl = liveData?.tvlFormatted ?? '-'
  const riskColor = catalog.risk === 'low' ? 'var(--ok)' : catalog.risk === 'medium' ? '#f59e0b' : '#f97316'

  // User position — match by contract address
  const posEntry = catalog.address
    ? Object.entries(positions).find(([a]) => a.toLowerCase() === catalog.address.toLowerCase())
    : null
  const posBalance = posEntry ? Number(posEntry[1].balance || 0) / 1e6 : null

  const handleFarm = () => {
    sessionStorage.setItem('yv_prefill_protocol', protocol)
    sessionStorage.setItem('yv_prefill_name', catalog.name)
    sessionStorage.setItem('yv_prefill_apy', String(apy))
    navigateTo('strategy')
  }

  return (
    <div className="stage enter" style={{ maxWidth: 600, margin: '0 auto', padding: 32 }}>
      <button onClick={() => { if (window.history.length > 1) window.history.back(); else navigateTo('home'); }} style={backBtn}>← Back to Vaults</button>

      <div style={{ marginTop: 22 }}>
        <span className="mono" style={{ fontSize: 10, color: 'var(--text-faint)', letterSpacing: '-0.01em', textTransform: 'lowercase' }}>
          {protocol}
        </span>
      </div>
      <h2 style={{ fontSize: 22, fontWeight: 600, margin: '4px 0 6px' }}>{catalog.name}</h2>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>{catalog.description}</p>

      <div style={divider} />

      {/* Metrics row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        {[
          { label: 'APY', value: `${Number(apy).toFixed(1)}%` },
          { label: 'TVL', value: tvl },
          { label: 'Risk', value: catalog.risk, color: riskColor },
          { label: 'Yield Source', value: catalog.yield_source },
        ].map(({ label, value, color }) => (
          <div key={label} style={metricCard}>
            <div className="mono" style={{ fontSize: 9, color: 'var(--text-faint)', textTransform: 'lowercase', letterSpacing: '-0.01em', marginBottom: 6 }}>
              {label}
            </div>
            <div style={{ fontSize: 13, fontWeight: 500, color: color || 'inherit' }}>{value}</div>
          </div>
        ))}
      </div>

      {/* APY 7d trend chart (live history) */}
      {apyStats && apyStats.values && (
        <div className="apy-chart">
          <div className="apy-chart-header">
            <span>APY 7d</span>
            <span className="apy-avg">7d avg: {apyStats.avg7d}%</span>
          </div>
          <span dangerouslySetInnerHTML={{ __html: generateSparkline(apyStats.values, { width: 280, height: 48, strokeWidth: 2 }) }} />
          <div className="apy-chart-labels">
            <span>{apyStats.values[0]?.toFixed(1)}%</span>
            <span className={parseFloat(apyStats.change7d) >= 0 ? 'up' : 'down'}>
              {parseFloat(apyStats.change7d) >= 0 ? '+' : ''}{apyStats.change7d}pp 7d
            </span>
            <span>{apyStats.current}%</span>
          </div>
        </div>
      )}

      <div style={divider} />

      {/* Risk profile */}
      <div>
        <div style={sectionLabel}>RISK PROFILE</div>
        <div style={{ fontSize: 13, marginTop: 8, lineHeight: 1.55, color: 'var(--text-muted)' }}>
          <span style={{ color: riskColor, fontWeight: 500 }}>{catalog.risk}</span>
          {' · '}
          {catalog.description}
          {catalog.drawdown && (
            <span style={{ color: 'var(--text-faint)' }}>
              {' '}· max drawdown {catalog.drawdown}%
            </span>
          )}
        </div>
      </div>

      {/* User position (only if exists) */}
      {posBalance !== null && (
        <>
          <div style={divider} />
          <div>
            <div style={sectionLabel}>YOUR POSITION</div>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginTop: 10, gap: 16 }}>
              <div>
                <span className="tnum" style={{ fontSize: 18, fontWeight: 500 }}>{posBalance.toFixed(2)}</span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 6 }}>USDC · {Number(apy).toFixed(1)}% APY</span>
                <div className="mono tnum" style={{ fontSize: 11, color: 'var(--ok)', marginTop: 5 }}>
                  +{(posBalance * Number(apy) / 100 / 365).toFixed(4)} USDC/day estimated
                </div>
              </div>
              <button style={pillBtn} onClick={() => navigateTo('agent')}>Withdraw →</button>
            </div>
          </div>
        </>
      )}

      <div style={divider} />

      {/* Contract address */}
      <div>
        <div style={sectionLabel}>CONTRACT (Base Sepolia testnet)</div>
        <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <span>{short(catalog.address)}</span>
          <a href={`https://sepolia.basescan.org/address/${catalog.address}`} target="_blank" rel="noopener noreferrer" style={extLink}>
            View on Basescan ↗
          </a>
        </div>
      </div>

      <div style={{ marginTop: 28, display: 'flex', justifyContent: 'flex-end' }}>
        <button className="btn btn-primary" onClick={handleFarm}>Farm this vault →</button>
      </div>
    </div>
  )
}
