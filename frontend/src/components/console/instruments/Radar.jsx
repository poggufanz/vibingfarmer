// frontend/src/components/console/instruments/Radar.jsx
import { radarBlipPoints } from './geometry.js'

/**
 * De-risk radar. Sweep rotates only while armed (the radar runner genuinely scans);
 * reduced-motion kills the animation via console.css. Blips = recent derisk events.
 */
export default function Radar({ events = [], armed = false, nowMs, size = 180 }) {
  const c = size / 2
  const blips = radarBlipPoints(events, { nowMs, size })
  return (
    <svg
      className="instrument"
      role="img"
      aria-label={`derisk radar · ${blips.length} recent events`}
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
    >
      {[1, 0.66, 0.33].map((f) => (
        <circle key={f} cx={c} cy={c} r={(c - 6) * f} fill="none" stroke="var(--border)" strokeWidth="1" />
      ))}
      <line x1={6} y1={c} x2={size - 6} y2={c} stroke="var(--border)" strokeWidth="1" />
      <line x1={c} y1={6} x2={c} y2={size - 6} stroke="var(--border)" strokeWidth="1" />
      {armed && (
        <g className="radar-sweep-line">
          <line x1={c} y1={c} x2={c} y2={8} stroke="var(--ok)" strokeWidth="1.5" opacity="0.8" />
        </g>
      )}
      {blips.map((b, i) => (
        <circle key={i} className="radar-blip" cx={b.x} cy={b.y} r="3" fill="var(--warn)">
          <title>{`derisk · ${b.label}`}</title>
        </circle>
      ))}
      <circle cx={c} cy={c} r="2" fill="var(--text-faint)" />
    </svg>
  )
}
