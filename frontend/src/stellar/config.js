// Public Stellar chain-layer constants, selected per network. Client-safe (no secrets, no SDK).
// testnet values sync from deployments/stellar-testnet.json (re-sync after redeploys / the
// quarterly reset — see docs/runbooks/testnet-reset.md); mainnet values stay null until the
// mainnet deploy fills them. Importing with VITE_STELLAR_NETWORK=mainnet before that THROWS on
// purpose — no silent null addresses. Per-address env overrides (VITE_SOROBAN_*) win over the
// network block, which is what the redeploy checklist uses.

const META_ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {}
const PROC_ENV = (typeof process !== 'undefined' && process.env) || {}
const env = (key) => META_ENV[key] ?? PROC_ENV[key] ?? ''

const NETWORKS = {
  testnet: {
    label: 'TESTNET',
    passphrase: 'Test SDF Network ; September 2015',
    rpc: 'https://soroban-testnet.stellar.org',
    // Horizon (NOT the Soroban RPC) is the only source of account balances — rpc.getAccount
    // returns sequence only. See scripts/stellar-relay-smoke.mjs.
    horizon: 'https://horizon-testnet.stellar.org',
    // Deposit target (old 1:1 vault, kept for history/rollback). The server relay refuses to
    // fee-bump anything that does not invoke this contract's `deposit`.
    vault: 'CBZNITAPHCLSPEXC3UKIERYRUJR56GISM2G2Z5XD6KZH3U4ZZ76XNQOU',
    // Registry — hardened redeploy 2026-07-14: authorize(agent) derives the record from the
    // agent's on-chain scope; record_of / is_revoked reads + agent_authorized/agent_revoked events.
    registry: 'CAP5E2FPDAGEQ7SR55YRY4Z56GPBSTRRZJCYN2PQ6PZQHQJKYEDVM5FB',
    // On-chain strategy attestation (F5). attest(attester, strategy_hash, label) anchors the AI
    // strategy hash on-chain; user-signed inner tx, relayer fee-bumps so the user pays 0 XLM.
    attestation: 'CDDOW2FZ7ALBWBXF22TPMPDHPXSKTMLQGGQWUYX7YOJZAHICD7DUO2K6',
    // Yield-farming asset = Blend testnet USDC (7 decimals). The vault's underlying IS the asset
    // Blend lends, so deposits supply into the pool. Pulls + pays dividends in it.
    token: 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU',
    // Pre-seeded demo agent custom account (1a, v3 — scope pins the AUTOFARM vault; constructor
    // self-approves it for the cap). Owner = vf-deployer; signer in deployments JSON.
    demoAgent: 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC',
    // agent_account wasm v3 (hardened redeploy 2026-07-14, already uploaded on-chain) —
    // deployAgentForSession + the funding router deploy per-run agents from this hash. v3 adds
    // on-chain enforced revoke, owner_withdraw terminal exit, and scope_of() for the registry's
    // derived records. The demo agent above stays on the OLD v1 wasm (8c607112ba…dda62).
    agentWasmHash: 'd61ceaaaf5a3fd9fd25987eba0f843ccb79880f3eaa137e066b5f63ab9eaa2ba',
    // Single-signature grant factory + funding gate (funding_router). Owner signs ONE grant tx (nested
    // SEP-41 approve + agent deploys); worker funding = relayed router.pull (0 further signatures). The
    // server relay guard's SOROBAN_ROUTER_ADDRESS env MUST match this exact address.
    fundingRouter: 'CCEWWRQVYKEIWTO7GTX2QVHQASC3GIQOZZTDMGTOHFQYKZIX5KJ6CYE5',
    // The exit-side mirror of the grant (exit_router). `sweep(owner, agents, to)` batches one
    // owner_withdraw per agent into the ONE host-function invocation a tx allows, so leaving N
    // agents costs ONE signature instead of N. Stateless, no admin, zero custody.
    exitRouter: 'CDGDIPHBN3MSNURDX33IZBXXQTJPT7THAXSMVBAIOIXLOA6OF32IRS2J',
    // Real-yield source (#2): Blend Capital v2 lending pool the vault supplies into (re-verified
    // live at cutover — spec §7). blendUsdc = the pool's USDC reserve (same SAC as `token`).
    blendPool: 'CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF',
    blendUsdc: 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU',
    // Autofarm vault + strategy (vf-autofarm) — strategy-registry-capable wasm. This is the app's
    // LIVE deposit target (see SOROBAN_ACTIVE_VAULT_ADDRESS): shares are exchange-rate priced
    // (price_per_share ≠ 1:1) — convert shares via pps for every USDC display. The relay's
    // server-side allowlist (SOROBAN_VAULT_ADDRESS env) must equal this or deposits are refused.
    autofarmVault: 'CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77',
    strategy1: 'CAR7XFFRKMUYSERYBSLQ4LXRY2E2W7G7WG4VQI55FWLSJWQVLNTAFVBE',
    // Keeper (compound/rebalance caller) — DEDICATED identity, deliberately NOT the relayer
    // G-address: a leaked relay secret must not grant keeper powers (and vice versa).
    keeper: 'GA2CMBS3LRY5MH64KKMHOYVA6WTLPMKRMIWEJDOIGHYPB7WMC3QHRCBU',
  },
  mainnet: {
    label: 'PUBLIC',
    passphrase: 'Public Global Stellar Network ; September 2015',
    rpc: null,
    horizon: null,
    vault: null,
    registry: null,
    attestation: null,
    token: null,
    demoAgent: null,
    agentWasmHash: null,
    fundingRouter: null,
    exitRouter: null,
    blendPool: null,
    blendUsdc: null,
    autofarmVault: null,
    strategy1: null,
    keeper: null,
  },
}

