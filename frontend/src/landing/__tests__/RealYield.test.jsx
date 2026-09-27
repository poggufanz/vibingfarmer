// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import RealYield from '../sections/RealYield.jsx'
import { setMotion } from './motionEnv.js'

beforeEach(() => setMotion({ reduce: true }))
afterEach(cleanup)

const unavailable = { aprBps: null, totalAssets: null, status: 'unavailable' }

describe('RealYield', () => {
  it('walks the capital path in flow order', () => {
    const { container } = render(<RealYield stats={unavailable} />)
    const stages = [...container.querySelectorAll('.vf-path__stage strong')].map(
      (s) => s.textContent
    )
    expect(stages).toEqual([
      'USDC budget',
      'Agent accounts',
      'vfVLT vault shares',
      'Blend v2 USDC pool',
      'Interest + BLND',
    ])
  })

  it('states only provable facts', () => {
    render(<RealYield stats={unavailable} />)
    expect(screen.getByText('None in vault, strategy or router contracts')).toBeTruthy()
    expect(screen.getByText('Sponsored by fee-bump relay')).toBeTruthy()
    expect(screen.getByText(/admin cannot pause redemption/)).toBeTruthy()
  })

  it('shows live numbers when present and "--" when not', () => {
    const { rerender } = render(<RealYield stats={unavailable} />)
    expect(screen.getByTestId('yield-apr').textContent).toBe('--')
    rerender(<RealYield stats={{ aprBps: 431, totalAssets: 1_234_567_890_000n, status: 'live' }} />)
    expect(screen.getByTestId('yield-apr').textContent).toBe('4.31%')
    expect(screen.getByTestId('yield-tvl').textContent).toBe('123,457 USDC')
  })

  it('keeps counting readouts out of live regions and labels the APR as an estimate', () => {
    render(<RealYield stats={unavailable} />)
    expect(screen.getByTestId('yield-apr').closest('[aria-live]')).toBeNull()
    expect(screen.getByTestId('yield-tvl').closest('[aria-live]')).toBeNull()
    expect(screen.getByText('Est. Blend USDC supply APR')).toBeTruthy()
  })

  it('runs its motion branch without throwing', () => {
    setMotion({ reduce: false })
    const { container } = render(<RealYield stats={unavailable} />)
    expect(container.querySelectorAll('.vf-path__stage')).toHaveLength(5)
  })
})
