// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import VibeForever from '../sections/VibeForever.jsx'
import { setMotion } from './motionEnv.js'

beforeEach(() => setMotion({ reduce: true }))
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
  })

  it('keeps the list layout on small screens even with motion', () => {
    setMotion({ reduce: false, desktop: false })
    const { container } = render(<VibeForever />)
    expect(container.querySelector('.vf-vibe').classList.contains('is-scrubbed')).toBe(false)
  })
})