export const STELLAR_NETWORK = env('VITE_STELLAR_NETWORK') || 'testnet'
const NET = NETWORKS[STELLAR_NETWORK]
if (!NET) throw new Error(`unknown VITE_STELLAR_NETWORK: ${STELLAR_NETWORK}`)

// Per-field resolution: env override -> network block -> throw when the block is unfilled
// (selecting mainnet before its addresses are filled fails loudly instead of yielding null).
const pick = (envKey, field) => {
  const v = env(envKey) || NET[field]
  if (v === null || v === undefined || v === '')
    throw new Error(
      `stellar config: ${STELLAR_NETWORK} value for ${field} unfilled (set ${envKey})`
    )
  return v
}

export const NETWORK_PASSPHRASE = pick('VITE_STELLAR_PASSPHRASE', 'passphrase')
export const SOROBAN_RPC_URL = pick('VITE_SOROBAN_RPC_URL', 'rpc')
export const HORIZON_URL = pick('VITE_HORIZON_URL', 'horizon')
export const SOROBAN_VAULT_ADDRESS = pick('VITE_SOROBAN_VAULT_ADDRESS', 'vault')
export const SOROBAN_REGISTRY_ADDRESS = pick('VITE_SOROBAN_REGISTRY_ADDRESS', 'registry')
export const SOROBAN_ATTESTATION_ADDRESS = pick('VITE_SOROBAN_ATTESTATION_ADDRESS', 'attestation')
export const SOROBAN_TOKEN_ADDRESS = pick('VITE_SOROBAN_TOKEN_ADDRESS', 'token')
export const SOROBAN_DEMO_AGENT = pick('VITE_SOROBAN_DEMO_AGENT', 'demoAgent')
export const SOROBAN_AGENT_WASM_HASH = pick('VITE_SOROBAN_AGENT_WASM_HASH', 'agentWasmHash')
// Optional on purpose (no pick/throw): empty = single-signature flow disabled, legacy path runs.
export const SOROBAN_FUNDING_ROUTER_ADDRESS =
  env('VITE_SOROBAN_FUNDING_ROUTER_ADDRESS') || NET.fundingRouter || ''
// Optional on purpose (no pick/throw), same as the funding router above: empty = the one-signature
// exit is off and withdraw falls back to the per-agent, one-signature-each sweep loop. That is the
// rollback lever for a freshly deployed exit_router — unset it and nothing else has to change.
export const SOROBAN_EXIT_ROUTER_ADDRESS =
  env('VITE_SOROBAN_EXIT_ROUTER_ADDRESS') || NET.exitRouter || ''
