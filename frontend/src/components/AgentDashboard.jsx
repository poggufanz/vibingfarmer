// AgentDashboard.jsx
// Autonomous-agent page: portfolio summary, live positions, explainable alerts.
// "Users should always feel like they're driving, even when the agent does the work."
import React, { useState, useEffect } from 'react'
import WithdrawModal from './WithdrawModal.jsx'
import { loadSettings, t } from '../settingsStore.js'

const POSITION_INTERVAL = 5 * 60 * 1000 // mirrors worker INTERVALS.position
const u = (units) => Number(units || 0) / 1e6
const fmt = (units) => u(units).toFixed(2)
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '')
const formatTime = (ts, now = Date.now()) => {
  if (!ts) return '-'
  const { timestampFormat } = loadSettings()
  if (timestampFormat === 'absolute') {
    return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  }
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)} min ago`
}
const fmtRemain = (ms) => {
  if (ms <= 0) return 'now'
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60)
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`
}

// ─── Shared style primitives ────────────────────────────────────────────────
const mono = { fontFamily: 'var(--font-mono)', fontSize: 10.5 }
const sectionLabel = {
  fontSize: 11, letterSpacing: '0.01em', textTransform: 'capitalize', fontWeight: 500,
  color: 'var(--text-muted)', marginBottom: 10,
}
const textBtn = (color = 'var(--text-muted)') => ({
  appearance: 'none', border: 0, background: 'transparent',
  fontSize: 11, color, cursor: 'pointer', padding: 0,
  fontFamily: 'var(--font-mono)', lineHeight: 1,
})

