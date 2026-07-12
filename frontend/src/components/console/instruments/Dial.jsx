// frontend/src/components/console/instruments/Dial.jsx
import { dialGeometry } from './geometry.js'

/** Autopilot APR dial. Needle eases 600ms via CSS .dial-needle. */
export default function Dial({ aprPct = null, size = 180 }) {
  const g = dialGeometry(aprPct, { size })
  const h = size / 2 + 26
  return (
    <div style={{ textAlign: 'center' }}>
      <svg
        className="instrument"
        role="img"
        aria-label={`supply apr ${aprPct == null ? 'unknown' : `${aprPct.toFixed(2)} percent`}`}
        viewBox={`0 0 ${size} ${h}`}
        width={size}
        height={h}
      >
        <path d={g.arcPath} fill="none" stroke="var(--border-strong)" strokeWidth="1.5" />
        <line
          className="dial-needle"
          x1={g.cx}
          y1={g.cy}
          x2={g.cx}
          y2={g.cy - g.r + 10}
          stroke={aprPct == null ? 'var(--text-faint)' : 'var(--ok)'}
          strokeWidth="1.5"
          style={{ transform: `rotate(${g.angle}deg)`, transformOrigin: `${g.cx}px ${g.cy}px` }}
        />
        <circle cx={g.cx} cy={g.cy} r="3" fill="var(--text-faint)" />
        <text
          x={g.cx}
          y={g.cy + 22}
          textAnchor="middle"
          className="tnum"
          fill="var(--text)"
          style={{ font: '500 16px var(--font-mono)' }}
        >
          {aprPct == null ? '--' : `${aprPct.toFixed(2)}%`}
        </text>
      </svg>
      <div className="instrument-caption">supply apr · scale 0–{g.max}%</div>
    </div>
  )
}
