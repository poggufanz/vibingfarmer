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
export const SOROBAN_VAULT_ADDRESS = 'CBZNITAPHCLSPEXC3UKIERYRUJR56GISM2G2Z5XD6KZH3U4ZZ76XNQOU'
// Registry (sub-project 1a) — record_of / is_revoked reads + agent_authorized/agent_revoked events.
export const SOROBAN_REGISTRY_ADDRESS = 'CAEHOZGUGVNRCAFVJCSR3B2EFJ55LEA34S76HTRQGH7XSPBO7YIMNZOQ'
// On-chain strategy attestation (F5). attest(attester, strategy_hash, label) anchors the AI
// strategy hash on-chain; user-signed inner tx, relayer fee-bumps so the user pays 0 XLM.
export const SOROBAN_ATTESTATION_ADDRESS = 'CDDOW2FZ7ALBWBXF22TPMPDHPXSKTMLQGGQWUYX7YOJZAHICD7DUO2K6'
// Yield-farming asset = Blend testnet USDC (7 decimals) post-cutover — the vault's underlying
// IS the asset Blend lends, so deposits supply into the pool. Pulls + pays dividends in it.
export const SOROBAN_TOKEN_ADDRESS = 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU'
// Pre-seeded demo agent custom account (1a, v2 — constructor self-approves the vault for cap).
// Used by the smoke script + demo flows. Owner = vf-deployer; signer in deployments JSON.
export const SOROBAN_DEMO_AGENT = 'CD3MQJ4YZQ5MDSKDETEFZMDV5J5URVXM46NY5Y3RICUOVJJOFIZTKJ7K'
// Token + vault-share decimals (both 7). Amounts are i128 in base units (1 VFUSD = 10_000_000).
export const SOROBAN_DECIMALS = 7

// Real-yield source (sub-project #2): Blend Capital v2 lending pool the vault supplies into.
// Wired live at the testnet cutover (spec §4.1/§7) — vault redeployed on Blend USDC + set_pool
// run. Surfaces the live yield source for UI/docs. Mirrors vault.blendPool in the deployments JSON.
// Testnet V2 pool + USDC reserve (re-verified live at cutover — see spec §7):
export const SOROBAN_BLEND_POOL_ADDRESS = 'CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF'
export const SOROBAN_BLEND_USDC_ADDRESS = 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU'

// New gasless relay endpoint. Distinct from the EVM /api/relay (decommissioned in step 6).
export const RELAY_PROXY_URL = '/api/stellar-relay'