// Escape hatch: force the legacy per-agent deploy/fund signature path even when the router is
// deployed (VITE_LEGACY_AGENT_SETUP=1). env() helper keeps this vitest/node-safe.
export const LEGACY_AGENT_SETUP = env('VITE_LEGACY_AGENT_SETUP') === '1'
// The single-signature grant flow is the DEFAULT whenever the router is deployed and the legacy escape
// hatch is off. Orchestrator + UI branch on this single knob.
export const USE_FUNDING_ROUTER = Boolean(SOROBAN_FUNDING_ROUTER_ADDRESS) && !LEGACY_AGENT_SETUP
// Token + vault-share decimals (both 7). Amounts are i128 in base units (1 VFUSD = 10_000_000).
export const SOROBAN_DECIMALS = 7
// Timebound for every tx a HUMAN signs. Load-bearing: it must outlive WALLET_SIGN_TIMEOUT_MS
// (agentSetup.js, 120s) plus the build's RPC round-trips (getAccount + getLatestLedger +
// simulate + prepare), because the clock starts at BUILD time, not at popup time. This was 60s
// — i.e. HALF the sign window the same code grants the user — so anyone who actually read the
// wallet popup blew the timebound and submitted a txTooLate. The failure then surfaced as an
// unrelated balance error via the relay fallback (see relay.js), which is why it went unnoticed.
// agentSetup.test.js pins the invariant.
export const TX_TIMEBOUND_SECONDS = 300
export const SOROBAN_BLEND_POOL_ADDRESS = pick('VITE_SOROBAN_BLEND_POOL_ADDRESS', 'blendPool')
export const SOROBAN_BLEND_USDC_ADDRESS = pick('VITE_SOROBAN_BLEND_USDC_ADDRESS', 'blendUsdc')
export const SOROBAN_AUTOFARM_VAULT_ADDRESS = pick(
  'VITE_SOROBAN_AUTOFARM_VAULT_ADDRESS',
  'autofarmVault'
)
export const SOROBAN_STRATEGY_1_ADDRESS = pick('VITE_SOROBAN_STRATEGY_1_ADDRESS', 'strategy1')
// The app's LIVE deposit target = the autofarm vault (derived, not separately configured).
export const SOROBAN_ACTIVE_VAULT_ADDRESS = SOROBAN_AUTOFARM_VAULT_ADDRESS
export const SOROBAN_KEEPER_ADDRESS = pick('VITE_SOROBAN_KEEPER_ADDRESS', 'keeper')
// 'TESTNET' | 'PUBLIC' — used by vfWalletModule.getNetwork() (Stellar Wallets Kit).
export const STELLAR_NETWORK_LABEL = NET.label

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
const isExt = typeof window !== 'undefined' && window.location.protocol === 'chrome-extension:'
// Extension fallback = the DEPLOYED backend, never localhost: a packed build that missed
// VF_API_BASE used to bake http://localhost:8788 in, so passkey registration (SAK relayerUrl)
// fetched a dead port on every user machine — "Failed to deploy smart account contract:
// Failed to fetch". Dev extension builds override via VF_API_BASE=http://localhost:5173.
const EXT_DEFAULT_API_BASE = 'https://vibing-farmer.pages.dev'
// The import.meta.env literal is what the extension build's `define` replaces (see
// vite.config.extension.js) — unlike the process.env clause it is NOT gated on a runtime
// `process` global (extension pages only get one if a polyfill chunk loads first), so a
// build-time VF_API_BASE override (e.g. the dev/preview origin) always wins. Web builds
// must NOT set VITE_VF_API_BASE in .env — the deployed app needs the relative path.
const API_BASE =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_VF_API_BASE) ||
  (typeof process !== 'undefined' && process.env && process.env.VF_API_BASE) ||
  (isExt ? EXT_DEFAULT_API_BASE : '')
const VF_RELAY = (typeof process !== 'undefined' && process.env && process.env.VF_RELAY_URL) || ''
export const RELAY_PROXY_URL = API_BASE
  ? `${API_BASE}/api/stellar-relay`
  : VF_RELAY || '/api/stellar-relay'
export const FAUCET_PROXY_URL = API_BASE ? `${API_BASE}/api/faucet` : '/api/faucet'
