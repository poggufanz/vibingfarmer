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
    expect(screen.getByText('1 active scopes, 40.00 USDC total cap')).toBeTruthy()
  })
  it('revoke fires per row; revoked rows are hidden, not rendered as money at risk', () => {
    // A revoked scope is terminal (owner_withdraw sweeps then revokes) — rendering its cap as a
    // "Max at risk" card reads as money still allocated after the funds already went home.
    const onRevoke = vi.fn()
    render(<MandateZone scopes={scopes} onRevoke={onRevoke} />)
    fireEvent.click(screen.getByRole('button', { name: /revoke/i }))
    expect(onRevoke).toHaveBeenCalledWith(scopes[0].agent)
    expect(screen.queryByText(/Max at risk 60.00/)).toBeNull()
    expect(screen.getByText(/1 exited agent hidden/)).toBeTruthy()
  })
  it('all scopes revoked reads as a completed exit, not an empty account', () => {
    render(<MandateZone scopes={scopes.map((s) => ({ ...s, revoked: true }))} onRevoke={() => {}} />)
    expect(screen.getByText(/All 2 agents exited — funds swept back to your wallet/)).toBeTruthy()
    expect(screen.queryByText(/Max at risk/)).toBeNull()
  })
  it('empty state', () => {
    render(<MandateZone scopes={[]} onRevoke={() => {}} />)
    expect(screen.getByText('No scoped agents. Create a grant to add scopes.')).toBeTruthy()
  })
  it('paginates at 3 scopes per page', () => {
    const many = Array.from({ length: 4 }, (_, i) => ({
      agent: `CAGENT${i}XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXAB1${i}`,
      capPerPeriod: 100_000_000,
      maxAtRisk: 50_000_000,
      revoked: false,
    }))
    render(<MandateZone scopes={many} onRevoke={() => {}} />)
    expect(screen.getAllByText(/Max at risk/)).toHaveLength(3)
    expect(screen.getByText('1 / 2')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /next page/i }))
    expect(screen.getAllByText(/Max at risk/)).toHaveLength(1)
    expect(screen.getByText('04')).toBeTruthy()
    expect(screen.getByRole('button', { name: /next page/i }).disabled).toBe(true)
  })
  it('no pager when scopes fit on one page', () => {
    render(<MandateZone scopes={scopes} onRevoke={() => {}} />)
    expect(screen.queryByRole('button', { name: /next page/i })).toBeNull()
  })
})
