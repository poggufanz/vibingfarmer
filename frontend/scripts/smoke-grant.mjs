// frontend/scripts/smoke-grant.mjs
//
// One-popup grant, end-to-end on Stellar testnet, headless (no browser). Proves the whole
// feature/one-popup-grant flow on-chain via the PRODUCTION assemblers (src/stellar/grant.js +
// agentDeposit.js), with a direct owner keypair standing in for the Freighter envelope popup and
// a fresh ed25519 session key standing in for the worker's cached session key:
//
//   1. ONE owner-signed grant tx (relayed, 0 gas) → router.grant
//        → nested SEP-41 token.approve(owner, router, budget, expiry)  (allowance == budget)
//        → deploy_v2 of one fresh agent_account (recorded agent -> owner in the router)
//   2. relayed router.pull(agent, amount)  → USDC moves owner -> agent  (0 popups)
//   3. relayed vault.deposit(agent, amount) → vault shares minted > 0    (0 popups)
//
// Mirrors the harness seams of scripts/stellar-deposit-smoke.mjs + m3plus-fund-approve-deposit
// -smoke.mjs: dotenv env loading, forged dev Origin on relay calls only, the VF_RELAY_URL knob,
// and direct keypair signing instead of a wallet. NOT part of `vitest run` — it hits live testnet.
//
// Run (needs the dev server up for /api/stellar-relay):
//   Terminal 1:  cd frontend && npm run dev
//   Terminal 2:  cd frontend && \
//                GRANT_OWNER_SECRET=S... VF_RELAY_URL=http://localhost:5173/api/stellar-relay \
//                node scripts/smoke-grant.mjs --submit
// VF_RELAY_URL is the FULL relay endpoint — config.js uses it verbatim as RELAY_PROXY_URL.
//
// GRANT_OWNER_SECRET = the S... secret of a FUNDED owner account: testnet XLM (friendbot) AND a
// Blend USDC balance + trustline (issuer GATALT…, token CAQCF…). The vf-deployer identity
// (GCIOUP4U…RYHNS) qualifies — `stellar keys show vf-deployer` in WSL. NEVER commit the secret;
// this script only reads it from the environment.
import 'dotenv/config'

// Headless node fetch sends no Origin → api/_guard.js applyCors 403s the relay call. Forge the
// dev origin on RELAY calls only (browser-enforced header; the same seam the wallet smokes use).
// Everything else (Soroban RPC) passes through untouched — wrapping those mangles the SDK Headers.
const realFetch = globalThis.fetch
// The forged header is the ORIGIN (scheme+host+port), derived from VF_RELAY_URL whether that is
// the bare origin or the full /api/stellar-relay endpoint — the CORS allowlist matches the origin.
const RELAY_ORIGIN = (() => {
  try {
    return new URL(process.env.VF_RELAY_URL || 'http://localhost:5173').origin
  } catch {
    return 'http://localhost:5173'
  }
})()
globalThis.fetch = (url, init = {}) => {
  if (!String(url).includes('/api/stellar-relay')) return realFetch(url, init)
  return realFetch(url, { ...init, headers: { ...(init.headers || {}), Origin: RELAY_ORIGIN } })
}

const { Keypair, TransactionBuilder } = await import('@stellar/stellar-sdk')
const { newSessionKey } = await import('../src/stellar/sessionKey.js')
const { submitGrant, runAgentPull, readAllowance } = await import('../src/stellar/grant.js')
const { runAgentDeposit, readVaultShares, readTokenBalance } = await import(
  '../src/stellar/agentDeposit.js'
)
const { rpcServer, readContract } = await import('../src/stellar/client.js')
const {
  NETWORK_PASSPHRASE,
  SOROBAN_ACTIVE_VAULT_ADDRESS,
  SOROBAN_FUNDING_ROUTER_ADDRESS,
} = await import('../src/stellar/config.js')

// 7-dp base units (1 USDC = 10_000_000). budget ≥ pull; pull == deposit; deposit ≥ Blend's supply
// minimum (a sub-1-USDC deposit mints 0 bTokens and the pool rejects it — see stellar-deposit-smoke).
const BUDGET = 50_000_000n // 5 USDC allowance (leaves 0-popup headroom for a repeat run)
const CAP = 50_000_000n // 5 USDC per-agent deposit cap
const PULL = 20_000_000n // 2 USDC funded to the agent
const DEPOSIT = 20_000_000n // 2 USDC deposited into the vault

async function pollUntil(read, ok, { tries = 30, intervalMs = 1500, label } = {}) {
  let v = await read()
  for (let i = 0; i < tries && !ok(v); i++) {
    await new Promise((r) => setTimeout(r, intervalMs))
    v = await read()
  }
  if (!ok(v)) throw new Error(`timed out waiting for ${label}: last=${v}`)
  return v
}

