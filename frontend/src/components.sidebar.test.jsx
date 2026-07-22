// @vitest-environment jsdom
import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { Sidebar, TopBar } from './components.jsx'

afterEach(cleanup)

describe('Sidebar', () => {
  it('keeps collapse state and current-page semantics available to assistive technology', () => {
    const onToggle = vi.fn()
    const { rerender } = render(
      <MemoryRouter initialEntries={['/home']}>
        <Sidebar extended={false} onToggle={onToggle} />
      </MemoryRouter>
    )

    expect(screen.getByRole('button', { name: 'Home' }).getAttribute('aria-current')).toBe('page')
    const expand = screen.getByRole('button', { name: 'Expand sidebar' })
    expect(expand.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(expand)
    expect(onToggle).toHaveBeenCalledOnce()

    rerender(
      <MemoryRouter initialEntries={['/home']}>
        <Sidebar extended onToggle={onToggle} />
      </MemoryRouter>
    )
    expect(
      screen.getByRole('button', { name: 'Collapse sidebar' }).getAttribute('aria-expanded')
    ).toBe('true')
  })

  it('renders the "New deposit" label routing to /strategy, current when active', () => {
    render(
      <MemoryRouter initialEntries={['/strategy']}>
        <Sidebar extended onToggle={() => {}} />
      </MemoryRouter>
    )
    const item = screen.getByRole('button', { name: 'New deposit' })
    expect(item.getAttribute('aria-current')).toBe('page')
  })

  it('navigates to /strategy when "New deposit" is activated', () => {
    render(
      <MemoryRouter initialEntries={['/home']}>
        <Sidebar extended onToggle={() => {}} />
      </MemoryRouter>
    )
    fireEvent.click(screen.getByRole('button', { name: 'New deposit' }))
    // aria-current flips to the newly active item once React Router's location updates.
    expect(screen.getByRole('button', { name: 'New deposit' }).getAttribute('aria-current')).toBe(
      'page'
    )
  })

  it('renders the "My money" label routing to /agent, current when active', () => {
    render(
      <MemoryRouter initialEntries={['/agent']}>
        <Sidebar extended onToggle={() => {}} />
      </MemoryRouter>
    )
    const item = screen.getByRole('button', { name: 'My money' })
    expect(item.getAttribute('aria-current')).toBe('page')
  })

  it('navigates to /agent when "My money" is activated', () => {
    render(
      <MemoryRouter initialEntries={['/home']}>
        <Sidebar extended onToggle={() => {}} />
      </MemoryRouter>
    )
    fireEvent.click(screen.getByRole('button', { name: 'My money' }))
    expect(screen.getByRole('button', { name: 'My money' }).getAttribute('aria-current')).toBe(
      'page'
    )
  })

  it('no longer renders the retired inline logo image / old labels', () => {
    render(
      <MemoryRouter initialEntries={['/home']}>
        <Sidebar extended onToggle={() => {}} />
      </MemoryRouter>
    )
    expect(document.querySelector('img[src="/vibing_farmer.logo.svg"]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Strategy' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Dashboard' })).toBeNull()
  })

  it('renders a compact BrandLockup for the sidebar mark', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/home']}>
        <Sidebar extended onToggle={() => {}} />
      </MemoryRouter>
    )
    expect(container.querySelector('.pc-brand-lockup--compact')).toBeTruthy()
  })
})

describe('TopBar', () => {
  const baseProps = { onReset: () => {}, railCollapsed: false, onToggleRail: () => {} }

  it('renders a NetworkBadge with the visible "Stellar testnet" label', () => {
    render(<TopBar {...baseProps} />)
    expect(screen.getByText('Stellar testnet')).toBeTruthy()
  })

  it('renders the brand as a BrandLockup', () => {
    const { container } = render(<TopBar {...baseProps} />)
    expect(container.querySelector('.pc-brand-lockup')).toBeTruthy()
  })

  it('renames the flow-restart icon button so it never collides with the Sidebar\'s "New deposit" navigation label', () => {
    const onReset = vi.fn()
    render(<TopBar {...baseProps} onReset={onReset} />)
    expect(screen.queryByRole('button', { name: 'New deposit' })).toBeNull()
    const startOver = screen.getByRole('button', { name: 'Start over' })
    fireEvent.click(startOver)
    expect(onReset).toHaveBeenCalledOnce()
  })
})
