import { useRef } from 'react'
import { MOTION, countUp, gsap, playWhileVisible, useGSAP, useScroller } from '../motion/gsap.js'
import { formatApr, formatTvl, wholeUsdc } from '../useLandingStats.js'
import FieldArt from './FieldArt.jsx'
import './hero.css'

const STAMP = {
  loading: 'reading Stellar testnet',
  live: 'live · Stellar testnet',
  unavailable: 'unavailable · on-chain read failed',
}

function scrollToHowItWorks(event) {
  const target = document.getElementById('how-it-works')
  if (!target) return
  event.preventDefault()
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
}

// Act one: the signature stroke draws, then becomes the fence. Act two: the crew keeps walking
// its rows for as long as the hero is on screen.
function heroTimeline(root, scroller) {
  const q = gsap.utils.selector(root)
  const [setLine, vibeLine] = q('.vf-hero__title .vf-line > span')
  const intro = gsap.timeline({ defaults: { ease: 'expo.out' } })
  intro
    .from(q('.vf-hero__kicker'), { opacity: 0, y: 12, duration: 0.6 })
    .from(setLine, { yPercent: 105, duration: 1.1 }, 0.05)
    .fromTo(
      q('.vf-field__sig'),
      { opacity: 1, strokeDashoffset: 1 },
      { strokeDashoffset: 0, duration: 0.9, ease: 'power2.inOut' },
      0.35
    )
    .fromTo(
      q('.vf-field__fence'),
      { strokeDashoffset: 1 },
      { strokeDashoffset: 0, duration: 0.9, ease: 'power2.inOut' },
      1.05
    )
    .to(q('.vf-field__sig'), { opacity: 0, duration: 0.5, ease: 'power1.out' }, 1.15)
    .from(q('.vf-field__fill'), { attr: { width: 0 }, duration: 1, stagger: 0.08 }, 1.3)
    .from(
      q('.vf-field__crew'),
      { scale: 0, transformOrigin: '50% 50%', duration: 0.6, stagger: 0.07, ease: 'back.out(2)' },
      1.4
    )
    .from(vibeLine, { yPercent: 105, duration: 1.1 }, 1.45)
    .from(
      q('.vf-hero__lede, .vf-hero__actions, .vf-hero__live'),
      { opacity: 0, y: 16, duration: 0.8, stagger: 0.08 },
      1.6
    )

  // Four legs per crew (out, back, out, back), so every walk ends at its row head.
  const walk = gsap.timeline({ paused: true })
  q('.vf-field__crew').forEach((crew, i) => {
    walk.to(
      crew,
      { x: 300 + i * 14, duration: 7 + i * 1.3, ease: 'sine.inOut', repeat: 3, yoyo: true },
      i * 0.4
    )
  })
  let introDone = false
  const visible = playWhileVisible(walk, { scroller, trigger: root, ready: () => introDone })
  intro.call(() => {
    introDone = true
    visible.start()
  })

  gsap.to(q('.vf-hero__art'), {
    yPercent: -8,
    ease: 'none',
    scrollTrigger: { scroller, trigger: root, start: 'top top', end: 'bottom top', scrub: true },
  })
}

export default function Hero({ onStart, stats }) {
  const root = useRef(null)
  const aprRef = useRef(null)
  const tvlRef = useRef(null)
  const scroller = useScroller()

  useGSAP(
    () => {
      const mm = gsap.matchMedia()
      mm.add(MOTION, (ctx) => {
        if (ctx.conditions.motion) heroTimeline(root.current, scroller.current)
      })
    },
    { scope: root }
  )

  useGSAP(
    () => {
      if (stats.status !== 'live') return
      const mm = gsap.matchMedia()
      mm.add(MOTION, (ctx) => {
        if (!ctx.conditions.motion) return
        if (stats.aprBps != null) {
          countUp(aprRef.current, stats.aprBps / 100, (v) => `${v.toFixed(2)}%`)
        }
        if (stats.totalAssets != null) {
          const whole = Number(wholeUsdc(stats.totalAssets))
          countUp(tvlRef.current, whole, (v) => `${Math.round(v).toLocaleString('en-US')} USDC`)
        }
      })
    },
    { dependencies: [stats.status], scope: root }
  )

  return (
    <header className="vf-hero" data-landing-section="Hero" ref={root}>
      <div className="vf-hero__copy">
        <p className="vf-kicker vf-hero__kicker">Autonomous USDC yield · Stellar testnet</p>
        <h1 className="vf-hero__title">
          <span className="vf-line vf-hero__set">
            <span>Set once. </span>
          </span>
          <span className="vf-line vf-hero__vibe">
            <span>Vibe forever.</span>
          </span>
        </h1>
        <p className="vf-hero__lede">
          Choose a USDC budget and risk level once. Scoped agents supply Blend lending on Stellar,
          compound, and stand watch until your grant expires or you revoke it.
        </p>
        <div className="vf-hero__actions">
          <button className="vf-button vf-button--primary" type="button" onClick={onStart}>
            Launch app
            <span className="vf-button__arrow" aria-hidden="true">
              →
            </span>
          </button>
          <a className="vf-text-link" href="#how-it-works" onClick={scrollToHowItWorks}>
            See how it works
          </a>
        </div>
      </div>

      <figure className="vf-hero__art">
        <FieldArt />
        <figcaption className="vf-caption">
          Illustration: one grant, four scoped workers, one fence.
        </figcaption>
      </figure>

      <div className="vf-hero__live">
        <dl className="vf-readout" aria-live="polite">
          <div>
            <dt>Blend USDC supply APR</dt>
            <dd data-testid="hero-apr" ref={aprRef}>
              {formatApr(stats.aprBps)}
            </dd>
          </div>
          <div>
            <dt>Vault TVL</dt>
            <dd data-testid="hero-tvl" ref={tvlRef}>
              {formatTvl(stats.totalAssets)}
            </dd>
          </div>
          <div>
            <dt>Signatures to start</dt>
            <dd data-testid="hero-signatures">1</dd>
          </div>
        </dl>
        <p className="vf-stamp" data-status={stats.status}>
          {STAMP[stats.status]}
        </p>
      </div>
    </header>
  )
}