async function main() {
  const OWNER_SECRET = process.env.GRANT_OWNER_SECRET
  if (!OWNER_SECRET)
    throw new Error('set GRANT_OWNER_SECRET to a funded owner (testnet XLM + Blend USDC + trustline)')
  if (!SOROBAN_FUNDING_ROUTER_ADDRESS) throw new Error('SOROBAN_FUNDING_ROUTER_ADDRESS unset')

  const owner = Keypair.fromSecret(OWNER_SECRET)
  const server = await rpcServer()
  const router = SOROBAN_FUNDING_ROUTER_ADDRESS
  const vault = SOROBAN_ACTIVE_VAULT_ADDRESS

  console.log('=== one-popup grant smoke (testnet) ===')
  console.log('owner :', owner.publicKey())
  console.log('router:', router)
  console.log('vault :', vault)

  const ownerUsdcBefore = await readTokenBalance(owner.publicKey(), { server })
  console.log('owner USDC before:', ownerUsdcBefore?.toString())
  if (ownerUsdcBefore == null || ownerUsdcBefore < PULL)
    throw new Error(`owner has insufficient USDC (need ≥ ${PULL}, have ${ownerUsdcBefore})`)

  // ── 1. THE ONE POPUP: build → owner-sign the envelope → relayed grant ──────────────────────
  // A fresh ed25519 session key = the worker's on-chain "agent" signer; the router deploys the
  // agent_account pinned to it and records agent -> owner. Signing the envelope with the owner
  // keypair stands in for the single Freighter popup (source == owner covers the whole auth tree,
  // including the nested token.approve — no separate auth entry to sign).
  const sessionKey = newSessionKey()
  const nowSec = Math.floor(Date.now() / 1000)
  const agentInits = [
    {
      signer: sessionKey.rawPublicKey,
      cap: CAP,
      vault,
      periodDuration: 3600,
      expiry: nowSec + 86_400,
    },
  ]
  const signWithOwner = async (xdrB64) => {
    const tx = TransactionBuilder.fromXDR(xdrB64, NETWORK_PASSPHRASE)
    tx.sign(owner)
    return tx.toEnvelope().toXDR('base64')
  }

  // Note: no `server` passed to submitGrant — its direct-submit fallback (submitUserTx) treats an
  // injected server as a test fake, and we want the relay (0-gas) path anyway. buildGrantTx spins
  // up its own rpcServer(); reads below reuse the shared `server`.
  const grant = await submitGrant({
    owner: owner.publicKey(),
    budgetBaseUnits: BUDGET,
    durationSeconds: 86_400,
    agentInits,
    sign: signWithOwner,
  })
  if (grant.status !== 'SUCCESS') throw new Error(`grant not SUCCESS: ${grant.status}`)
  const agent = grant.agentAddresses[0]
  console.log('\n[1] grant tx        :', grant.hash, grant.relayer ? '(relayed, 0 gas)' : '(direct)')
  console.log('    agent deployed  :', agent)
  console.log('    expiry ledger   :', grant.expiryLedger)

  // allowance == budget, and the router recorded this agent -> owner.
  const allow = await readAllowance({ owner: owner.publicKey(), server })
  console.log('    allowance set   :', allow.amount.toString())
  if (allow.amount !== BUDGET)
    throw new Error(`allowance ${allow.amount} != budget ${BUDGET} — nested approve did not land`)
  const recordedOwner = await readContract({
    contract: router,
    method: 'owner_of',
    args: [{ addr: agent }],
    server,
  })
  console.log('    owner_of(agent) :', recordedOwner)
  if (recordedOwner !== owner.publicKey())
    throw new Error(`router did not record agent -> owner (got ${recordedOwner})`)

  // ── 2. relayed router.pull — USDC moves owner -> agent, 0 popups ────────────────────────────
  const pull = await runAgentPull({ agentAddress: agent, amount: PULL, sessionKey, server })
  if (!pull || (pull.status !== 'SUCCESS' && pull.status !== 'PENDING'))
    throw new Error(`pull failed: ${JSON.stringify(pull)}`)
  const agentUsdc = await pollUntil(
    () => readTokenBalance(agent, { server }),
    (b) => b != null && b >= PULL,
    { label: 'agent USDC after pull' }
  )
  console.log('\n[2] pull tx         :', pull.hash, `(relayed, 0 gas) status=${pull.status}`)
  console.log('    agent USDC      :', agentUsdc.toString())
  const ownerUsdcAfter = await readTokenBalance(owner.publicKey(), { server })
  console.log('    owner USDC after:', ownerUsdcAfter?.toString())
  if (ownerUsdcAfter == null || ownerUsdcBefore - ownerUsdcAfter < PULL)
    throw new Error('owner USDC did not drop by the pull amount')

  // ── 3. relayed vault.deposit — shares minted > 0, 0 popups ──────────────────────────────────
  const sharesBefore = (await readVaultShares(agent, { server })) ?? 0n
  const dep = await runAgentDeposit({ agentAddress: agent, amount: DEPOSIT, sessionKey, server })
  if (!dep || (dep.status !== 'SUCCESS' && dep.status !== 'PENDING'))
    throw new Error(`deposit failed: ${JSON.stringify(dep)}`)
  const sharesAfter = await pollUntil(
    () => readVaultShares(agent, { server }),
    (s) => s != null && s > sharesBefore,
    { label: 'vault shares after deposit' }
  )
  console.log('\n[3] deposit tx      :', dep.hash, `(relayed, 0 gas) status=${dep.status}`)
  console.log('    shares          :', sharesBefore.toString(), '->', sharesAfter.toString())
  if (sharesAfter <= sharesBefore) throw new Error('vault shares did not increase')

  console.log('\n=== PASS: one-popup grant → relayed pull → relayed deposit, shares minted ===')
  console.log('tx hashes:')
  console.log('  grant  :', grant.hash)
  console.log('  pull   :', pull.hash)
  console.log('  deposit:', dep.hash)
}

if (process.argv.includes('--submit')) {
  main().catch((e) => {
    console.error('smoke-grant error:', e?.stack || e?.message || e)
    process.exitCode = 1
  })
} else {
  console.log('dry: module loaded. pass --submit to run live (needs dev server + GRANT_OWNER_SECRET)')
}
