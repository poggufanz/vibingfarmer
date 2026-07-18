// frontend/src/graph/current.js
// Particle-current logic — renderer-agnostic. A particle is {t, speed, size, hot}
// riding an edge's quadratic path at parameter t ∈ [0,1].

export const MAX_PARTICLES = 300
export const EDGE_PARTICLE_CAP = 24

// spawn probability per frame per edge / parameter-speed per frame @60fps
const FLOW_RATE = { off: 0, idle: 0.02, calm: 0.012, hot: 0.09 }
const FLOW_SPEED = { idle: 0.004, calm: 0.003, hot: 0.011 }

export const edgeFlow = (sourceState, targetState) => {
  if (sourceState === 'failed' || targetState === 'failed') return 'off'
  if (sourceState === 'running' || targetState === 'running') return 'hot'
  if (sourceState === 'confirmed' && targetState === 'confirmed') return 'calm'
  return 'idle'
}

export const advanceParticles = (particles, delta) =>
  particles.map((p) => ({ ...p, t: p.t + p.speed * delta })).filter((p) => p.t <= 1)

export const spawnFor = (flow, rand) => {
  const rate = FLOW_RATE[flow] || 0
  if (rate === 0 || rand() >= rate) return null
  const hot = flow === 'hot'
  return { t: 0, speed: FLOW_SPEED[flow] || FLOW_SPEED.idle, size: hot ? 1.7 : 1, hot }
}
