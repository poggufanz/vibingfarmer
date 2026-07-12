// frontend/src/components/console/CouncilZone.jsx
// Jury bench + verdict stamp. Absorbs the old "Council Monitor" section: monitorStatus
// feeds the header LED/meta, decision rows feed the bench.
import { useEffect, useState } from 'react'
import ZoneFrame from './ZoneFrame.jsx'
import { agoText } from './consoleUtils.js'
import { DecisionLogPanel } from '../../agents.jsx'

const STANCE = { DEPOSIT: { glyph: '↑', word: 'deposit', tone: 'ok' }, HOLD: { glyph: '—', word: 'hold', tone: 'warn' }, WITHDRAW: { glyph: '↓', word: 'withdraw', tone: 'danger' } }
const ROLES = ['yield', 'risk', 'market']

export default function CouncilZone({ monitorStatus = null, decisionsRows = [], decisionsSummary = null, nowMs }) {
  const [logOpen, setLogOpen] = useState(false)
  useEffect(() => {
    if (!logOpen) return
    const onKey = (e) => e.key === 'Escape' && setLogOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [logOpen])

  const latest = decisionsRows[0] || null
  const verdictOf = (role) => latest?.verdicts?.find((v) => v.role === role) || null
  const led =
    monitorStatus?.result === 'violation' || monitorStatus?.result === 'rejected'
      ? 'danger'
      : monitorStatus?.level === 'fast' || monitorStatus?.level === 'full'
        ? 'warn'
        : latest
          ? 'ok'
          : 'idle'

  return (
    <ZoneFrame
      title="council"
      hue="council"
      led={led}
      className="console-council"
      meta={monitorStatus?.lastCheck ? agoText(monitorStatus.lastCheck, nowMs) : null}
    >
      {!latest ? (
        <div className="zone-empty">council idle — verdicts appear after first cycle</div>
      ) : (
        <>
          <div className="council-bench">
            {ROLES.map((role) => {
              const v = verdictOf(role)
              const s = v ? STANCE[v.signal] : null
              return (
                <div className="council-seat" key={role} data-tone={s?.tone || ''}>
                  <span className="council-role mono">{role}</span>
                  <span className="council-glyph" aria-hidden="true">{s?.glyph || '·'}</span>
                  <span className="council-word mono">{s?.word || '--'}</span>
                  <span className="council-conf tnum mono">{v ? `${Math.round(v.confidence * 100)}%` : '--'}</span>
                </div>
              )
            })}
          </div>
          <div className="council-verdict">
            <span className="council-stamp mono" data-tone={latest.finalDecision === 'keep' ? 'ok' : 'danger'}>
              {latest.finalDecision.toUpperCase()}
            </span>
            <div className="council-verdict-meta mono">
              <span className="tnum">
                {latest.majoritySignal} ×{latest.majorityCount} · {Math.round((latest.avgConfidence || 0) * 100)}% avg
              </span>
              <span>resolved by {latest.resolvedBy} · cycle {String(latest.cycle).padStart(2, '0')}</span>
              {monitorStatus?.reason && <span className="council-reason">{monitorStatus.reason}</span>}
            </div>
          </div>
        </>
      )}
      <div className="council-foot">
        <button className="btn btn-ghost pos-cta" onClick={() => setLogOpen(true)}>
          full decision log
        </button>
      </div>
      {logOpen && (
        <div className="modal-backdrop" onClick={() => setLogOpen(false)} role="dialog" aria-modal="true" aria-label="decision log">
          <div className="council-modal" onClick={(e) => e.stopPropagation()}>
            <DecisionLogPanel rows={decisionsRows} summary={decisionsSummary} />
            <button className="btn btn-ghost pos-cta" onClick={() => setLogOpen(false)}>close</button>
          </div>
        </div>
      )}
    </ZoneFrame>
  )
}
