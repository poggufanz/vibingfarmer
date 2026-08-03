// @vitest-environment jsdom
// frontend/src/components/settings/LegacyAutoExitCleanup.test.jsx
// Pocket Crew "My money" Task 10: this surface INSPECTS legacy auto-exit localStorage and lets the
// owner delete it explicitly. It must never execute, schedule, or authorize a fund movement, must
// never silently delete on load, must never render unreadable data as "nothing to clean up", and
// must never call the deleted action "revocation" (deleting a local key does not change an
// on-chain registered signer).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import LegacyAutoExitCleanup from './LegacyAutoExitCleanup.jsx'

expect.extend(axeMatchers)

function stubStorage() {
  const store = {}
  const api = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v)
    },
    removeItem: (k) => {
      delete store[k]
    },
    key: (i) => Object.keys(store)[i] ?? null,
    get length() {
      return Object.keys(store).length
    },
  }
  globalThis.localStorage = api
  return store
}

afterEach(() => {
  cleanup()
})

describe('LegacyAutoExitCleanup — no legacy data', () => {
  beforeEach(() => {
    stubStorage()
  })

  it('honestly reports nothing to clean up when no legacy keys exist, with no delete controls', () => {
    render(<LegacyAutoExitCleanup />)
    expect(screen.getByText(/no legacy auto-exit data/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()
  })

  it('has no accessibility violations in the empty state', async () => {
    const { container } = render(<LegacyAutoExitCleanup />)
    expect(await axe(container)).toHaveNoViolations()
  })

  it('contains no em-dash/en-dash design separators in the empty-state copy', () => {
    const { container } = render(<LegacyAutoExitCleanup />)
    expect(container.textContent).not.toMatch(/[–—]/)
  })
})

describe('LegacyAutoExitCleanup — storage scan failed', () => {
  afterEach(() => {
    delete globalThis.localStorage
  })

  it('reports the scan failed instead of claiming there is nothing to clean up', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError: storage disabled')
      },
    })
    render(<LegacyAutoExitCleanup />)
    expect(screen.queryByText(/no legacy auto-exit data/i)).toBeNull()
    expect(screen.getByText(/could not be scanned/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()
  })
})

describe('LegacyAutoExitCleanup — with legacy data', () => {
  beforeEach(() => {
    stubStorage()
    localStorage.setItem(
      'yv_exit_rules_GOWNER1',
      JSON.stringify({ authorized: true, utilization: { enabled: true } })
    )
    localStorage.setItem(
      'yv_exit_key_cagent1',
      JSON.stringify({ publicKey: 'GPUBKEY', secret: 'SSECRET' })
    )
    localStorage.setItem('yv_last_exit_trip_GOWNER1', 'not a number')
    localStorage.setItem(
      'vf.manualExitKey.v2|stellar-testnet|GOWNER1|CAGENT1',
      JSON.stringify({ owner: 'GOWNER1', agent: 'CAGENT1' })
    )
  })

  it('never deletes anything on mount', () => {
    render(<LegacyAutoExitCleanup />)
    expect(localStorage.getItem('yv_exit_rules_GOWNER1')).not.toBeNull()
    expect(localStorage.getItem('yv_exit_key_cagent1')).not.toBeNull()
  })

  it('lists every legacy row, including one that could not be read — never "nothing to clean up"', () => {
    render(<LegacyAutoExitCleanup />)
    expect(screen.queryByText(/no legacy auto-exit data/i)).toBeNull()
    expect(screen.getByText(/could not be read/i)).toBeTruthy()
  })

  it('never exposes the exit-signer secret anywhere in the rendered output', () => {
    const { container } = render(<LegacyAutoExitCleanup />)
    expect(container.textContent).not.toMatch(/SSECRET/)
  })

  it('never renders the delete action as "revoke" — a local delete is not an on-chain revocation', () => {
    render(<LegacyAutoExitCleanup />)
    expect(screen.queryByRole('button', { name: /revoke/i })).toBeNull()
  })

  it('the delete control carries no entrance-animation class or transition', () => {
    render(<LegacyAutoExitCleanup />)
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    const deleteBtn = screen.getByRole('button', { name: /delete selected/i })
    expect(deleteBtn.className).not.toMatch(/enter/)
    expect(deleteBtn.style.animation).toBe('')
  })

  it('requires an explicit confirmation before deleting, listing the exact keys affected', () => {
    render(<LegacyAutoExitCleanup />)

    fireEvent.click(screen.getByLabelText(/exit-signer key cache/i))
    fireEvent.click(screen.getByRole('button', { name: /delete selected/i }))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('yv_exit_key_cagent1')).toBeTruthy()

    // Nothing is deleted until the dialog is explicitly confirmed.
    expect(localStorage.getItem('yv_exit_key_cagent1')).not.toBeNull()
  })

  it('cancelling the confirmation leaves storage untouched', () => {
    render(<LegacyAutoExitCleanup />)

    fireEvent.click(screen.getByLabelText(/exit-signer key cache/i))
    fireEvent.click(screen.getByRole('button', { name: /delete selected/i }))
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

    expect(localStorage.getItem('yv_exit_key_cagent1')).not.toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('confirming deletes only the selected keys and never touches the v2 manual key', () => {
    render(<LegacyAutoExitCleanup />)

    fireEvent.click(screen.getByLabelText(/exit-signer key cache/i))
    fireEvent.click(screen.getByRole('button', { name: /delete selected/i }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /^delete/i }))

    expect(localStorage.getItem('yv_exit_key_cagent1')).toBeNull()
    expect(localStorage.getItem('yv_exit_rules_GOWNER1')).not.toBeNull() // unselected, untouched
    expect(
      localStorage.getItem('vf.manualExitKey.v2|stellar-testnet|GOWNER1|CAGENT1')
    ).not.toBeNull()
  })

  it('labels an exit key as superseded when a live manual partial-withdraw registration exists', () => {
    render(<LegacyAutoExitCleanup />)
    expect(screen.getByText(/newer manual withdraw key exists/i)).toBeTruthy()
  })

  it('contains no em-dash/en-dash design separators in the rendered copy', () => {
    const { container } = render(<LegacyAutoExitCleanup />)
    expect(container.textContent).not.toMatch(/[–—]/)
  })

  it('has no accessibility violations with rows and an open confirmation dialog', async () => {
    const { container } = render(<LegacyAutoExitCleanup />)
    expect(await axe(container)).toHaveNoViolations()

    fireEvent.click(screen.getByLabelText(/exit-signer key cache/i))
    fireEvent.click(screen.getByRole('button', { name: /delete selected/i }))
    expect(await axe(container)).toHaveNoViolations()
  })
})
