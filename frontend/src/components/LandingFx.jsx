// LandingFx owns the landing page's finite decorative layer.
// Content, navigation, and execution state remain in the landing components.
import { useCallback, useEffect, useRef, useState } from 'react'
import gsap from 'gsap'

const SUB_TEXT = 'be ready for VIBING FARMER'

function reducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : true
}

function IntroGate({ rootRef }) {
  const [active, setActive] = useState(() => !reducedMotion())
  const overlayRef = useRef(null)
  const doneRef = useRef(false)
  const previousOverflowRef = useRef('')

  useEffect(() => {
    const root = rootRef?.current
    if (!active || !root) return undefined

    previousOverflowRef.current = root.style.overflow
    root.style.overflow = 'hidden'
    return () => {
      root.style.overflow = previousOverflowRef.current
    }
  }, [active, rootRef])

  useEffect(() => {
    if (!active || reducedMotion() || !overlayRef.current) return undefined

    const context = gsap.context(() => {
      const copy = overlayRef.current.querySelectorAll('[data-vf-reveal]')
      gsap.fromTo(
        copy,
        { opacity: 0, y: 8, scale: 0.99 },
        {
          opacity: 1,
          y: 0,
          scale: 1,
          duration: 0.32,
          stagger: 0.04,
          ease: 'power3.out',
        }
      )
    }, overlayRef)

    return () => context.revert()
  }, [active])

  const dismiss = useCallback(() => {
    if (doneRef.current) return
    doneRef.current = true
    const root = rootRef?.current
    if (root) root.style.overflow = previousOverflowRef.current
    setActive(false)
  }, [rootRef])

  useEffect(() => {
    const overlay = overlayRef.current
    if (!active || !overlay) return undefined

    overlay.addEventListener('wheel', dismiss, { passive: true })
    overlay.addEventListener('touchstart', dismiss, { passive: true })
    window.addEventListener('keydown', dismiss)
    return () => {
      overlay.removeEventListener('wheel', dismiss)
      overlay.removeEventListener('touchstart', dismiss)
      window.removeEventListener('keydown', dismiss)
    }
  }, [active, dismiss])

  if (!active) return null

  return (
    <section className="vf-intro" ref={overlayRef} aria-label="Welcome" onClick={dismiss}>
      <div className="vf-intro__grid" aria-hidden="true" />
      <div className="vf-intro__scanlines" aria-hidden="true" />
      <div className="vf-intro__center">
        <p className="vf-intro__ready" data-vf-reveal>
          READY OR NOT?
        </p>
        <p className="vf-intro__sub" aria-label={SUB_TEXT} data-vf-reveal>
          <span aria-hidden="true">{SUB_TEXT}</span>
        </p>
      </div>
      <p className="vf-intro__hint" aria-hidden="true" data-vf-reveal>
        scroll to enter
      </p>
      <div className="vf-intro__flash" aria-hidden="true" />
    </section>
  )
}

export default function LandingFx({ rootRef }) {
  return <IntroGate rootRef={rootRef} />
}
