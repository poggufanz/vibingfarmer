// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { CrewActivity } from './CrewActivity.jsx'

afterEach(cleanup)

const FIXTURE_NOW_MS = Date.parse('2026-08-11T00:00:00.000Z')
const CREW_CSS = readFileSync('src/components/crew/crew.css', 'utf8')

describe('CrewActivity', () => {
  it('renders source-backed compound and rebalance rows with supplied technical evidence', () => {
    render(
      <CrewActivity
        nowMs={FIXTURE_NOW_MS}
        keeperEvents={[
          {
            id: 'compound:12345',
            kind: 'compound_executed',
            totalGainUsdc: '4.82',
            txHash: 'abcdef1234567890',
            timestamp: FIXTURE_NOW_MS,
            closedAt: FIXTURE_NOW_MS - 60_000,
          },
          {
            id: 'rebalance:12346',
            kind: 'rebalance_executed',
            fromLabel: 'Blend A',
            toLabel: 'Blend B',
            amountUsdc: '12.00',
            txHash: '0123456789abcdef',
            timestamp: FIXTURE_NOW_MS,
            closedAt: FIXTURE_NOW_MS - 120_000,
          },
        ]}
        decisions={[
          {
            id: 'decision:1',
            tone: 'kept',
            title: 'Keep the current vault',
            detail: 'Source-backed monitor result',
            time: 'ledger 12345',
          },
        ]}
      />
    )

    expect(screen.getByText('Compounded, +4.82 USDC')).toBeTruthy()
    expect(screen.getByText(/Rebalanced, Blend A to Blend B, 12\.00 USDC/)).toBeTruthy()
    expect(screen.getByText('abcdef12…567890')).toBeTruthy()
    expect(screen.getByText('01234567…abcdef')).toBeTruthy()
    expect(screen.getByText('2026-08-10T23:59:00.000Z')).toBeTruthy()
    expect(screen.getByText('Keep the current vault')).toBeTruthy()
    expect(screen.getByText('ledger 12345')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Decisions we logged' })).toBeTruthy()
    expect(screen.queryByText(/Every decision/i)).toBeNull()
  })

  it('renders explicit empty feeds and fails closed for incomplete or unsupported records', () => {
    render(
      <CrewActivity
        nowMs={FIXTURE_NOW_MS}
        keeperEvents={[
          { id: 'unknown:1', kind: 'vault_upgrade_executed', txHash: 'not-a-keeper-row' },
          { id: 'compound:missing', kind: 'compound_executed', txHash: null },
        ]}
        decisions={[
          { id: 'incomplete', tone: 'kept', title: '', detail: '', time: '' },
          { id: 'missing-id', tone: 'kept', title: 'Should not render' },
          null,
        ]}
      />
    )

    expect(screen.getByText('No keeper activity yet on this device.')).toBeTruthy()
    expect(screen.getByText('Decision unavailable')).toBeTruthy()
    expect(screen.queryByText('Should not render')).toBeNull()
    expect(screen.queryByText('undefined')).toBeNull()
    expect(screen.queryByText(/not-a-keeper-row/)).toBeNull()
  })

  it('announces newly rendered source rows politely without inventing omitted events', async () => {
    const { rerender } = render(<CrewActivity nowMs={FIXTURE_NOW_MS} />)
    expect(screen.queryByRole('status')).toBeNull()

    rerender(
      <CrewActivity
        nowMs={FIXTURE_NOW_MS}
        keeperEvents={[
          {
            id: 'compound:new',
            kind: 'compound_executed',
            totalGainUsdc: '1.00',
            txHash: 'fedcba9876543210',
            closedAt: FIXTURE_NOW_MS - 60_000,
          },
        ]}
        decisions={[]}
      />
    )

    const status = await screen.findByRole('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.textContent).toMatch(/new keeper activity/i)
    expect(status.textContent).toMatch(/1/)
  })

  it('fails closed on poisoned or incomplete keeper evidence and never presents secret fields', () => {
    render(
      <CrewActivity
        nowMs={FIXTURE_NOW_MS}
        keeperEvents={[
          {
            id: 'compound:poisoned',
            kind: 'compound_executed',
            totalGainUsdc: 'NaN',
            txHash: 'private-session-key',
            secretKey: 'signer-secret',
            capability: 'vault-admin',
            closedAt: null,
          },
          {
            id: 'rebalance:incomplete',
            kind: 'rebalance_executed',
            amountUsdc: '12.0.0',
            fromLabel: 'Blend A',
            toLabel: 'Blend B',
            txHash: 'not-a-canonical-hash',
            closedAt: FIXTURE_NOW_MS,
            privateCustody: 'owner-signer',
          },
        ]}
        decisions={[
          {
            id: 'decision:secret',
            tone: 'kept',
            title: 'Keep the current vault',
            detail: 'safe detail',
            time: 'ledger 123',
            signer: 'session-private-key',
            capability: 'admin',
          },
        ]}
      />
    )

    expect(screen.getByText('No keeper activity yet on this device.')).toBeTruthy()
    expect(screen.queryByText(/Compound completed|Compounded/)).toBeNull()
    expect(screen.queryByText(/Rebalance completed|Rebalanced/)).toBeNull()
    expect(
      screen.queryByText(/NaN|12\.0\.0|private-session-key|signer-secret|vault-admin|owner-signer/)
    ).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText('Keep the current vault')).toBeTruthy()
    expect(screen.queryByText('session-private-key')).toBeNull()
  })

  it('omits read-time Observed copy when no deterministic clock is supplied', () => {
    render(
      <CrewActivity
        keeperEvents={[
          {
            id: 'compound:source-time',
            kind: 'compound_executed',
            totalGainUsdc: '1.00',
            txHash: 'fedcba9876543210',
            closedAt: FIXTURE_NOW_MS - 60_000,
            timestamp: FIXTURE_NOW_MS,
          },
        ]}
      />
    )

    expect(screen.queryByText(/Observed/)).toBeNull()
    expect(screen.getByText('2026-08-10T23:59:00.000Z')).toBeTruthy()
  })

  it('defines a mobile wrapping contract for technical keeper evidence', () => {
    expect(CREW_CSS).toMatch(/@media\s*\(max-width:\s*640px\)[\s\S]*\.pc-crew-keeper-row/)
    expect(CREW_CSS).toMatch(/\.pc-crew-keeper-time[\s\S]*white-space:\s*normal/)
    expect(CREW_CSS).toMatch(/\.pc-crew-keeper-time[\s\S]*overflow-wrap:\s*anywhere/)
  })
})
