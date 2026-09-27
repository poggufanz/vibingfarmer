import { useRef } from 'react'
import { MOTION, gsap, useGSAP, useScroller } from '../motion/gsap.js'
import './set-once.css'

const INTENT = [
  ['Amount', '500 USDC'],
  ['Risk', 'Balanced'],
  ['Workers', '4'],
  ['Grant', '30 days'],
]

const REVIEW = [
  {
    title: 'Strategist',
    copy: 'Proposes an allocation from live context, and falls back to a deterministic split if no AI provider answers.',
  },
  {
    title: 'Council',
    copy: 'Specialist seats debate the plan. The risk seat holds a hard veto.',
  },
  {
    title: 'Eligibility gate',
    copy: 'Missing or stale protocol facts reject a target instead of passing it.',
  },
  {
    title: 'You approve',
    copy: 'Review and edit every worker skill. Nothing moves before you sign.',
  },
]

const GLYPHS = Array.from({ length: 8 }, (_, i) => i)
const SIGNATURE_GLYPH =
  'M3 17C7 6 10 5 11 11C12 17 9 21 12 18C16 14 18 6 22 8C25 10 22 17 26 15C29 13 30 9 33 10'

function setOnceMotion(root, scroller) {
  const q = gsap.utils.selector(root)
  const reveal = (targets, vars, trigger = root) =>
    gsap.from(targets, {
      ...vars,
      ease: 'expo.out',
      scrollTrigger: { scroller, trigger, start: 'top 80%', once: true },
    })

  reveal(q('.vf-set__head .vf-line > span'), { yPercent: 105, duration: 1, stagger: 0.08 })
  reveal(q('.vf-intent'), { opacity: 0, y: 40, duration: 1 }, q('.vf-intent')[0])
  reveal(
    q('.vf-review__line'),
    { scaleX: 0, transformOrigin: 'left center', duration: 1.2 },
    q('.vf-review')[0]
  )
  reveal(
    q('.vf-review__step'),
    { opacity: 0, y: 24, duration: 0.8, stagger: 0.1 },
    q('.vf-review')[0]
  )

  const glyphs = q('.vf-sigs__glyph')
  const first = glyphs[0]
  gsap
    .timeline({
      scrollTrigger: {
        scroller,
        trigger: q('.vf-sigs')[0],
        start: 'top 75%',
        end: 'bottom 40%',
        scrub: 0.6,
      },
    })
    .to(glyphs.slice(1), {
      x: (i, glyph) => first.offsetLeft - glyph.offsetLeft,
      opacity: 0,
      ease: 'power2.in',
      stagger: 0.04,
    })
    .to(q('.vf-sigs__before'), { opacity: 0.35 }, '<')
    .fromTo(q('.vf-sigs__after'), { opacity: 0.35 }, { opacity: 1 }, '<0.2')
    .fromTo(
      first,
      { scale: 1 },
      { scale: 1.25, transformOrigin: '50% 50%', ease: 'back.out(3)' },
      '>-0.1'
    )
}

export default function SetOnce() {
  const root = useRef(null)
  const scroller = useScroller()

  useGSAP(
    () => {
      const mm = gsap.matchMedia()
      mm.add(MOTION, (ctx) => {
        if (ctx.conditions.motion) setOnceMotion(root.current, scroller.current)
      })
    },
    { scope: root }
  )

  return (
    <section
      className="vf-section vf-set"
      id="how-it-works"
      data-landing-section="SetOnce"
      aria-labelledby="set-title"
      ref={root}
    >
      <div className="vf-set__top">
        <div className="vf-section-head vf-set__head">
          <p className="vf-kicker">01 · Set once</p>
          <h2 id="set-title">
            <span className="vf-line">
              <span>One decision. </span>
            </span>
            <span className="vf-line">
              <span>Made properly.</span>
            </span>
          </h2>
          <p>
            You make the only call that needs a human: how much, how careful, how many workers.
            Everything the AI proposes is reviewed before any capital moves.
          </p>
        </div>

        <article className="vf-intent" aria-label="Example intent">
          <header className="vf-intent__head">
            <span>Your intent</span>
            <span className="vf-intent__badge">Example</span>
          </header>
          <dl className="vf-intent__rows">
            {INTENT.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <footer className="vf-intent__foot">
            <span>One wallet signature</span>
            <code>funding_router.grant</code>
          </footer>
        </article>
      </div>

      <div className="vf-review">
        <span className="vf-review__line" aria-hidden="true" />
        <ol className="vf-review__steps">
          {REVIEW.map((step, i) => (
            <li className="vf-review__step" key={step.title}>
              <span className="vf-review__num" aria-hidden="true">
                {String(i + 1).padStart(2, '0')}
              </span>
              <h3>{step.title}</h3>
              <p>{step.copy}</p>
            </li>
          ))}
        </ol>
      </div>

      <div className="vf-sigs">
        <p className="vf-sigs__label vf-sigs__before">Manual cycle: 8+ signatures</p>
        <div className="vf-sigs__row" aria-hidden="true">
          {GLYPHS.map((i) => (
            <svg className="vf-sigs__glyph" viewBox="0 0 36 24" key={i}>
              <path d={SIGNATURE_GLYPH} />
            </svg>
          ))}
        </div>
        <p className="vf-sigs__label vf-sigs__after">Vibing Farmer: 1 to start · 0 to repeat</p>
      </div>
    </section>
  )
}
