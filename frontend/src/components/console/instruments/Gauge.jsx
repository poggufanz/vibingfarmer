// frontend/src/components/console/instruments/Gauge.jsx
import { gaugeRatio } from './geometry.js'

/** Segmented budget gauge (mandate cap usage). */
export default function Gauge({ value, max, segments = 12 }) {
  const on = Math.round(gaugeRatio(value, max) * segments)
  return (
    <span
      role="img"
      aria-label={`gauge ${value} of ${max}`}
      style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}
    >
      {Array.from({ length: segments }, (_, i) => (
        <span
          key={i}
          className={`gauge-seg${i < on ? ' on' : ''}`}
          style={{
            width: 6,
            height: 10,
            borderRadius: 1,
            background:
              i < on ? 'var(--warn)' : 'color-mix(in srgb, var(--text-faint) 25%, transparent)',
          }}
        />
      ))}
    </span>
  )
}
