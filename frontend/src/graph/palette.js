// frontend/src/graph/palette.js
// State palette + node state mappers for the swarm graph. Literal colors mirror
// Pocket Crew semantics because canvas/WebGL cannot resolve CSS custom properties.

import { isLightTheme } from '../design/theme.js'

// `skipped` used to reuse forest.ownedMuted (#536159), a tone calibrated for light
// surfaces only — it read below the 3:1 graphical threshold against the dark canvas
// and workspace. `#7A8F82` / `#6F7D74` are dedicated dark-safe / light-safe grays that
// also keep skipped visually distinct from idle (the day theme previously reused the
// same hex for both, erasing the difference between "never ran" and "deliberately
// skipped"). Group colors for orchestrator/vault previously mirrored the running/
// confirmed state colors exactly, so an idle orchestrator or vault node was
// indistinguishable from an actively running/confirmed one; they now fall back to
// the idle-family grays instead. `pool` no longer collides with `keeper`.
export const GRAPH_COLOR = {
  idle: '#8C9B93',
  running: '#DFF56C',
  confirmed: '#F2F5EF',
  skipped: '#7A8F82',
  failed: '#E26E67',
}
export const GRAPH_COLOR_LIGHT = {
  idle: '#5F6C65',
  running: '#17251F',
  confirmed: '#20342B',
  skipped: '#6F7D74',
  failed: '#A8403C',
}
export const GROUP_BASE = {
  orchestrator: '#A8B5AD',
  vault: '#8C9B93',
  keeper: '#A8B5AD',
  strategy: '#8C9B93',
  pool: '#7A8F82',
}
export const GROUP_BASE_LIGHT = {
  orchestrator: '#536159',
  vault: '#5F6C65',
  keeper: '#536159',
  strategy: '#5F6C65',
  pool: '#6F7D74',
}
export const PULSE_COLOR = '#DFF56C'
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

const lightPreference = (themeOrLight) =>
  typeof themeOrLight === 'boolean' ? themeOrLight : isLightTheme(themeOrLight)

export const paletteFor = (themeOrLight) => {
  const isLight = lightPreference(themeOrLight)
  return {
    state: isLight ? GRAPH_COLOR_LIGHT : GRAPH_COLOR,
    group: isLight ? GROUP_BASE_LIGHT : GROUP_BASE,
    // Line color mirrors `skipped` and must stay theme-aware — it used to be a
    // hardcoded light-surface tone that fell below 3:1 against the dark canvas.
    line: isLight ? GRAPH_COLOR_LIGHT.skipped : GRAPH_COLOR.skipped,
    label: isLight ? '#17251F' : '#F2F5EF',
    current: isLight ? '#17251F' : PULSE_COLOR,
    dust: isLight ? '#5F6C65' : '#8C9B93',
  }
}

export const computeOrchestratorState = (execMap) => {
  const vals = Object.values(execMap || {})
  if (vals.some((a) => a.status === 'failed')) return 'failed'
  if (vals.length > 0 && vals.every((a) => a.status === 'confirmed')) return 'confirmed'
  if (vals.some((a) => a.status === 'running')) return 'running'
  return 'idle'
}

const stepState = (ex) => {
  const d = ex.steps?.deposit
  return d === 'confirmed'
    ? 'confirmed'
    : d === 'running'
      ? 'running'
      : d === 'failed'
        ? 'failed'
        : 'idle'
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
  const group = palette.group || GROUP_BASE
  if (s === 'static') return group[node.kind]
  if (s === 'idle' && node.kind === 'orchestrator') return group.orchestrator
  if (s === 'idle' && node.kind === 'vault') return group.vault
  return palette.state[s] || palette.state.idle
}

export const nodeRunning = (node, execMap) => nodeStateOf(node, execMap) === 'running'
