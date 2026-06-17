// LandingHero.jsx
// Scroll-driven hero for Vibing Farmer.
// Direction: editorial-finance terminal — dark canvas, single acid accent,
// the demo player as the one moving signature element.
//
// Desktop  → 300vh scroll stage; sticky player morphs center → left → right,
//            scene text staggers in on the opposite side (framer-motion).
// Mobile / reduced-motion → static 3-section stacked layout, no scroll math.
//
// Stack note: project ships no Tailwind. Styling uses the existing CSS-var
// design tokens (style.css) via inline objects + a scoped <style> for the
// things inline can't express (hover, media queries, reduced-motion, texture).

import { useRef, useState, useEffect } from 'react'
import {
  motion,
  useScroll,
  useTransform,
  useSpring,
  useMotionValueEvent,
} from 'framer-motion'
import NavBar from './NavBar.jsx'

/* ----------------------------- content ----------------------------- */

const SCENE_2 = {
  heading: ['Your USDC.', 'Earning yield.', 'Zero gas.'],
  features: [
    'Venice AI picks the optimal vault allocation',
    'Three-specialist AI Council (Yield, Risk, Market) deliberates',
    'Monte Carlo simulation projects risk & returns',
    '1Shot relayer pays all gas. You pay $0',
  ],
}

const SCENE_3 = {
  heading: ['Permission-bounded', 'autonomy.'],
  features: [
    'EIP-7702 smart account upgrade',
    'ERC-7715 scoped permissions & AgentRegistry',
    'Parallel worker agents execute using ephemeral keys',
    'On-chain strategy attestation (ERC-8004)',
  ],
}

/* --------------------------- motion variants ----------------------- */
// Each line: x(30) + opacity 0 + blur(8px) → settled. 80ms between lines.

const groupV = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08 } },
}

const lineV = {
  hidden: { opacity: 0, x: 30, filter: 'blur(8px)' },
  show: {
    opacity: 1,
    x: 0,
    filter: 'blur(0px)',
    transition: { type: 'spring', stiffness: 120, damping: 22 },
  },
}

/* ------------------------------ pieces ----------------------------- */

// The player itself — pure presentation. Animation lives on the wrapper.
function Player({ src = '/demo.mp4' }) {
  return (
    <div className="vf-player">
      <div className="vf-player__chrome">
        <span className="vf-dot" />
        <span className="vf-dot" />
        <span className="vf-dot" />
      </div>
      <div className="vf-player__stage">
        <div className="vf-player__glow" aria-hidden="true" />
        {/* key={src} → swapping the per-scene video remounts cleanly. */}
        <video
          key={src}
          src={src}
          autoPlay
          loop
          muted
          playsInline
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      </div>
    </div>
  )
}

// Above-the-fold hero — value prop + CTA visible without scroll.
// Editorial split: copy left, the demo player right. Stacks on mobile.
function HeroSection({ onStart }) {
  return (
    <section className="vf-hero">
      <div className="vf-hero__copy">
        <p className="vf-hero__eyebrow">Autonomous yield · Base Sepolia testnet</p>
        <h1 className="vf-hero__headline">
          <span>Set your yield once.</span>
          <span className="vf-hero__headline-soft">Agents farm it forever.</span>
        </h1>
        <p className="vf-hero__sub">
          Permission-bounded agents swap, approve, and deposit across vaults in
          parallel. Zero gas, fully on-chain, fully revocable.
        </p>
        <div className="vf-hero__cta">
          <button className="vf-cta__btn" onClick={onStart}>
            Start farming <span aria-hidden="true">→</span>
          </button>
        </div>
      </div>
      <div className="vf-hero__visual">
        <Player src="/demo.mp4" />
      </div>
    </section>
  )
}

function SceneText({ data, side, active }) {
  return (
    <motion.div
      className={`vf-scene-text vf-scene-text--${side}`}
      variants={groupV}
      initial="hidden"
      animate={active ? 'show' : 'hidden'}
      aria-hidden={active ? undefined : 'true'}
      // Hidden scenes are opacity:0 but still in the layer stack — kill
      // pointer capture so they don't block the player / CTA beneath them.
      style={{ pointerEvents: active ? 'auto' : 'none' }}
    >
      <h2 className="vf-headline">
        {data.heading.map((l) => (
          <motion.span key={l} className="vf-headline__line" variants={lineV}>
            {l}
          </motion.span>
        ))}
      </h2>
      <ul className="vf-features">
        {data.features.map((f) => (
          <motion.li key={f} className="vf-feature" variants={lineV}>
            {f}
          </motion.li>
        ))}
      </ul>
    </motion.div>
  )
}

