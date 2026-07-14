// LandingFx — GSAP layer on top of the public landing page.
// Everything here is decorative and fail-open: reduced-motion users get none of
// it, touch devices skip the cursor/x-ray, and missing DOM targets are ignored.
import { useEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { Observer } from 'gsap/Observer'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { ScrambleTextPlugin } from 'gsap/ScrambleTextPlugin'
import { SplitText } from 'gsap/SplitText'

gsap.registerPlugin(useGSAP, Observer, ScrollTrigger, ScrambleTextPlugin, SplitText)

const SUB_TEXT = 'be ready for VIBING FARMER'

// ponytail: media checks read once per mount; live prefers-reduced-motion
// toggles mid-session re-apply on next landing mount.
function reducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : true
}

function finePointer() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: fine)').matches
    : false
}

// Full-screen black gate shown before the landing page. "READY OR NOT?"
// flickers like a broken neon sign; any scroll, click, or key collapses the
// overlay like a CRT powering off, revealing the page beneath.
function IntroGate({ rootRef }) {
  const [active, setActive] = useState(() => !reducedMotion())
  const overlayRef = useRef(null)
  const readyRef = useRef(null)
  const subRef = useRef(null)
  const doneRef = useRef(false)

  // Lock the landing scroller while the gate is up.
  useEffect(() => {
    const root = rootRef.current
    if (!active || !root) return undefined
    const prev = root.style.overflow
    root.style.overflow = 'hidden'
    return () => {
      root.style.overflow = prev
    }
  }, [active, rootRef])

  const { contextSafe } = useGSAP(
    () => {
      if (!active || !readyRef.current) return
      const split = SplitText.create(readyRef.current, {
        type: 'chars',
        charsClass: 'vf-intro__ch',
      })

      gsap
        .timeline({ defaults: { ease: 'power2.out' } })
        .set(subRef.current, { autoAlpha: 0 })
        .from(split.chars, {
          autoAlpha: 0,
          duration: 0.06,
          stagger: { each: 0.05, from: 'random' },
        })
        .to(subRef.current, { autoAlpha: 1, duration: 0.1 }, '-=0.2')
        .to(
          subRef.current,
          {
            duration: 1.2,
            scrambleText: { text: SUB_TEXT, chars: 'upperAndLowerCase', speed: 0.4 },
          },
          '<'
        )
        .from('.vf-intro__hint', { autoAlpha: 0, duration: 0.5 }, '-=0.5')

      // Broken-neon flicker: random characters dip irregularly, forever.
      const flicker = gsap.timeline({ repeat: -1, repeatDelay: 0.9, delay: 1.1 })
      split.chars.forEach((ch) => {
        if (Math.random() < 0.4) {
          flicker.to(
            ch,
            {
              opacity: gsap.utils.random(0.05, 0.4),
              duration: 0.07,
              repeat: 1,
              yoyo: true,
              ease: 'none',
            },
            gsap.utils.random(0, 1.4)
          )
        }
      })
      flicker.to(
        readyRef.current,
        { opacity: 0.72, duration: 0.05, repeat: 1, yoyo: true, ease: 'none' },
        gsap.utils.random(0.2, 1.2)
      )

      gsap.to('.vf-intro__hint', {
        y: 6,
        duration: 0.9,
        repeat: -1,
        yoyo: true,
        ease: 'sine.inOut',
      })
    },
    { scope: overlayRef, dependencies: [active] }
  )

  // Curtain exit: the user's scroll intent slides the gate up, bottom edge
  // glowing, while the headline lags behind for a parallax peel. The hero and
  // navbar re-enter underneath — their framer entrance already played while
  // hidden behind the gate, so without this the page would appear static.
  const dismiss = contextSafe(() => {
    if (doneRef.current || !overlayRef.current) return
    doneRef.current = true
    const overlay = overlayRef.current
    const root = rootRef.current
    const heroBits = root
      ? gsap.utils.toArray(
          '.vf-hero .vf-kicker, .vf-hero h1, .vf-hero__lede, .vf-hero__actions',
          root
        )
      : []
    const heroMedia = root?.querySelector('.vf-hero__media .vf-media')
    const navBar = root?.querySelector('.nv-bar')

    const tl = gsap
      .timeline({ onComplete: () => setActive(false) })
      .to('.vf-intro__flash', { autoAlpha: 1, duration: 0.12 })
      .to(overlay, { yPercent: -100, duration: 0.75, ease: 'power4.inOut' }, '<')
      .to('.vf-intro__center', { y: 140, duration: 0.75, ease: 'power4.inOut' }, '<')
      .to('.vf-intro__hint', { autoAlpha: 0, duration: 0.2 }, '<')
    if (heroBits.length) {
      tl.from(
        heroBits,
        { autoAlpha: 0, y: 34, duration: 0.6, ease: 'power3.out', stagger: 0.07 },
        '-=0.35'
      )
    }
    if (heroMedia) {
      tl.from(
        heroMedia,
        { autoAlpha: 0, y: 40, rotation: 1.5, duration: 0.7, ease: 'power3.out' },
        '<0.1'
      )
    }
    if (navBar) {
      tl.from(navBar, { autoAlpha: 0, yPercent: -100, duration: 0.5, ease: 'power3.out' }, '<')
    }
  })

  useEffect(() => {
    if (!active || !overlayRef.current) return undefined
    const obs = Observer.create({
      target: overlayRef.current,
      type: 'wheel,touch',
      tolerance: 6,
      onUp: dismiss,
      onDown: dismiss,
    })
    window.addEventListener('keydown', dismiss)
    return () => {
      obs.kill()
      window.removeEventListener('keydown', dismiss)
    }
  }, [active, dismiss])

  if (!active) return null
  return (
    <section className="vf-intro" ref={overlayRef} aria-label="Welcome" onClick={dismiss}>
      <div className="vf-intro__grid" aria-hidden="true" />
      <div className="vf-intro__scanlines" aria-hidden="true" />
      <div className="vf-intro__center">
        <p className="vf-intro__ready" ref={readyRef}>
          READY OR NOT?
        </p>
        <p className="vf-intro__sub" aria-label={SUB_TEXT}>
          <span aria-hidden="true" ref={subRef}>
            {SUB_TEXT}
          </span>
        </p>
      </div>
      <p className="vf-intro__hint" aria-hidden="true">
        scroll to enter
      </p>
      <div className="vf-intro__flash" aria-hidden="true" />
    </section>
  )
}

