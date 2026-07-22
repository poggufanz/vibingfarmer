// frontend/src/graph/palette.js
// State palette + node state mappers for the swarm graph. Literal colors mirror
// Pocket Crew semantics because canvas/WebGL cannot resolve CSS custom properties.

import { isLightTheme } from '../design/theme.js'

export const GRAPH_COLOR = {
  idle: '#8C9B93',
  running: '#DFF56C',
  confirmed: '#F2F5EF',
  skipped: '#536159',
  failed: '#E26E67',
}
export const GRAPH_COLOR_LIGHT = {
  idle: '#5F6C65',
  running: '#17251F',
  confirmed: '#20342B',
  skipped: '#5F6C65',
  failed: '#A8403C',
}
export const GROUP_BASE = {
  orchestrator: '#DFF56C',
  vault: '#F2F5EF',
  keeper: '#A8B5AD',
  strategy: '#8C9B93',
  pool: '#A8B5AD',
}
export const GROUP_BASE_LIGHT = {
  orchestrator: '#17251F',
  vault: '#20342B',
  keeper: '#536159',
  strategy: '#5F6C65',
  pool: '#536159',
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
    line: '#536159',
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
