// readProvider.js
// Singleton read-only provider using a dedicated Sepolia RPC.
//
// Never use BrowserProvider for reads — it routes every call through MetaMask's
// single request queue, so a concurrent eth_call throws -32603 while a
// wallet_* request (e.g. wallet_requestExecutionPermissions) is pending.
//
// READ-ONLY: balanceOf, call, getLogs, getBlock → getReadProvider()
// SIGNING:   sign, send, wallet_* RPC          → BrowserProvider(window.ethereum)

import { ethers } from 'ethers'
import { SEPOLIA_CHAIN_ID } from './config.js'

let _readProvider = null

export function getReadProvider() {
  if (_readProvider) return _readProvider

  const rpcUrl = import.meta.env.VITE_RPC_URL
    || 'https://sepolia.base.org'

  // staticNetwork: the URL dictates the chain (Base Sepolia), so skip the per-call
  // eth_chainId validation round trip. ethers v6 successor to StaticJsonRpcProvider.
  // Safe ONLY because this provider never points at MetaMask.
  const network = ethers.Network.from(SEPOLIA_CHAIN_ID)
  _readProvider = new ethers.JsonRpcProvider(rpcUrl, network, { staticNetwork: network })
  return _readProvider
}

// Reset if needed (e.g. on network change).
export function resetReadProvider() {
  _readProvider = null
}
