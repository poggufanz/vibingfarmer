// frontend/src/components/console/CouncilZone.jsx
// Jury bench + verdict stamp. Absorbs the old "Council Monitor" section: monitorStatus
// feeds the header LED/meta, decision rows feed the bench.
import { useEffect, useState } from 'react'
import ZoneFrame from './ZoneFrame.jsx'
import { agoText } from './consoleUtils.js'
import { DecisionLogPanel } from '../../agents.jsx'

const STANCE = {
  DEPOSIT: { word: 'Deposit', tone: 'ok' },
  HOLD: { word: 'Hold', tone: 'warn' },
  WITHDRAW: { word: 'Withdraw', tone: 'danger' },
}
const ROLES = ['yield', 'risk', 'market']

export default function CouncilZone({
  monitorStatus = null,
  decisionsRows = [],
  decisionsSummary = null,
  nowMs,
}) {
  const [logOpen, setLogOpen] = useState(false)
  useEffect(() => {
    if (!logOpen) return
    const onKey = (e) => e.key === 'Escape' && setLogOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [logOpen])

  const latest = decisionsRows[0] || null
  const resolvedBy = latest?.resolvedBy?.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())
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
      title="Council"
      hue="council"
      led={led}
      className="console-council"
      meta={monitorStatus?.lastCheck ? agoText(monitorStatus.lastCheck, nowMs) : null}
    >
      {!latest ? (
        <div className="zone-empty">Council is idle. Verdicts appear after the first cycle.</div>
      ) : (
        <>
          <div className="council-bench">
            {ROLES.map((role) => {
              const v = verdictOf(role)
              const s = v ? STANCE[v.signal] : null
              return (
                <div className="council-seat" key={role} data-tone={s?.tone || ''}>
                  <span className="council-role mono">
                    {role.replace(/^./, (c) => c.toUpperCase())}
                  </span>
                  <span className="council-glyph" aria-hidden="true">
                    <span className="ui-dot" />
                  </span>
                  <span className="council-word mono">{s?.word || '--'}</span>
                  <span className="council-conf tnum mono">
                    {v ? `${Math.round(v.confidence * 100)}%` : '--'}
                  </span>
                </div>
              )
            })}
          </div>
          <div className="council-verdict">
            <span
              className="council-stamp mono"
              data-tone={latest.finalDecision === 'keep' ? 'ok' : 'danger'}
            >
              {latest.finalDecision.toUpperCase()}
            </span>
            <div className="council-verdict-meta mono">
              <span className="tnum">
                {latest.majoritySignal}, {latest.majorityCount} votes,{' '}
                {Math.round((latest.avgConfidence || 0) * 100)}% avg
              </span>
              <span>
                Resolved by {resolvedBy}, Cycle {String(latest.cycle).padStart(2, '0')}
              </span>
              {monitorStatus?.reason && (
                <span className="council-reason">{monitorStatus.reason}</span>
              )}
            </div>
          </div>
        </>
      )}
      <div className="council-foot">
        <button className="btn btn-ghost pos-cta" onClick={() => setLogOpen(true)}>
          Full decision log
        </button>
      </div>
      {logOpen && (
        <div
          className="modal-backdrop"
          onClick={() => setLogOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Decision log"
        >
          <div className="council-modal" onClick={(e) => e.stopPropagation()}>
            <DecisionLogPanel rows={decisionsRows} summary={decisionsSummary} />
            <button className="btn btn-ghost pos-cta" onClick={() => setLogOpen(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </ZoneFrame>
  )
}
