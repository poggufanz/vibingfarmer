import { WALLET_CONFIG } from './config.js'
import { rpcServer } from '../stellar/client.js'
import { SOROBAN_TOKEN_ADDRESS } from '../stellar/config.js'

const CACHE_KEY = 'vf_wallet_contract'

// SmartAccountKit is a NAMED export, new-constructed (confirmed against the
// installed dist .d.ts: `const kit = new SmartAccountKit({ rpcUrl, ... })`).
// It is imported DYNAMICALLY (not at module top level) so that callers who
// inject a kit (unit tests, the popup with an existing kit) never trigger SAK
// module evaluation. The installed dist re-exports a directory subpath
// (`export { SmartAccountKit } from "./kit"`) that raw Node's ESM resolver
// rejects, and vitest externalizes node_modules through that same resolver — a
// static top-level import would break the suite even with a fake kit injected.
// The Vite bundler path used at the manual M1 gate resolves it fine. Mirrors
// readBalance's existing dynamic import of agentDeposit.js.
export async function makeKit(overrides = {}) {
  const { SmartAccountKit } = await import('smart-account-kit')
  return new SmartAccountKit({ ...WALLET_CONFIG, ...overrides })
}

export async function createPasskeyWallet({ appName, userName, kit }) {
  kit = kit ?? (await makeKit())
  const { contractId, credentialId } = await kit.createWallet(appName, userName, {
    autoSubmit: true, // deploy the account
    autoFund: true, // Friendbot (testnet)
  })
  localStorage.setItem(CACHE_KEY, contractId)
  return { contractId, credentialId }
}

// Reconnect priority: explicit contractId > local cache > credentialId (indexer) > prompt.
export async function connectPasskeyWallet({ contractId, credentialId, kit } = {}) {
  kit = kit ?? (await makeKit())
  const cached = contractId ?? localStorage.getItem(CACHE_KEY)
  let res
  if (cached) res = await kit.connectWallet({ contractId: cached })
  else if (credentialId)
    res = await kit.connectWallet({ credentialId }) // needs indexer
  else res = await kit.connectWallet({ prompt: true })
  if (res?.contractId) localStorage.setItem(CACHE_KEY, res.contractId)
  return { contractId: res.contractId }
}

// Balance via the existing token contract read (reuses VF's rpc + scval path).
export async function readBalance(contractId, { server } = {}) {
  const { readTokenBalance } = await import('../stellar/agentDeposit.js')
  return readTokenBalance(contractId, {
    token: SOROBAN_TOKEN_ADDRESS,
    server: server ?? (await rpcServer()),
  })
}
