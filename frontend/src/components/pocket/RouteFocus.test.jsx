// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { RouteFocus, SkipLink, routeLabel, routeTitle } from './RouteFocus.jsx'

expect.extend(axeMatchers)

afterEach(cleanup)

describe('routeLabel / routeTitle', () => {
  it('names every known route', () => {
    expect(routeLabel('/home')).toBe('Home')
    expect(routeLabel('/strategy')).toBe('New deposit')
    expect(routeLabel('/agent')).toBe('My money')
    expect(routeLabel('/history')).toBe('History')
    expect(routeLabel('/settings')).toBe('Settings')
    expect(routeLabel('/explorer')).toBe('Explorer')
    expect(routeLabel('/ecosystem')).toBe('Ecosystem')
    expect(routeLabel('/replay')).toBe('Replay')
    expect(routeLabel('/developers/skills')).toBe('Developers')
    expect(routeLabel('/vault/aave-v3')).toBe('Vault details')
    expect(routeLabel('/tx/abc123')).toBe('Transaction details')
  })

  it('has no label for an unmapped/redirect-only path', () => {
    expect(routeLabel('/farm')).toBeNull()
    expect(routeLabel('/')).toBeNull()
  })

  it('builds a single-middle-dot title, brand-only when there is no page name', () => {
    expect(routeTitle('/agent')).toBe('My money · Vibing Farmer')
    expect(routeTitle('/farm')).toBe('Vibing Farmer')
    // exactly one middle dot, never an em/en dash
    expect(routeTitle('/agent').match(/·/g)).toHaveLength(1)
    expect(routeTitle('/agent')).not.toMatch(/[-–—|]/)
  })
})

describe('SkipLink', () => {
  it('is a real link, visible copy "Skip to content"', () => {
    render(
      <div>
        <SkipLink />
        <main>
          <h1>Page</h1>
        </main>
      </div>
    )
    expect(screen.getByRole('link', { name: 'Skip to content' })).toBeTruthy()
  })

  it('moves focus to the main landmark on activation, adding tabindex on demand', () => {
    render(
      <div>
        <SkipLink />
        <main>
          <h1>Page</h1>
        </main>
      </div>
    )
    const link = screen.getByRole('link', { name: 'Skip to content' })
    fireEvent.click(link)
    const main = screen.getByRole('main')
    expect(document.activeElement).toBe(main)
    expect(main.getAttribute('tabindex')).toBe('-1')
  })

  it('prefers a [data-route-heading] target over the bare main landmark', () => {
    render(
      <div>
        <SkipLink />
        <main>
          <h1 data-route-heading tabIndex={-1}>
            Page heading
          </h1>
        </main>
      </div>
    )
    fireEvent.click(screen.getByRole('link', { name: 'Skip to content' }))
    expect(document.activeElement).toBe(screen.getByText('Page heading'))
  })

  it('has zero axe violations', async () => {
    const { container } = render(
      <div>
        <SkipLink />
        <main>
          <h1>Page</h1>
        </main>
      </div>
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('RouteFocus', () => {
  function Shell({ pathname }) {
    return (
      <div>
        <nav aria-label="Primary navigation">
          <button>Home</button>
        </nav>
        <main>
          <RouteFocus pathname={pathname} />
          <h1>Stage for {pathname}</h1>
        </main>
      </div>
    )
  }

  it('mounts inside exactly one main landmark for the whole shell', () => {
    render(<Shell pathname="/home" />)
    expect(screen.getAllByRole('main')).toHaveLength(1)
  })

  it('focuses the main landmark when the route changes', () => {
    const { rerender } = render(<Shell pathname="/home" />)
    rerender(<Shell pathname="/agent" />)
    expect(document.activeElement).toBe(screen.getByRole('main'))
  })

  it('announces the destination route once in a polite live region', () => {
    const { rerender, container } = render(<Shell pathname="/home" />)
    rerender(<Shell pathname="/agent" />)
    const region = container.querySelector('[role="status"][aria-live="polite"]')
    expect(region.textContent).toBe('Navigated to My money')
  })

  it('never steals focus for a re-render that leaves the pathname unchanged (background update)', () => {
    const { rerender } = render(<Shell pathname="/agent" />)
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    expect(document.activeElement).toBe(input)

    // Same pathname, different unrelated content -- simulates a background position/poll update.
    rerender(<Shell pathname="/agent" />)
    expect(document.activeElement).toBe(input)
    document.body.removeChild(input)
  })

  it('has zero axe violations', async () => {
    const { container } = render(<Shell pathname="/home" />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
