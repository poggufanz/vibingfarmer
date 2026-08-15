// frontend/src/graph/PixiSwarmGraph.jsx
// Pixi-rendered swarm graph — drop-in replacement for the old force-graph AgentGraph.
// Same props contract; pixi.js is lazy-imported so the main bundle stays lean, and a
// static DOM fallback renders when WebGL/WebGPU is unavailable (jsdom included).
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { buildGraphData } from './topology.js'
import { layoutGraph } from './layout.js'
import { nodeColor, paletteFor } from './palette.js'
import { createScene } from './scene.js'

const REDUCED_MQ = '(prefers-reduced-motion: reduce)'

// Pixi's renderer resize updates both the backing-store dimensions and the canvas's inline CSS
// width/height in pixels. Keep the backing store authoritative for rendering, but let layout own
// the CSS box so a canvas mounted in a disclosure follows its available content width through
// responsive reflow and CSS zoom.
const keepCanvasInLayoutBox = (canvas) => {
  canvas.style.width = '100%'
  canvas.style.height = '100%'
}

// pixijs-application skill (Common Mistakes / destroy): pass releaseGlobalResources so
// global pools (batches, texture caches) drain on teardown — without it, re-creating an
// Application in the same tab (React StrictMode double-mount, or remount on new data)
// is the usual cause of flickering and stale textures on the second init.
const safeDestroy = (app) => {
  try {
    app?.destroy(
      { removeView: true, releaseGlobalResources: true },
      { children: true, texture: true, textureSource: true }
    )
  } catch {
    // an app whose init() rejected has nothing valid to destroy
  }
}

