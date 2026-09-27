import { useRef } from 'react'
import {
  MOTION,
  ScrollTrigger,
  countUp,
  gsap,
  playWhileVisible,
  useGSAP,
  useScroller,
} from '../motion/gsap.js'
import { formatApr, formatTvl, wholeUsdc } from '../useLandingStats.js'
import './real-yield.css'

const PATH = [
  { name: 'USDC budget', detail: 'Stays in your wallet, capped by the grant allowance.' },
  { name: 'Agent accounts', detail: 'Scoped signers pull only their share.' },
  { name: 'vfVLT vault shares', detail: 'Your claim on the vault, redeemable.' },
  { name: 'Blend v2 USDC pool', detail: 'The lending market that pays interest.' },
  { name: 'Interest + BLND', detail: 'Harvested and re-supplied by the keeper.' },
]

const FACTS = [
  ['Asset', 'USDC'],
  ['Network', 'Stellar testnet'],
  ['Yield source', 'Blend Capital v2 lending interest'],
  ['Protocol fee', 'None in vault, strategy or router contracts'],
  ['Network fee', 'Sponsored by fee-bump relay'],
  ['Exit', 'Redeem any time; the admin cannot pause redemption'],
]

const STAMP = {
  loading: 'reading Stellar testnet',
  live: 'live · Stellar testnet',
  unavailable: 'unavailable · on-chain read failed',
}

function yieldMotion(root, scroller) {
  const q = gsap.utils.selector(root)
  const path = q('.vf-path')[0]
  const line = q('.vf-path__line')[0]

  gsap.from(q('.vf-yield__head .vf-line > span'), {
    yPercent: 105,
    duration: 1,
    stagger: 0.08,
    ease: 'expo.out',
    scrollTrigger: { scroller, trigger: root, start: 'top 80%', once: true },
  })
  gsap.from(line, {
    scaleX: 0,
    transformOrigin: 'left center',
    ease: 'none',
    scrollTrigger: { scroller, trigger: path, start: 'top 85%', end: 'top 45%', scrub: true },
  })
  gsap.from(q('.vf-path__stage'), {
    opacity: 0,
    y: 24,
    duration: 0.8,
    stagger: 0.1,
    ease: 'expo.out',
    scrollTrigger: { scroller, trigger: path, start: 'top 80%', once: true },
  })

  // Capital moves along the path while the section is on screen: five passes per viewing.
  const flow = gsap.fromTo(
    q('.vf-path__token'),
    { x: 0 },
    { x: () => line.offsetWidth, duration: 6, ease: 'none', repeat: 4, paused: true }
  )
  playWhileVisible(flow, { scroller, trigger: root }).start()
}

export default function RealYield({ stats }) {
  const root = useRef(null)
  const aprRef = useRef(null)
  const tvlRef = useRef(null)
  const scroller = useScroller()

  useGSAP(
    () => {
      const mm = gsap.matchMedia()
      mm.add(MOTION, (ctx) => {
        if (ctx.conditions.motion) yieldMotion(root.current, scroller.current)
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
        const trigger = {
          scroller: scroller.current,
          trigger: aprRef.current,
          start: 'top 90%',
          once: true,
        }
        ScrollTrigger.create({
          ...trigger,
          onEnter: () => {
            if (stats.aprBps != null) {
              countUp(aprRef.current, stats.aprBps / 100, (v) => `${v.toFixed(2)}%`)
            }
            if (stats.totalAssets != null) {
              const whole = Number(wholeUsdc(stats.totalAssets))
              countUp(tvlRef.current, whole, (v) => `${Math.round(v).toLocaleString('en-US')} USDC`)
            }
          },
        })
      })
    },
    { dependencies: [stats.status], scope: root }
  )

  return (
    <section
      className="vf-section vf-yield"
      data-landing-section="RealYield"
      aria-labelledby="yield-title"
      ref={root}
    >
      <div className="vf-section-head vf-yield__head">
        <p className="vf-kicker">03 · Real yield</p>
        <h2 id="yield-title">
          <span className="vf-line">
            <span>Real lending yield </span>
          </span>
          <span className="vf-line">
            <span>underneath.</span>
          </span>
        </h2>
        <p>
          Deposits become vault shares, and the strategy supplies them to Blend Capital v2. Interest
          comes from borrowers, and BLND rewards are harvested on-chain rather than simulated in the
          interface.
        </p>
      </div>

      <ol className="vf-path">
        {PATH.map((stage, i) => (
          <li className="vf-path__stage" key={stage.name}>
            <span className="vf-path__index" aria-hidden="true">
              {String(i + 1).padStart(2, '0')}
            </span>
            <strong>{stage.name}</strong>
            <span className="vf-path__detail">{stage.detail}</span>
          </li>
        ))}
      </ol>
      <div className="vf-path__rail" aria-hidden="true">
        <span className="vf-path__line" />
        <span className="vf-path__token" />
      </div>

      <div className="vf-yield__grid">
        <div className="vf-yield__live">
          <dl className="vf-readout vf-readout--two" aria-live="polite">
            <div>
              <dt>Blend USDC supply APR</dt>
              <dd data-testid="yield-apr" ref={aprRef}>
                {formatApr(stats.aprBps)}
              </dd>
            </div>
            <div>
              <dt>Vault TVL</dt>
              <dd data-testid="yield-tvl" ref={tvlRef}>
                {formatTvl(stats.totalAssets)}
              </dd>
            </div>
          </dl>
          <p className="vf-stamp" data-status={stats.status}>
            {STAMP[stats.status]}
          </p>
          <p className="vf-caption">
            APR is the pool&apos;s current supply rate and changes with utilisation. TVL is testnet
            USDC held by the vault.
          </p>
        </div>

        <dl className="vf-facts">
          {FACTS.map(([term, value]) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}
