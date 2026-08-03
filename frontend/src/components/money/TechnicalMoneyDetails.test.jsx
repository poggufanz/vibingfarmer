// frontend/src/components/money/TechnicalMoneyDetails.test.jsx
// My Money Task 13 Part B item 8. TechnicalMoneyDetails had no dedicated test file before this --
// MyMoneyRoute.test.jsx (unauthorized here) already proves the DOM-list-before-graph ORDERING
// contract at the route level; this file proves the graph disclosure itself renders REAL agent
// data (not a placeholder that merely occupies the right position in the DOM), and that an empty
// agent list never tries to render a one-node graph of nothing.
//
// pixi.js is mocked exactly like graph/PixiSwarmGraph.test.jsx: jsdom has no WebGL, so
// Application.init() rejects in a real browser-less run too (PixiSwarmGraph.jsx's own header
// comment) -- this mock just keeps the test hermetic/fast rather than changing the code path.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

vi.mock('pixi.js', () => ({
  Application: class {
    async init() {
      throw new Error('no gl in jsdom')
    }
    destroy() {}
  },
}))

import { TechnicalMoneyDetails } from './TechnicalMoneyDetails.jsx'

afterEach(cleanup)

function agent(address) {
  return {
    address,
    scope: { state: 'known', value: { revoked: false, expiry: 0 } },
    executionStatus: 'idle',
    problems: [],
  }
}

describe('TechnicalMoneyDetails — agent network graph (My Money Task 13 Part B item 8)', () => {
  it('renders a real node for every known agent address, not a fabricated/placeholder graph', async () => {
    render(<TechnicalMoneyDetails model={{}} agents={[agent('CAGENT1'), agent('CAGENT2')]} />)
    // jsdom has no WebGL, so PixiSwarmGraph falls back to its static DOM render (StaticGraphFallback)
    // -- real node labels, not a canvas we can't inspect. Awaited because pixi's init rejects async.
    expect(await screen.findByText('CAGENT1')).toBeTruthy()
    expect(await screen.findByText('CAGENT2')).toBeTruthy()
    expect(screen.getByText('Your vault')).toBeTruthy()
    // The old placeholder copy must be gone -- this is a real graph now, not "planned for this space".
    expect(screen.queryByText(/planned for this space/)).toBeNull()
  })

  it('never attempts a graph of nothing when there are no agents', () => {
    render(<TechnicalMoneyDetails model={{}} agents={[]} />)
    expect(screen.getByText('No agents yet to graph.')).toBeTruthy()
    expect(document.querySelector('.agent-graph')).toBeNull()
  })

  it('the graph disclosure never replaces the raw agent scope-fields list above it (DOM order)', async () => {
    render(<TechnicalMoneyDetails model={{}} agents={[agent('CAGENT1')]} />)
    // "Raw agent scope fields" (this component's own earlier disclosure) must still list the real
    // agent -- the graph augments, it does not substitute.
    const rawFieldsRow = screen.getByText(/^CAGENT1: scope=/)
    const graphNode = await screen.findByText('CAGENT1', { selector: 'span' })
    expect(rawFieldsRow).toBeTruthy()
    expect(graphNode).toBeTruthy()
    expect(
      rawFieldsRow.compareDocumentPosition(graphNode) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })
})
