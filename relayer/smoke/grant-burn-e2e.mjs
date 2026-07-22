// relayer/smoke/grant-burn-e2e.mjs
// Live testnet smoke for the WHOLE grant-covers-burn chain (plan Task 8): ONE owner signature
// (funding_router v2 grant, two token budgets, a Deposit-kind agent + a Bridge-kind agent) ->
// relayed router.pull funds the bridge agent -> the bridge agent's OWN session key authorizes
// deposit_for_burn (relayed, zero further signatures) -> the relayer watches Circle Iris, mints
// on Base Sepolia, and dispatches the session-key deposit into the YieldRouter pool. Every stage
// after the grant is gasless/popup-free — mirrors baseLeg.js's production glue (crossChainFarm's
// runFarmFlow with a burn dep override) instead of re-deriving it, so this smoke exercises the
// SAME code path the app ships, not a parallel one.
//
// Pattern: relayer/smoke/mint-unwind-mandate.mjs (owner/session/env machinery) +
// relayer/smoke/mint-mandate.mjs (imported directly for the Base mandate ceremony) +
// frontend/scripts/smoke-grant.mjs (headless owner-keypair signing standing in for the wallet
// popup, relay Origin forging). NOT part of `npm test` — it hits live Stellar + Base testnet and
// waits out real CCTP standard-finality attestation (~13-25 min, relayer/src/cctp/iris.mjs).
//
// Requires (relayer/.dev.vars): RELAYER_BASE_PRIVKEY, ZERODEV_PROJECT_ID, YIELD_ROUTER_ADDRESS,
// SMOKE_STELLAR_SECRET/PUBLIC (funded: testnet XLM + a real balance of the CCTP USDC SAC,
// CBIELTK6…QDAMA — the owner never needs the vault's Blend-USDC token here since the Deposit
// agent is only DEPLOYED, never pulled; SEP-41 approve does not require the approver to hold a
// balance). Needs BOTH servers up locally:
//   Terminal 1:  cd frontend && npm run dev                          (serves /api/stellar-relay)
//   Terminal 2:  cd relayer  && node --env-file=.dev.vars src/main.mjs   (serves /api/vf-cross/*)
//   Terminal 3:  cd relayer  && node --env-file=.dev.vars smoke/grant-burn-e2e.mjs
// Override endpoints with VF_RELAY_URL / RELAYER_BASE_URL if the servers run on other ports.
import { writeFileSync } from 'node:fs'
import { generatePrivateKey } from 'viem/accounts'
import { createPublicClient, http } from 'viem'
import { baseSepolia } from 'viem/chains'
import { main as mintMandate } from './mint-mandate.mjs'
import deployments from '../../deployments/base-sepolia.json' with { type: 'json' }

const need = (k) => {
  if (!process.env[k] || /FILL_ME/.test(process.env[k])) throw new Error(`env ${k} missing/unfilled`)
  return process.env[k]
}

// Headless node fetch sends no Origin -> frontend/api/_guard.js's applyCors 403s the relay call.
// Forge the dev Origin on /api/stellar-relay calls ONLY (the same seam frontend/scripts/smoke-
// grant.mjs uses) — everything else (Soroban RPC, the relayer's own /api/vf-cross/*) passes
// through untouched.
const VF_RELAY_URL = process.env.VF_RELAY_URL || 'http://localhost:5173/api/stellar-relay'
const RELAYER_BASE_URL = process.env.RELAYER_BASE_URL || 'http://localhost:8788/api/vf-cross'
process.env.VF_RELAY_URL = VF_RELAY_URL
const RELAY_ORIGIN = new URL(VF_RELAY_URL).origin
const realFetch = globalThis.fetch
globalThis.fetch = (url, init = {}) => {
  if (!String(url).includes('/api/stellar-relay')) return realFetch(url, init)
  return realFetch(url, { ...init, headers: { ...(init.headers || {}), Origin: RELAY_ORIGIN } })
}

