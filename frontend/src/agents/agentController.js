// agentController.js
// Main-thread controller. Spawns the background monitor worker, routes its messages, and
// asks Venice AI to classify risk. Roadmap v2: the v2 MockVault is plain ERC-4626 with no
// on-chain harvest, and withdraw is a direct user-signed tx (the user owns the shares) —
// there is no relayer harvest/withdraw path anymore.

import { saveTransaction } from '../history.js'
import { ownerWithdraw } from '../stellar/exit.js'
import { SOROBAN_DEMO_AGENT } from '../stellar/config.js'
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
// pin: the demo sweeps the single pre-deployed agent; a multi-agent run should pass the tracked
// per-agent address (exec state) as `agentAddress`.

/** Emergency exit — called from a risk alert. User-signed owner_withdraw (a single signature). */
export async function emergencyWithdraw(
  vaultAddress,
  amount,
  userAddress,
  agentAddress = SOROBAN_DEMO_AGENT
) {
  const { hash } = await ownerWithdraw({ owner: userAddress, agentAddress, to: userAddress })
  saveTransaction({
    txHash: hash,
    vaultName: 'Emergency Exit',
    vaultAddress: agentAddress,
    workerLabel: 'RiskWatcher',
    network: 'stellar-testnet',
  })
  return hash
}

/** Manual exit from the dashboard. Returns { txHash, status }. */
export async function withdrawFromVault(
  vaultAddress,
  amount,
  userAddress,
  agentAddress = SOROBAN_DEMO_AGENT
) {
  const { hash, status } = await ownerWithdraw({
    owner: userAddress,
    agentAddress,
    to: userAddress,
  })
  return { txHash: hash, status }
}
