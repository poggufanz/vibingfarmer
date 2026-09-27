import { useRef } from 'react'
import { MOTION, gsap, useGSAP, useScroller } from '../motion/gsap.js'
import FieldArt, { FIELD_FILL, PLOT_WIDTH } from './FieldArt.jsx'
import './vibe-forever.css'

const BEATS = [
  {
    id: 'fund',
    title: 'Workers fund themselves',
    copy: 'Each worker pulls only its share of the budget. One failure does not stop the others.',
  },
  {
    id: 'earn',
    title: 'Deposits start earning',
    copy: 'Capital enters the vault and is supplied to Blend, where it earns lending interest.',
  },
  {
    id: 'compound',
    title: 'The keeper compounds',
    copy: 'Every 15 minutes a separate keeper harvests and re-supplies, within contract caps.',
  },
  {
    id: 'watch',
    title: 'Lifeboat keeps watch',
    copy: 'The radar reads the market on every ledger, about every 6 seconds.',
  },
  {
    id: 'derisk',
    title: 'Stress? It de-risks',
    copy: 'Lifeboat moves funds to vault-idle, only under your mandate. Without one it alarms and waits.',
  },
  {
    id: 'resume',
    title: 'Then it resumes',
    copy: 'Conditions clear and supply resumes. Thirty days in, you have still signed once.',
  },
]

// Grant bay centre, measured in the stage viewBox, relative to each crew's row head.
const GRANT_DX = -144
const grantDy = (i) => 220 - (96 + i * 84)
const FAILED = 2

function beatSwap(tl, beats, ticks, i, at) {
  tl.to(beats[i - 1], { opacity: 0, y: -16, duration: 0.4 }, at)
    .fromTo(beats[i], { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.4 }, `${at}+=0.2`)
    .to(ticks[i - 1], { opacity: 0.3, duration: 0.2 }, at)
    .to(ticks[i], { opacity: 1, duration: 0.2 }, at)
}

function scrubStage(root, scroller) {
  const q = gsap.utils.selector(root)
  const beats = q('.vf-beat')
  const ticks = q('.vf-vibe__ticks li')
  const day = q('.vf-vibe__day')[0]
  const crews = q('.vf-field__crew')
  const fills = q('.vf-field__fill')
  const live = fills.filter((_, i) => i !== FAILED)
  const liveWidth = (i) => PLOT_WIDTH * FIELD_FILL[i >= FAILED ? i + 1 : i]
  const warn = getComputedStyle(root).getPropertyValue('--pc-warning').trim() || '#e8a33d'
  const ink = getComputedStyle(root).getPropertyValue('--pc-ink').trim() || '#f2f5ef'

  root.classList.add('is-scrubbed')
  gsap.set(beats.slice(1), { opacity: 0 })
  gsap.set(ticks.slice(1), { opacity: 0.3 })
  gsap.set(crews, { x: GRANT_DX, y: (i) => grantDy(i) })
  gsap.set(fills, { attr: { width: 0 } })

  const tl = gsap.timeline({
    defaults: { ease: 'power2.inOut' },
    scrollTrigger: {
      scroller,
      trigger: q('.vf-vibe__stage')[0],
      pin: true,
      start: 'top top',
      end: '+=300%',
      scrub: 0.8,
      snap: { snapTo: 'labels', duration: { min: 0.2, max: 0.8 }, ease: 'power1.inOut' },
      onUpdate: (self) => {
        day.textContent = String(Math.round(1 + self.progress * 29)).padStart(2, '0')
      },
    },
  })

  tl.addLabel('fund')
    .to(crews, { x: 0, y: 0, duration: 1, stagger: 0.1 }, 'fund')
    .to(crews[FAILED], { opacity: 0.35, duration: 0.3 }, 'fund+=0.9')
    .to(q('.vf-field__fail'), { opacity: 1, duration: 0.3 }, 'fund+=0.9')
    .addLabel('earn', '+=0.4')
  beatSwap(tl, beats, ticks, 1, 'earn')
  tl.to(
    live,
    { attr: { width: (i) => liveWidth(i) * 0.9 }, duration: 1.1, stagger: 0.08 },
    'earn'
  ).addLabel('compound', '+=0.4')
  beatSwap(tl, beats, ticks, 2, 'compound')
  tl.fromTo(
    q('.vf-field__sweep'),
    { opacity: 1, x: 0 },
    { x: PLOT_WIDTH, duration: 1, ease: 'none' },
    'compound'
  )
    .to(q('.vf-field__sweep'), { opacity: 0, duration: 0.2 }, '>')
    .to(live, { attr: { width: (i) => liveWidth(i) }, duration: 0.8 }, 'compound+=0.4')
    .addLabel('watch', '+=0.4')
  beatSwap(tl, beats, ticks, 3, 'watch')
  tl.fromTo(
    q('.vf-field__radar'),
    { attr: { r: 0 }, opacity: 0.7 },
    { attr: { r: 260 }, opacity: 0, duration: 0.9, ease: 'power1.out', repeat: 1 },
    'watch'
  ).addLabel('derisk', '+=0.4')
  beatSwap(tl, beats, ticks, 4, 'derisk')
  tl.to(q('.vf-field__fence'), { stroke: warn, duration: 0.3 }, 'derisk')
    .to(live, { attr: { width: 0 }, duration: 0.9 }, 'derisk+=0.2')
    .to(
      q('.vf-field__idle .vf-field__bay-value:not(.vf-field__bay-alt)'),
      { opacity: 0 },
      'derisk+=0.5'
    )
    .to(q('.vf-field__bay-alt'), { opacity: 1 }, 'derisk+=0.5')
    .addLabel('resume', '+=0.4')
  beatSwap(tl, beats, ticks, 5, 'resume')
  tl.to(q('.vf-field__fence'), { stroke: ink, duration: 0.3 }, 'resume')
    .to(q('.vf-field__bay-alt'), { opacity: 0 }, 'resume')
    .to(q('.vf-field__idle .vf-field__bay-value:not(.vf-field__bay-alt)'), { opacity: 1 }, 'resume')
    .to(live, { attr: { width: (i) => liveWidth(i) }, duration: 0.9, stagger: 0.06 }, 'resume+=0.2')
    .addLabel('end', '+=0.3')

  return () => root.classList.remove('is-scrubbed')
}

