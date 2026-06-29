import { NETWORK_PASSPHRASE, SOROBAN_RPC_URL, RELAY_PROXY_URL } from '../stellar/config.js'

// RP-ID is the host the extension claims via host_permissions (Task 0 manifest).
export const RP_ID = import.meta.env?.VITE_VF_RP_ID ?? 'localhost'
export const RP_NAME = 'Vibing Farmer'

// Self-deployed on testnet by scripts/soroban/deploy-smart-account.sh (Task 6).
// Stay null until that runs; the script prints the exact two lines to paste here
// (synced into deployments/stellar-testnet.json "smartAccount" too — same
// inline-constant discipline as stellar/config.js).
export const ACCOUNT_WASM_HASH = null
export const WEBAUTHN_VERIFIER_ADDRESS = null

export function makeWalletConfig(overrides = {}) {
  return {
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: SOROBAN_RPC_URL,
    relayerUrl: RELAY_PROXY_URL,
    rpId: RP_ID,
    rpName: RP_NAME,
    accountWasmHash: ACCOUNT_WASM_HASH,
    webauthnVerifierAddress: WEBAUTHN_VERIFIER_ADDRESS,
    ...overrides,
  }
}

export const WALLET_CONFIG = makeWalletConfig()
