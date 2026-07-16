import { describe, it, expect } from 'vitest'
import {
  GRAPH_COLOR,
  GROUP_BASE,
  NODE_R,
  hexToNum,
  paletteFor,
  computeOrchestratorState,
  nodeStateOf,
  nodeColor,
  nodeRunning,
} from './palette.js'

const exec = {
  'worker-1': { status: 'running', steps: { swap: 'skipped', approve: 'confirmed', deposit: 'running' } },
  'worker-2': { status: 'confirmed', steps: { swap: 'skipped', approve: 'confirmed', deposit: 'confirmed' } },
}

describe('hexToNum', () => {
  it('converts #cfff3d to 0xcfff3d', () => {
    expect(hexToNum('#cfff3d')).toBe(0xcfff3d)
  })
})

describe('paletteFor', () => {
  it('switches state palette by theme', () => {
    expect(paletteFor(false).state).toBe(GRAPH_COLOR)
    expect(paletteFor(true).state.running).toBe('#b07a1a')
    expect(paletteFor(false).line).toBe('#3a3a32')
  })
})

describe('computeOrchestratorState', () => {
  it('running wins over confirmed, failed wins over all, empty = idle', () => {
    expect(computeOrchestratorState(exec)).toBe('running')
    expect(computeOrchestratorState({ a: { status: 'confirmed' } })).toBe('confirmed')
    expect(computeOrchestratorState({ a: { status: 'failed' }, b: { status: 'running' } })).toBe('failed')
    expect(computeOrchestratorState({})).toBe('idle')
  })
})

describe('nodeStateOf / nodeColor / nodeRunning', () => {
  const palette = paletteFor(false)
  it('worker takes its exec status', () => {
    expect(nodeStateOf({ kind: 'worker', agentId: 'worker-1' }, exec)).toBe('running')
    expect(nodeRunning({ kind: 'worker', agentId: 'worker-1' }, exec)).toBe(true)
  })
  it('step takes its per-step state (skipped supported)', () => {
    expect(nodeStateOf({ kind: 'step', agentId: 'worker-1', stepId: 'swap' }, exec)).toBe('skipped')
    expect(nodeColor({ kind: 'step', agentId: 'worker-1', stepId: 'swap' }, exec, palette)).toBe(GRAPH_COLOR.skipped)
  })
  it('strategy-vault follows the deposit step', () => {
    expect(nodeStateOf({ kind: 'vault', agentId: 'worker-2' }, exec)).toBe('confirmed')
    expect(nodeColor({ kind: 'vault', agentId: 'worker-2' }, exec, palette)).toBe(GRAPH_COLOR.confirmed)
  })
  it('idle orchestrator/vault use group base colors, idle worker uses state idle', () => {
    expect(nodeColor({ kind: 'orchestrator' }, {}, palette)).toBe(GROUP_BASE.orchestrator)
    expect(nodeColor({ kind: 'vault', agentId: 'x' }, {}, palette)).toBe(GROUP_BASE.vault)
    expect(nodeColor({ kind: 'worker', agentId: 'x' }, {}, palette)).toBe(GRAPH_COLOR.idle)
  })
  it('keeper/strategy/pool are static group colors and never running', () => {
    expect(nodeStateOf({ kind: 'keeper' }, exec)).toBe('static')
    expect(nodeColor({ kind: 'pool' }, exec, palette)).toBe(GROUP_BASE.pool)
    expect(nodeRunning({ kind: 'strategy' }, exec)).toBe(false)
  })
  it('NODE_R covers every kind', () => {
    ;['orchestrator', 'worker', 'step', 'vault', 'keeper', 'strategy', 'pool'].forEach((k) =>
      expect(NODE_R[k]).toBeGreaterThan(0)
    )
  })
})
