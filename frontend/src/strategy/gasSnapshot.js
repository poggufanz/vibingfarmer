// gasSnapshot.js
// Live gas-price snapshot for the /strategy DAG. An independent fetch node:
// reads Base Sepolia fee data through the dedicated read-only provider (never the
// wallet's BrowserProvider) and classifies congestion. Never throws on its own
// contract; the DAG runner also isolates failures.

import { getReadProvider } from '../readProvider.js'

const ELEVATED_GWEI = 30
const HIGH_GWEI = 80

/**
 * @returns {Promise<{ gwei:number, level:'normal'|'elevated'|'high' }>}
 */
export async function fetchGasSnapshot() {
  const provider = getReadProvider()
  const fee = await provider.getFeeData()
  const wei = fee.gasPrice ?? fee.maxFeePerGas ?? 0n
  const gwei = Number(wei) / 1e9
  const level = gwei >= HIGH_GWEI ? 'high' : gwei >= ELEVATED_GWEI ? 'elevated' : 'normal'
  return { gwei: Number(gwei.toFixed(2)), level }
}
