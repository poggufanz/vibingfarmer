// frontend/src/design/usePocketTransition.js
// State-driven GSAP entrance motion for Pocket Crew surfaces (Foundation Task 5). Restrained by
// design: one entrance treatment, triggered only by a state-key change -- never a scroll
// position, an interval, or an infinite loop. Elements opt in explicitly via
// `[data-pocket-enter]` so this hook never guesses what "just appeared" means.
import { useRef } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'

gsap.registerPlugin(useGSAP)

// Approved ruling 6 overrides the area-plan's power2.out default; other defaults stand as
// specified: 0.32s duration, y:8 rise, opacity 0->1, stagger capped at 0.04s/item.
const DURATION = 0.32
const EASE = 'power3.out'
const RISE_Y = 8
const STAGGER = 0.04
const ERROR_SHIFT_X = 2

// ponytail: read once per state-key change, not subscribed live -- matches the existing
// reducedMotion()/finePointer() convention in LandingFx.jsx. A mid-session OS preference flip is
// picked up on the next state transition, not this one already in flight.
function prefersReducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}

/**
 * @param {import('react').RefObject<Element>} scopeRef container whose `[data-pocket-enter]`
 *   descendants are animated
 * @param {string|number} stateKey changing this re-triggers the entrance
 * @param {{ error?: boolean }} [options] `error: true` swaps the entrance for a single small
 *   x-shift (never a repeating shake) -- for surfaces reporting a failed state
 */
export function usePocketTransition(scopeRef, stateKey, options = {}) {
  const { error = false } = options
  // Keep the latest option without forcing a re-run of the effect below on every render --
  // only a real stateKey change should re-fire the transition.
  const errorRef = useRef(error)
  errorRef.current = error

  useGSAP(
    () => {
      const scope = scopeRef.current
      if (!scope) return

      const targets = gsap.utils.toArray('[data-pocket-enter]', scope)
      if (targets.length === 0) return

      if (prefersReducedMotion()) {
        gsap.set(targets, { opacity: 1, x: 0, y: 0, scale: 1 })
        return
      }

      if (errorRef.current) {
        gsap.to(targets, {
          x: ERROR_SHIFT_X,
          duration: DURATION,
          ease: EASE,
          yoyo: true,
          repeat: 1,
        })
        return
      }

      gsap.from(targets, {
        opacity: 0,
        y: RISE_Y,
        duration: DURATION,
        ease: EASE,
        stagger: STAGGER,
      })
    },
    { scope: scopeRef, dependencies: [stateKey] }
  )
}
