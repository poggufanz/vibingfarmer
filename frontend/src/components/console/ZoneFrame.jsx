// frontend/src/components/console/ZoneFrame.jsx
// Tier-D zone chrome: mono header strip + status LED + corner ticks (CSS).
// Presentational only — hue/led semantics are the caller's business.
import './../../console.css'

/**
 * @param {object} p
 * @param {string} p.title lowercase mono kicker
 * @param {'accent'|'council'|'ok'|'info'|'warn'|'danger'|'neutral'} [p.hue]
 * @param {'ok'|'warn'|'danger'|'info'|'accent'|'idle'} [p.led]
 * @param {boolean} [p.ledPulse] max one pulsing LED per zone (design rule)
 * @param {import('react').ReactNode} [p.meta] right-aligned header content
 */
export default function ZoneFrame({
  title,
  hue = 'neutral',
  led = 'idle',
  ledPulse = false,
  meta = null,
  ariaLabel,
  className = '',
  children,
}) {
  return (
    <section className={`zone ${className}`} data-hue={hue} role="region" aria-label={ariaLabel || title}>
      <div className="zone-head">
        <span className={`zone-led${ledPulse ? ' pulse' : ''}`} data-state={led} aria-hidden="true" />
        <span className="zone-title mono">{title}</span>
        {meta != null && <span className="zone-meta mono">{meta}</span>}
      </div>
      <div className="zone-body">{children}</div>
    </section>
  )
}