// ─── AgentDashboard ──────────────────────────────────────────────────────────
export default function AgentDashboard({
  active, positions = {}, alerts = [], vaultMeta = {}, lastUpdated = null, userAddress, settings = {},
  withdrawEnabled = true, onHarvest, onEmergencyWithdraw, onReview, onDismiss, onWithdrawSuccess, onNewStrategy,
  loopPanel = null, loopStatus = null, decisionPanel = null,
}) {
  const [now, setNow] = useState(Date.now())
  const [withdrawVault, setWithdrawVault] = useState(null)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const { language: lang } = loadSettings()

  const posList = Object.entries(positions)
  const apyOf = (addr) => vaultMeta[addr.toLowerCase()]?.apy || 0
  const totalUnits = posList.reduce((s, [, p]) => s + Number(p.balance || 0), 0)
  const earnedUnits = posList.reduce((s, [, p]) => s + Number(p.unclaimedRewards || 0), 0)
  const blendedApy = totalUnits > 0
    ? posList.reduce((s, [a, p]) => s + Number(p.balance || 0) * apyOf(a), 0) / totalUnits
    : 0
  const nextCheck = lastUpdated ? lastUpdated + POSITION_INTERVAL : null

  return (
    <div className="panel enter">
      <style>{`@keyframes yvpulse{0%,100%{opacity:1}50%{opacity:.25}}@media(prefers-reduced-motion:reduce){.yv-pulse{animation:none!important}}`}</style>

      {/* ── HEADER ─────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        paddingBottom: 16, borderBottom: '1px solid var(--border)', marginBottom: 20,
      }}>
        <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.015em', color: 'var(--text)' }}>
          Autonomous Agent
        </span>
        {(() => {
          // One status line for the whole panel: loop state wins when the loop runs.
          const loopOn = loopStatus?.running
          const cycling = Boolean(loopOn && loopStatus.phase && loopStatus.phase !== 'sleep')
          const on = loopOn || active
          const statusText = !on ? 'stopped'
            : cycling ? `evaluating · ${loopStatus.phase}`
            : 'monitoring'
          return (
            <span style={{ display: 'flex', alignItems: 'center', gap: 5, ...mono }}>
              <span
                className="yv-pulse"
                style={{
                  width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                  background: !on ? 'var(--text-faint)' : cycling ? 'var(--warn)' : 'var(--ok)',
                  animation: on ? `yvpulse ${cycling ? '0.8s' : '1.6s'} ease-in-out infinite` : 'none',
                }}
              />
              <span style={{ color: !on ? 'var(--text-faint)' : cycling ? 'var(--warn)' : 'var(--ok)' }}>
                {statusText}
              </span>
              <span style={{ color: 'var(--text-faint)' }}>
                {loopOn ? `· cycle ${String(loopStatus.cycle || 0).padStart(2, '0')}` : '· co-pilot'}
              </span>
            </span>
          )
        })()}
      </div>

      {/* ── TOTAL PORTFOLIO ────────────────────────────────────────────── */}
      <div style={{ paddingBottom: 20, borderBottom: '1px solid var(--border)', marginBottom: 20 }}>
        <div style={sectionLabel}>Total Portfolio</div>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
              <span className="tnum" style={{
                fontSize: '2.4rem', fontWeight: 500, lineHeight: 1,
                letterSpacing: '-0.03em', color: 'var(--text)',
              }}>
                {(totalUnits / 1e6).toFixed(2)}
              </span>
              <span style={{ ...mono, color: 'var(--text-faint)', paddingBottom: 3 }}>USDC</span>
            </div>
            <div style={{ ...mono, color: 'var(--text-muted)', marginTop: 6 }}>
              deposited · blended {blendedApy.toFixed(1)}% APY
            </div>
          </div>
          <div style={{ textAlign: 'right', flexShrink: 0 }}>
            <div className="tnum" style={{ fontSize: 15, fontWeight: 500, color: earnedUnits > 0 ? 'var(--ok)' : 'var(--text-faint)' }}>
              +{(earnedUnits / 1e6).toFixed(4)}
            </div>
            <div style={{ ...mono, color: 'var(--text-faint)', marginTop: 3 }}>
              earned · {formatTime(lastUpdated, now)}
            </div>
          </div>
        </div>
      </div>

      {/* ── POSITIONS ──────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 20 }}>
        <div style={sectionLabel}>Positions</div>

        {posList.length === 0 ? (
          /* Empty state */
          <div style={{ textAlign: 'center', padding: '36px 16px' }}>
            <div style={{ fontSize: 26, color: 'var(--text-faint)', marginBottom: 14, lineHeight: 1 }}>○</div>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6 }}>
              no active positions
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-faint)', lineHeight: 1.65, marginBottom: 20 }}>
              Start your first strategy to begin farming.<br />
              AI will recommend the optimal vault.
            </div>
            {onNewStrategy && (
              <button style={textBtn('var(--text-muted)')} onClick={onNewStrategy}>
                {t(lang, 'newStrategy')} →
              </button>
            )}
          </div>
        ) : (
          posList.map(([addr, p]) => {
            const apy = apyOf(addr)
            const bal = u(p.balance)
            const daily = bal * (apy / 100) / 365
            const pct = totalUnits > 0 ? (Number(p.balance) / totalUnits) * 100 : 0
            return (
              <div key={addr} style={{
                background: 'var(--bg-card)',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border)',
                padding: '14px 16px',
                marginBottom: 8,
              }}>
                {/* Name + amount */}
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', marginBottom: 3, lineHeight: 1.3 }}>
                      {p.vaultName}
                    </div>
                    <div style={{ ...mono, color: 'var(--text-faint)' }}>
                      {vaultMeta[addr.toLowerCase()]?.protocol || ''}{vaultMeta[addr.toLowerCase()]?.protocol ? ' · ' : ''}{apy.toFixed(1)}% APY
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div className="tnum" style={{ fontSize: 14, fontWeight: 500, color: 'var(--text)', lineHeight: 1.3 }}>
                      {bal.toFixed(2)}{' '}
                      <span style={{ ...mono, fontSize: 10, color: 'var(--text-faint)' }}>USDC</span>
                    </div>
                    <div className="tnum" style={{ ...mono, color: 'var(--ok)', marginTop: 3 }}>
                      +{daily.toFixed(4)}/day
                    </div>
                  </div>
                </div>

                {/* Progress bar */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <div style={{ flex: 1, height: 3, background: 'rgba(255,255,255,.06)', borderRadius: 2 }}>
                    <div style={{
                      height: '100%', width: `${pct}%`,
                      background: 'var(--accent)', borderRadius: 2,
                      transition: 'width .4s ease',
                    }} />
                  </div>
                  <span style={{ ...mono, fontSize: 10, color: 'var(--text-faint)', minWidth: 26, textAlign: 'right' }}>
                    {pct.toFixed(0)}%
                  </span>
                </div>

                {/* Withdraw */}
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button
                    style={{
                      ...textBtn(withdrawEnabled ? 'var(--text-muted)' : 'var(--text-faint)'),
                      opacity: withdrawEnabled ? 1 : .45,
                      cursor: withdrawEnabled ? 'pointer' : 'not-allowed',
                    }}
                    disabled={!withdrawEnabled}
                    title={withdrawEnabled ? 'Withdraw from this position' : 'Withdraw unavailable during active execution'}
                    onClick={() => setWithdrawVault({
                      vault: { name: p.vaultName, address: addr, protocol: vaultMeta[addr.toLowerCase()]?.protocol || '', apy },
                      balance: p.balance,
                      unclaimedRewards: p.unclaimedRewards,
                    })}
                  >
                    withdraw →
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Alerts moved to the global top-bar bell (NotificationCenter). */}

      {loopPanel && (
        <div style={{ paddingTop: 20, borderTop: '1px solid var(--border)', marginTop: 20 }}>
          <div style={sectionLabel}>Monitor Loop</div>
          {loopPanel}
        </div>
      )}

      {decisionPanel && (
        <div style={{ paddingTop: 20, borderTop: '1px solid var(--border)', marginTop: 20 }}>
          <div style={sectionLabel}>Decision Log</div>
          {decisionPanel}
        </div>
      )}

      {withdrawVault && (
        <WithdrawModal
          vault={withdrawVault.vault}
          balance={withdrawVault.balance}
          unclaimedRewards={withdrawVault.unclaimedRewards}
          userAddress={userAddress}
          onClose={() => setWithdrawVault(null)}
          onSuccess={onWithdrawSuccess || (() => {})}
        />
      )}
    </div>
  )
}
