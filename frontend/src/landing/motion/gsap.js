// Landing motion is intentional product design, owned by src/landing. Do not strip it during
// design-conform passes: LandingContract.test.jsx requires it (commit 87a0da86 removed it once and
// a ban test kept it removed). Rules that keep it inside the Pocket Crew web contract:
//   - loops are finite GSAP timelines (the web contract bans repeat: -1 and CSS keyframe loops),
//     created paused and run through playWhileVisible;
//   - every ScrollTrigger names the landing scroller (.vf-landing owns overflow, not the window);
//   - no tweens are created under prefers-reduced-motion, and the default CSS is the final frame.
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { useGSAP } from '@gsap/react'

gsap.registerPlugin(useGSAP, ScrollTrigger)

// One query on purpose: gsap.matchMedia reverts and re-runs a callback whenever any of its queries
// flips, so a width condition here would replay every intro when a window is resized.
export const MOTION = '(prefers-reduced-motion: no-preference)'

// Read the scroller from the DOM inside the motion callback, never from a parent ref: React runs
// a child's layout effects before it attaches the parent's ref, so on the first (production) mount
// a ref is still null and ScrollTrigger silently falls back to the window, which never scrolls.
// Outside the landing (isolated section tests) this is null and the window is the right default.
export const scrollerOf = (el) => el.closest('.vf-landing')

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
  return gsap.to(proxy, {
    value: to,
    duration,
    ease: 'power3.out',
    onUpdate: () => {
      node.nodeValue = format(proxy.value)
    },
  })
}

export { gsap, ScrollTrigger, useGSAP }
