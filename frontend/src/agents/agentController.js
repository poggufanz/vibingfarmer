// agentController.js
// Main-thread controller. Spawns the background monitor worker, routes its messages, and
// asks Venice AI to classify risk. Roadmap v2: the v2 MockVault is plain ERC-4626 with no
// on-chain harvest, and withdraw is a direct user-signed tx (the user owns the shares) —
// there is no relayer harvest/withdraw path anymore.

import { saveTransaction } from '../history.js'
import { withdrawFromVaultOnChain } from '../wallet.js'
import { classifyRisk } from '../venice.js'

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
  listeners.forEach(cb => cb(event))
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
    case 'RISK_SCAN_RESULT': {
      const severity = await classifyRisk(payload.searchAnswer, payload.protocol)
      if (severity === 'high' || severity === 'medium') emit({ kind: 'risk_alert', severity, ...payload })
      break
    }
    case 'MONITOR_ERROR':
      console.warn('[Agent]', payload.monitor, payload.error)
      break
  }
}

/** Emergency withdraw — called from a risk alert. `amount` is asset units (string/bigint).
 *  User-signed ERC-4626 withdraw (one popup). Same native-gas asterisk as revoke. */
export async function emergencyWithdraw(vaultAddress, amount, userAddress) {
  const { txHash } = await withdrawFromVaultOnChain(vaultAddress, amount, userAddress)
  saveTransaction({ txHash, vaultName: 'Emergency Withdraw', vaultAddress, amountUsdc: Number(amount) / 1e6, workerLabel: 'RiskWatcher', network: 'sepolia' })
  return txHash
}

/** Manual withdraw from the dashboard with a user-specified amount (asset units, string/bigint).
 *  Returns { txHash, status }. */
export async function withdrawFromVault(vaultAddress, amount, userAddress) {
  return withdrawFromVaultOnChain(vaultAddress, amount, userAddress)
}
