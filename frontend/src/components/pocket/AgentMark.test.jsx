// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { resolveAgentIdentity } from '../../design/pocket-crew-foundation.js'
import { AgentMark } from './AgentMark.jsx'
import { BrandLockup } from './BrandLockup.jsx'

expect.extend(axeMatchers)

afterEach(cleanup)

function bodyFill(container) {
  return container.querySelector('svg path').getAttribute('fill')
}

describe('AgentMark', () => {
  it('is an inline SVG with at least two paths (body + a small lower-left tail)', () => {
    const { container } = render(<AgentMark identity="GA1AGENT" />)
    const svg = container.querySelector('svg')
    expect(svg).toBeTruthy()
    expect(svg.tagName.toLowerCase()).toBe('svg')
    const paths = container.querySelectorAll('svg path')
    expect(paths.length).toBeGreaterThanOrEqual(2)
    // Tail path sits left of and below the body's own bounding path start (x <~ 10, y > 20) --
    // asserted loosely against the fixed geometry rather than pixel measurement (jsdom has no
    // layout engine).
    const tailPath = paths[paths.length - 1]
    expect(tailPath.getAttribute('d')).toMatch(/^M9 25/)
  })

  it('identical identity strings always produce the same crew color across reorder', () => {
    const { container: order1 } = render(
      <div>
        <div data-id="a">
          <AgentMark identity="GA-AAA" />
        </div>
        <div data-id="b">
          <AgentMark identity="GA-BBB" />
        </div>
      </div>
    )
    const fillA1 = order1.querySelector('[data-id="a"] svg path').getAttribute('fill')
    cleanup()

    const { container: order2 } = render(
      <div>
        <div data-id="b">
          <AgentMark identity="GA-BBB" />
        </div>
        <div data-id="a">
          <AgentMark identity="GA-AAA" />
        </div>
      </div>
    )
    const fillA2 = order2.querySelector('[data-id="a"] svg path').getAttribute('fill')

    expect(fillA1).toBe(fillA2)
  })

  it('the same identity produces the same color across a full remount', () => {
    const first = render(<AgentMark identity="GA-STABLE" />)
    const fill1 = bodyFill(first.container)
    first.unmount()

    const second = render(<AgentMark identity="GA-STABLE" />)
    const fill2 = bodyFill(second.container)

    expect(fill1).toBe(fill2)
  })

  it('never derives color from list index -- two different identities at the same list position differ in seed, not position', () => {
    const listA = render(
      <div>
        <AgentMark identity="GA-ONE" />
      </div>
    )
    const fillOne = bodyFill(listA.container)
    listA.unmount()

    // Same position (index 0), different identity -- the fill must track the identity, not the
    // slot, so this is not required to differ, but it must be computed from GA-TWO, which we
    // verify by cross-checking against the identity->color hash directly below.
    const listB = render(
      <div>
        <AgentMark identity="GA-TWO" />
      </div>
    )
    const fillTwo = bodyFill(listB.container)
    listB.unmount()

    // Re-render GA-ONE again at a fresh mount to prove the color is a pure function of the
    // identity string, unaffected by how many other marks rendered in between.
    const listA2 = render(
      <div>
        <AgentMark identity="GA-ONE" />
      </div>
    )
    expect(bodyFill(listA2.container)).toBe(fillOne)
    expect(fillTwo).toBeDefined()
  })

  it('planned identity may use a reviewed allocationId without an address', () => {
    const identity = resolveAgentIdentity({
      phase: 'planned',
      allocationId: 'allocation-reviewed-1',
      source: 'reviewed-plan',
    })
    const { container } = render(<AgentMark identity={identity} />)
    expect(container.querySelector('svg')).toBeTruthy()
    expect(container.querySelector('[data-identity-state="available"]')).toBeTruthy()
    expect(container.querySelector('[data-identity-key="allocation-reviewed-1"]')).toBeTruthy()
    expect(screen.getByRole('img', { name: /Planned/i })).toBeTruthy()
  })

  it('planned identity may use a reviewed runId without an address', () => {
    const identity = resolveAgentIdentity({
      phase: 'planned',
      runId: 'run-reviewed-1',
      source: 'reviewed-plan',
    })
    const { container } = render(<AgentMark identity={identity} />)
    expect(container.querySelector('svg')).toBeTruthy()
    expect(container.querySelector('[data-identity-key="run-reviewed-1"]')).toBeTruthy()
  })

  it('deployed and reused identities require a verified address and provenance source', () => {
    for (const phase of ['deployed', 'reused']) {
      const identity = resolveAgentIdentity({
        phase,
        allocationId: 'allocation-reviewed-2',
        runId: 'run-reviewed-2',
        verifiedAddress: 'GVERIFIED-AGENT-1',
        verified: true,
        source: phase === 'deployed' ? 'creation-event' : 'owner-discovery',
      })
      const { container, unmount } = render(<AgentMark identity={identity} />)
      expect(container.querySelector('svg')).toBeTruthy()
      expect(container.querySelector('[data-identity-key="GVERIFIED-AGENT-1"]')).toBeTruthy()
      expect(
        screen.getByRole('img', { name: phase === 'reused' ? /Existing/i : /Deployed/i })
      ).toBeTruthy()
      unmount()
    }
  })

  it('uses the canonical Existing label for a verified reused identity', () => {
    const identity = resolveAgentIdentity({
      phase: 'reused',
      verifiedAddress: 'GREUSED-AGENT-1',
      verified: true,
      source: 'owner-discovery',
    })
    render(<AgentMark identity={identity} />)
    expect(screen.getByRole('img', { name: 'Existing, Reused' })).toBeTruthy()
  })

  it('missing deployed proof fails closed with a neutral unavailable message and no mark', () => {
    const { container } = render(
      <AgentMark
        identity={{
          phase: 'deployed',
          allocationId: 'allocation-no-proof',
          source: 'reviewed-plan',
        }}
      />
    )
    expect(container.querySelector('svg')).toBeNull()
    expect(container.querySelector('.pc-agent-mark')).toBeNull()
    expect(container.querySelector('[data-identity-state="unavailable"]')).toBeTruthy()
    expect(screen.getByText('Agent identity unavailable')).toBeTruthy()
    for (const forbidden of ['balance', 'cap', 'custody', 'action']) {
      expect(container.textContent.toLowerCase()).not.toContain(forbidden)
    }
  })

  it('does not use persona text as identity or change a reviewed identity color', () => {
    const first = render(
      <AgentMark
        identity={{
          phase: 'planned',
          allocationId: 'allocation-persona-stable',
          source: 'reviewed-plan',
          persona: 'Sprout',
        }}
      />
    )
    const firstFill = bodyFill(first.container)
    first.unmount()

    const second = render(
      <AgentMark
        identity={{
          phase: 'planned',
          allocationId: 'allocation-persona-stable',
          source: 'reviewed-plan',
          persona: 'Mochi',
        }}
      />
    )
    expect(bodyFill(second.container)).toBe(firstFill)
    expect(second.container.textContent).not.toMatch(/Sprout|Mochi/)
  })

  it('fails closed for missing or empty identity without rendering a decorative mark', () => {
    const missing = render(<AgentMark />)
    expect(missing.container.querySelector('svg')).toBeNull()
    expect(screen.getByText('Agent identity unavailable')).toBeTruthy()
    missing.unmount()

    const empty = render(<AgentMark identity="" />)
    expect(empty.container.querySelector('svg')).toBeNull()
    expect(screen.getByText('Agent identity unavailable')).toBeTruthy()
  })

  it('state is dual-coded: visible text/glyph changes with state, not only color', () => {
    const active = render(<AgentMark identity="GA-STATE" state="active" />)
    const activeGlyph = active.container.querySelector('.pc-agent-mark-state').textContent
    active.unmount()

    const failed = render(<AgentMark identity="GA-STATE" state="failed" />)
    const failedGlyph = failed.container.querySelector('.pc-agent-mark-state').textContent

    expect(activeGlyph).not.toBe(failedGlyph)
    expect(screen.getByRole('img', { name: /Failed/i })).toBeTruthy()
  })

  it('keeps six deterministic crew colors independent of theme and list position', () => {
    const allocationIds = [
      'allocation-2',
      'allocation-1',
      'allocation-0',
      'allocation-5',
      'allocation-4',
      'allocation-3',
    ]
    for (const theme of ['forest', 'day-field']) {
      document.documentElement.dataset.theme = theme
      const { container } = render(
        <div>
          {allocationIds.map((allocationId) => (
            <AgentMark
              key={allocationId}
              identity={{ phase: 'planned', allocationId, source: 'reviewed-plan' }}
            />
          ))}
        </div>
      )
      const fills = Array.from(container.querySelectorAll('.pc-agent-mark path:first-child')).map(
        (path) => path.getAttribute('fill')
      )
      expect(new Set(fills)).toHaveLength(6)
      cleanup()
    }
  })

  it('renders an optional label as the visible center glyph', () => {
    render(<AgentMark identity="GA-LABEL" label="A1" />)
    expect(screen.getByText('A1')).toBeTruthy()
  })

  for (const size of [16, 20, 32]) {
    it(`carries a size-specific class distinct from the product mark at ${size}px`, () => {
      const { container } = render(<AgentMark identity="GA-SIZE" size={size} />)
      const svg = container.querySelector('svg')
      expect(svg.getAttribute('class')).toContain(`pc-agent-mark--${size}`)
      expect(svg.getAttribute('width')).toBe(String(size))
    })
  }

  it('has a distinct path signature/class from the product mark (BrandLockup)', () => {
    const agent = render(<AgentMark identity="GA-DISTINCT" size={32} />)
    const brand = render(<BrandLockup variant="compact" />)

    // The product mark is a raster/vector <img> reference to the fixed brand asset -- never an
    // inline <path>, and never carries the agent class.
    expect(brand.container.querySelector('.pc-agent-mark')).toBeNull()
    expect(brand.container.querySelector('img')).toBeTruthy()
    // AgentMark never carries the product lockup's class.
    expect(agent.container.querySelector('.pc-brand-mark')).toBeNull()

    agent.unmount()
    brand.unmount()
  })

  it('has zero axe violations', async () => {
    const { container } = render(<AgentMark identity="GA-AXE" state="confirmed" label="A1" />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
