import { useRef, useState } from 'react'
import { MOTION, countUp, gsap, useGSAP, scrollerOf } from '../motion/gsap.js'
import './leash.css'

const BOUNDS = [
  {
    title: 'Budget',
    copy: 'A SEP-41 allowance caps the total the router can ever pull for your workers.',
  },
  {
    title: 'One vault',
    copy: 'Each worker is deployed for one approved vault. Its session key cannot redirect a deposit.',
  },
  {
    title: 'Expiry',
    copy: 'Agent scope and token allowance stop working at their on-chain expiry.',
  },
  {
    title: 'Revoke',
    copy: 'Set the router allowance to zero from your wallet and the leash closes.',
  },
]

const ALSO = [
  'Vault upgrades are announced three days ahead and need a 2-of-3 multisig.',
  'The funding router has no admin.',
  'Deployed agent accounts are immutable.',
]

const BUDGET = 500

function leashMotion(root) {
  const scroller = scrollerOf(root)
  const q = gsap.utils.selector(root)
  const frame = q('.vf-leash__frame')[0]
  gsap.from(q('.vf-leash__head .vf-line > span'), {
    yPercent: 105,
    duration: 1,
    stagger: 0.08,
    ease: 'expo.out',
    scrollTrigger: { scroller, trigger: root, start: 'top 80%', once: true },
  })
  gsap.fromTo(
    q('.vf-leash__fence rect'),
    { strokeDashoffset: 1 },
    {
      strokeDashoffset: 0,
      ease: 'none',
      scrollTrigger: { scroller, trigger: frame, start: 'top 85%', end: 'center 55%', scrub: true },
    }
  )
  gsap.from(q('.vf-bound'), {
    opacity: 0,
    y: 24,
    duration: 0.8,
    stagger: 0.08,
    ease: 'expo.out',
    scrollTrigger: { scroller, trigger: frame, start: 'top 75%', once: true },
  })
}

export default function Leash() {
  const root = useRef(null)
  const allowanceRef = useRef(null)
  const mounted = useRef(false)
  const counting = useRef(null)
  const [revoked, setRevoked] = useState(false)
  const allowance = revoked ? 0 : BUDGET

  useGSAP(
    () => {
      const mm = gsap.matchMedia()
      mm.add(MOTION, () => leashMotion(root.current))
    },
    { scope: root }
  )

  useGSAP(
    () => {
      if (!mounted.current) {
        mounted.current = true
        return
      }
      // A second click mid-count must stop the first count, or both write the same text node.
      counting.current?.kill()
      counting.current = null
      if (!window.matchMedia(MOTION).matches) return
      counting.current = countUp(allowanceRef.current, allowance, (v) => `${Math.round(v)} USDC`, {
        from: BUDGET - allowance,
        duration: 0.6,
      })
    },
    { dependencies: [revoked], scope: root }
  )

  return (
    <section
      className="vf-section vf-leash"
      data-landing-section="Leash"
      aria-labelledby="leash-title"
      ref={root}
    >
      <div className="vf-section-head vf-leash__head">
        <p className="vf-kicker">04 · The leash</p>
        <h2 id="leash-title">
          <span className="vf-line">
            <span>Autonomy </span>
          </span>
          <span className="vf-line">
            <span>on a leash.</span>
          </span>
        </h2>
        <p>AI proposes. Soroban enforces. The limits live in contracts, not in a prompt.</p>
      </div>

      <div className="vf-leash__body">
        <div className="vf-leash__frame">
          <svg className="vf-leash__fence" aria-hidden="true" focusable="false">
            <rect pathLength="1" />
          </svg>
          <ul className="vf-leash__bounds">
            {BOUNDS.map((bound, i) => (
              <li className="vf-bound" key={bound.title}>
                <span className="vf-bound__num" aria-hidden="true">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <h3>{bound.title}</h3>
                <p>{bound.copy}</p>
              </li>
            ))}
          </ul>
        </div>

        <aside
          className="vf-revoke"
          data-state={revoked ? 'closed' : 'open'}
          aria-labelledby="revoke-title"
        >
          <header className="vf-revoke__head">
            <h3 id="revoke-title">Try the kill switch</h3>
            <span className="vf-revoke__badge">Demo</span>
          </header>
          <svg className="vf-gate" viewBox="0 0 200 72" aria-hidden="true" focusable="false">
            <rect className="vf-gate__post" x="14" y="18" width="8" height="46" rx="2" />
            <rect className="vf-gate__post" x="118" y="18" width="8" height="46" rx="2" />
            <line className="vf-gate__bar" x1="22" y1="30" x2="118" y2="30" />
            <circle className="vf-gate__crew" cx="150" cy="44" r="6" />
            <circle className="vf-gate__crew" cx="172" cy="44" r="6" />
          </svg>
          <dl className="vf-revoke__read">
            <div>
              <dt>Router allowance</dt>
              <dd data-testid="leash-allowance" ref={allowanceRef}>
                {`${allowance} USDC`}
              </dd>
            </div>
            <div>
              <dt>Leash</dt>
              <dd>
                {revoked ? 'Closed · nothing can be pulled' : 'Open · workers pull within budget'}
              </dd>
            </div>
          </dl>
          <code className="vf-revoke__call">{`approve(router, ${allowance})`}</code>
          <button
            type="button"
            className="vf-button vf-button--ghost vf-revoke__toggle"
            aria-pressed={revoked}
            onClick={() => setRevoked((value) => !value)}
          >
            Revoke (demo)
          </button>
          <p className="vf-caption">Demo only. No transaction is sent.</p>
        </aside>
      </div>

      <ul className="vf-leash__also" aria-label="Also enforced">
        {ALSO.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  )
}
