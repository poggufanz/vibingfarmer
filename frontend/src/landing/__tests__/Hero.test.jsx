// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Hero from '../sections/Hero.jsx'

beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
})

afterEach(cleanup)

const unavailable = { aprBps: null, totalAssets: null, status: 'unavailable' }

describe('Hero', () => {
  it('leads with the principle and one launch action', () => {
    const onStart = vi.fn()
    render(<Hero onStart={onStart} stats={unavailable} />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Set once. Vibe forever.')
    fireEvent.click(screen.getByRole('button', { name: 'Launch app' }))
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('link', { name: 'See how it works' }).getAttribute('href')).toBe(
      '#how-it-works'
    )
  })

  it('shows "--" and an unavailable stamp instead of a fake number', () => {
    render(<Hero onStart={() => {}} stats={unavailable} />)
    expect(screen.getByTestId('hero-apr').textContent).toBe('--')
    expect(screen.getByTestId('hero-tvl').textContent).toBe('--')
    expect(screen.getByText(/unavailable/i)).toBeTruthy()
  })

  it('runs the motion branch without throwing and keeps the final text', () => {
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: !query.includes(': reduce'),
      media: query,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
    render(
      <Hero onStart={() => {}} stats={{ aprBps: 612, totalAssets: 50_000_000n, status: 'live' }} />
    )
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Set once. Vibe forever.')
  })

  // countUp rewrites these nodes from 0 upward; inside a live region every frame is announced.
  it('keeps counting readouts out of live regions and labels the APR as an estimate', () => {
    render(<Hero onStart={() => {}} stats={unavailable} />)
    expect(screen.getByTestId('hero-apr').closest('[aria-live]')).toBeNull()
    expect(screen.getByTestId('hero-tvl').closest('[aria-live]')).toBeNull()
    expect(screen.getByText('Est. Blend USDC supply APR')).toBeTruthy()
  })

  it('never stamps "live" when one of the two reads failed', () => {
    render(
      <Hero
        onStart={() => {}}
        stats={{ aprBps: null, totalAssets: 50_000_000n, status: 'partial' }}
      />
    )
    expect(screen.getByTestId('hero-apr').textContent).toBe('--')
    expect(screen.queryByText(/^live/)).toBeNull()
    expect(screen.getByText('partly live · one on-chain read failed')).toBeTruthy()
  })

  it('shows live testnet numbers and a signature count of one', () => {
    render(
      <Hero onStart={() => {}} stats={{ aprBps: 612, totalAssets: 50_000_000n, status: 'live' }} />
    )
    expect(screen.getByTestId('hero-apr').textContent).toBe('6.12%')
    expect(screen.getByTestId('hero-tvl').textContent).toBe('5 USDC')
    expect(screen.getByTestId('hero-signatures').textContent).toBe('1')
    expect(screen.getByText(/live · Stellar testnet/)).toBeTruthy()
  })
})
