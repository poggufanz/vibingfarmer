// @vitest-environment jsdom
// frontend/src/components/console/MandateZone.test.jsx
import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import MandateZone from './MandateZone.jsx'

afterEach(cleanup)

const scopes = [
  {
    agent: 'CAGENT1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXAB12',
    capPerPeriod: 400_000_000,
    maxAtRisk: 200_000_000,
    revoked: false,
  },
  {
    agent: 'CAGENT2XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXCD34',
    capPerPeriod: 600_000_000,
    maxAtRisk: 600_000_000,
    revoked: true,
  },
]

describe('MandateZone', () => {
  it('summarizes active scopes and total cap', () => {
    render(<MandateZone scopes={scopes} onRevoke={() => {}} />)
    expect(screen.getByText(/1 scopes active · 40.00 USDC total cap/)).toBeTruthy()
  })
  it('revoke fires per row; revoked rows show label instead', () => {
    const onRevoke = vi.fn()
    render(<MandateZone scopes={scopes} onRevoke={onRevoke} />)
    fireEvent.click(screen.getByRole('button', { name: /revoke/i }))
    expect(onRevoke).toHaveBeenCalledWith(scopes[0].agent)
    expect(screen.getByText('revoked')).toBeTruthy()
  })
  it('empty state', () => {
    render(<MandateZone scopes={[]} onRevoke={() => {}} />)
    expect(screen.getByText(/no scoped agents — grant creates scopes/)).toBeTruthy()
  })
})
