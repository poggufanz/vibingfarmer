// Public Stellar testnet constants for the chain layer. Client-safe (no secrets, no SDK).
// Addresses synced from deployments/stellar-testnet.json — re-sync after any redeploy or a
// quarterly testnet reset (same discipline as the EVM config.js address sync).

export const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015'
export const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org'
// Horizon (NOT the Soroban RPC) is the only source of account balances — rpc.getAccount
// returns sequence only. See scripts/stellar-relay-smoke.mjs.
export const HORIZON_URL = 'https://horizon-testnet.stellar.org'

// Deposit target. The server relay refuses to fee-bump anything that does not invoke this
// contract's `deposit` (defense-in-depth on top of the per-IP rate limit).
export const SOROBAN_VAULT_ADDRESS = 'CCDXZ6BUA7TPR3EXQWJWUD7EYR6OUMJRYIKYXPE53HRJOJFY5CXEHTN5'
// Registry (sub-project 1a) — record_of / is_revoked reads + agent_authorized/agent_revoked events.
export const SOROBAN_REGISTRY_ADDRESS = 'CAEHOZGUGVNRCAFVJCSR3B2EFJ55LEA34S76HTRQGH7XSPBO7YIMNZOQ'
// Yield-farming asset (plain SAC VFUSD, 7 decimals). The vault pulls + pays dividends in it.
export const SOROBAN_TOKEN_ADDRESS = 'CAJSGONIIU4QPLNIVVOO7QCYC2LWGYMGXTD7BXSSNIQWWDHWFQTSAEB4'
// Pre-seeded demo agent custom account (1a) — used by the smoke script + demo flows.
export const SOROBAN_DEMO_AGENT = 'CCRG37UTQ2BRCJSA3WYZIUTSGZVLYQ7C4EET2WYUWLU4NAWTETGB77JW'
// Token + vault-share decimals (both 7). Amounts are i128 in base units (1 VFUSD = 10_000_000).
export const SOROBAN_DECIMALS = 7

// New gasless relay endpoint. Distinct from the EVM /api/relay (decommissioned in step 6).
export const RELAY_PROXY_URL = '/api/stellar-relay'