function CtaBlock({ onStart }) {
  return (
    <div className="vf-cta">
      <button className="vf-cta__btn" onClick={onStart}>
        Start farming <span aria-hidden="true">→</span>
      </button>
      <p className="vf-cta__sub">Base Sepolia testnet · MetaMask Flask</p>
    </div>
  )
}

// Closing panel — shared by scroll + static layouts.
function OutroContent({ onStart }) {
  return (
    <>
      <p className="vf-outro__eyebrow">the vault is open</p>
      <h2 className="vf-outro__title">
        The agents run.<br />
        <span className="vf-outro__title-soft">You don't have to.</span>
      </h2>
      <p className="vf-outro__sub">
        Autonomous yield, scoped permissions, zero gas. Set once. Vibe forever.
      </p>
      <CtaBlock onStart={onStart} />
    </>
  )
}

/* ----------------------- static fallback layout -------------------- */
// Mobile + reduced-motion. Stacks vertically; CSS handles a soft fade-in.

function StaticHero({ onStart }) {
  return (
    <div className="vf-static">
      <HeroSection onStart={onStart} />

      <section className="vf-static__scene vf-static__scene--split">
        <Player src="/strategy.mp4" />
        <SceneText data={SCENE_2} side="right" active />
      </section>

      <section className="vf-static__scene vf-static__scene--split reverse">
        <SceneText data={SCENE_3} side="left" active />
        <Player src="/agent.mp4" />
      </section>

      <section className="vf-static__scene vf-outro">
        <div className="vf-outro__inner">
          <OutroContent onStart={onStart} />
        </div>
      </section>
    </div>
  )
}

/* -------------------------- scroll-driven -------------------------- */

// Per-scene video mapped to user's recorded demo components.
const SCENE_VIDEO = { 1: '/demo.mp4', 2: '/strategy.mp4', 3: '/agent.mp4' }

