// Landing motion is intentional product design, owned by src/landing. Do not strip it during
// design-conform passes: LandingContract.test.jsx requires it (commit 87a0da86 removed it once and
// a ban test kept it removed). Rules that keep it inside the Pocket Crew web contract:
//   - loops are GSAP timelines created paused and toggled by ScrollTrigger, never CSS keyframes;
//   - every ScrollTrigger names the landing scroller (.vf-landing owns overflow, not the window);
//   - no tweens are created under prefers-reduced-motion, and the default CSS is the final frame.
import { createContext, useContext } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { useGSAP } from '@gsap/react'

gsap.registerPlugin(useGSAP, ScrollTrigger)

export const MOTION = {
  motion: '(prefers-reduced-motion: no-preference)',
  desktop: '(min-width: 860px)',
}

export const ScrollerContext = createContext({ current: null })
export const useScroller = () => useContext(ScrollerContext)

// Rolls a readout from `from` to its value. Call only inside a motion branch: React has already
// rendered the final text, so skipping this leaves the correct number on screen. It writes the
// existing text node (never textContent) so React keeps ownership of the node for later updates.
export function countUp(el, to, format, { from = 0, duration = 1.2 } = {}) {
  const node = el?.firstChild
  if (!node || node.nodeType !== Node.TEXT_NODE || !Number.isFinite(to)) return
  const proxy = { value: from }
  gsap.to(proxy, {
    value: to,
    duration,
    ease: 'power3.out',
    onUpdate: () => {
      node.nodeValue = format(proxy.value)
    },
  })
}

export { gsap, ScrollTrigger, useGSAP }
