// One-glance system state. Accent budget lives here: LED (running) + portfolio figure.
import { remainText, mandateRemaining } from './consoleUtils.js'

export default function CommandStrip({
  running,
  cycling,
  phase,
  cycle,
  totalDisplay,
  earnedDisplay,
  blendedApy,
  lifeboatMode,
  mandateState,
  scopesCount,
  nowS,
}) {
  const stateText = !running ? 'Stopped' : cycling ? `Evaluating · ${phase}` : 'Monitoring'
  const { leftS } = mandateRemaining(mandateState, nowS)
  const earnedPos = Number(earnedDisplay) > 0
  return (
    <section
      className="zone console-strip"
      data-hue="accent"
      role="region"
      aria-label="operations console status"
    >
      <div className="strip-inner">
        <div className="strip-state">
          <span
            className={`zone-led${running ? ' pulse' : ''}`}
            data-state={running ? 'accent' : 'idle'}
            aria-hidden="true"
          />
          <span className="zone-title mono">operations console</span>
          <span className="strip-statetext mono" data-on={running ? '1' : '0'}>
            {stateText}
            {running ? ` · cycle ${String(cycle || 0).padStart(2, '0')}` : ''}
          </span>
        </div>
        <div className="strip-portfolio">
          <span className="strip-figure tnum">{totalDisplay}</span>
          <span className="mono strip-unit">USDC</span>
          <span className="strip-earned tnum mono" data-tone={earnedPos ? 'ok' : 'idle'}>
            +{earnedDisplay} · {blendedApy.toFixed(1)}% apy
          </span>
        </div>
        <div className="strip-chips">
          <span className="con-chip" data-tone={leftS > 0 ? undefined : 'warn'}>
            mandate {leftS > 0 ? remainText(leftS * 1000) : 'none'}
          </span>
          {lifeboatMode && (
            <span
              className="con-chip"
              data-tone={
                lifeboatMode === 'ENGAGED' ? 'danger' : lifeboatMode === 'ARMED' ? 'ok' : undefined
              }
            >
              lifeboat {lifeboatMode}
            </span>
          )}
          <span className="con-chip">{scopesCount} scopes</span>
        </div>
      </div>
    </section>
  )
}
