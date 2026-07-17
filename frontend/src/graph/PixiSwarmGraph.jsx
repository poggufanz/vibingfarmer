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
}) {
  const wrapRef = useRef(null)
  const sceneRef = useRef(null)
  // latest-value refs so the async init and the scene always see current props
  const latest = useRef({})
  latest.current = { execMap, paletteIsLight, onAgentClick }
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
        el.appendChild(app.canvas)
        const scene = createScene(PIXI, app, {
          data,
          execMap: latest.current.execMap,
          paletteIsLight: latest.current.paletteIsLight,
          reducedMotion: window.matchMedia?.(REDUCED_MQ)?.matches || false,
          onWorkerClick: (id) => latest.current.onAgentClick?.(id),
        })
        sceneRef.current = scene
        ro = new ResizeObserver(([entry]) => {
          const { width, height } = entry.contentRect
          if (width > 0 && height > 0) {
            app.renderer.resize(width, height)
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

  return (
    <div className="agent-graph" ref={wrapRef} style={{ position: 'relative' }}>
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
