import { NETWORK_PASSPHRASE, SOROBAN_RPC_URL, RELAY_PROXY_URL } from '../stellar/config.js'

// RP-ID = the WebAuthn relying-party domain. Web app: 'localhost' (a valid registrable domain
// that matches its origin). Extension: a chrome-extension:// origin REJECTS any explicit rpId
// ("<id> is an invalid domain"), so build with VITE_VF_RP_ID=origin (or empty) → RP_ID undefined
// → rpId is omitted and Chrome defaults the relying party to the extension's own origin (the only
// rpId a chrome-extension page can use). Applies to BOTH the register and sign WebAuthn calls,
// since SAK reads rpId from this config (account.js makeKit → new SmartAccountKit(WALLET_CONFIG)).
const rawRpId = import.meta.env?.VITE_VF_RP_ID ?? 'localhost'
export const RP_ID = rawRpId && rawRpId !== 'origin' ? rawRpId : undefined
export const RP_NAME = 'Vibing Farmer'

// Version-matched OZ smart-account artifacts for smart-account-kit-bindings 0.1.2.
// LIVE on testnet (the bindings-0.1.2 demo-env set: gitHead ff0eb9d8, rs-sdk
// 23.2.1 / pre-v0.7 build — NOT the drifted v0.7.2 tag). accountWasmHash is
// content-addressed: `stellar contract install` of the matching smart_account.wasm
// re-yields this exact hash, so we reuse the live install instead of self-deploying
// (plan Task 6 Step 1: prefer SDK-default testnet addresses). webauthn_verifier
// CBSHV66W... is already a live testnet contract. Synced into
// deployments/stellar-testnet.json "smartAccount" (same inline-constant discipline
// as stellar/config.js). Local wasm provenance: scripts/soroban/wasm/.
export const ACCOUNT_WASM_HASH = 'a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e'
export const WEBAUTHN_VERIFIER_ADDRESS = 'CBSHV66WG7UV6FQVUTB67P3DZUEJ2KJ5X6JKQH5MFRAAFNFJUAJVXJYV'
// SAK's only SDK-defaulted value; cold/cross-device discovery only (off the M1-M3 path).
export const SMART_ACCOUNT_INDEXER_URL = 'https://smart-account-indexer.sdf-ecosystem.workers.dev'

export function makeWalletConfig(overrides = {}) {
  return {
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: SOROBAN_RPC_URL,
    relayerUrl: RELAY_PROXY_URL,
    // Omit rpId entirely when undefined (extension build) so SAK/WebAuthn default to the origin.
    ...(RP_ID ? { rpId: RP_ID } : {}),
    rpName: RP_NAME,
    accountWasmHash: ACCOUNT_WASM_HASH,
    webauthnVerifierAddress: WEBAUTHN_VERIFIER_ADDRESS,
    indexerUrl: SMART_ACCOUNT_INDEXER_URL,
    ...overrides,
  }
}

export const WALLET_CONFIG = makeWalletConfig()
