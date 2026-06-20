// Public Stellar testnet constants for the chain layer. Client-safe (no secrets, no SDK).
// Addresses synced from deployments/stellar-testnet.json — re-sync after any redeploy or a
// quarterly testnet reset (same discipline as the EVM config.js address sync).

export const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015'
export const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org'

// Deposit target. The server relay refuses to fee-bump anything that does not invoke this
// contract's `deposit` (defense-in-depth on top of the per-IP rate limit).
export const SOROBAN_VAULT_ADDRESS = 'CCTGGJVVY45DYDDXM3XBFEJ2OT2J2ZT6HIXZEQKXU7Z53TH3YSZJC3PF'

// New gasless relay endpoint. Distinct from the EVM /api/relay (decommissioned in step 6).
export const RELAY_PROXY_URL = '/api/stellar-relay'
