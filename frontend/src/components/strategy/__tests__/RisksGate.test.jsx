// frontend/src/components/strategy/__tests__/RisksGate.test.jsx
// P1 G7: the Risks page lists all six risks with mitigations; the first-grant gate modal
// requires the checkbox before continuing; the shell footer links to /risks permanently.
// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { RisksPage } from '../RisksPage.jsx'
import { RisksGateModal } from '../RisksGateModal.jsx'
import { Sidebar } from '../../../components.jsx'
import { ROUTES } from '../../../app/router.js'
import { routeLabel } from '../../pocket/RouteFocus.jsx'

afterEach(cleanup)

const here = path.dirname(fileURLToPath(import.meta.url))

describe('RisksPage — six risks plus their shipped mitigations', () => {
  it('renders every risk title with its mitigation', () => {
    render(<RisksPage />)
    for (const title of [
      'Smart-contract risk',
      'Oracle risk',
      'Liquidity risk',
      'Testnet reset risk',
      'Bridge delay risk',
      'Grant scope risk',
    ]) {
      expect(screen.getByRole('heading', { name: title })).toBeTruthy()
    }
    expect(screen.getByText(/multisig/)).toBeTruthy()
    expect(screen.getByText(/resumable/)).toBeTruthy()
    expect(screen.getByText(/testnet funds only/i)).toBeTruthy()
    // P1 G8: the audit-plan line — honestly unaudited, scoped, no false claim.
    expect(screen.getByText(/not audited yet/i)).toBeTruthy()
    expect(screen.getByText(/agent auth/)).toBeTruthy()
  })
})

describe('RisksGateModal — checkbox required before continuing', () => {
  it('renders nothing while closed', () => {
    const { container } = render(
      <RisksGateModal open={false} onConfirm={vi.fn()} onClose={vi.fn()} />
    )
    expect(container.innerHTML).toBe('')
  })

  it('disables continue until "saya paham" is checked, then confirms', () => {
    const onConfirm = vi.fn()
    render(<RisksGateModal open onConfirm={onConfirm} onClose={vi.fn()} />)
    const continueBtn = screen.getByRole('button', { name: 'Acknowledge and continue' })
    expect(continueBtn.disabled).toBe(true)
    fireEvent.click(continueBtn)
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox', { name: /saya paham/i }))
    expect(screen.getByRole('button', { name: 'Acknowledge and continue' }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge and continue' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('cancel closes without confirming', () => {
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    render(<RisksGateModal open onConfirm={onConfirm} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('reopening resets the checkbox', () => {
    const { rerender } = render(<RisksGateModal open onConfirm={vi.fn()} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /saya paham/i }))
    expect(screen.getByRole('button', { name: 'Acknowledge and continue' }).disabled).toBe(false)
    rerender(<RisksGateModal open={false} onConfirm={vi.fn()} onClose={vi.fn()} />)
    rerender(<RisksGateModal open onConfirm={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Acknowledge and continue' }).disabled).toBe(true)
  })
})

describe('Risks shell — permanent footer link to /risks', () => {
  it('ROUTES and the title table know /risks', () => {
    expect(ROUTES.RISKS).toBe('/risks')
    expect(routeLabel('/risks')).toBe('Risks')
  })

  it('the sidebar footer exposes Risks and navigates to /risks', () => {
    render(
      <MemoryRouter initialEntries={['/home']}>
        <Sidebar extended onToggle={() => {}} />
      </MemoryRouter>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Risks' }))
    expect(screen.getByRole('button', { name: 'Risks' }).getAttribute('aria-current')).toBe('page')
  })

  it('the four-item primary nav is untouched by the footer link', () => {
    render(
      <MemoryRouter initialEntries={['/home']}>
        <Sidebar extended onToggle={() => {}} />
      </MemoryRouter>
    )
    for (const name of [/my money/i, /put it to work/i, /the crew/i, /history/i]) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }
    // Developers and Settings live in the TopBar account panel, not the sidebar.
    expect(screen.queryByRole('button', { name: /developers/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /settings/i })).toBeNull()
  })
})

describe('P1 G7 — app wiring (structural; app.jsx is too heavy to render)', () => {
  const src = fs.readFileSync(path.resolve(here, '../../../app.jsx'), 'utf8')

  it('the /risks route renders RisksPage', () => {
    const start = src.indexOf('path="/risks"')
    expect(start, 'Route /risks not found in app.jsx').toBeGreaterThan(-1)
    const end = src.indexOf('<Route', start + 1)
    expect(src.slice(start, end)).toMatch(/<RisksPage/)
  })

  it('onRequestGrant opens the gate for a wallet that still owes acknowledgement', () => {
    expect(src).toMatch(/needsRisksAck\(\{ owner: realAddress \}\)/)
    expect(src).toMatch(/setRisksGateOpen\(true\)/)
  })

  it('confirming persists the ack and then runs the standard grant flow', () => {
    expect(src).toMatch(/saveRisksAck\(\{ owner: realAddress \}\)/)
    const confirmStart = src.indexOf('async function handleRisksGateConfirm')
    expect(confirmStart).toBeGreaterThan(-1)
    const block = src.slice(confirmStart, confirmStart + 1200)
    expect(block).toMatch(/dispatchFlow\(\{ type: 'GRANT_REQUESTED' \}\)/)
    expect(block).toMatch(/requestPermissionConfirmation\(\)/)
  })

  it('the gate modal is mounted route-level with its three props', () => {
    expect(src).toMatch(/<RisksGateModal[\s\S]*?open=\{risksGateOpen\}[\s\S]*?\/>/)
    expect(src).toMatch(/onConfirm=\{handleRisksGateConfirm\}/)
    expect(src).toMatch(/onClose=\{handleRisksGateClose\}/)
  })
  it('dismissing the gate rejects instead of dispatching a grant', () => {
    const closeStart = src.indexOf('function handleRisksGateClose')
    expect(closeStart).toBeGreaterThan(-1)
    const nextFn = src.indexOf('\n  function ', closeStart + 1)
    const block = src.slice(closeStart, nextFn === -1 ? closeStart + 500 : nextFn)
    expect(block).toMatch(/reject\(new Error/)
    expect(block).not.toMatch(/GRANT_REQUESTED/)
  })
})
