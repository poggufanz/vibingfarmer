// frontend/src/components/strategy/CrewSplit.jsx
// The crew split bar (2026-09-28 Strategy redesign): one horizontal bar, one segment per crew
// member, sized from the exact bigint units the plan already holds. It is a picture of numbers the
// surface already shows in text (the crew line, each allocation row), so the SVG is aria-hidden and
// the figure's caption carries the meaning. Segment widths are integer basis points of the
// decimal-normalized total -- never a float re-derivation of the amounts themselves.
import { useRef } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'

gsap.registerPlugin(useGSAP)

const BAR_WIDTH = 1000
const BAR_HEIGHT = 16
const SEGMENT_GAP = 6

// Persona -> crew palette slot. Sprout reads green, Clover pink, Mochi teal; the Base bridge leg is
// always the blue slot so "blue = Base" holds anywhere a split is drawn.
const PERSONA_TONE = Object.freeze({ sprout: 1, clover: 6, mochi: 5 })
export const BRIDGE_TONE = 2

export function toneFor(persona, kind) {
  if (kind === 'bridge') return BRIDGE_TONE
  return PERSONA_TONE[persona?.id] || 3
}

/**
 * @param {Array<{units: string|bigint, decimals: number}>} segments
 * @returns {number[]} basis points (0..10000) per segment, in order
 */
export function shareBasisPoints(segments) {
  try {
    const scale = segments.reduce((max, s) => Math.max(max, s.decimals), 0)
    const normalized = segments.map((s) => BigInt(s.units) * 10n ** BigInt(scale - s.decimals))
    const total = normalized.reduce((sum, n) => sum + n, 0n)
    if (total <= 0n) return segments.map(() => 0)
    return normalized.map((n) => Number((n * 10000n) / total))
  } catch {
    return segments.map(() => 0)
  }
}

export function formatShare(basisPoints) {
  return `${(Math.round(basisPoints / 10) / 10).toFixed(1)}%`
}

/**
 * @param {object} props
 * @param {Array<{id: string, units: string|bigint, decimals: number, tone: number,
 *   name?: string, avatar?: string}>} props.segments
 * @param {boolean} [props.legend] render the name + share legend (input preview only -- on the
 *   reviewed plan the allocation rows below are the legend)
 * @param {string} [props.emptyText] invitation shown while there is nothing to split yet
 */
export function CrewSplit({ segments, legend = false, emptyText, caption }) {
  const barRef = useRef(null)
  const shares = shareBasisPoints(segments)
  const hasSplit = segments.length > 0 && shares.some((bp) => bp > 0)
  // Remount key: the bar only re-grows when the crew itself changes (count or members), not on
  // every keystroke of the amount -- an even split keeps the same proportions as the amount moves.
  const layoutKey = segments.map((s) => `${s.id}:${s.tone}`).join('|')

  useGSAP(
    () => {
      if (!hasSplit || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
      const rects = barRef.current?.querySelectorAll('.pc-crew-split-seg')
      if (!rects?.length) return
      gsap.from(rects, {
        attr: { width: 0 },
        duration: 0.5,
        ease: 'power3.out',
        stagger: 0.07,
      })
    },
    { dependencies: [layoutKey, hasSplit], scope: barRef, revertOnUpdate: true }
  )

  let cursor = 0
  const rects = shares.map((bp, index) => {
    const width = (bp / 10000) * BAR_WIDTH
    const x = cursor
    cursor += width
    const isLast = index === shares.length - 1
    return { x, width: Math.max(0, isLast ? width : width - SEGMENT_GAP) }
  })

  return (
    <figure className="pc-crew-split" data-empty={hasSplit ? undefined : 'true'}>
      {caption && <figcaption className="pc-crew-split-caption">{caption}</figcaption>}
      <div className="pc-crew-split-track" ref={barRef}>
        {hasSplit ? (
          <svg
            key={layoutKey}
            className="pc-crew-split-bar"
            viewBox={`0 0 ${BAR_WIDTH} ${BAR_HEIGHT}`}
            preserveAspectRatio="none"
            aria-hidden="true"
            focusable="false"
          >
            {segments.map((segment, index) => (
              <rect
                key={segment.id}
                className="pc-crew-split-seg"
                data-tone={segment.tone}
                data-seg={index}
                x={rects[index].x}
                y="0"
                width={rects[index].width}
                height={BAR_HEIGHT}
              />
            ))}
          </svg>
        ) : (
          <p className="pc-crew-split-empty">{emptyText}</p>
        )}
      </div>
      {legend && hasSplit && (
        <ul className="pc-crew-split-legend">
          {segments.map((segment, index) => (
            <li key={segment.id} className="pc-crew-split-item" data-tone={segment.tone}>
              {segment.avatar ? (
                <img
                  className="pc-crew-split-avatar"
                  src={segment.avatar}
                  alt=""
                  aria-hidden="true"
                  width="28"
                  height="28"
                />
              ) : (
                <span className="pc-crew-split-swatch" aria-hidden="true" />
              )}
              <span className="pc-crew-split-name">{segment.name}</span>
              <span className="pc-crew-split-share">{formatShare(shares[index])}</span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  )
}