const { Keypair, TransactionBuilder } = await import('@stellar/stellar-sdk')
const { newSessionKey } = await import('../../frontend/src/stellar/sessionKey.js')
const {
  submitGrant,
  runAgentPull,
  readAllowance,
  AGENT_KIND_DEPOSIT,
  AGENT_KIND_BRIDGE,
} = await import('../../frontend/src/stellar/grant.js')
const { runAgentBurn } = await import('../../frontend/src/stellar/agentBurn.js')
const {
  evmAddrToBytes32,
  STELLAR_TOKEN_MESSENGER_MINTER,
  STELLAR_USDC_SAC,
  CCTP_BASE_DOMAIN,
  ZERO32,
} = await import('../../frontend/src/stellar/cctpBurn.js')
const { rpcServer, readContract } = await import('../../frontend/src/stellar/client.js')
const { readTokenBalance } = await import('../../frontend/src/stellar/agentDeposit.js')
const {
  NETWORK_PASSPHRASE,
  SOROBAN_FUNDING_ROUTER_ADDRESS,
  SOROBAN_ACTIVE_VAULT_ADDRESS,
  SOROBAN_TOKEN_ADDRESS,
} = await import('../../frontend/src/stellar/config.js')
const { runFarmFlow } = await import('../../frontend/src/crossChainFarm.js')
const { postFarm, pollFarmStatus, postMandate, getMandateStatus } = await import(
  '../../frontend/src/base/relayerClient.js'
)
const { estimateMinShares } = await import('../../frontend/src/base/quotes.js')

// 7dp Stellar base units (1 USDC = 10_000_000). Mirrors smoke-farm.mjs's amounts exactly so the
// Base-side allocation (1_000_000 at 6dp) and the durable mandate's SMOKE_FARM_CAP (mint-mandate.mjs)
// line up without any headroom math.
const ONE_USDC_7DP = 10_000_000n
const DEPOSIT_BUDGET = ONE_USDC_7DP // approved, never pulled — proves the multi-token grant only
const DEPOSIT_CAP = ONE_USDC_7DP
const BRIDGE_BUDGET = 2n * ONE_USDC_7DP // headroom over the 1.0 pull
const BRIDGE_CAP = ONE_USDC_7DP
const PULL_AMOUNT = ONE_USDC_7DP
const BURN_UNITS7 = ONE_USDC_7DP // -> 1_000_000 at 6dp on Base (crossChainFarm enforces the /10)
const AGENT_PERIOD_SECONDS = 3600
const AGENT_EXPIRY_SECONDS = 86_400

async function pollUntil(read, ok, { tries = 30, intervalMs = 1500, label } = {}) {
  let v = await read()
  for (let i = 0; i < tries && !ok(v); i++) {
    await new Promise((r) => setTimeout(r, intervalMs))
    v = await read()
  }
  if (!ok(v)) throw new Error(`timed out waiting for ${label}: last=${v}`)
  return v
}

// JSON.stringify throws on BigInt (runFarmFlow's onEvent payloads carry amountUnits as one) —
// stringify every bigint as its decimal string instead of adding a util dependency for one line.
const jsonSafe = (v, indent) =>
  JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() : val), indent)

