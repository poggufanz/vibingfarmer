// frontend/src/graph/scene.js
// Pixi scene for the swarm graph — the only module that touches pixi objects.
// The React wrapper owns the Application; this builds/updates the stage.
import { layoutGraph, conduitControl, pointOnQuadratic } from './layout.js'
import { NODE_R, hexToNum, paletteFor, nodeColor, nodeStateOf } from './palette.js'
import {
  edgeFlow,
  advanceParticles,
  spawnFor,
  MAX_PARTICLES,
  EDGE_PARTICLE_CAP,
} from './current.js'
import {
  corePulseScale,
  coronaAlpha,
  settleRing,
  failFlicker,
  waveT,
  spawnDust,
  stepDust,
  DUST_COUNT,
} from './fx.js'

const SCALE = 2.2 // NODE_R was tuned for the old zoom-fitted canvas; upscale to pixel space
const GLOW_SIZE = 64
const LABEL_LOD_W = 520
const HOT_TINT = 0xf0b54a

const makeGlowTexture = (PIXI) => {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = GLOW_SIZE
  const ctx = canvas.getContext('2d')
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.35, 'rgba(255,255,255,0.55)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, GLOW_SIZE, GLOW_SIZE)
  return PIXI.Texture.from(canvas)
}

export function createScene(
  PIXI,
  app,
  { data, execMap, paletteIsLight, reducedMotion, onWorkerClick }
) {
  let isLight = !!paletteIsLight
  let palette = paletteFor(isLight)
  let exec = execMap || {}
  let reduced = !!reducedMotion
  let w = app.screen.width
  let h = app.screen.height
  let tMs = 0
  let wave = null // { key, startMs }
  const fxQueue = [] // { id, kind: 'settle' | 'flicker', startMs }
  const prevState = new Map()
  const destroyCbs = []

  const glowTex = makeGlowTexture(PIXI)
  const root = new PIXI.Container()
  app.stage.addChild(root)

  // layers bottom→top: dust, conduits, current, nodes
  const dustPC = new PIXI.ParticleContainer({
    texture: glowTex,
    dynamicProperties: { position: true, color: false },
    boundsArea: new PIXI.Rectangle(0, 0, w, h),
  })
  dustPC.blendMode = 'add'
  const conduitG = new PIXI.Graphics()
  const currentPC = new PIXI.ParticleContainer({
    texture: glowTex,
    dynamicProperties: { position: true, color: true, vertex: true },
    boundsArea: new PIXI.Rectangle(0, 0, w, h),
  })
  currentPC.blendMode = 'add'
  const nodeLayer = new PIXI.Container()
  root.addChild(dustPC, conduitG, currentPC, nodeLayer)

  // static pools — Particle instances are reused, only their fields change per frame
  const pool = Array.from(
    { length: MAX_PARTICLES },
    () => new PIXI.Particle({ texture: glowTex, anchorX: 0.5, anchorY: 0.5, alpha: 0 })
  )
  pool.forEach((p) => currentPC.addParticle(p))
  let dust = spawnDust(w, h, DUST_COUNT)
  const dustPool = dust.map(
    (d) =>
      new PIXI.Particle({
        texture: glowTex,
        x: d.x,
        y: d.y,
        scaleX: (d.size * 4) / GLOW_SIZE,
        scaleY: (d.size * 4) / GLOW_SIZE,
        anchorX: 0.5,
        anchorY: 0.5,
        alpha: d.alpha,
        tint: hexToNum(palette.dust),
      })
  )
  dustPool.forEach((p) => dustPC.addParticle(p))

  const nodesById = new Map(data.nodes.map((n) => [n.id, n]))
  let positions = layoutGraph(data, w, h).positions

  const labelBaseAlpha = (node) =>
    w < LABEL_LOD_W && (node.kind === 'step' || node.kind === 'pool') ? 0 : 0.85

  const views = data.nodes.map((node) => {
    const c = new PIXI.Container()
    const r = (NODE_R[node.kind] || 5) * SCALE
    const glow = new PIXI.Sprite({ texture: glowTex, anchor: 0.5 })
    glow.blendMode = 'add'
    glow.scale.set((r * 3.4) / GLOW_SIZE)
    glow.alpha = 0.22
    const orb = new PIXI.Graphics()
    const ring = new PIXI.Graphics()
    ring.alpha = 0
    const label = new PIXI.Text({
      text: node.name,
      style: {
        fontFamily: 'Geist, sans-serif',
        fontSize: 11,
        fontWeight: '600',
        fill: palette.label,
      },
      resolution: 2,
    })
    label.anchor.set(0.5, 0)
    label.y = r + 4
    label.scale.set(0.85)
    c.addChild(glow, orb, ring, label)
    const p = positions.get(node.id) || { x: w / 2, y: h / 2 }
    c.position.set(p.x, p.y)
    const view = { node, c, glow, orb, ring, label, r, target: { x: p.x, y: p.y } }
    if (node.kind === 'worker') {
      c.eventMode = 'static'
      c.cursor = 'pointer'
      c.hitArea = new PIXI.Circle(0, 0, r + 8)
      c.on('pointertap', () => onWorkerClick?.(node.id))
      c.on('pointerover', () => {
        ring.alpha = 0.9
        label.alpha = 1
      })
      c.on('pointerout', () => {
        ring.alpha = 0
        label.alpha = labelBaseAlpha(node)
      })
    }
    nodeLayer.addChild(c)
    return view
  })
  const viewById = new Map(views.map((v) => [v.node.id, v]))
  const edges = data.links.map((l) => ({
    source: l.source,
    target: l.target,
    pulseKey: l.pulseKey || null,
    particles: [],
  }))

  const stateOf = (id) => nodeStateOf(nodesById.get(id) || {}, exec)

  const edgeGeom = (e) => {
    const a = viewById.get(e.source)?.c.position
    const b = viewById.get(e.target)?.c.position
    if (!a || !b) return null
    return { a, b, c: conduitControl(a, b) }
  }

  const drawNode = (v) => {
    const color = hexToNum(nodeColor(v.node, exec, palette))
    v.orb
      .clear()
      .circle(0, 0, v.r)
      .fill({ color })
      .stroke({ width: 1, color: isLight ? 0x000000 : 0xffffff, alpha: 0.16 })
    v.ring
      .clear()
      .circle(0, 0, v.r + 4)
      .stroke({ width: 1.5, color: hexToNum(palette.current), alpha: 1 })
    v.glow.tint = color
    v.label.style.fill = palette.label
    v.label.alpha = labelBaseAlpha(v.node)
  }

  const drawConduits = () => {
    conduitG.clear()
    edges.forEach((e) => {
      const g = edgeGeom(e)
      if (!g) return
      const f = edgeFlow(stateOf(e.source), stateOf(e.target))
      const isWave = wave && e.pulseKey && e.pulseKey === wave.key
      const color = isWave ? hexToNum(palette.current) : hexToNum(palette.line)
      const alpha = isWave ? 0.9 : f === 'off' ? 0.1 : f === 'hot' ? 0.45 : 0.25
      conduitG
        .moveTo(g.a.x, g.a.y)
        .quadraticCurveTo(g.c.x, g.c.y, g.b.x, g.b.y)
        .stroke({ width: isWave ? 2.5 : 1.2, color, alpha })
    })
  }

  const seedReducedParticles = () => {
    edges.forEach((e) => {
      const f = edgeFlow(stateOf(e.source), stateOf(e.target))
      e.particles =
        f === 'off'
          ? []
          : [
              { t: 0.3, speed: 0, size: 1, hot: f === 'hot' },
              { t: 0.7, speed: 0, size: 1, hot: f === 'hot' },
            ]
    })
  }

  // ponytail: pool writes mutate Particle fields in place — per-frame allocation is the
  // thing being avoided; the logic layer above (advanceParticles) stays pure.
  const renderCurrent = (dt) => {
    let used = 0
    const waveElapsed = wave ? tMs - wave.startMs : 0
    edges.forEach((e) => {
      const g = edgeGeom(e)
      if (!g) {
        e.particles = []
        return
      }
      const f = edgeFlow(stateOf(e.source), stateOf(e.target))
      if (!reduced) {
        e.particles = advanceParticles(e.particles, dt)
        const spawned = spawnFor(f, Math.random)
        if (spawned && e.particles.length < EDGE_PARTICLE_CAP) e.particles.push(spawned)
        if (wave && e.pulseKey === wave.key) {
          const t = waveT(waveElapsed)
          if (t != null && e.particles.length < EDGE_PARTICLE_CAP) {
            e.particles.push({ t, speed: 0.002, size: 2.2, hot: false, wave: true })
          }
        }
      }
      e.particles.forEach((p) => {
        if (used >= MAX_PARTICLES) return
        const pos = pointOnQuadratic(g.a, g.c, g.b, p.t)
        const px = pool[used++]
        px.x = pos.x
        px.y = pos.y
        const s = (p.size * 7) / GLOW_SIZE
        px.scaleX = s
        px.scaleY = s
        px.tint = p.wave ? hexToNum(palette.current) : p.hot ? HOT_TINT : hexToNum(palette.current)
        px.alpha = p.wave ? 1 : p.hot ? 0.9 : 0.55
      })
    })
    for (let i = used; i < MAX_PARTICLES; i++) pool[i].alpha = 0
  }

  const anyTweening = () =>
    views.some((v) => Math.abs(v.c.x - v.target.x) + Math.abs(v.c.y - v.target.y) > 0.5)

  const tick = (ticker) => {
    tMs += ticker.deltaMS
    const dt = ticker.deltaTime
    const tweening = anyTweening()
    if (tweening) {
      views.forEach((v) => {
        v.c.x += (v.target.x - v.c.x) * Math.min(1, 0.12 * dt)
        v.c.y += (v.target.y - v.c.y) * Math.min(1, 0.12 * dt)
      })
      drawConduits()
    }
    views.forEach((v) => {
      const running = nodeStateOf(v.node, exec) === 'running'
      if (v.node.kind === 'orchestrator' && !reduced) v.c.scale.set(corePulseScale(tMs))
      v.glow.alpha = running ? (reduced ? 0.5 : coronaAlpha(tMs)) : 0.22
    })
    for (let i = fxQueue.length - 1; i >= 0; i--) {
      const fx = fxQueue[i]
      const v = viewById.get(fx.id)
      const elapsed = tMs - fx.startMs
      if (!v) {
        fxQueue.splice(i, 1)
        continue
      }
      if (fx.kind === 'settle') {
        const env = settleRing(elapsed)
        if (!env) {
          v.ring.alpha = 0
          v.ring.scale.set(1)
          fxQueue.splice(i, 1)
        } else {
          v.ring.alpha = env.alpha
          v.ring.scale.set(env.scale)
        }
      } else {
        const env = failFlicker(elapsed)
        if (!env) {
          v.orb.alpha = 1
          fxQueue.splice(i, 1)
        } else {
          v.orb.alpha = env.alpha
        }
      }
    }
    if (wave && waveT(tMs - wave.startMs) == null) {
      wave = null
      drawConduits()
    }
    renderCurrent(dt)
    if (!reduced) {
      dust = stepDust(dust, dt, w, h)
      for (let i = 0; i < dustPool.length; i++) {
        dustPool[i].x = dust[i].x
        dustPool[i].y = dust[i].y
      }
    }
  }

  const setExecMap = (next) => {
    exec = next || {}
    let dirty = false
    views.forEach((v) => {
      const s = nodeStateOf(v.node, exec)
      const prev = prevState.get(v.node.id)
      if (prev !== s) {
        prevState.set(v.node.id, s)
        dirty = true
        drawNode(v)
        if (prev && s === 'confirmed') fxQueue.push({ id: v.node.id, kind: 'settle', startMs: tMs })
        if (prev && s === 'failed' && !reduced)
          fxQueue.push({ id: v.node.id, kind: 'flicker', startMs: tMs })
      }
    })
    if (dirty) {
      drawConduits()
      if (reduced) seedReducedParticles()
    }
  }

  const setPalette = (nextIsLight) => {
    isLight = !!nextIsLight
    palette = paletteFor(isLight)
    views.forEach(drawNode)
    drawConduits()
    const dustTint = hexToNum(palette.dust)
    dustPool.forEach((p) => {
      p.tint = dustTint
    })
    dustPC.update() // color is a static property on the dust container
  }

  const setReduced = (nextReduced) => {
    reduced = !!nextReduced
    if (reduced) {
      seedReducedParticles()
      views.forEach((v) => {
        if (v.node.kind === 'orchestrator') v.c.scale.set(1)
      })
    }
  }

  const pulse = (key) => {
    if (!key) return
    wave = { key, startMs: tMs }
    drawConduits()
  }

  const relayout = (width, height) => {
    w = width
    h = height
    positions = layoutGraph(data, w, h).positions
    views.forEach((v) => {
      const p = positions.get(v.node.id)
      if (p) v.target = { x: p.x, y: p.y }
      v.label.alpha = labelBaseAlpha(v.node)
    })
    dustPC.boundsArea = new PIXI.Rectangle(0, 0, w, h)
    currentPC.boundsArea = new PIXI.Rectangle(0, 0, w, h)
    dust = spawnDust(w, h, DUST_COUNT)
  }

  // initial paint
  views.forEach((v) => {
    prevState.set(v.node.id, nodeStateOf(v.node, exec))
    drawNode(v)
  })
  drawConduits()
  if (reduced) seedReducedParticles()
  app.ticker.add(tick)

  return {
    setExecMap,
    setPalette,
    setReduced,
    pulse,
    relayout,
    onDestroy: (cb) => destroyCbs.push(cb),
    destroy: () => {
      app.ticker.remove(tick)
      destroyCbs.forEach((cb) => cb())
      // display objects + textures die with app.destroy in the wrapper
    },
  }
}