function revealList(root, scroller) {
  const q = gsap.utils.selector(root)
  gsap.from(q('.vf-beat'), {
    opacity: 0,
    y: 24,
    duration: 0.8,
    stagger: 0.08,
    ease: 'expo.out',
    scrollTrigger: { scroller, trigger: q('.vf-beats')[0], start: 'top 85%', once: true },
  })
}

export default function VibeForever() {
  const root = useRef(null)
  const scroller = useScroller()

  useGSAP(
    () => {
      const mm = gsap.matchMedia()
      mm.add(MOTION, (ctx) => {
        const { motion, desktop } = ctx.conditions
        if (!motion) return undefined
        gsap.from(gsap.utils.toArray('.vf-vibe__head .vf-line > span', root.current), {
          yPercent: 105,
          duration: 1,
          stagger: 0.08,
          ease: 'expo.out',
          scrollTrigger: {
            scroller: scroller.current,
            trigger: root.current,
            start: 'top 80%',
            once: true,
          },
        })
        if (desktop) return scrubStage(root.current, scroller.current)
        revealList(root.current, scroller.current)
        return undefined
      })
    },
    { scope: root }
  )

  return (
    <section
      className="vf-section vf-vibe"
      data-landing-section="VibeForever"
      aria-labelledby="vibe-title"
      ref={root}
    >
      <div className="vf-section-head vf-vibe__head">
        <p className="vf-kicker">02 · Vibe forever</p>
        <h2 id="vibe-title">
          <span className="vf-line">
            <span>Then it runs </span>
          </span>
          <span className="vf-line">
            <span>without you.</span>
          </span>
        </h2>
        <p>
          After the grant, workers, the keeper and Lifeboat carry the position. Scroll through
          thirty days of one run.
        </p>
      </div>

      <div className="vf-vibe__stage">
        <div className="vf-vibe__hud" aria-hidden="true">
          <div>
            <span>Day</span>
            <strong className="vf-vibe__day">30</strong>
          </div>
          <div>
            <span>Your signatures</span>
            <strong className="vf-vibe__sigs">1</strong>
          </div>
          <ol className="vf-vibe__ticks">
            {BEATS.map((beat) => (
              <li key={beat.id} />
            ))}
          </ol>
        </div>

        <figure className="vf-vibe__art">
          <FieldArt variant="stage" />
          <figcaption className="vf-caption">
            Illustration of the run lifecycle — not live data.
          </figcaption>
        </figure>

        <ol className="vf-beats">
          {BEATS.map((beat, i) => (
            <li className="vf-beat" data-beat={beat.id} key={beat.id}>
              <span className="vf-beat__num" aria-hidden="true">
                {String(i + 1).padStart(2, '0')}
              </span>
              <h3>{beat.title}</h3>
              <p>{beat.copy}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}
