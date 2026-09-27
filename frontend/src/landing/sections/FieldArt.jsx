// Shared landing motif, drawn top-down: plots are vault positions, crew marks are scoped agents,
// the fence is the on-chain leash, and the signature stroke is the one grant that becomes it.
// GSAP animates these nodes through attributes, opacity and the SVG transform attribute, so the
// stylesheet must never set a CSS `transform` on them (it would silently override the tween).
import './field-art.css'

const ROWS = [0, 1, 2, 3]
const PLOT = { x: 56, w: 408, h: 64, top: 64, gap: 84 }
const FILL = [0.58, 0.74, 0.66, 0.82]
const FENCE =
  'M42 24H478A18 18 0 0 1 496 42V398A18 18 0 0 1 478 416H42A18 18 0 0 1 24 398V42A18 18 0 0 1 42 24Z'
const SIGNATURE =
  'M78 292C104 226 132 214 142 262C152 310 120 352 150 330C196 296 214 196 250 214C284 231 250 318 292 300C330 284 344 226 380 238C408 248 398 300 430 286C448 278 458 262 470 256'

export const FIELD_FILL = FILL
export const PLOT_WIDTH = PLOT.w

const rowY = (i) => PLOT.top + i * PLOT.gap

function furrows(y) {
  const x1 = PLOT.x + 18
  const x2 = PLOT.x + PLOT.w - 18
  return [16, 32, 48].map((dy) => `M${x1} ${y + dy}H${x2}`).join('')
}

function Row({ i }) {
  const y = rowY(i)
  return (
    <g className="vf-field__row" style={{ '--crew': `var(--pc-crew-${i + 1})` }}>
      <rect className="vf-field__plot" x={PLOT.x} y={y} width={PLOT.w} height={PLOT.h} rx="10" />
      <path className="vf-field__furrows" d={furrows(y)} />
      <rect
        className="vf-field__fill"
        x={PLOT.x}
        y={y}
        width={PLOT.w * FILL[i]}
        height={PLOT.h}
        rx="10"
      />
      <g transform={`translate(${PLOT.x + 28} ${y + PLOT.h / 2})`}>
        <g className="vf-field__crew" data-crew={i + 1}>
          <circle className="vf-field__crew-ring" r="14" />
          <circle className="vf-field__crew-dot" r="8" />
        </g>
      </g>
    </g>
  )
}

function StageParts() {
  const failY = rowY(2) + PLOT.h / 2
  return (
    <>
      <line className="vf-field__sweep" x1={PLOT.x} x2={PLOT.x} y1="40" y2="400" />
      <circle className="vf-field__radar" cx="260" cy="220" r="0" />
      <g className="vf-field__fail" transform={`translate(${PLOT.x + 28} ${failY})`}>
        <path d="M-9 -9L9 9M9 -9L-9 9" />
      </g>
    </>
  )
}

function Bay({ className, x, title, value, alt }) {
  return (
    <g className={className}>
      <rect x={x} y="168" width="88" height="104" rx="12" />
      <text x={x + 44} y="208">
        {title}
      </text>
      <text className="vf-field__bay-value" x={x + 44} y="236">
        {value}
      </text>
      {alt && (
        <text className="vf-field__bay-value vf-field__bay-alt" x={x + 44} y="236">
          {alt}
        </text>
      )}
    </g>
  )
}

export default function FieldArt({ variant = 'hero' }) {
  const stage = variant === 'stage'
  const land = (
    <g className="vf-field__land">
      {ROWS.map((i) => (
        <Row i={i} key={i} />
      ))}
      <path className="vf-field__fence" d={FENCE} pathLength="1" />
      <path className="vf-field__sig" d={SIGNATURE} pathLength="1" />
      {stage && <StageParts />}
    </g>
  )

  return (
    <svg
      className={`vf-field vf-field--${variant}`}
      viewBox={stage ? '0 0 744 440' : '0 0 520 440'}
      aria-hidden="true"
      focusable="false"
    >
      {stage ? (
        <>
          <Bay className="vf-field__grant" x={8} title="Grant" value="500 USDC" />
          <g transform="translate(112 0)">{land}</g>
          <Bay className="vf-field__idle" x={648} title="Vault idle" value="0 USDC" alt="500 USDC" />
        </>
      ) : (
        land
      )}
    </svg>
  )
}
