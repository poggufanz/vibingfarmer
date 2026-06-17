// OnboardingFlow.jsx
// APY-first onboarding for users who have never connected a wallet.
// Screen 1: value proposition + live vault rates (no wallet needed).
// Screen 2: how it works (shown after connect, before Step 01).
// Self-fetches DeFiLlama data so APY is visible with zero wallet interaction.
import React, { useState, useEffect } from 'react'
import { Icon } from '../components.jsx'
import { YieldLine } from './SignatureMark.jsx'
import { useCountUp, riseDelay } from '../motion.js'
import { fetchDeFiLlamaVaults } from '../defiLlama.js'
import { fetchApyHistoryBatch } from '../apyHistory.js'
import { generateSparkline, calcApyStats } from '../sparkline.js'
import { VAULT_CATALOG } from '../config.js'

// APY value that counts up from 0 on mount.
function ApyValue({ value, delay = 0 }) {
  const n = useCountUp(Number(value) || 0, { duration: 1000, delay })
  return (
    <span className="mono tnum accent" style={{ fontSize: 13, fontWeight: 600, minWidth: 64, textAlign: 'right' }}>
      {n.toFixed(1)}% APY
    </span>
  )
}

const FLASK_URL = 'https://metamask.io/flask/'
const SEED = VAULT_CATALOG.slice(0, 3).map((v) => ({ name: v.name, protocol: v.protocol, apy: v.apy, poolId: null }))

const HOW_STEPS = [
  { n: '01', title: 'Venice AI picks the best vault for your risk.', sub: 'Live market data, not guesswork.' },
  { n: '02', title: 'You approve one permission with hard limits.', sub: 'Max amount and vault are yours to set. Revoke anytime.' },
  { n: '03', title: 'Agents execute automatically. You pay zero gas.', sub: '1Shot relayer covers the gas.' },
  { n: '04', title: 'Background agent monitors 24/7.', sub: 'APY drops or risk spikes, you get alerted.' },
]

const scrollWrap = { minHeight: '100vh', overflowY: 'auto', display: 'grid', placeItems: 'center', padding: '40px 32px' }

function ValueScreen({ vaults, histories, onConnect }) {
  return (
    <div className="enter" style={scrollWrap}>
      <div className="onb-split">
        <div className="onb-left">
          <div className="brand brand--hero">
            <span>vibing</span><span className="slash">/</span><span className="vibing">farmer</span>
          </div>

          <h1 className="h-display onb-h1">Your USDC should be earning.</h1>
          <p className="lede onb-sub">Set your limits once. Agents farm the best vaults for you, gas-free.</p>

          <button className="btn btn-primary btn-lg onb-cta" onClick={onConnect}>
            Connect wallet &amp; start farming <Icon name="arrow" size={14} />
          </button>

          <div className="foot-note onb-foot">
            Already have MetaMask Flask? Connect above.<br />
            Need Flask? <a href={FLASK_URL} target="_blank" rel="noopener noreferrer" className="onb-link">Download in 2 minutes</a>
          </div>
        </div>

        <div className="onb-right">
          <div className="onb-sig"><YieldLine height={120} /></div>
          <div className="onb-rates-label"><span className="live-dot" />Live vault rates</div>
          <div className="onb-rates">
            {vaults.map((v, i) => {
              const stats = v.poolId && histories[v.poolId] ? calcApyStats(histories[v.poolId]) : null
              return (
                <div key={v.name} className="onb-rate-row rise" style={riseDelay(i, 90, 250)}>
                  <span style={{ flex: 1, fontSize: 13 }}>{v.name}</span>
                  {stats && <span dangerouslySetInnerHTML={{ __html: generateSparkline(stats.values, { width: 56, height: 22 }) }} />}
                  <ApyValue value={v.apy} delay={350 + i * 90} />
                </div>
              )
            })}
            <div className="onb-rate-row onb-rate-idle rise" style={riseDelay(vaults.length, 90, 250)}>
              <span style={{ flex: 1, fontSize: 13, color: 'var(--text-muted)' }}>vs leaving in wallet</span>
              <span className="mono tnum" style={{ fontSize: 13, color: 'var(--text-faint)' }}>0.0% APY</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function HowItWorksScreen({ onDone, onSkip }) {
  return (
    <div className="enter" style={scrollWrap}>
      <div style={{ maxWidth: 540, width: '100%', textAlign: 'left' }}>
        <h1 className="h-display" style={{ fontSize: 28 }}>How Vibing Farmer works</h1>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, margin: '28px 0' }}>
          {HOW_STEPS.map((s) => (
            <div key={s.n} style={{ display: 'flex', gap: 16, alignItems: 'baseline' }}>
              <span className="mono accent" style={{ fontSize: 13, fontWeight: 600, flex: 'none', minWidth: 22 }}>{s.n}</span>
              <div>
                <div style={{ fontSize: 14.5, fontWeight: 500, letterSpacing: '-0.01em' }}>{s.title}</div>
                <div className="lede" style={{ fontSize: 12.5, marginTop: 3 }}>{s.sub}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="action-row" style={{ gap: 10 }}>
          <button className="btn btn-ghost" onClick={onSkip}>Skip intro</button>
          <button className="btn btn-primary btn-lg" onClick={onDone}>Start farming <Icon name="arrow" size={14} /></button>
        </div>
      </div>
    </div>
  )
}

export default function OnboardingFlow({ connected, onConnect, onComplete }) {
  const [screen, setScreen] = useState(1)
  const [vaults, setVaults] = useState(SEED)
  const [histories, setHistories] = useState({})

  // Fetch live vault data on mount — no wallet needed.
  useEffect(() => {
    let alive = true
    fetchDeFiLlamaVaults().then((vs) => {
      if (!alive || !vs?.length) return
      const top = vs.slice(0, 3)
      setVaults(top)
      const ids = top.map((v) => v.poolId).filter(Boolean)
      if (ids.length) fetchApyHistoryBatch(ids).then((m) => { if (alive) setHistories(m) })
    })
    return () => { alive = false }
  }, [])

  // Advance to "how it works" once the wallet connects.
  useEffect(() => { if (connected && screen === 1) setScreen(2) }, [connected, screen])

  if (screen === 1) return <ValueScreen vaults={vaults} histories={histories} onConnect={onConnect} />
  return <HowItWorksScreen onDone={onComplete} onSkip={onComplete} />
}