// Round cursor: fast dot + lagging ring in blend-difference. Over the hero it
// becomes an x-ray lens that unmasks the schematic layer underneath.
function Cursor({ rootRef }) {
  const wrapRef = useRef(null)
  const dotRef = useRef(null)
  const ringRef = useRef(null)

  useGSAP(
    () => {
      if (reducedMotion() || !finePointer()) return undefined
      const root = rootRef.current
      const wrap = wrapRef.current
      if (!root || !wrap) return undefined

      root.classList.add('vf-no-cursor')
      gsap.set([dotRef.current, ringRef.current], {
        xPercent: -50,
        yPercent: -50,
        x: -200,
        y: -200,
      })

      const dotX = gsap.quickTo(dotRef.current, 'x', { duration: 0.12, ease: 'power3.out' })
      const dotY = gsap.quickTo(dotRef.current, 'y', { duration: 0.12, ease: 'power3.out' })
      const ringX = gsap.quickTo(ringRef.current, 'x', { duration: 0.5, ease: 'power3.out' })
      const ringY = gsap.quickTo(ringRef.current, 'y', { duration: 0.5, ease: 'power3.out' })

      let shown = false
      const onMove = (e) => {
        if (!shown) {
          shown = true
          gsap.to(wrap, { autoAlpha: 1, duration: 0.2 })
        }
        dotX(e.clientX)
        dotY(e.clientY)
        ringX(e.clientX)
        ringY(e.clientY)
      }
      const sync = (e) => {
        const t = e.target instanceof Element ? e.target : null
        const hot = t?.closest('a, button')
        const xray = t?.closest('[data-xray]')
        wrap.classList.toggle('is-xray', !!xray && !hot)
        gsap.to(ringRef.current, {
          scale: hot ? 2 : xray ? 2.6 : 1,
          duration: 0.25,
          ease: 'power2.out',
          overwrite: 'auto',
        })
      }
      const onDown = () => gsap.to(dotRef.current, { scale: 0.5, duration: 0.15 })
      const onUp = () => gsap.to(dotRef.current, { scale: 1, duration: 0.2 })
      const onLeave = () => {
        shown = false
        gsap.to(wrap, { autoAlpha: 0, duration: 0.25 })
      }

      window.addEventListener('pointermove', onMove, { passive: true })
      root.addEventListener('pointerover', sync)
      window.addEventListener('pointerdown', onDown)
      window.addEventListener('pointerup', onUp)
      document.documentElement.addEventListener('pointerleave', onLeave)

      // X-ray lens: follow the pointer with CSS vars driving a radial mask.
      const xr = root.querySelector('.vf-hero__xray')
      const hero = xr?.closest('[data-xray]')
      let unbindXray
      if (xr && hero) {
        gsap.set(xr, { '--xr-x': '0px', '--xr-y': '0px', '--xr-r': '0px' })
        const xrX = gsap.quickTo(xr, '--xr-x', { duration: 0.16, ease: 'power2.out' })
        const xrY = gsap.quickTo(xr, '--xr-y', { duration: 0.16, ease: 'power2.out' })
        const move = (e) => {
          const r = hero.getBoundingClientRect()
          xrX(e.clientX - r.left)
          xrY(e.clientY - r.top)
        }
        const enter = () => gsap.to(xr, { '--xr-r': '96px', duration: 0.45, ease: 'power3.out' })
        const leave = () => gsap.to(xr, { '--xr-r': '0px', duration: 0.35, ease: 'power3.in' })
        hero.addEventListener('pointermove', move, { passive: true })
        hero.addEventListener('pointerenter', enter)
        hero.addEventListener('pointerleave', leave)
        unbindXray = () => {
          hero.removeEventListener('pointermove', move)
          hero.removeEventListener('pointerenter', enter)
          hero.removeEventListener('pointerleave', leave)
        }
      }

      return () => {
        root.classList.remove('vf-no-cursor')
        window.removeEventListener('pointermove', onMove)
        root.removeEventListener('pointerover', sync)
        window.removeEventListener('pointerdown', onDown)
        window.removeEventListener('pointerup', onUp)
        document.documentElement.removeEventListener('pointerleave', onLeave)
        unbindXray?.()
      }
    },
    { scope: wrapRef }
  )

  return (
    <div className="vf-cursor" ref={wrapRef} aria-hidden="true">
      <div className="vf-cursor__ring" ref={ringRef} />
      <div className="vf-cursor__dot" ref={dotRef} />
    </div>
  )
}

