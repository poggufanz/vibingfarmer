// frontend/src/graph/palette.js
// State palette + node state mappers for the swarm graph. Values mirror the product
// palette (Acid Yield) — literal hex because canvas/webgl can't resolve CSS vars.

export const GRAPH_COLOR = {
  idle: '#3a3b33',
  running: '#f0b54a',
  confirmed: '#6fe39a',
  skipped: '#6b7280',
  failed: '#ff7479',
}
export const GRAPH_COLOR_LIGHT = {
  idle: '#b8b5aa',
  running: '#b07a1a',
  confirmed: '#2d7a4a',
  skipped: '#6b7280',
  failed: '#a83a3a',
}
export const GROUP_BASE = {
  orchestrator: '#cfff3d',
  vault: '#6366f1',
  keeper: '#f0b54a',
  strategy: '#6fe39a',
  pool: '#7a9fff',
}
export const PULSE_COLOR = '#cfff3d'
export const NODE_R = {
  orchestrator: 9,
  worker: 6.5,
  step: 4,
  vault: 6.5,
  keeper: 6.5,
  strategy: 6,
  pool: 5.5,
}

export const hexToNum = (hex) => parseInt(String(hex).replace('#', ''), 16)

export const paletteFor = (isLight) => ({
  state: isLight ? GRAPH_COLOR_LIGHT : GRAPH_COLOR,
  line: isLight ? '#c4c1b8' : '#3a3a32',
  label: isLight ? '#4a4840' : '#cfcdc4',
  current: isLight ? '#7f9e1f' : PULSE_COLOR,
  dust: isLight ? '#8a8778' : '#8f8d7f',
})

export const computeOrchestratorState = (execMap) => {
  const vals = Object.values(execMap || {})
  if (vals.some((a) => a.status === 'failed')) return 'failed'
  if (vals.length > 0 && vals.every((a) => a.status === 'confirmed')) return 'confirmed'
  if (vals.some((a) => a.status === 'running')) return 'running'
  return 'idle'
}

const stepState = (ex) => {
  const d = ex.steps?.deposit
  return d === 'confirmed' ? 'confirmed' : d === 'running' ? 'running' : d === 'failed' ? 'failed' : 'idle'
}

export const nodeStateOf = (node, execMap) => {
  if (node.kind === 'orchestrator') return computeOrchestratorState(execMap)
  if (node.kind === 'keeper' || node.kind === 'strategy' || node.kind === 'pool') return 'static'
  const ex = (execMap || {})[node.agentId] || { status: 'idle', steps: {} }
  if (node.kind === 'worker') return ex.status || 'idle'
  if (node.kind === 'step') return ex.steps?.[node.stepId] || 'idle'
  return stepState(ex) // vault in strategy mode follows the deposit step
}

export const nodeColor = (node, execMap, palette) => {
  const s = nodeStateOf(node, execMap)
  if (s === 'static') return GROUP_BASE[node.kind]
  if (s === 'idle' && node.kind === 'orchestrator') return GROUP_BASE.orchestrator
  if (s === 'idle' && node.kind === 'vault') return GROUP_BASE.vault
  return palette.state[s] || palette.state.idle
}

export const nodeRunning = (node, execMap) => nodeStateOf(node, execMap) === 'running'
