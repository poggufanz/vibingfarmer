/* @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

const pixiTestState = vi.hoisted(() => ({
  canInit: false,
  apps: [],
  resizeObservers: [],
}))

const sceneTestMock = vi.hoisted(() => ({
  createScene: vi.fn(() => ({
    destroy: vi.fn(),
    relayout: vi.fn(),
    setExecMap: vi.fn(),
    setPalette: vi.fn(),
    setReduced: vi.fn(),
    pulse: vi.fn(),
  })),
}))

// jsdom has no WebGL — make app.init reject so the component takes the fallback path,
// which is exactly what happens in a real GL-less environment.
vi.mock('pixi.js', () => ({
  Application: class {
    constructor() {
      this.canvas = document.createElement('canvas')
      this.renderer = {
        resize: vi.fn((width, height) => {
          // Pixi's renderer keeps the backing-store dimensions and also writes pixel CSS
          // dimensions. The component must replace only the latter with a responsive CSS box.
          this.canvas.width = width
          this.canvas.height = height
          this.canvas.style.width = `${width}px`
          this.canvas.style.height = `${height}px`
        }),
      }
      this.ticker = {
        started: true,
        stop: vi.fn(() => {
          this.ticker.started = false
        }),
        start: vi.fn(() => {
          this.ticker.started = true
        }),
      }
      pixiTestState.apps.push(this)
    }

    async init(options) {
      this.initOptions = options
      if (!pixiTestState.canInit) throw new Error('no gl in jsdom')
      this.renderer.resize(options.width, options.height)
    }

    destroy() {
      this.destroyed = true
    }
  },
}))

vi.mock('./scene.js', () => ({
  createScene: (...args) => sceneTestMock.createScene(...args),
}))

import { PixiSwarmGraph } from './PixiSwarmGraph.jsx'

afterEach(() => {
  cleanup()
  pixiTestState.canInit = false
  pixiTestState.apps.length = 0
  pixiTestState.resizeObservers.length = 0
  delete globalThis.ResizeObserver
  sceneTestMock.createScene.mockClear()
})

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

describe('PixiSwarmGraph responsive canvas sizing', () => {
  it('keeps the canvas CSS box responsive independently of Pixi backing dimensions', async () => {
    pixiTestState.canInit = true
    globalThis.ResizeObserver = class {
      constructor(callback) {
        this.callback = callback
        pixiTestState.resizeObservers.push(this)
      }

      observe(element) {
        this.element = element
      }

      disconnect() {}
    }

    const { container } = render(
      <PixiSwarmGraph graphData={cluster} execMap={{}} paletteIsLight={false} />
    )
    const wrapper = container.querySelector('.agent-graph')
    let width = 878
    Object.defineProperties(wrapper, {
      clientWidth: { configurable: true, get: () => width },
      clientHeight: { configurable: true, get: () => 358 },
    })

    await waitFor(() => expect(wrapper.querySelector('canvas')).toBeTruthy())
    const app = pixiTestState.apps[0]
    const canvas = wrapper.querySelector('canvas')
    expect(app.initOptions.width).toBe(878)
    expect(pixiTestState.resizeObservers).toHaveLength(1)
    expect(canvas.style.width).toBe('100%')
    expect(canvas.style.height).toBe('100%')
    expect(canvas.width).toBe(878)
    expect(canvas.height).toBe(358)

    // A closed <details> can suppress ResizeObserver delivery while its canvas remains mounted.
    // When a current content measurement does arrive, the CSS box must still follow its parent
    // even though Pixi rewrites its backing-store CSS dimensions during renderer.resize().
    width = 260
    pixiTestState.resizeObservers[0].callback([{ contentRect: { width, height: 358 } }])

    await waitFor(() => expect(app.renderer.resize).toHaveBeenCalledWith(260, 358))
    expect(canvas.style.width).toBe('100%')
    expect(canvas.style.height).toBe('100%')
    expect(canvas.width).toBe(260)
    expect(canvas.height).toBe(358)
  })
})
