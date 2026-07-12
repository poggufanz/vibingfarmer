// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Player } from './LandingHero.jsx'

afterEach(cleanup)

describe('LandingHero Player', () => {
  it('requires explicit playback when motion is reduced', () => {
    const { container } = render(<Player src="/demo.mp4" reduceMotion />)
    const video = container.querySelector('video')

    expect(video.autoplay).toBe(false)
    expect(video.loop).toBe(false)
    expect(video.controls).toBe(true)
  })
})
