// @vitest-environment jsdom
// frontend/src/components/console/LifeboatZone.test.jsx
import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import LifeboatZone from './LifeboatZone.jsx'

afterEach(cleanup)

const NOW = 1_000_000_000_000
const nowS = Math.floor(NOW / 1000)
const armed = {
  derisked: false,
  mandateExpiry: nowS + 43_200,
  authority: 'GKEEPXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX4F2A',
}

describe('LifeboatZone', () => {
  it('armed: radar sweeps, threats 0, mandate countdown, renew enabled', () => {
    const onGrant = vi.fn()
    const { container } = render(
      <LifeboatZone
        state={armed}
        events={[]}
        owner="GUSER"
        onGrant={onGrant}
        busy={false}
        nowMs={NOW}
      />
    )
    expect(screen.getByText('ARMED')).toBeTruthy()
    expect(container.querySelector('.radar-sweep-line')).toBeTruthy()
    expect(screen.getByText(/threats · 0/)).toBeTruthy()
    expect(screen.getByText(/12h 0m/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /renew 24h mandate/i }))
    expect(onGrant).toHaveBeenCalled()
  })
  it('engaged: escalates and shows runbook from events', () => {
    const { container } = render(
      <LifeboatZone
        state={{ ...armed, derisked: true }}
        events={[
          { type: 'derisk', reasonCode: 1, txHash: 'ff00ff00ff00ff', timestamp: NOW - 5000 },
        ]}
        owner="GUSER"
        onGrant={() => {}}
        busy={false}
        nowMs={NOW}
      />
    )
    expect(screen.getByText('ENGAGED')).toBeTruthy()
    expect(container.querySelector('[data-escalated="1"]')).toBeTruthy()
    expect(screen.getByText(/Lifeboat engaged/)).toBeTruthy()
  })
  it('null state renders -- and no fake mode', () => {
    render(
      <LifeboatZone
        state={null}
        events={[]}
        owner={null}
        onGrant={() => {}}
        busy={false}
        nowMs={NOW}
      />
    )
    expect(screen.getByText('--')).toBeTruthy()
  })
})
