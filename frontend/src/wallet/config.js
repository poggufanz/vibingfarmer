import { NETWORK_PASSPHRASE, SOROBAN_RPC_URL, RELAY_PROXY_URL } from '../stellar/config.js'

// RP-ID is the host the extension claims via host_permissions (Task 0 manifest).
export const RP_ID = import.meta.env?.VITE_VF_RP_ID ?? 'localhost'
export const RP_NAME = 'Vibing Farmer'

// accountWasmHash + webauthnVerifierAddress are filled in by Task 6 (self-deployed on testnet).
export function makeWalletConfig(overrides = {}) {
  return {
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: SOROBAN_RPC_URL,
    relayerUrl: RELAY_PROXY_URL,
    rpId: RP_ID,
    rpName: RP_NAME,
    accountWasmHash: null,
    webauthnVerifierAddress: null,
    ...overrides,
  }
}

export const WALLET_CONFIG = makeWalletConfig()
