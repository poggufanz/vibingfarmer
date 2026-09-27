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

export { gsap, ScrollTrigger, useGSAP }
