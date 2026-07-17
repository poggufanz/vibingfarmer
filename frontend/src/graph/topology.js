// frontend/src/graph/topology.js
// Graph topology builders — pure data, no rendering. Extracted from agents.jsx so the
// Pixi renderer and the exec-state UI share them without an import cycle
// (agents.jsx → graph/*, never the reverse).

export const STEP_IDS = ['swap', 'approve', 'deposit']
export const STEP_LABELS = { swap: 'Swap', approve: 'Approve', deposit: 'Deposit' }

export const buildGraphData = (strategy) => {
  const nodes = [{ id: 'orchestrator', name: 'Orchestrator', kind: 'orchestrator' }]
  const links = []
  strategy.agents.forEach((a) => {
    nodes.push({ id: a.id, name: `W${a.idx}, ${a.vault.protocol}`, kind: 'worker', agentId: a.id })
    links.push({ source: 'orchestrator', target: a.id })
    let prev = a.id
    STEP_IDS.forEach((sid) => {
      const id = `${a.id}-${sid}`
      nodes.push({ id, name: STEP_LABELS[sid], kind: 'step', agentId: a.id, stepId: sid })
      links.push({ source: prev, target: id })
      prev = id
    })
    const vId = `${a.id}-vault`
    nodes.push({ id: vId, name: `Vault, ${a.vault.apy}%`, kind: 'vault', agentId: a.id })
    links.push({ source: prev, target: vId })
  })
  return { nodes, links }
}

// Normalized edge id — direction-independent, so a Rebalance event's (from, to) pair matches
// regardless of which strategy/pseudo-target the vault treats as source vs. target on-chain
// (the de-risk-to-idle fallback can rebalance strategy→vault OR vault→strategy).
export const rebalancePulseKey = (a, b) => [a, b].filter(Boolean).sort().join('->')

const pulseLink = (a, b) => ({ source: a, target: b, pulseKey: rebalancePulseKey(a, b) })

/**
 * Static keeper/strategy/pool subgraph — the Autofarm vault's automation topology,
 * distinct from the per-session Orchestrator→Worker→Steps→Vault graph above.
 * @param {{ vaultAddress?: string, keeperAddress?: string, strategies?: Array<{address:string, label?:string, poolAddress?:string, poolLabel?:string}> }} p
 * @returns {{ nodes: object[], links: object[] }}
 */
export const buildAutofarmGraphData = ({ vaultAddress, keeperAddress, strategies = [] } = {}) => {
  if (!vaultAddress) return { nodes: [], links: [] }
  const nodes = [{ id: vaultAddress, name: 'Autofarm vault', kind: 'vault' }]
  const links = []
  if (keeperAddress) {
    nodes.push({ id: keeperAddress, name: 'Keeper', kind: 'keeper' })
    links.push(pulseLink(keeperAddress, vaultAddress))
  }
  strategies.forEach((s, i) => {
    if (!s?.address) return
    nodes.push({ id: s.address, name: s.label || `Strategy ${i + 1}`, kind: 'strategy' })
    links.push(pulseLink(s.address, vaultAddress))
    if (s.poolAddress) {
      const poolId = `pool:${s.poolAddress}`
      nodes.push({ id: poolId, name: s.poolLabel || 'Blend pool', kind: 'pool' })
      links.push(pulseLink(s.address, poolId))
    }
  })
  return { nodes, links }
}
