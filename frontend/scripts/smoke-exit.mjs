// Live-testnet proof of the F11 autonomous exit (exitExecutor.js) — the two-leg gasless path:
// leg 1 vault.redeem via relay, leg 2 token.transfer(agent → owner) sized by the agent's REAL
// post-redeem balance. Uses a dedicated smoke agent_account so demo-agent state is untouched.
//
// One-time setup (WSL — deploys the smoke agent, constructor pins scope to the autofarm vault):
//   stellar contract deploy --wasm-hash <agentAccountWasmHash> --source vf-deployer --network testnet \
//     -- --owner <VF_DEPLOYER_G> --signer <SMOKE_SESSION pubkey hex> --scope '{...vault, token, cap...}'
// then set in gitignored frontend/.env: SMOKE_AGENT_ADDRESS=C... SMOKE_SESSION_SECRET=S...
//
// Run (Windows PowerShell, dev server on :5173 with SOROBAN_VAULT_ADDRESS+SOROBAN_TOKEN_ADDRESS set):
//   $env:VF_RELAY_URL='http://localhost:5173/api/stellar-relay'; npx vite-node scripts/smoke-exit.mjs
import 'dotenv/config'

// Headless node fetch sends no Origin → api/_guard.js applyCors 403s the relay call. Forge the
// dev origin on RELAY calls only; Soroban RPC calls pass through untouched.
const realFetch = globalThis.fetch
globalThis.fetch = (url, init = {}) => {
  if (!String(url).includes('/api/stellar-relay')) return realFetch(url, init)
  return realFetch(url, {
    ...init,
    headers: { ...(init.headers || {}), Origin: 'http://localhost:5173' },
  })
}

// exitExecutor loads the exit key through wallet/exitKey.js, which reads localStorage —
// absent in node. In-memory shim installed BEFORE the module imports below.
const _mem = new Map()
globalThis.localStorage = {
  getItem: (k) => (_mem.has(k) ? _mem.get(k) : null),
  setItem: (k, v) => _mem.set(k, String(v)),
  removeItem: (k) => _mem.delete(k),
}

const { Keypair } = await import('@stellar/stellar-sdk')
const { newSessionKey } = await import('../src/stellar/sessionKey.js')
const { runAgentDeposit, readVaultShares, readTokenBalance } = await import(
  '../src/stellar/agentDeposit.js'
)
const { rpcServer, buildInvokeTx, submitUserTx } = await import('../src/stellar/client.js')
const { saveExitKey } = await import('../src/wallet/exitKey.js')
const { runAutonomousExit } = await import('../src/agents/exitExecutor.js')
const { SOROBAN_ACTIVE_VAULT_ADDRESS, SOROBAN_TOKEN_ADDRESS } = await import(
  '../src/stellar/config.js'
)

const AGENT = process.env.SMOKE_AGENT_ADDRESS
const faucetSecret = process.env.VF_FAUCET_SECRET
const sessionSecret = process.env.SMOKE_SESSION_SECRET
if (!AGENT || !faucetSecret || !sessionSecret)
  throw new Error('set SMOKE_AGENT_ADDRESS, VF_FAUCET_SECRET, SMOKE_SESSION_SECRET in frontend/.env')

const deployer = Keypair.fromSecret(faucetSecret) // owner of the smoke agent + USDC holder
const sessionKey = newSessionKey(sessionSecret)
const AMOUNT = 20_000_000n // 2 USDC — above Blend's ≥1 USDC dust floor
const DUST = 3_000n

/** Owner-signed direct invoke (owner == tx source → source-account auth, no agent entry). */
async function ownerInvoke(contract, method, args, label) {
  const s = await rpcServer()
  const { tx } = await buildInvokeTx({
    source: deployer.publicKey(),
    contract,
    method,
    args,
    server: s,
  })
  tx.sign(deployer)
  const res = await submitUserTx({ signedXdr: tx.toEnvelope().toXDR('base64') })
  if (res.status !== 'SUCCESS') throw new Error(`${label} failed: ${res.status}`)
  console.log(`${label} tx ${res.hash}`)
  return res
}

console.log('agent:', AGENT)
console.log('vault:', SOROBAN_ACTIVE_VAULT_ADDRESS)

// 1. Fresh per-run exit key, registered on-chain (owner-gated) and saved where the
//    production loadExitKey will find it.
const exitKp = Keypair.random()
await ownerInvoke(
  AGENT,
  'set_exit_signer',
  [{ bytes32: exitKp.rawPublicKey() }],
  'set_exit_signer'
)
saveExitKey(AGENT, { publicKey: exitKp.publicKey(), secret: exitKp.secret() })

// 2. Fund the agent (vault.deposit pulls from the agent itself; constructor pre-approved).
await ownerInvoke(
  SOROBAN_TOKEN_ADDRESS,
  'transfer',
  [{ addr: deployer.publicKey() }, { addr: AGENT }, { i128: AMOUNT }],
  'fund agent'
)

// 3. Gasless deposit through the production relay path (session-key auth).
const dep = await runAgentDeposit({ agentAddress: AGENT, amount: AMOUNT, sessionKey })
console.log('deposit relay result:', dep)
if (!dep || dep.status !== 'SUCCESS') throw new Error(`deposit failed: ${JSON.stringify(dep)}`)
const shares = await readVaultShares(AGENT)
console.log('shares after deposit:', shares)
if (!shares || shares <= 0n) throw new Error('FAIL: no shares minted')

// 4. THE exit under test — production runAutonomousExit, both legs through the relay.
const ownerBefore = await readTokenBalance(deployer.publicKey())
const out = await runAutonomousExit({ agentAddress: AGENT, ownerAddress: deployer.publicKey() })
console.log('exit result:', out)

// 5. Post-conditions: shares burned, agent swept clean, owner made whole (minus rounding dust).
const sharesAfter = await readVaultShares(AGENT)
const agentAfter = await readTokenBalance(AGENT)
const ownerAfter = await readTokenBalance(deployer.publicKey())
const ownerDelta = ownerAfter - ownerBefore
console.log('shares after exit:', sharesAfter, ' agent balance:', agentAfter)
console.log('owner delta:', ownerDelta, ` (deposit was ${AMOUNT})`)
if (sharesAfter !== 0n) throw new Error('FAIL: shares not fully redeemed')
if (agentAfter !== 0n) throw new Error('FAIL: agent still holds tokens — sweep incomplete')
if (ownerDelta < AMOUNT - DUST)
  throw new Error(`FAIL: owner delta ${ownerDelta} below deposit-minus-dust`)
console.log(
  `PASS: autonomous exit live-proven — redeem ${out.redeemHash} then balance-sized transfer ${out.hash}`
)
