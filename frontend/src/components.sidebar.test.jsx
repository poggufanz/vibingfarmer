// @vitest-environment jsdom
import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { Sidebar } from './components.jsx'

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
})
