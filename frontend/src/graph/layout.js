// frontend/src/graph/layout.js
// Deterministic layouts — pure functions of ({nodes, links}, w, h). No physics:
// the previous d3-force experiments were unstable and got reverted.

export const detectMode = (nodes = []) => {
  if (nodes.some((n) => n.kind === 'orchestrator')) return 'strategy'
  if (nodes.some((n) => n.kind === 'keeper' || n.kind === 'strategy' || n.kind === 'pool'))
    return 'cluster'
  return 'generic'
}

const STRATEGY_COLS = { orchestrator: 0.07, worker: 0.28, swap: 0.45, approve: 0.6, deposit: 0.75, vault: 0.93 }

const layoutStrategy = (nodes, w, h) => {
  const workers = nodes.filter((n) => n.kind === 'worker')
  const laneY = new Map(workers.map((n, i) => [n.agentId, ((i + 1) / (workers.length + 1)) * h]))
  const pos = new Map()
  nodes.forEach((n) => {
    if (n.kind === 'orchestrator') {
      pos.set(n.id, { x: STRATEGY_COLS.orchestrator * w, y: h / 2 })
      return
    }
    const y = laneY.get(n.agentId) ?? h / 2
    const x =
      n.kind === 'worker'
        ? STRATEGY_COLS.worker
        : n.kind === 'step'
          ? STRATEGY_COLS[n.stepId]
          : STRATEGY_COLS.vault
    pos.set(n.id, { x: x * w, y })
  })
  return pos
}

const layoutCluster = (nodes, links, w, h) => {
  const cx = w / 2
  const cy = h * 0.52
  // Pools sit at 1.65R past the ring — on wide-short canvases (e.g. the /agent Swarm panel)
  // the naive R = min(w,h)*0.3 pushes bottom-bearing pools below the canvas. Clamp R so the
  // outermost pool ring (1.65R) plus label clearance stays within [0, h] both above and below cy.
  const PAD = 28 // pool orb + label clearance
  const R = Math.min(Math.min(w, h) * 0.3, (cy - PAD) / 1.65, (h - cy - PAD) / 1.65)
  const pos = new Map()
  const vault = nodes.find((n) => n.kind === 'vault')
  if (vault) pos.set(vault.id, { x: cx, y: cy })
  const keeper = nodes.find((n) => n.kind === 'keeper')
  const strategies = nodes.filter((n) => n.kind === 'strategy')
  const slots = strategies.length + (keeper ? 1 : 0)
  const angleAt = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(slots, 1)
  let slot = 0
  if (keeper) {
    pos.set(keeper.id, { x: cx + R * Math.cos(angleAt(0)), y: cy + R * Math.sin(angleAt(0)) })
    slot = 1
  }
  const strategyAngle = new Map()
  strategies.forEach((s, i) => {
    const a = angleAt(slot + i)
    strategyAngle.set(s.id, a)
    pos.set(s.id, { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) })
  })
  nodes
    .filter((n) => n.kind === 'pool')
    .forEach((p) => {
      const link = links.find((l) => l.target === p.id || l.source === p.id)
      const parentId = link ? (link.source === p.id ? link.target : link.source) : null
      const a = strategyAngle.get(parentId) ?? Math.PI / 2
      const Rp = R * 1.65
      pos.set(p.id, { x: cx + Rp * Math.cos(a), y: cy + Rp * Math.sin(a) })
    })
  // any node kind we didn't place (defensive) → center
  nodes.forEach((n) => {
    if (!pos.has(n.id)) pos.set(n.id, { x: cx, y: cy })
  })
  return pos
}

const layoutGeneric = (nodes, links, w, h) => {
  const cx = w / 2
  const cy = h / 2
  const pos = new Map()
  if (!nodes.length) return pos
  const degree = new Map(nodes.map((n) => [n.id, 0]))
  links.forEach((l) => {
    degree.set(l.source, (degree.get(l.source) || 0) + 1)
    degree.set(l.target, (degree.get(l.target) || 0) + 1)
  })
  const root = [...nodes].sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0))[0]
  const depth = new Map([[root.id, 0]])
  const queue = [root.id]
  while (queue.length) {
    const id = queue.shift()
    links.forEach((l) => {
      const next = l.source === id ? l.target : l.target === id ? l.source : null
      if (next && !depth.has(next)) {
        depth.set(next, depth.get(id) + 1)
        queue.push(next)
      }
    })
  }
  const maxSeen = Math.max(0, ...depth.values())
  const rings = new Map()
  nodes.forEach((n) => {
    const d = depth.has(n.id) ? depth.get(n.id) : maxSeen + 1 // disconnected → outermost
    if (!rings.has(d)) rings.set(d, [])
    rings.get(d).push(n)
  })
  const step = Math.min(w, h) * 0.16
  rings.forEach((ring, d) => {
    ring.forEach((n, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / ring.length
      pos.set(n.id, { x: cx + d * step * Math.cos(a), y: cy + d * step * Math.sin(a) })
    })
  })
  return pos
}

export const layoutGraph = ({ nodes = [], links = [] } = {}, w, h) => {
  const mode = detectMode(nodes)
  const positions =
    mode === 'strategy'
      ? layoutStrategy(nodes, w, h)
      : mode === 'cluster'
        ? layoutCluster(nodes, links, w, h)
        : layoutGeneric(nodes, links, w, h)
  return { mode, positions }
}

// Quadratic control point perpendicular to the chord — gives conduits a gentle bow.
export const conduitControl = (a, b, bow = 0.12) => {
  const mx = (a.x + b.x) / 2
  const my = (a.y + b.y) / 2
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  return { x: mx - (dy / len) * len * bow, y: my + (dx / len) * len * bow }
}

export const pointOnQuadratic = (a, c, b, t) => {
  const u = 1 - t
  return {
    x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
  }
}