function ScrollHero({ onStart, scrollContainer }) {
  const ref = useRef(null)
  // Track scroll inside our own fixed container — the app locks body/#root
  // (overflow:hidden, height:100vh), so window scroll never progresses.
  const { scrollYProgress } = useScroll({
    container: scrollContainer,
    target: ref,
    offset: ['start start', 'end end'],
  })

  // Player morph. Spring on the signature transit (stiffness 100 / damping 20).
  const scaleRaw = useTransform(scrollYProgress, [0, 0.33], [1, 0.58])
  const xRaw = useTransform(scrollYProgress, [0, 0.33, 0.66], ['0%', '-32%', '32%'])
  const rotRaw = useTransform(scrollYProgress, [0, 0.33, 0.66], [0, 5, -5])

  const springCfg = { stiffness: 100, damping: 20, mass: 0.6 }
  const scale = useSpring(scaleRaw, springCfg)
  const x = useSpring(xRaw, springCfg)
  const rotateY = useSpring(rotRaw, springCfg)

  // Faint lime trail trails the player as it moves laterally.
  const trailOpacity = useTransform(
    scrollYProgress,
    [0, 0.18, 0.33, 0.5, 0.66, 0.82],
    [0, 0.5, 0, 0.5, 0, 0]
  )

  // Scene activation from scroll position (drives stagger + which video plays).
  const [scene, setScene] = useState(1)
  useMotionValueEvent(scrollYProgress, 'change', (p) => {
    const next = p < 0.2 ? 1 : p < 0.6 ? 2 : 3
    setScene((cur) => (cur === next ? cur : next))
  })

  // Tagline + scroll hint live in scene 1 only.
  const introOpacity = useTransform(scrollYProgress, [0, 0.12, 0.2], [1, 1, 0])

  return (
    <>
    <HeroSection onStart={onStart} />
    <section className="vf-stage" ref={ref}>
      <div className="vf-stage__sticky">
        {/* persistent top nav carries the wordmark now (see <NavBar/> at root) */}

        {/* scene 2 text — right side, in 0.2–0.6 */}
        <SceneText data={SCENE_2} side="right" active={scene === 2} />
        {/* scene 3 text — left side, in 0.6+ */}
        <SceneText data={SCENE_3} side="left" active={scene === 3} />

        {/* the moving player — video crossfades per scene */}
        <motion.div className="vf-stage__player" style={{ x, scale, rotateY }}>
          <motion.div
            className="vf-stage__trail"
            style={{ opacity: trailOpacity }}
            aria-hidden="true"
          />
          <Player src={SCENE_VIDEO[scene]} />
        </motion.div>

        {/* scene 1 tagline */}
        <motion.div className="vf-stage__intro" style={{ opacity: introOpacity }}>
          <p className="vf-tagline">Set once. Vibe forever.</p>
        </motion.div>

      </div>
    </section>

    {/* outro — closing panel after the last scene, scrolls up as the
        sticky stage releases. The primary conversion moment. */}
    <section className="vf-outro">
      <motion.div
        className="vf-outro__inner"
        initial={{ opacity: 0, y: 30 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ root: scrollContainer, once: true, amount: 0.35 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      >
        <OutroContent onStart={onStart} />
      </motion.div>
    </section>
    </>
  )
}

/* ------------------------------ root ------------------------------ */

export default function LandingHero({ onStart }) {
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 760px)')
    const sync = () => setIsMobile(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  // Static layout only on real small screens. Desktop always animates —
  // the scroll-morph is the product's core demo, shown to every visitor.
  const useStatic = isMobile
  const containerRef = useRef(null)

  return (
    <div
      className="vf-landing"
      ref={containerRef}
      data-static={useStatic ? 'true' : 'false'}
    >
      <StyleTag />
      <NavBar />
      {useStatic ? (
        <StaticHero onStart={onStart} />
      ) : (
        <ScrollHero onStart={onStart} scrollContainer={containerRef} />
      )}
    </div>
  )
}

/* ---------------------------- styles ------------------------------ */
// Scoped to .vf-landing. Inherits palette tokens from style.css so the
// hero re-themes with the rest of the app (Acid Yield, Mono Slate, …).

function StyleTag() {
  return (
    <style>{`
.vf-landing {
  position: fixed;
  inset: 0;
  z-index: 50;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  background: var(--bg-base, #0e0f0c);
  color: var(--text, #ecebe1);
  font-family: var(--font-body, "Geist", system-ui, sans-serif);
  --vf-accent: var(--accent, #cfff3d);
  --vf-player-w: clamp(280px, 66vw, 820px);
}

/* faint grid texture for atmosphere */
.vf-landing::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  background-image:
    linear-gradient(rgba(255,255,255,0.018) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.018) 1px, transparent 1px);
  background-size: 48px 48px;
  mask-image: radial-gradient(ellipse 80% 70% at 50% 40%, #000 30%, transparent 100%);
}

/* ---------- wordmark ---------- */
.vf-wordmark {
  display: inline-flex;
  align-items: baseline;
  gap: 0.4ch;
  font-size: clamp(1.1rem, 2.4vw, 1.6rem);
  letter-spacing: -0.01em;
  user-select: none;
}
.vf-wordmark.is-small { font-size: clamp(0.95rem, 1.6vw, 1.2rem); }
.vf-wordmark__vibe {
  font-family: var(--font-script, "Newsreader", serif);
  font-style: italic;
  font-weight: 500;
  color: var(--text, #ecebe1);
}
.vf-wordmark__slash {
  color: var(--vf-accent);
  font-weight: 400;
  transform: translateY(-0.02em);
}
.vf-wordmark__farm {
  font-family: var(--font-mono, "JetBrains Mono", monospace);
  font-weight: 500;
  text-transform: lowercase;
  letter-spacing: 0.02em;
  color: var(--text, #ecebe1);
}

/* ---------- player ---------- */
.vf-player {
  width: 100%;
  border: 1px solid var(--border-strong, rgba(255,255,255,0.13));
  border-radius: var(--radius-xl, 18px);
  overflow: hidden;
  background: var(--bg-card, #1a1b16);
  box-shadow:
    0 1px 0 rgba(255,255,255,0.04) inset,
    0 40px 90px -40px rgba(0,0,0,0.85);
}
.vf-player__chrome {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 11px 14px;
  border-bottom: 1px solid var(--border, rgba(255,255,255,0.06));
  background: var(--bg-elev, #22231d);
}
.vf-dot {
  width: 9px; height: 9px; border-radius: 50%;
  background: var(--text-faint, #56564f);
  opacity: 0.6;
}
.vf-player__stage {
  position: relative;
  aspect-ratio: 16 / 9;
  display: grid;
  place-items: center;
  background:
    radial-gradient(120% 120% at 50% 0%, rgba(255,255,255,0.03), transparent 60%),
    var(--bg-base, #0e0f0c);
}
.vf-player__glow {
  position: absolute;
  width: 42%;
  aspect-ratio: 1;
  border-radius: 50%;
  background: var(--vf-accent);
  filter: blur(90px);
  opacity: 0.12;
  pointer-events: none;
}

/* ---------- above-the-fold hero (editorial split) ---------- */
.vf-hero {
  position: relative;
  z-index: 1;
  min-height: 100vh;
  max-width: 1400px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: 1.1fr 1fr;
  align-items: center;
  gap: clamp(2rem, 5vw, 4.5rem);
  padding: clamp(5.5rem, 12vh, 8rem) clamp(1.5rem, 6vw, 5rem) clamp(3rem, 8vh, 6rem);
}
.vf-hero__copy {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: clamp(1rem, 2.4vh, 1.6rem);
}
.vf-hero__eyebrow {
  font-family: var(--font-mono, monospace);
  font-size: 0.74rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-faint, #56564f);
}
.vf-hero__headline {
  display: flex;
  flex-direction: column;
  font-family: var(--font-display, "Geist", sans-serif);
  font-weight: 700;
  letter-spacing: -0.035em;
  line-height: 1.02;
  font-size: clamp(2.1rem, 4.4vw, 3.4rem);
  color: var(--text, #ecebe1);
  text-wrap: balance;
}
.vf-hero__headline-soft { color: var(--text-muted, #95958a); }
.vf-hero__sub {
  font-family: var(--font-mono, monospace);
  font-size: clamp(0.84rem, 1.1vw, 0.98rem);
  line-height: 1.65;
  max-width: 46ch;
  color: var(--text-muted, #95958a);
}
.vf-hero__cta { margin-top: 0.3rem; }
.vf-hero__visual { width: 100%; }
.vf-hero__visual .vf-player { width: 100%; }

@media (max-width: 900px) {
  .vf-hero {
    grid-template-columns: 1fr;
    gap: 2.2rem;
    min-height: auto;
    padding-top: 6rem;
    padding-bottom: 3rem;
  }
  .vf-hero__visual { order: -1; }
}

/* ---------- tagline / hint ---------- */
.vf-tagline {
  font-family: var(--font-script, "Newsreader", serif);
  font-style: italic;
  font-size: clamp(1.05rem, 2.2vw, 1.5rem);
  color: var(--text-muted, #95958a);
}
/* ---------- scene text ---------- */
.vf-headline {
  display: flex;
  flex-direction: column;
  font-family: var(--font-display, "Geist", sans-serif);
  font-weight: 700;
  letter-spacing: -0.035em;
  line-height: 0.98;
  font-size: clamp(2rem, 5vw, 4rem);
  color: var(--text, #ecebe1);
  margin-bottom: 1.6rem;
}
.vf-features { list-style: none; display: flex; flex-direction: column; gap: 0.75rem; }
.vf-feature {
  font-family: var(--font-mono, monospace);
  font-size: clamp(0.8rem, 1.1vw, 0.95rem);
  line-height: 1.4;
  color: var(--text-muted, #95958a);
  padding-left: 0.9rem;
  border-left: 1px solid var(--border-strong, rgba(255,255,255,0.13));
}

/* ---------- CTA ---------- */
.vf-cta { display: flex; flex-direction: column; align-items: center; gap: 1rem; }
.vf-cta__btn {
  font-family: var(--font-mono, monospace);
  font-weight: 600;
  font-size: 1rem;
  letter-spacing: 0.01em;
  padding: 0.95rem 2.1rem;
  border-radius: var(--radius-lg, 14px);
  color: var(--accent-fg, #0e0f0c);
  background: var(--vf-accent);
  border: none;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 0.6ch;
  box-shadow: 0 0 0 0 rgba(207,255,61,0);
  transition: transform 220ms cubic-bezier(0.16,1,0.3,1),
              box-shadow 220ms ease;
}
.vf-cta__btn span { transition: transform 220ms cubic-bezier(0.16,1,0.3,1); }
.vf-cta__btn:hover { transform: translateY(-2px); box-shadow: 0 0 40px 2px rgba(207,255,61,0.4); }
.vf-cta__btn:hover span { transform: translateX(4px); }
.vf-cta__btn:active { transform: translateY(0); }
.vf-cta__sub {
  font-family: var(--font-mono, monospace);
  font-size: 0.74rem;
  letter-spacing: 0.06em;
  color: var(--text-faint, #56564f);
}

/* =========================================================
   SCROLL STAGE (desktop)
   ========================================================= */
.vf-stage { position: relative; height: 320vh; z-index: 1; }
.vf-stage__sticky {
  position: sticky;
  top: 0;
  height: 100vh;
  overflow: hidden;
  display: grid;
  place-items: center;
}

.vf-stage__mark { position: absolute; top: clamp(24px, 5vh, 56px); left: 50%; transform: translateX(-50%); z-index: 5; }

.vf-stage__player {
  position: relative;
  width: var(--vf-player-w);
  z-index: 4;
  transform-style: preserve-3d;
  perspective: 1200px;
  will-change: transform;
}
.vf-stage__trail {
  position: absolute;
  inset: -3% -2%;
  border-radius: 24px;
  background: radial-gradient(55% 55% at 50% 50%, rgba(207,255,61,0.2), transparent 70%);
  filter: blur(22px);
  z-index: -1;
  pointer-events: none;
}

.vf-stage__intro {
  position: absolute;
  bottom: clamp(28px, 7vh, 70px);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.9rem;
  text-align: center;
  z-index: 5;
}

/* scene text absolutely placed on opposite half of the player */
.vf-scene-text {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: min(40vw, 520px);
  z-index: 6;
}
.vf-scene-text--right { right: clamp(40px, 7vw, 120px); }
.vf-scene-text--left  { left: clamp(40px, 7vw, 120px); }

/* ---------- outro / closing panel ---------- */
.vf-outro {
  position: relative;
  z-index: 1;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: clamp(3rem, 8vw, 7rem) clamp(1.2rem, 6vw, 4rem);
  border-top: 1px solid var(--border, rgba(255,255,255,0.06));
  background:
    radial-gradient(120% 80% at 50% 100%, var(--accent-soft, rgba(207,255,61,0.08)), transparent 62%),
    var(--bg-base, #0e0f0c);
}
.vf-outro__inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.4rem;
  text-align: center;
  max-width: 760px;
}
.vf-outro__eyebrow {
  font-family: var(--font-mono, monospace);
  font-size: 0.72rem;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--vf-accent);
}
.vf-outro__title {
  font-family: var(--font-display, "Geist", sans-serif);
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1;
  font-size: clamp(2.4rem, 6vw, 5rem);
  color: var(--text, #ecebe1);
}
.vf-outro__title-soft {
  color: var(--text-muted, #95958a);
  font-weight: 600;
}
.vf-outro__sub {
  font-family: var(--font-mono, monospace);
  font-size: clamp(0.82rem, 1.2vw, 0.98rem);
  line-height: 1.7;
  max-width: 46ch;
  color: var(--text-muted, #95958a);
}
.vf-outro .vf-cta { margin-top: 0.6rem; }

/* =========================================================
   STATIC LAYOUT (mobile / reduced-motion)
   ========================================================= */
.vf-static { position: relative; z-index: 1; }
.vf-static__scene {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1.6rem;
  padding: clamp(2rem, 8vw, 5rem) clamp(1.2rem, 6vw, 4rem);
  text-align: center;
}
.vf-static__scene .vf-player { max-width: var(--vf-player-w); }
.vf-static__scene--split { gap: 2.4rem; }
.vf-static .vf-scene-text { position: static; transform: none; width: 100%; max-width: 520px; }
.vf-static .vf-headline,
.vf-static .vf-features { align-items: center; }
.vf-static .vf-feature { text-align: center; border-left: none; padding-left: 0; }

/* gentle entrance for static scenes */
@media (prefers-reduced-motion: no-preference) {
  .vf-static__scene > * {
    animation: vf-rise 600ms cubic-bezier(0.16,1,0.3,1) both;
  }
}
@keyframes vf-rise {
  from { opacity: 0; transform: translateY(16px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* desktop scene text reads left-aligned; static stays centered */
@media (min-width: 761px) {
  .vf-scene-text .vf-headline,
  .vf-scene-text .vf-features { align-items: flex-start; text-align: left; }
}

`}</style>
  )
}
