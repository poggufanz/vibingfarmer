// Landing motion is intentional product design, owned by src/landing. Do not strip it during
// design-conform passes: LandingContract.test.jsx requires it (commit 87a0da86 removed it once and
// a ban test kept it removed). Rules that keep it inside the Pocket Crew web contract:
//   - loops are finite GSAP timelines (the web contract bans repeat: -1 and CSS keyframe loops),
//     created paused and run through playWhileVisible;
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

// Runs a finite ambient loop only while `trigger` is on screen: it pauses when the section
// leaves and starts again from the top if it had already finished. `ready` holds the loop back
// until an intro completes; call start() once it has.
export function playWhileVisible(loop, { scroller, trigger, ready = () => true }) {
  const play = () => (loop.progress() === 1 ? loop.restart() : loop.play())
  const visible = ScrollTrigger.create({
    scroller,
    trigger,
    start: 'top bottom',
    end: 'bottom top',
    onToggle: (self) => {
      if (!self.isActive) loop.pause()
      else if (ready()) play()
    },
  })
  return {
    start: () => {
      if (visible.isActive) play()
    },
  }
}

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
