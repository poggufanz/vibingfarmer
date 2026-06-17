// SignatureMark.jsx
// Brand signature: a yield curve that draws itself on mount.
// "Set once. Vibe forever." — the line keeps climbing. Acid-lime motif.
import React from 'react'

// Climbing curve, oldest (bottom-left) → newest (top-right).
const CURVE = 'M 8 104 C 56 100 78 78 116 70 S 186 50 214 36 S 276 16 292 10'
const AREA = `${CURVE} L 292 116 L 8 116 Z`

export function YieldLine({ height = 132 }) {
  return (
    <svg className="sig-yield" viewBox="0 0 300 120" height={height}
         role="img" aria-label="Yield climbing over time" preserveAspectRatio="none">
      <g className="sig-grid">
        <line x1="0" y1="40" x2="300" y2="40" />
        <line x1="0" y1="80" x2="300" y2="80" />
      </g>
      <path className="sig-area" d={AREA} />
      <path className="sig-path" d={CURVE} pathLength="1" />
      <circle className="sig-head-ring" cx="292" cy="10" r="5" />
      <circle className="sig-head" cx="292" cy="10" r="3.5" />
    </svg>
  )
}
