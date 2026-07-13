// frontend/src/components/console/SwarmZone.jsx
// Hero zone: promoted AgentGraph + horizontal trace strip of recent automation events.
import ZoneFrame from './ZoneFrame.jsx'
import { AgentGraph } from '../../agents.jsx'
import { agoText } from './consoleUtils.js'

const TONE_VAR = { ok: 'var(--ok)', info: 'var(--info)', warn: 'var(--warn)' }

export default function SwarmZone({
  graphData,
  paletteIsLight,
  pulseEdge,
  traceEvents = [],
  nowMs,
}) {
  const nodes = graphData?.nodes?.length || 0
  const links = graphData?.links?.length || 0
  const last = traceEvents[0] || null
  return (
    <ZoneFrame
      title="Swarm"
      hue="accent"
      led={nodes ? 'ok' : 'idle'}
      className="console-swarm"
      meta={<span className="tnum">{`${nodes} nodes, ${links} links`}</span>}
    >
      {nodes === 0 ? (
        <div className="zone-empty">No active agents. Create a grant to deploy the swarm.</div>
      ) : (
        <div className="swarm-canvas">
          <AgentGraph
            graphData={graphData}
            execMap={{}}
            paletteIsLight={paletteIsLight}
            pulseEdge={pulseEdge}
          />
        </div>
      )}
      <div
        className="trace-strip"
        role="img"
        aria-label={`Trace with ${traceEvents.length} recent events`}
      >
        {traceEvents
          .slice(0, 20)
          .reverse()
          .map((e, i) => (
            <span
              key={i}
              className="trace-tick"
              style={{ background: TONE_VAR[e.tone] || 'var(--text-faint)' }}
            >
              <span className="trace-tip mono">{e.label}</span>
            </span>
          ))}
      </div>
      <div className="instrument-caption">
        {last
          ? `Last: ${last.label}, ${agoText(last.timestamp, nowMs)}`
          : 'No automation events yet.'}
      </div>
    </ZoneFrame>
  )
}