function stage(label) {
  const t0 = Date.now()
  console.log(`\n=== ${label} ===`)
  return () => console.log(`    (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
}

async function main() {
  const t0 = Date.now()
  const ownerSecret = need('SMOKE_STELLAR_SECRET')
  if (!SOROBAN_FUNDING_ROUTER_ADDRESS) throw new Error('SOROBAN_FUNDING_ROUTER_ADDRESS unset')
  const owner = Keypair.fromSecret(ownerSecret)
  const server = await rpcServer()
  const router = SOROBAN_FUNDING_ROUTER_ADDRESS
  const vault = SOROBAN_ACTIVE_VAULT_ADDRESS
  const pool = deployments.yieldRouter.allowedPools[0]

  console.log('=== grant-burn-e2e smoke (testnet) ===')
  console.log('owner        :', owner.publicKey())
  console.log('router (v2)  :', router)
  console.log('vault        :', vault)
  console.log('bridge token :', STELLAR_USDC_SAC)
  console.log('deposit token:', SOROBAN_TOKEN_ADDRESS)
  console.log('base pool    :', pool)
  console.log('relay        :', VF_RELAY_URL)
  console.log('relayer      :', RELAYER_BASE_URL)

  let done = stage('[0] preflight — owner CCTP-USDC balance')
  const ownerUsdcBefore = await readTokenBalance(owner.publicKey(), { token: STELLAR_USDC_SAC, server })
  console.log('    owner CCTP-USDC:', ownerUsdcBefore?.toString())
  if (ownerUsdcBefore == null || ownerUsdcBefore < PULL_AMOUNT) {
    throw new Error(
      `owner has insufficient CCTP USDC (need >= ${PULL_AMOUNT}, have ${ownerUsdcBefore}) — SMOKE_STELLAR_SECRET must hold a real ${STELLAR_USDC_SAC} balance`
    )
  }
  done()

  // ── [1] Base mandate ceremony (owner-side ECDSA stand-in for the passkey popup) ────────────
  done = stage('[1] Base durable mandate (mint-mandate.mjs)')
  const baseSessionPrivateKey = generatePrivateKey()
  const mandate = await mintMandate({ env: { ...process.env, SMOKE_SESSION_PRIVKEY: baseSessionPrivateKey } })
  const kernelAddress = mandate.ownerSideAccount.address
  console.log('    Base smart account (mint recipient):', kernelAddress)
  console.log('    session key                        :', mandate.sessionAddress)
  console.log('    mandate valid until (unix)          :', mandate.validUntil)
  await postMandate({
    serializedApproval: mandate.approval,
    sessionPrivateKey: baseSessionPrivateKey,
    expiry: mandate.validUntil,
    baseUrl: RELAYER_BASE_URL,
  })
  const mandateStatus = await getMandateStatus(mandate.approval, { baseUrl: RELAYER_BASE_URL })
  console.log('    relayer mandate status              :', jsonSafe(mandateStatus))
  if (!mandateStatus.valid) throw new Error('relayer rejected the registered mandate')
  done()

  // ── [2] THE ONE SIGNATURE: grant v2 — two budgets, one Deposit agent + one Bridge agent ────
  done = stage('[2] grant v2 (ONE signature: budgets=2 tokens, agents=[deposit, bridge])')
  const depositSessionKey = newSessionKey()
  const bridgeSessionKey = newSessionKey()
  const nowSec = Math.floor(Date.now() / 1000)
  const mintRecipient32 = evmAddrToBytes32(kernelAddress)

  const budgets = [
    { token: SOROBAN_TOKEN_ADDRESS, budget: DEPOSIT_BUDGET },
    { token: STELLAR_USDC_SAC, budget: BRIDGE_BUDGET },
  ]
  const agentInits = [
    {
      signer: depositSessionKey.rawPublicKey,
      cap: DEPOSIT_CAP,
      token: SOROBAN_TOKEN_ADDRESS,
      target: vault,
      kind: AGENT_KIND_DEPOSIT,
      mintRecipient: ZERO32,
      destinationDomain: 0,
      periodDuration: AGENT_PERIOD_SECONDS,
      expiry: nowSec + AGENT_EXPIRY_SECONDS,
    },
    {
      signer: bridgeSessionKey.rawPublicKey,
      cap: BRIDGE_CAP,
      token: STELLAR_USDC_SAC,
      target: STELLAR_TOKEN_MESSENGER_MINTER,
      kind: AGENT_KIND_BRIDGE,
      mintRecipient: mintRecipient32,
      destinationDomain: CCTP_BASE_DOMAIN,
      periodDuration: AGENT_PERIOD_SECONDS,
      expiry: nowSec + AGENT_EXPIRY_SECONDS,
    },
  ]
  const signWithOwner = async (xdrB64) => {
    const tx = TransactionBuilder.fromXDR(xdrB64, NETWORK_PASSPHRASE)
    tx.sign(owner)
    return tx.toEnvelope().toXDR('base64')
  }

  const grant = await submitGrant({
    owner: owner.publicKey(),
    budgets,
    durationSeconds: AGENT_EXPIRY_SECONDS,
    agentInits,
    sign: signWithOwner,
  })
  if (grant.status !== 'SUCCESS') throw new Error(`grant not SUCCESS: ${grant.status}`)
  const [depositAgent, bridgeAgent] = grant.agentAddresses
  console.log('    grant tx        :', grant.hash, grant.relayer ? '(relayed, 0 gas)' : '(direct)')
  console.log('    deposit agent   :', depositAgent)
  console.log('    bridge agent    :', bridgeAgent)
  console.log('    expiry ledger   :', grant.expiryLedger)
  if (grant.bridgeAgentAddress !== bridgeAgent) {
    throw new Error(`bridgeAgentAddress mismatch: ${grant.bridgeAgentAddress} != ${bridgeAgent}`)
  }

  const depositOwner = await readContract({ contract: router, method: 'owner_of', args: [{ addr: depositAgent }], server })
  const bridgeOwner = await readContract({ contract: router, method: 'owner_of', args: [{ addr: bridgeAgent }], server })
  console.log('    owner_of(deposit):', depositOwner)
  console.log('    owner_of(bridge) :', bridgeOwner)
  if (depositOwner !== owner.publicKey() || bridgeOwner !== owner.publicKey()) {
    throw new Error('router did not record both agents -> owner')
  }
  const depositAllow = await readAllowance({ owner: owner.publicKey(), router, token: SOROBAN_TOKEN_ADDRESS, server })
  const bridgeAllow = await readAllowance({ owner: owner.publicKey(), router, token: STELLAR_USDC_SAC, server })
  console.log('    deposit-token allowance:', depositAllow.amount.toString())
  console.log('    bridge-token allowance :', bridgeAllow.amount.toString())
  if (depositAllow.amount !== DEPOSIT_BUDGET || bridgeAllow.amount !== BRIDGE_BUDGET) {
    throw new Error('nested per-token approve did not land at the expected budgets')
  }
  done()

  // ── [3] relayed router.pull — CCTP-USDC moves owner -> bridge agent, 0 popups ───────────────
  done = stage('[3] router.pull(bridgeAgent) — relayed, 0 gas')
  const pull = await runAgentPull({ agentAddress: bridgeAgent, amount: PULL_AMOUNT, sessionKey: bridgeSessionKey, server })
  if (!pull || (pull.status !== 'SUCCESS' && pull.status !== 'PENDING')) {
    throw new Error(`pull failed: ${jsonSafe(pull)}`)
  }
  const bridgeAgentUsdc = await pollUntil(
    () => readTokenBalance(bridgeAgent, { token: STELLAR_USDC_SAC, server }),
    (b) => b != null && b >= PULL_AMOUNT,
    { label: 'bridge agent CCTP-USDC after pull' }
  )
  console.log('    pull tx           :', pull.hash, `(relayed) status=${pull.status}`)
  console.log('    bridge agent USDC :', bridgeAgentUsdc.toString())
  done()

  // ── [4] burn (bridge agent session key) -> relay mint on Base -> pool deposit ───────────────
  // Reuses the SAME production glue baseLeg.js drives (crossChainFarm.runFarmFlow), with the
  // `burn` dep swapped for the grant-covered pull+burn path — this IS the "Node-side equivalent"
  // of runAgentBurn's relay path, not a re-derivation of it.
  done = stage('[4] deposit_for_burn (relayed) -> relayer mint+deposit (this waits out real CCTP attestation, ~13-25 min)')
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org'),
  })
  const minShares = await estimateMinShares({ pool, amountBaseUnits: BURN_UNITS7 / 10n, publicClient })
  console.log('    quoted minShares  :', minShares.toString())
  const allocations = [{ pool, amountBaseUnits: BURN_UNITS7 / 10n, minShares }]

  const result = await runFarmFlow({
    stellarWallet: { address: owner.publicKey() },
    baseRecipientAddress: kernelAddress,
    sessionKeyAddress: mandate.sessionAddress,
    serializedApproval: mandate.approval,
    allocations,
    burnUnits7: BURN_UNITS7,
    onEvent: (name, data) => console.log(`    [event] ${name}`, jsonSafe(data)),
    deps: {
      burn: async ({ amountUnits }) => {
        const burned = await runAgentBurn({
          bridgeAgentAddress: bridgeAgent,
          amountUnits,
          mintRecipient: mintRecipient32,
          sessionKey: bridgeSessionKey,
          server,
        })
        if (!burned) throw new Error('relay unavailable for deposit_for_burn')
        return burned
      },
      postFarm: (p) => postFarm({ ...p, baseUrl: RELAYER_BASE_URL }),
      // Client-side poll budget must exceed the relayer's own Iris poll ceiling
      // (relayer/src/cctp/iris.mjs DEFAULT_MAX_ATTEMPTS=300 @ 5s = 25 min) with margin.
      pollFarmStatus: (p) => pollFarmStatus({ ...p, baseUrl: RELAYER_BASE_URL, intervalMs: 15_000, maxTries: 130 }),
    },
  })
  console.log('    burn tx    :', result.burnHash)
  console.log('    job id     :', result.jobId)
  console.log('    final status:', result.finalStatus)
  if (result.finalStatus !== 'done') {
    throw new Error(`farm job did not settle: finalStatus=${result.finalStatus}`)
  }
  done()

  // ── [5] assert the pool deposit actually landed ─────────────────────────────────────────────
  done = stage('[5] assert pool deposit')
  const statusRes = await fetch(`${RELAYER_BASE_URL}/status/${result.jobId}`)
  const jobRecord = await statusRes.json()
  const depositsStep = jobRecord.steps?.find((s) => s.step === 'deposits')
  const mintStep = jobRecord.steps?.find((s) => s.step === 'mint')
  console.log('    mint step   :', jsonSafe(mintStep))
  console.log('    deposit step:', jsonSafe(depositsStep))
  const depositEntry = depositsStep?.results?.[0]
  if (!depositEntry || depositEntry.status !== 'fulfilled') {
    throw new Error(`pool deposit did not fulfil: ${jsonSafe(depositEntry)}`)
  }
  console.log('    deposit tx  :', depositEntry.value?.txHash)
  done()

  const summary = {
    at: new Date().toISOString(),
    ownerStellar: owner.publicKey(),
    routerV2: router,
    depositAgent,
    bridgeAgent,
    grantTx: grant.hash,
    pullTx: pull.hash,
    burnTx: result.burnHash,
    baseSmartAccount: kernelAddress,
    jobId: result.jobId,
    mintTx: mintStep?.mintTxHash,
    depositTx: depositEntry.value?.txHash,
    depositPool: pool,
    totalSeconds: ((Date.now() - t0) / 1000).toFixed(1),
  }
  console.log('\n=== PASS: grant v2 (1 sig) -> relayed pull -> relayed burn -> CCTP mint -> pool deposit ===')
  console.log(jsonSafe(summary, 2))

  const md = `## Grant-burn e2e smoke — ${summary.at}
- Owner (Stellar): ${summary.ownerStellar}
- Router v2: ${summary.routerV2}
- Deposit agent: ${summary.depositAgent}
- Bridge agent: ${summary.bridgeAgent}
- Grant tx (1 signature): ${summary.grantTx}
- Pull tx (relayed): ${summary.pullTx}
- Burn tx (relayed deposit_for_burn): ${summary.burnTx}
- Base smart account (mint recipient): ${summary.baseSmartAccount}
- Relayer job: ${summary.jobId}
- Base mint tx: ${summary.mintTx}
- Base pool deposit tx: ${summary.depositTx} (pool ${summary.depositPool})
- Wall clock: ${summary.totalSeconds}s
`
  writeFileSync(new URL('../SMOKE.md', import.meta.url), md, { flag: 'a' })
  return summary
}

main().catch((e) => {
  console.error('\nSMOKE FAILED:', e?.stack || e?.message || e)
  process.exitCode = 1
})
