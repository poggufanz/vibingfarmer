// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ScrollTrigger } from '../motion/gsap.js'
import VibeForever from '../sections/VibeForever.jsx'
import { setMotion } from './motionEnv.js'

beforeEach(() => setMotion({ reduce: true }))
const pinned = () => ScrollTrigger.getAll().find((st) => st.pin)
afterEach(cleanup)

describe('VibeForever', () => {
  it('tells the run lifecycle in six ordered beats', () => {
    const { container } = render(<VibeForever />)
    const beats = [...container.querySelectorAll('.vf-beat')]
    expect(beats.map((beat) => beat.dataset.beat)).toEqual([
      'fund',
      'earn',
      'compound',
      'watch',
      'derisk',
      'resume',
    ])
    expect(screen.getByText('One failure does not stop the others.', { exact: false })).toBeTruthy()
    expect(screen.getByText(/only under your mandate/)).toBeTruthy()
  })

  it('labels the stage as an illustration and never counts a second signature', () => {
    const { container } = render(<VibeForever />)
    expect(screen.getByText('Illustration of the run lifecycle — not live data.')).toBeTruthy()
    expect(container.querySelector('.vf-vibe__sigs').textContent).toBe('1')
  })

  it('stays a readable list under reduced motion', () => {
    const { container } = render(<VibeForever />)
    expect(container.querySelector('.vf-vibe').classList.contains('is-scrubbed')).toBe(false)
  })

  it('switches to the pinned scrub stage with desktop motion', () => {
    setMotion({ reduce: false, desktop: true })
    const { container } = render(<VibeForever />)
    expect(container.querySelector('.vf-vibe').classList.contains('is-scrubbed')).toBe(true)
    expect(pinned()?.pin).toBe(container.querySelector('.vf-vibe__stage'))
  })

  it('counts the run from day 01 to day 30', () => {
    setMotion({ reduce: false, desktop: true })
    const { container } = render(<VibeForever />)
    const day = container.querySelector('.vf-vibe__day')
    expect(day.textContent).toBe('01')
    pinned().animation.progress(1)
    expect(day.textContent).toBe('30')
  })

  // The 100vh stage cannot fit the art and its "not live data" caption on a short viewport.
  it('keeps the list layout on short screens so the illustration caption stays visible', () => {
    setMotion({ reduce: false, desktop: true, tall: false })
    const { container } = render(<VibeForever />)
    expect(container.querySelector('.vf-vibe').classList.contains('is-scrubbed')).toBe(false)
    expect(pinned()).toBeUndefined()
  })

  // A tweened inline stroke fights the fence's CSS transition and trails a fast scrub.
  it('turns the fence to warning only while de-risking, through a class', () => {
    setMotion({ reduce: false, desktop: true })
    const { container } = render(<VibeForever />)
    const field = container.querySelector('.vf-field--stage')
    const tl = pinned().animation
    tl.progress((tl.labels.derisk + 0.1) / tl.duration())
    expect(field.classList.contains('is-warning')).toBe(true)
    expect(container.querySelector('.vf-field__fence').style.stroke).toBe('')
    tl.progress(1)
    expect(field.classList.contains('is-warning')).toBe(false)
  })

  it('keeps the list layout on small screens even with motion', () => {
    setMotion({ reduce: false, desktop: false })
    const { container } = render(<VibeForever />)
    expect(container.querySelector('.vf-vibe').classList.contains('is-scrubbed')).toBe(false)
  })
})
