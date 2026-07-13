// frontend/src/components/console/instruments/geometry.js
// Pure SVG geometry for console instruments. No React, no Date.now() — time is
// always a parameter so every output is deterministic and unit-testable.

/** Beat amplitudes by cycle verdict (fraction of available half-height). */
const BEAT_AMP = { keep: 1, gated: 0.5, idle: 0.35, discard: -0.8, crash: -1 }

/**
 * @param {Array<{verdict: string}>} rows newest-first cycle rows
 * @returns {{path: string, markers: Array<{x:number,y:number,verdict:string}>}}
 */
export function ekgGeometry(rows, { width, height, maxBeats = 24 }) {
  const baseY = Math.round(height * 0.62)
  if (!rows || rows.length === 0) return { path: `M0,${baseY} L${width},${baseY}`, markers: [] }
  const beats = rows.slice(0, maxBeats).reverse() // oldest → left
  const stepX = width / (beats.length + 1)
  const half = baseY - 4
  let d = `M0,${baseY}`
  const markers = []
  beats.forEach((r, i) => {
    const cx = Math.round(stepX * (i + 1))
    const amp = BEAT_AMP[r.verdict] ?? 0.35
    const peakY = Math.round(baseY - amp * half * 0.9)
    d += ` L${cx - 4},${baseY} L${cx},${peakY} L${cx + 4},${baseY}`
    if (r.verdict === 'discard' || r.verdict === 'crash') {
      markers.push({ x: cx, y: peakY, verdict: r.verdict })
    }
  })
  d += ` L${width},${baseY}`
  return { path: d, markers }
}

const polar = (cx, cy, r, deg) => {
  const rad = ((deg - 90) * Math.PI) / 180
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

/**
 * Semicircular dial. Needle angle in degrees: -90 (min) .. +90 (max).
 * @param {number|null} aprPct
 */
export function dialGeometry(aprPct, { size = 180 } = {}) {
  const apr = Number.isFinite(aprPct) ? Math.max(0, aprPct) : null
  const max = Math.max(10, Math.ceil(((apr ?? 0) * 1.5) / 5) * 5)
  const angle = apr == null ? -90 : -90 + (Math.min(apr, max) / max) * 180
  const cx = size / 2
  const cy = size / 2
  const r = size / 2 - 8
  const a = polar(cx, cy, r, -90)
  const b = polar(cx, cy, r, 90)
  const arcPath = `M${a.x},${a.y} A${r},${r} 0 0 1 ${b.x},${b.y}`
  return { angle, max, cx, cy, r, arcPath }
}

/**
 * Honest blip mapping: radius = event age (recent near center), angle = golden-angle
 * spread by index. Only 'derisk' events within maxAgeMs.
 * @param {Array<{type:string,timestamp?:number,txHash?:string}>} events
 */
export function radarBlipPoints(events, { nowMs, size = 180, maxAgeMs = 86_400_000 } = {}) {
  const cx = size / 2
  const cy = size / 2
  const rMax = size / 2 - 6
  return (events || [])
    .filter((e) => e.type === 'derisk' && nowMs - (e.timestamp || 0) <= maxAgeMs)
    .map((e, i) => {
      const ageFrac = Math.min(1, Math.max(0, (nowMs - (e.timestamp || 0)) / maxAgeMs))
      const deg = (i * 137.5) % 360
      const r = (0.18 + 0.72 * ageFrac) * rMax
      const p = polar(cx, cy, r, deg)
      return { x: p.x, y: p.y, ageFrac, type: e.type, label: e.txHash || '' }
    })
}

/** @returns {number} 0..1 */
export function gaugeRatio(value, max) {
  if (!max || !Number.isFinite(Number(max))) return 0
  return Math.min(1, Math.max(0, Number(value) / Number(max)))
}