export default function LandingFx({ rootRef }) {
  const barRef = useRef(null)

  // Scroll-driven accents. `.vf-landing` is the scroll container (fixed +
  // overflow-y auto), so every ScrollTrigger must name it as scroller.
  useGSAP(
    () => {
      if (reducedMotion()) return
      const root = rootRef.current
      if (!root) return
      const scroller = root

      const main = root.querySelector('main')
      if (barRef.current && main) {
        gsap.fromTo(
          barRef.current,
          { scaleX: 0 },
          {
            scaleX: 1,
            ease: 'none',
            scrollTrigger: {
              scroller,
              trigger: main,
              start: 'top top',
              end: 'bottom bottom',
              scrub: 0.3,
            },
          }
        )
      }

      gsap.utils.toArray('.vf-proof__item strong', root).forEach((el) => {
        gsap.to(el, {
          duration: 1.1,
          scrambleText: { text: el.textContent, chars: '01▮▯/', speed: 0.4 },
          scrollTrigger: { scroller, trigger: el, start: 'top 88%', once: true },
        })
      })

      // Flow rows stay visible at all times — the accent line + .is-active
      // highlight (below) carry the scroll story.
      const rows = gsap.utils.toArray('.vf-flow__row', root)

      // Problem section: the "typical flow" column decays while the Vibing
      // Farmer column lifts with an accent glow — the contrast, literally.
      const contrast = root.querySelector('.vf-contrast')
      const oldWay = root.querySelector('.vf-contrast__column:not(.vf-contrast__column--vf)')
      const newWay = root.querySelector('.vf-contrast__column--vf')
      if (contrast && oldWay && newWay) {
        const contrastST = {
          scroller,
          trigger: contrast,
          start: 'top 75%',
          end: 'top 35%',
          scrub: 0.5,
        }
        gsap.to(oldWay, { opacity: 0.4, filter: 'grayscale(1)', scrollTrigger: contrastST })
        gsap.to(newWay, {
          y: -8,
          boxShadow: '0 0 0 1px rgba(207, 255, 61, 0.45), 0 18px 60px rgba(207, 255, 61, 0.08)',
          scrollTrigger: { ...contrastST },
        })
      }

      // Flow section: an accent line draws down the list; each step lights up
      // (CSS .is-active) while the playhead passes it.
      if (rows.length) {
        const line = root.querySelector('.vf-flow__line')
        if (line) {
          gsap.fromTo(
            line,
            { scaleY: 0 },
            {
              scaleY: 1,
              ease: 'none',
              scrollTrigger: {
                scroller,
                trigger: rows[0].parentElement,
                start: 'top 65%',
                end: 'bottom 55%',
                scrub: 0.4,
              },
            }
          )
        }
        // Arm the dim-until-seen state only when JS runs; rows rise in via CSS
        // transitions (.is-seen sticks, .is-active follows the playhead), so a
        // failed trigger degrades to "dim but readable", never blank.
        rows[0]?.parentElement?.classList.add('vf-flow--armed')
        rows.forEach((row) => {
          ScrollTrigger.create({
            scroller,
            trigger: row,
            start: 'top 62%',
            end: 'bottom 40%',
            toggleClass: { targets: row, className: 'is-active' },
            onEnter: () => row.classList.add('is-seen'),
          })
        })
      }

      // Bounds section: the leash made visible — a line draws itself around
      // the four boundary cards as you scroll (rect pathLength trick, no
      // measurement needed, jsdom-safe).
      const leashRect = root.querySelector('.vf-bounds__leash rect')
      const boundsWrap = root.querySelector('.vf-bounds__wrap')
      if (leashRect && boundsWrap) {
        gsap.to(leashRect, {
          strokeDashoffset: 0,
          ease: 'none',
          scrollTrigger: {
            scroller,
            trigger: boundsWrap,
            start: 'top 80%',
            end: 'bottom 70%',
            scrub: 0.5,
          },
        })
      }
      const bounds = gsap.utils.toArray('.vf-bound', root)
      if (bounds.length) {
        gsap.from(bounds, {
          autoAlpha: 0,
          y: 30,
          scale: 0.96,
          duration: 0.6,
          ease: 'power3.out',
          stagger: 0.1,
          scrollTrigger: {
            scroller,
            trigger: bounds[0].parentElement,
            start: 'top 80%',
            once: true,
          },
        })
      }

      // Intelligence: decision layers file in one by one — proposal passing
      // through the strategist, council, gate, simulation.
      const stack = gsap.utils.toArray('.vf-decision-stack > div', root)
      if (stack.length) {
        gsap.from(stack, {
          autoAlpha: 0,
          x: -28,
          duration: 0.5,
          ease: 'power3.out',
          stagger: 0.12,
          scrollTrigger: {
            scroller,
            trigger: stack[0].parentElement,
            start: 'top 80%',
            once: true,
          },
        })
      }

      // Yield: capital "packets" stream along the capital path while it is on
      // screen; paused off screen so they cost nothing.
      const flowWrap = root.querySelector('.vf-capital-flow')
      if (flowWrap) {
        const dots = gsap.utils.toArray('span', flowWrap)
        gsap.set(dots, { autoAlpha: 1 })
        const dotTweens = dots.map((dot, i) =>
          gsap.fromTo(
            dot,
            { x: 0 },
            {
              x: () => flowWrap.clientWidth,
              duration: 2.4,
              ease: 'none',
              repeat: -1,
              delay: i * 0.8,
              paused: true,
            }
          )
        )
        ScrollTrigger.create({
          scroller,
          trigger: flowWrap,
          start: 'top 92%',
          end: 'bottom 8%',
          onToggle: (self) => dotTweens.forEach((t) => (self.isActive ? t.play() : t.pause())),
        })
      }

      // Lifeboat card gets a radar sweep (pure CSS animation, class-gated so
      // it only runs while visible).
      const lifeboat = root.querySelector('.vf-operation--lifeboat')
      if (lifeboat) {
        ScrollTrigger.create({
          scroller,
          trigger: lifeboat,
          start: 'top 90%',
          end: 'bottom 10%',
          toggleClass: { targets: lifeboat, className: 'is-live' },
        })
      }

      // Relay: "0 XLM" arrives like the intro headline — characters blink in
      // randomly, then keep the broken-neon flicker while on screen. The ping
      // ring (CSS .is-hit) fires once the entrance finishes.
      const relayNum = root.querySelector('.vf-relay__number strong')
      if (relayNum) {
        const relaySplit = SplitText.create(relayNum, { type: 'chars' })
        gsap.from(relaySplit.chars, {
          autoAlpha: 0,
          duration: 0.06,
          stagger: { each: 0.09, from: 'random' },
          scrollTrigger: { scroller, trigger: relayNum, start: 'top 82%', once: true },
          onComplete: () => relayNum.parentElement?.classList.add('is-hit'),
        })
        const relayFlicker = gsap.timeline({ repeat: -1, repeatDelay: 1.1, paused: true })
        relaySplit.chars.forEach((ch) => {
          if (Math.random() < 0.6) {
            relayFlicker.to(
              ch,
              {
                opacity: gsap.utils.random(0.15, 0.5),
                duration: 0.08,
                repeat: 1,
                yoyo: true,
                ease: 'none',
              },
              gsap.utils.random(0, 1.2)
            )
          }
        })
        ScrollTrigger.create({
          scroller,
          trigger: relayNum,
          start: 'top 95%',
          end: 'bottom 5%',
          onToggle: (self) => (self.isActive ? relayFlicker.play() : relayFlicker.pause()),
        })
      }

      // Observability facts + honesty groups: quiet staggered reveals.
      const facts = gsap.utils.toArray('.vf-observe__facts > div', root)
      if (facts.length) {
        gsap.from(facts, {
          autoAlpha: 0,
          y: 24,
          duration: 0.5,
          ease: 'power3.out',
          stagger: 0.12,
          scrollTrigger: {
            scroller,
            trigger: facts[0].parentElement,
            start: 'top 82%',
            once: true,
          },
        })
      }
      const groups = gsap.utils.toArray('.vf-honesty__group', root)
      if (groups.length) {
        gsap.from(groups, {
          autoAlpha: 0,
          y: 28,
          rotation: 1.2,
          transformOrigin: 'left bottom',
          duration: 0.55,
          ease: 'power3.out',
          stagger: 0.12,
          scrollTrigger: {
            scroller,
            trigger: groups[0].parentElement,
            start: 'top 82%',
            once: true,
          },
        })
      }

      // Marquee band: endless outline-text loop, paused while off screen.
      const marqueeTrack = root.querySelector('.vf-marquee__track')
      if (marqueeTrack) {
        const marqueeLoop = gsap.to(marqueeTrack, {
          xPercent: -50,
          ease: 'none',
          duration: 22,
          repeat: -1,
          paused: true,
        })
        ScrollTrigger.create({
          scroller,
          trigger: marqueeTrack.parentElement,
          start: 'top bottom',
          end: 'bottom top',
          onToggle: (self) => (self.isActive ? marqueeLoop.play() : marqueeLoop.pause()),
        })
      }

      // Parallax the inner figure, not `.vf-hero__media` — framer-motion owns
      // that wrapper's transform during the entrance animation.
      const media = root.querySelector('.vf-hero__media .vf-media')
      const hero = root.querySelector('.vf-hero')
      if (media && hero) {
        gsap.to(media, {
          y: -40,
          ease: 'none',
          scrollTrigger: {
            scroller,
            trigger: hero,
            start: 'top top',
            end: 'bottom top',
            scrub: 0.5,
          },
        })
      }

      const tagline = root.querySelector('.vf-final__tagline')
      if (tagline) {
        const split = SplitText.create(tagline, { type: 'chars' })
        gsap.from(split.chars, {
          yPercent: 130,
          autoAlpha: 0,
          rotation: 8,
          duration: 0.55,
          ease: 'back.out(1.7)',
          stagger: 0.03,
          scrollTrigger: { scroller, trigger: tagline, start: 'top 88%', once: true },
        })
      }

      // Magnetic CTAs: buttons lean toward the cursor and snap back, the
      // label scrambles on hover, press squishes. Pointer-fine only.
      const ctaCleanups = []
      if (finePointer()) {
        gsap.utils.toArray('.vf-button, .nv-cta', root).forEach((btn) => {
          btn.classList.add('vf-magnetic')
          const text = btn.textContent.trim()
          // Freeze the accessible name so the scramble never garbles it.
          if (text && !btn.getAttribute('aria-label')) btn.setAttribute('aria-label', text)
          const xTo = gsap.quickTo(btn, 'x', { duration: 0.35, ease: 'power3.out' })
          const yTo = gsap.quickTo(btn, 'y', { duration: 0.35, ease: 'power3.out' })
          const move = (e) => {
            const r = btn.getBoundingClientRect()
            xTo((e.clientX - r.left - r.width / 2) * 0.35)
            yTo((e.clientY - r.top - r.height / 2) * 0.35)
          }
          const enter = () => {
            if (text) {
              gsap.to(btn, {
                duration: 0.45,
                scrambleText: { text, chars: 'upperAndLowerCase', speed: 0.9 },
              })
            }
          }
          const leave = () => {
            xTo(0)
            yTo(0)
          }
          const down = () => gsap.to(btn, { scale: 0.96, duration: 0.12, ease: 'power2.out' })
          const up = () => gsap.to(btn, { scale: 1, duration: 0.25, ease: 'back.out(2.5)' })
          btn.addEventListener('pointermove', move, { passive: true })
          btn.addEventListener('pointerenter', enter)
          btn.addEventListener('pointerleave', leave)
          btn.addEventListener('pointerdown', down)
          btn.addEventListener('pointerup', up)
          ctaCleanups.push(() => {
            btn.removeEventListener('pointermove', move)
            btn.removeEventListener('pointerenter', enter)
            btn.removeEventListener('pointerleave', leave)
            btn.removeEventListener('pointerdown', down)
            btn.removeEventListener('pointerup', up)
            btn.classList.remove('vf-magnetic')
          })
        })
      }

      return () => ctaCleanups.forEach((fn) => fn())
    },
    { scope: rootRef }
  )

  return (
    <>
      <IntroGate rootRef={rootRef} />
      <Cursor rootRef={rootRef} />
      <div className="vf-progressbar" ref={barRef} aria-hidden="true" />
    </>
  )
}
