// frontend/src/components/console/instruments/Ekg.jsx
import { ekgGeometry } from './geometry.js'

/** Heartbeat trace: one beat per council cycle. Draw-on-data-change only (calm-idle). */
export default function Ekg({ rows = [], running = false, width = 260, height = 56 }) {
  const g = ekgGeometry(running ? rows : [], { width, height })
  return (
    <svg
      className="instrument"
      role="img"
      aria-label={`Monitor heartbeat, ${running ? rows.length : 0} cycles`}
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
    >
      <path d={g.path} fill="none" stroke="var(--info)" strokeWidth="1.5" />
      {g.markers.map((m, i) => (
        <circle key={i} cx={m.x} cy={m.y} r="2.5" fill="var(--danger)">
          <title>{m.verdict}</title>
        </circle>
      ))}
    </svg>
  )
}
