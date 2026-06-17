// motion.js
// Tiny motion primitives — compositor-friendly, reduced-motion aware.
// No animation library; rAF + CSS only.

import { useEffect, useRef, useState } from 'react'

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

// easeOutExpo — fast start, long settle. Reads "alive" without bounce.
const easeOutExpo = (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t))

/**
 * Animate a number from 0 → target on mount (and on target change).
 * Returns the live numeric value; format at the call site.
 *
 * @param {number} target
 * @param {object} [opts]
 * @param {number} [opts.duration=900] ms
 * @param {number} [opts.delay=0] ms
 * @returns {number}
 */
export function useCountUp(target, opts = {}) {
  const { duration = 900, delay = 0 } = opts
  const safeTarget = Number.isFinite(target) ? target : 0
  const [value, setValue] = useState(prefersReducedMotion() ? safeTarget : 0)
  const fromRef = useRef(0)
  const rafRef = useRef(0)
  const timerRef = useRef(0)

  useEffect(() => {
    if (prefersReducedMotion()) {
      setValue(safeTarget)
      return
    }
    const from = fromRef.current
    let start = 0
    const tick = (now) => {
      if (!start) start = now
      const p = Math.min(1, (now - start) / duration)
      const eased = easeOutExpo(p)
      setValue(from + (safeTarget - from) * eased)
      if (p < 1) rafRef.current = requestAnimationFrame(tick)
      else fromRef.current = safeTarget
    }
    timerRef.current = window.setTimeout(() => {
      rafRef.current = requestAnimationFrame(tick)
    }, delay)
    return () => {
      cancelAnimationFrame(rafRef.current)
      clearTimeout(timerRef.current)
    }
  }, [safeTarget, duration, delay])

  return value
}

/**
 * Staggered reveal delay helper — returns an inline style that runs the
 * `rise-in` keyframe with a per-index offset. Pair with CSS `.rise`.
 *
 * @param {number} index
 * @param {number} [step=70] ms between items
 * @param {number} [base=0] ms initial offset
 */
export function riseDelay(index, step = 70, base = 0) {
  return { animationDelay: `${base + index * step}ms` }
}
