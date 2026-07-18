/* @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

// jsdom has no WebGL — make app.init reject so the component takes the fallback path,
// which is exactly what happens in a real GL-less environment.
vi.mock('pixi.js', () => ({
  Application: class {
    async init() {
      throw new Error('no gl in jsdom')
    }
    destroy() {}
  },
}))

import { PixiSwarmGraph } from './PixiSwarmGraph.jsx'

afterEach(cleanup)

const cluster = {
  nodes: [
    { id: 'V', name: 'Autofarm vault', kind: 'vault' },
    { id: 'K', name: 'Keeper', kind: 'keeper' },
  ],
  links: [{ source: 'K', target: 'V', pulseKey: 'K->V' }],
}

describe('PixiSwarmGraph fallback', () => {
  it('renders the static DOM fallback when pixi cannot init', async () => {
    render(<PixiSwarmGraph graphData={cluster} execMap={{}} paletteIsLight={false} />)
    expect(await screen.findByText('Keeper')).toBeTruthy()
    expect(screen.getByText('Autofarm vault')).toBeTruthy()
  })

  it('renders nothing without data', () => {
    const { container } = render(<PixiSwarmGraph execMap={{}} />)
    expect(container.querySelector('.agent-graph')).toBeTruthy()
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })

  it('fallback worker node click calls onAgentClick with the worker id', async () => {
    const strategy = {
      agents: [{ id: 'worker-1', idx: '01', vault: { protocol: 'Blend', apy: '6.2' } }],
    }
    const onClick = vi.fn()
    render(<PixiSwarmGraph strategy={strategy} execMap={{}} onAgentClick={onClick} />)
    const btn = await screen.findByRole('button', { name: /W01/ })
    fireEvent.click(btn)
    expect(onClick).toHaveBeenCalledWith('worker-1')
  })
})
