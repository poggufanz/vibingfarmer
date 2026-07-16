// agentController.js
// Main-thread controller. Spawns the background monitor worker, routes its messages, and
// asks Venice AI to classify risk. Roadmap v2: the v2 MockVault is plain ERC-4626 with no
// on-chain harvest, and withdraw is a direct user-signed tx (the user owns the shares) —
// there is no relayer harvest/withdraw path anymore.

import { ownerWithdraw } from '../stellar/exit.js'
import { classifyRisk } from '../strategist.js'

let worker = null
let currentConfig = null
const listeners = new Set()

export function startBackgroundAgent(config) {
  if (worker) stopBackgroundAgent()
  currentConfig = config
  worker = new Worker(new URL('./backgroundAgent.worker.js', import.meta.url), { type: 'module' })
  worker.onmessage = handleWorkerMessage
  worker.postMessage({ type: 'INIT', payload: config })
}

export function stopBackgroundAgent() {
  if (worker) {
    worker.postMessage({ type: 'STOP' })
    worker.terminate()
    worker = null
  }
}

export function updateAgentConfig(patch) {
  if (!worker) return
  currentConfig = { ...currentConfig, ...patch }
  worker.postMessage({ type: 'UPDATE_CONFIG', payload: patch })
}

export function onAgentEvent(callback) {
  listeners.add(callback)
  return () => listeners.delete(callback)
}

function emit(event) {
  listeners.forEach((cb) => cb(event))
}

async function handleWorkerMessage(e) {
  const { type, payload } = e.data
  switch (type) {
    case 'POSITION_UPDATE':
      emit({ kind: 'position', ...payload })
      break
    case 'APY_DRIFT':
      emit({ kind: 'apy_drift', ...payload })
      break
    case 'REBALANCE_OPPORTUNITY':
      emit({ kind: 'rebalance_proposal', ...payload }) // propose only — never auto-execute
      break
    case 'MARKET_SIGNAL':
      emit({ kind: 'market_signal', ...payload })
      break
    case 'DRAWDOWN_ALERT':
      emit({
        kind: 'risk_alert',
        severity: 'high',
        reason: 'drawdown_exceeded',
        vaultName: payload.vaultName,
        vaultAddress: payload.vaultAddress,
        protocol: payload.protocol,
        searchAnswer: `Drawdown of ${payload.protocol} (${payload.drawdown}%) exceeds your configured limit of ${payload.maxDrawdown}%!`,
        timestamp: payload.timestamp,
      })
      break
    case 'RISK_SCAN_RESULT': {
      const severity = await classifyRisk(payload.searchAnswer, payload.protocol)
      if (severity === 'high' || severity === 'medium')
        emit({ kind: 'risk_alert', severity, ...payload })
      break
    }
    case 'MONITOR_ERROR':
      console.warn('[Agent]', payload.monitor, payload.error)
      break
  }
}

// Stellar exit: owner_withdraw(to) on the agent custom account redeems the agent's full vault
// position + sweeps the asset back to the owner (Phase 1). It is by-agent, not by-vault+amount —
// the `vaultAddress`/`amount` args are kept for caller compatibility but unused on this path.
// `agentAddress` is REQUIRED and must be the run's own agent (scopes[].agent). It used to default
// to SOROBAN_DEMO_AGENT, which is owned by vf-deployer and holds none of the user's funds: every
// withdraw invoked a stranger's account, failed on-chain, and still reported success.

/** Manual exit from the dashboard. Returns { txHash, status }. */
export async function withdrawFromVault(vaultAddress, amount, userAddress, agentAddress) {
  if (!agentAddress) throw new Error('withdrawFromVault requires the run’s agentAddress.')
  const { hash, status } = await ownerWithdraw({
    owner: userAddress,
    agentAddress,
    to: userAddress,
  })
  return { txHash: hash, status }
}

/**
 * Sweep a whole displayed position back to the user.
 *
 * A position is the SUM of every agent's shares, but `owner_withdraw` sweeps ONE agent at a time,
 * and Soroban allows a single host-function invocation per transaction — so N agents is N
 * user-signed transactions. They run sequentially: each needs its own wallet popup, and parallel
 * submissions from one source account race on the sequence number.
 *
 * One agent failing does not abort the rest — a revoked or empty agent must not strand the others'
 * funds. The per-agent outcome is returned so the caller can report partial success honestly
 * instead of showing a withdraw that half-happened as done.
 *
 * @param {string} vaultAddress
 * @param {string} userAddress
 * @param {string[]} agentAddresses
 * @param {(p: {index: number, total: number, agentAddress: string}) => void} [onProgress]
 * @returns {Promise<Array<{agentAddress: string, ok: boolean, txHash?: string, error?: string}>>}
 */
export async function withdrawAllFromVault(vaultAddress, userAddress, agentAddresses, onProgress) {
  if (!agentAddresses?.length)
    throw new Error('withdrawAllFromVault requires at least one agentAddress.')
  const results = []
  for (let index = 0; index < agentAddresses.length; index++) {
    const agentAddress = agentAddresses[index]
    onProgress?.({ index, total: agentAddresses.length, agentAddress })
    try {
      const { txHash } = await withdrawFromVault(vaultAddress, null, userAddress, agentAddress)
      results.push({ agentAddress, ok: true, txHash })
    } catch (err) {
      results.push({ agentAddress, ok: false, error: err?.message || String(err) })
    }
  }
  return results
}
