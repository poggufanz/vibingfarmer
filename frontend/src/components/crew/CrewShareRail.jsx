// frontend/src/components/crew/CrewShareRail.jsx
// The crew deck's split rail (2026-09-29 /agent redesign). One segment per persona, sized from the
// exact bigint units each persona already reports -- integer basis points through the same
// shareBasisPoints the Strategy split uses, never a float re-derivation of the amounts. The bar is
// a picture of numbers the legend states in text, so the SVG is aria-hidden.
//
// The legend is the control: pressing a persona spotlights its bay below (and scrolls it into view),
// hovering previews the same spotlight. Pressing the lit persona again clears it.
import { useRef } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { formatShare, shareBasisPoints, toneFor } from '../strategy/CrewSplit.jsx'

gsap.registerPlugin(useGSAP)

const BAR_WIDTH = 1000
const BAR_HEIGHT = 14
const SEGMENT_GAP = 8

/**
 * Share of `part` in `whole`, in basis points, or null when the two are not the same token or the
 * units are not a clean non-negative fraction of the whole.
 * @param {{token: string, units: string, decimals: number}|null} part
 * @param {{token: string, units: string, decimals: number}|null} whole
 * @returns {number|null}
 */
export function shareOf(part, whole) {
  if (!part || !whole || part.token !== whole.token) return null
  try {
    const scale = Math.max(part.decimals, whole.decimals)
    const p = BigInt(part.units) * 10n ** BigInt(scale - part.decimals)
    const w = BigInt(whole.units) * 10n ** BigInt(scale - whole.decimals)
    if (w <= 0n || p < 0n || p > w) return null
    return Number((p * 10000n) / w)
  } catch {
    return null
  }
}

// Shares only mean something when every funded persona holds exactly one amount of one token.
function personaShares(personas) {
  if (personas.some((persona) => (persona.totals?.length ?? 0) > 1)) return null
  const singles = personas.map((persona) => persona.totals?.[0] ?? null)
  const funded = singles.filter(Boolean)
  if (!funded.length || funded.some((amount) => amount.token !== funded[0].token)) return null
  const shares = shareBasisPoints(
    singles.map((amount) => amount ?? { units: '0', decimals: funded[0].decimals })
  )
  return shares.some((bp) => bp > 0) ? shares : null
}

function prefersReducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}

export function CrewShareRail({
  personas = [],
  focusId = null,
  spotlightId = null,
  onFocus,
  onPreview,
}) {
  const trackRef = useRef(null)
  const shares = personaShares(personas)
  const layoutKey = personas
    .map((persona, index) => `${persona.id}:${shares?.[index] ?? 0}`)
    .join('|')

  useGSAP(
    () => {
      if (!shares || prefersReducedMotion()) return
      const segments = trackRef.current?.querySelectorAll('.pc-crew-rail-seg')
      if (!segments?.length) return
      gsap.from(segments, { attr: { width: 0 }, duration: 0.6, ease: 'power3.out', stagger: 0.08 })
    },
    { dependencies: [layoutKey], scope: trackRef, revertOnUpdate: true }
  )

  if (!personas.length) return null

  let cursor = 0
  const rects = (shares ?? []).map((bp, index) => {
    const width = (bp / 10000) * BAR_WIDTH
    const x = cursor
    cursor += width
    const isLast = index === personas.length - 1
    return { x, width: Math.max(0, isLast || width === 0 ? width : width - SEGMENT_GAP) }
  })

  return (
    <div className="pc-crew-rail" data-spotlight={spotlightId ? 'true' : undefined}>
      {shares ? (
        <div className="pc-crew-rail-track" ref={trackRef}>
          <svg
            key={layoutKey}
            className="pc-crew-rail-bar"
            viewBox={`0 0 ${BAR_WIDTH} ${BAR_HEIGHT}`}
            preserveAspectRatio="none"
            aria-hidden="true"
            focusable="false"
          >
            {personas.map((persona, index) =>
              rects[index].width > 0 ? (
                <rect
                  key={persona.id}
                  className="pc-crew-rail-seg"
                  data-tone={toneFor(persona)}
                  data-lit={spotlightId === persona.id ? 'true' : undefined}
                  x={rects[index].x}
                  y="0"
                  width={rects[index].width}
                  height={BAR_HEIGHT}
                />
              ) : null
            )}
          </svg>
        </div>
      ) : null}
      <ul className="pc-crew-rail-legend" aria-label="Share of the working balance by persona">
        {personas.map((persona, index) => {
          const share = shares ? shares[index] : null
          return (
            <li key={persona.id}>
              <button
                type="button"
                className="pc-crew-rail-key"
                data-tone={toneFor(persona)}
                data-lit={spotlightId === persona.id ? 'true' : undefined}
                aria-pressed={focusId === persona.id}
                aria-controls={`crew-bay-${persona.id}`}
                onClick={() => onFocus?.(persona.id)}
                onMouseEnter={() => onPreview?.(persona.id)}
                onMouseLeave={() => onPreview?.(null)}
              >
                <span className="pc-crew-rail-swatch" aria-hidden="true" />
                <span className="pc-crew-rail-name">{persona.name}</span>
                <span className="pc-crew-rail-share">
                  {share != null && share > 0
                    ? formatShare(share)
                    : persona.children.length
                      ? '—'
                      : 'Idle'}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
