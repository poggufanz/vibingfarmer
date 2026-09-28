// frontend/src/components/console/instruments/Sparkline.jsx
// Price-per-share trailing sparkline. Pure presentation over display numbers
// (oldest → newest, see history/ppsHistory.js ppsDisplayValues); geometry lives in
// geometry.js so the mapping stays deterministic and unit-testable. Empty series
// renders a flat baseline labelled as "no history yet" — never a fabricated curve.
import { ppsSparklineGeometry } from './geometry.js'

export default function Sparkline({
  values = [],
  width = 260,
  height = 56,
  label = 'Price per share',
}) {
  const g = ppsSparklineGeometry(values, { width, height })
  const n = (values || []).filter(Number.isFinite).length
  return (
    <svg
      className="instrument"
      role="img"
      aria-label={g.empty ? `${label}, no history yet` : `${label} history, ${n} samples`}
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
    >
      <path d={g.path} fill="none" stroke="var(--ok)" strokeWidth="1.5" />
    </svg>
  )
}
