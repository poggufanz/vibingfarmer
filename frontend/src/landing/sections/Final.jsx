import { useRef } from 'react'
import { MOTION, gsap, playWhileVisible, useGSAP, scrollerOf } from '../motion/gsap.js'
import { ECOSYSTEM } from '../ecosystem.js'
import './final.css'

const LINKS = [
  ['GitHub', 'https://github.com/poggufanz/vibingfarmer'],
  ['Docs', 'https://vibingfarmer.gitbook.io/vibingfarmer/'],
  ['Whitepaper', '/vibing-farmer-whitepaper.pdf'],
  ['Security', 'https://github.com/poggufanz/vibingfarmer/blob/main/SECURITY.md'],
]

function finalMotion(root) {
  const scroller = scrollerOf(root)
  const q = gsap.utils.selector(root)
  const once = { scroller, trigger: root, start: 'top 75%', once: true }
  gsap.from(q('.vf-final__title .vf-line > span'), {
    yPercent: 105,
    duration: 1.2,
    stagger: 0.1,
    ease: 'expo.out',
    scrollTrigger: once,
  })
  gsap.from(q('.vf-final__copy > *'), {
    opacity: 0,
    y: 16,
    duration: 0.8,
    stagger: 0.08,
    delay: 0.3,
    ease: 'expo.out',
    scrollTrigger: once,
  })

  // The ecosystem band drifts only while it is on screen: two passes per viewing.
  const drift = gsap.to(q('.vf-marquee__track'), {
    xPercent: -50,
    duration: 36,
    ease: 'none',
    repeat: 1,
    paused: true,
  })
  playWhileVisible(drift, { scroller, trigger: q('.vf-marquee')[0] }).start()
}

function LogoSequence() {
  return (
    <span className="vf-marquee__seq">
      {ECOSYSTEM.map((item) => (
        <span className="vf-marquee__logo" key={item.name}>
          <img
            src={item.icon}
            alt=""
            loading="lazy"
            className={item.iconDark ? 'vf-marquee__icon--light-only' : undefined}
          />
          {item.iconDark && (
            <img
              src={item.iconDark}
              alt=""
              loading="lazy"
              className="vf-marquee__icon--dark-only"
            />
          )}
          {item.name}
        </span>
      ))}
    </span>
  )
}

export default function Final({ onStart }) {
  const root = useRef(null)

  useGSAP(
    () => {
      const mm = gsap.matchMedia()
      mm.add(MOTION, () => finalMotion(root.current))
    },
    { scope: root }
  )

  return (
    <section
      className="vf-final"
      data-landing-section="Final"
      aria-labelledby="final-title"
      ref={root}
    >
      <div className="vf-final__inner">
        <h2 id="final-title" className="vf-final__title">
          <span className="vf-line">
            <span>Set once. </span>
          </span>
          <span className="vf-line vf-final__vibe">
            <span>Vibe forever.</span>
          </span>
        </h2>
        <div className="vf-final__copy">
          <p>Choose the budget, risk and workers. Review the plan. Sign once.</p>
          <button className="vf-button vf-button--primary" type="button" onClick={onStart}>
            Launch app
            <span className="vf-button__arrow" aria-hidden="true">
              →
            </span>
          </button>
        </div>
      </div>

      <div className="vf-final__built">
        <p className="vf-kicker">Built with</p>
        <ul className="vf-sr-only">
          {ECOSYSTEM.map((item) => (
            <li key={item.name}>{item.name}</li>
          ))}
        </ul>
        <div className="vf-marquee" aria-hidden="true">
          <div className="vf-marquee__track">
            <LogoSequence />
            <LogoSequence />
          </div>
        </div>
      </div>

      <footer className="vf-footer">
        <p>Vibing Farmer · testnet software</p>
        <ul>
          {LINKS.map(([label, href]) => (
            <li key={label}>
              <a className="vf-text-link" href={href} target="_blank" rel="noreferrer">
                {label}
              </a>
            </li>
          ))}
        </ul>
      </footer>
    </section>
  )
}
