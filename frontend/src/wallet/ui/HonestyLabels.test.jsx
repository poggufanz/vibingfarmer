// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { HonestyLabels } from './HonestyLabels.jsx'

afterEach(cleanup)

describe('HonestyLabels', () => {
  it('renders testnet + protocol labels in global scope', () => {
    render(<HonestyLabels scope="global" />)
    const el = screen.getByTestId('honesty-global')
    expect(el.textContent).toMatch(/testnet-grade/)
    expect(el.textContent).toMatch(/mainnet-live at the protocol layer/)
  })

  it('renders the app-layer label in deposit scope', () => {
    render(<HonestyLabels scope="deposit" />)
    expect(screen.getByTestId('honesty-deposit').textContent).toMatch(/app-layer/)
  })

  it('renders the VF-custodied label in recovery scope', () => {
    render(<HonestyLabels scope="recovery" />)
    expect(screen.getByTestId('honesty-recovery').textContent).toMatch(/VF-custodied/)
  })

  it('defaults to global scope when prop is omitted', () => {
    render(<HonestyLabels />)
    expect(screen.getByTestId('honesty-global')).toBeTruthy()
  })

  it('renders the agent cap label in agent scope', () => {
    render(<HonestyLabels scope="agent" />)
    expect(screen.getByTestId('honesty-agent').textContent).toMatch(/not yet enforced on-chain/)
  })
})