export function PixiSwarmGraph({
  strategy,
  execMap = {},
  onAgentClick,
  paletteIsLight,
  graphData,
  pulseEdge,
  paused = false,
}) {
  const wrapRef = useRef(null)
  const sceneRef = useRef(null)
  const appRef = useRef(null)
  // latest-value refs so the async init and the scene always see current props
  const latest = useRef({})
  latest.current = { execMap, paletteIsLight, onAgentClick, paused }
  const [fallback, setFallback] = useState(false)
  const data = useMemo(
    () => graphData || (strategy ? buildGraphData(strategy) : { nodes: [], links: [] }),
    [strategy, graphData]
  )

  useEffect(() => {
    const el = wrapRef.current
    if (!el || fallback || !data.nodes.length) return undefined
    let disposed = false
    let app = null
    let ro = null
    let mq = null
    let onMq = null
    ;(async () => {
      try {
        const PIXI = await import('pixi.js')
        if (disposed) return
        app = new PIXI.Application()
        await app.init({
          backgroundAlpha: 0,
          antialias: true,
          autoDensity: true,
          resolution: Math.min(window.devicePixelRatio || 1, 2),
          width: Math.max(el.clientWidth, 10),
          height: Math.max(el.clientHeight, 10),
        })
        if (disposed) {
          safeDestroy(app)
          app = null
          return
        }
        app.canvas.style.position = 'absolute'
        app.canvas.style.inset = '0'
        keepCanvasInLayoutBox(app.canvas)
        el.appendChild(app.canvas)
        const scene = createScene(PIXI, app, {
          data,
          execMap: latest.current.execMap,
          paletteIsLight: latest.current.paletteIsLight,
          reducedMotion: window.matchMedia?.(REDUCED_MQ)?.matches || false,
          onWorkerClick: (id) => latest.current.onAgentClick?.(id),
        })
        sceneRef.current = scene
        appRef.current = app
        // `paused` may already have flipped true while init() was still resolving (e.g. a
        // disclosure closed again before Pixi finished loading) -- apply the CURRENT value here
        // rather than always starting the ticker, or a fast close/reopen would leave it running.
        if (latest.current.paused) app.ticker.stop()
        // Reads Pixi's OWN `ticker.started` back onto the DOM -- a test observing only the
        // `paused` prop below could pass even if the stop()/start() wiring were silently removed
        // (the prop would still say the right thing; the ticker would not). This is real Pixi
        // state, not an echo of the prop that requested it.
        if (el.isConnected) el.dataset.tickerStarted = String(app.ticker.started)
        ro = new ResizeObserver(([entry]) => {
          const { width, height } = entry.contentRect
          if (width > 0 && height > 0) {
            app.renderer.resize(width, height)
            keepCanvasInLayoutBox(app.canvas)
            scene.relayout(width, height)
          }
        })
        ro.observe(el)
        mq = window.matchMedia?.(REDUCED_MQ) || null
        onMq = () => scene.setReduced(mq.matches)
        mq?.addEventListener?.('change', onMq)
      } catch (err) {
        if (!disposed) {
          console.warn('PixiSwarmGraph: falling back to static render', err)
          safeDestroy(app)
          app = null
          setFallback(true)
        }
      }
    })()
    return () => {
      disposed = true
      ro?.disconnect()
      if (mq && onMq) mq.removeEventListener?.('change', onMq)
      sceneRef.current?.destroy()
      sceneRef.current = null
      appRef.current = null
      safeDestroy(app)
      app = null
    }
  }, [data, fallback])

  useEffect(() => {
    sceneRef.current?.setExecMap(execMap)
  }, [execMap])
  useEffect(() => {
    sceneRef.current?.setPalette(paletteIsLight)
  }, [paletteIsLight])
  useEffect(() => {
    if (pulseEdge?.key) sceneRef.current?.pulse(pulseEdge.key)
  }, [pulseEdge?.key, pulseEdge?.ts])
  // `paused` (e.g. driven by a parent disclosure's own open/close) stops/starts the SAME ticker
  // rather than destroying/recreating the Application -- positions, particles and node state all
  // survive a close/reopen exactly as they were, only the per-frame advance halts. A no-op default
  // (false) for every caller that doesn't pass it (src/agents.jsx's always-visible graph).
  useEffect(() => {
    const ticker = appRef.current?.ticker
    if (!ticker) return
    if (paused) ticker.stop()
    else ticker.start()
    if (wrapRef.current) wrapRef.current.dataset.tickerStarted = String(ticker.started)
  }, [paused])

  return (
    <div
      className="agent-graph"
      ref={wrapRef}
      style={{ position: 'relative' }}
      data-graph-paused={paused ? 'true' : 'false'}
    >
      {fallback && (
        <StaticGraphFallback
          data={data}
          execMap={execMap}
          paletteIsLight={paletteIsLight}
          onAgentClick={onAgentClick}
        />
      )}
    </div>
  )
}

// No-animation fallback: same layout, plain positioned DOM. AgentTiles below the graph
// stays the source of truth; this only keeps the topology visible.
function StaticGraphFallback({ data, execMap, paletteIsLight, onAgentClick }) {
  const palette = paletteFor(!!paletteIsLight)
  const { positions } = layoutGraph(data, 100, 100)
  return (
    <div className="agent-graph-fallback" style={{ position: 'absolute', inset: 0 }}>
      {data.nodes.map((n) => {
        const p = positions.get(n.id) || { x: 50, y: 50 }
        const style = {
          position: 'absolute',
          left: `${p.x}%`,
          top: `${p.y}%`,
          transform: 'translate(-50%, -50%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 2,
          background: 'none',
          border: 0,
          padding: 0,
        }
        const dot = (
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: nodeColor(n, execMap, palette),
              display: 'inline-block',
            }}
          />
        )
        const label = (
          <span className="mono" style={{ fontSize: 9, color: palette.label }}>
            {n.name}
          </span>
        )
        return n.kind === 'worker' ? (
          <button
            key={n.id}
            type="button"
            style={{ ...style, cursor: 'pointer' }}
            onClick={() => onAgentClick?.(n.id)}
          >
            {dot}
            {label}
          </button>
        ) : (
          <span key={n.id} style={style}>
            {dot}
            {label}
          </span>
        )
      })}
    </div>
  )
}
