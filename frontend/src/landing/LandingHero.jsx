// Public landing: "Set once. Vibe forever." Seven sections, each owning its markup, CSS and
// motion. `.vf-landing` is the scroll container (the app shell keeps the window fixed), so every
// ScrollTrigger names it (see scrollerOf in motion/gsap.js).
import { useEffect } from 'react'
import NavBar from '../components/NavBar.jsx'
import { ScrollTrigger } from './motion/gsap.js'
import { useLandingStats } from './useLandingStats.js'
import Hero from './sections/Hero.jsx'
import SetOnce from './sections/SetOnce.jsx'
import VibeForever from './sections/VibeForever.jsx'
import RealYield from './sections/RealYield.jsx'
import Leash from './sections/Leash.jsx'
import Risks from './sections/Risks.jsx'
import Final from './sections/Final.jsx'
import './LandingHero.css'

export default function LandingHero({ onStart }) {
  const stats = useLandingStats()

  // Web fonts change line heights, and with them every trigger position.
  useEffect(() => {
    let alive = true
    document.fonts?.ready.then(() => alive && ScrollTrigger.refresh())
    return () => {
      alive = false
    }
  }, [])

  return (
    <div className="vf-landing">
      <div className="vf-landing__backdrop" aria-hidden="true" />
      <NavBar onLaunch={onStart} />
      <main>
        <Hero onStart={onStart} stats={stats} />
        <SetOnce />
        <VibeForever />
        <RealYield stats={stats} />
        <Leash />
        <Risks />
        <Final onStart={onStart} />
      </main>
    </div>
  )
}
