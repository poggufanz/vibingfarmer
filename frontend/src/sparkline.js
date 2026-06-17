// sparkline.js
// Pure SVG sparkline generator — no chart library.
// Returns an SVG string for injection via dangerouslySetInnerHTML.
// Palette aligned to Vibing Farmer tokens: accent #cfff3d (up), danger #ff7479 (down).

const ACCENT_UP = '#cfff3d'   // --accent (lime)
const ACCENT_DOWN = '#ff7479' // --danger (coral)
const ACCENT_FLAT = 'rgba(255,255,255,0.4)'
const TREND_EPS = 0.1         // pp threshold for up/down vs flat

/**
 * Generate an inline SVG sparkline from APY data points (oldest → newest).
 *
 * @param {number[]} values - APY values
 * @param {object} [opts]
 * @param {number} [opts.width=80]
 * @param {number} [opts.height=28]
 * @param {string} [opts.color] - force line color; default derives from trend
 * @param {number} [opts.strokeWidth=1.5]
 * @returns {string} SVG markup
 */
export function generateSparkline(values, opts = {}) {
  const { width = 80, height = 28, color, strokeWidth = 1.5 } = opts

  if (!values || values.length < 2) {
    return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"></svg>`
  }

  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1

  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width
    const y = height - ((v - min) / range) * (height - 4) - 2
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })

  // Trend-based color unless explicitly overridden
  const trend = values[values.length - 1] - values[0]
  const lineColor = color
    || (trend > TREND_EPS ? ACCENT_UP : trend < -TREND_EPS ? ACCENT_DOWN : ACCENT_FLAT)

  const [dotX, dotY] = points[points.length - 1].split(',')

  return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"
         xmlns="http://www.w3.org/2000/svg" style="overflow:visible;display:block">
      <polyline
        class="spark-line"
        pathLength="1"
        points="${points.join(' ')}"
        fill="none"
        stroke="${lineColor}"
        stroke-width="${strokeWidth}"
        stroke-linecap="round"
        stroke-linejoin="round"
        opacity="0.85"
      />
      <circle class="spark-dot" cx="${dotX}" cy="${dotY}" r="2" fill="${lineColor}" />
    </svg>
  `
}

/**
 * Compute APY change stats from historical data points.
 *
 * @param {Array<{timestamp: string, apy: number}>} apyHistory - oldest → newest
 * @returns {{ current: string|null, change1d: string|null, change7d: string|null, avg7d: string|null, values?: number[] }}
 */
export function calcApyStats(apyHistory) {
  if (!apyHistory || apyHistory.length < 2) {
    return { current: null, change1d: null, change7d: null, avg7d: null }
  }

  const values = apyHistory.map((d) => d.apy)
  const current = values[values.length - 1]
  const yesterday = values[values.length - 2] ?? current
  const weekAgo = values[0]
  const avg7d = values.reduce((a, b) => a + b, 0) / values.length

  return {
    current: current.toFixed(2),
    change1d: (current - yesterday).toFixed(2), // pp change
    change7d: (current - weekAgo).toFixed(2),
    avg7d: avg7d.toFixed(2),
    values, // raw values for sparkline
  }
}
