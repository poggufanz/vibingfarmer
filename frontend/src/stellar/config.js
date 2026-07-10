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
export const SOROBAN_ATTESTATION_ADDRESS =
  'CDDOW2FZ7ALBWBXF22TPMPDHPXSKTMLQGGQWUYX7YOJZAHICD7DUO2K6'
// Yield-farming asset = Blend testnet USDC (7 decimals) post-cutover — the vault's underlying
// IS the asset Blend lends, so deposits supply into the pool. Pulls + pays dividends in it.
export const SOROBAN_TOKEN_ADDRESS = 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU'
// Pre-seeded demo agent custom account (1a, v3 — scope pins the AUTOFARM vault; constructor
// self-approves it for the cap). __check_auth scope is constructor-only, so the cutover needed
// a fresh deploy: v2 CD3MQJ4Y… stays pinned to the old 1:1 vault (kept on-chain for history).
// Used by the smoke script + demo flows. Owner = vf-deployer; signer in deployments JSON.
export const SOROBAN_DEMO_AGENT = 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC'
// agent_account wasm (v2) ALREADY uploaded on-chain — auto-execute deploys one fresh instance
// per run from this hash (create-from-wasm-hash, no wasm upload) so the constructor pins THAT
// run's session pubkey. v2 adds the 4th constructor arg (router: Option<Address>) + the
// pull@router context so a session key may authorize the funding_router's `pull` on it; the
// one-popup grant factory (SOROBAN_FUNDING_ROUTER_ADDRESS below) is pinned to THIS same hash.
// The demo agent above stays on the OLD v1 wasm (8c607112ba…dda62) for paths that need the
// pre-seeded account (exit settings, smoke scripts).
export const SOROBAN_AGENT_WASM_HASH =
  '7ced45e735e7e084d96d6a04df7cec6e07bc2b203eedb4d3422949a7e9cca717'
// One-popup grant factory + funding gate (funding_router). Owner signs ONE grant tx (covers the
// nested SEP-41 token.approve + deploys the run's agents); later worker funding is a relayed
// router.pull (0 popups). The server relay guard's SOROBAN_ROUTER_ADDRESS env MUST match this
// exact address or grant/pull fee-bumps are refused. Pins agent wasm v2 above + the USDC token.
export const SOROBAN_FUNDING_ROUTER_ADDRESS =
  'CBEI5VJKKWLXKQUUUETBAPZSQQLH7I57TSIDTMV4WJMBKIGVF7NSNOFY'
// Escape hatch: force the legacy per-agent deploy/fund popup path even when the router is deployed
// (VITE_LEGACY_AGENT_SETUP=1). Optional-chained so vitest (no import.meta.env) reads undefined → false.
export const LEGACY_AGENT_SETUP = import.meta.env?.VITE_LEGACY_AGENT_SETUP === '1'
// The one-popup grant flow is the DEFAULT whenever the router is deployed and the legacy escape
// hatch is off. Orchestrator + UI branch on this single knob.
export const USE_FUNDING_ROUTER = Boolean(SOROBAN_FUNDING_ROUTER_ADDRESS) && !LEGACY_AGENT_SETUP
// Token + vault-share decimals (both 7). Amounts are i128 in base units (1 VFUSD = 10_000_000).
export const SOROBAN_DECIMALS = 7

// Real-yield source (sub-project #2): Blend Capital v2 lending pool the vault supplies into.
// Wired live at the testnet cutover (spec §4.1/§7) — vault redeployed on Blend USDC + set_pool
// run. Surfaces the live yield source for UI/docs. Mirrors vault.blendPool in the deployments JSON.
// Testnet V2 pool + USDC reserve (re-verified live at cutover — see spec §7):
export const SOROBAN_BLEND_POOL_ADDRESS = 'CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF'
export const SOROBAN_BLEND_USDC_ADDRESS = 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU'

// Autofarm vault + strategy (sub-project vf-autofarm, Task 11). A NEW vault instance — the
// strategy-registry-capable wasm (add_strategy/set_keeper/compound/rebalance, Tasks 2-10) —
// deployed alongside `SOROBAN_VAULT_ADDRESS` above (the old vault predates that wasm and is
// kept for history/rollback; NOT yet flipped as the app's live deposit target — that cutover
// is a separate, later step). Single-strategy: Task 1's spike found a self-deployed second
// Blend pool cannot reach Active status on testnet without seeding real backstop capital
// (OWN_POOL_VIABLE=false), so this vault runs one Blend strategy on the same TestnetV2 pool
// and relies on the de-risk-to-idle rebalance fallback (rebalance(to=vault)) in place of a
// second strategy/pool. See docs/superpowers/plans/2026-07-03-vf-autofarm-progress.md.
export const SOROBAN_AUTOFARM_VAULT_ADDRESS =
  'CB5VKYDUIYX3RZWGVLKKNBPG7V7Z5JIHF2QPNQKWKAHVA3IPSLFZJDYU'
export const SOROBAN_STRATEGY_1_ADDRESS = 'CCH424TVLTP2P3URNRGGF26X24XRPBVBXCRZ6QBCWLSX6KH4QZSLNBC2'
// The app's LIVE deposit target (cutover, handoff §1). Points at the autofarm vault: shares are
// exchange-rate priced (price_per_share ≠ 1:1) — every USDC display must convert shares via pps.
// The relay's server-side allowlist (SOROBAN_VAULT_ADDRESS env in .dev.vars / Pages env) must be
// set to this same address or every deposit is refused. Old 1:1 vault above kept for rollback.
export const SOROBAN_ACTIVE_VAULT_ADDRESS = SOROBAN_AUTOFARM_VAULT_ADDRESS
// Keeper (compound/rebalance caller) — DEDICATED identity, deliberately NOT the relayer
// G-address: a leaked relay secret must not grant keeper powers (and vice versa).
// Re-pointed on-chain via set_keeper tx 5690e99bfe84740106c7ae015e82f2fb4b54fb99a4bb2ab988db4e05f9e73be9.
export const SOROBAN_KEEPER_ADDRESS = 'GA2CMBS3LRY5MH64KKMHOYVA6WTLPMKRMIWEJDOIGHYPB7WMC3QHRCBU'

// New gasless relay endpoint. Distinct from the EVM /api/relay (decommissioned in step 6).
// Browser uses the same-origin relative path. Headless smokes (vite-node/node) have no fetch
// origin, so they set VF_RELAY_URL to the running dev server's absolute endpoint
// (e.g. http://localhost:5173/api/stellar-relay). typeof guard keeps it browser-safe; unset in
// vitest → relative default (config/relay tests still assert '/api/stellar-relay').
// ponytail: env override, not a config object — one knob, the only one a headless run needs.
// Extension build injects VF_API_BASE (absolute origin of the running backend) so the packed
// chrome-extension:// pages can reach /api/* — a same-origin relative path resolves to the
// extension origin (chrome-extension://<id>/api/...) and 404s. Web app + headless smokes leave
// VF_API_BASE unset → relative path / the VF_RELAY_URL knob, exactly as before (tests see defaults).
const API_BASE = (typeof process !== 'undefined' && process.env && process.env.VF_API_BASE) || ''
const VF_RELAY = (typeof process !== 'undefined' && process.env && process.env.VF_RELAY_URL) || ''
export const RELAY_PROXY_URL = API_BASE
  ? `${API_BASE}/api/stellar-relay`
  : VF_RELAY || '/api/stellar-relay'
export const FAUCET_PROXY_URL = API_BASE ? `${API_BASE}/api/faucet` : '/api/faucet'
