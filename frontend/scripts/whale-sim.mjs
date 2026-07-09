// frontend/scripts/whale-sim.mjs — TESTNET ONLY whale simulator for the lifeboat demo.
// Mechanism (plan deviation 3): the whale deposits big through OUR vault (--setup: deposit +
// keeper compound sweeps it into the Blend strategy), then exits everything in one tx
// (--attack: redeem all) — the redeem drains the strategy, which withdraws from the Blend
// pool, producing a GENUINE pool-liquidity drop. No mocked signals; the radar reacts to the
// same pool USDC balance read it uses in production.
//
// Run (Windows PowerShell, from frontend/):
//   npx vite-node scripts/whale-sim.mjs --setup --amount 3000
//   npx vite-node scripts/whale-sim.mjs --attack
// Needs frontend/.env.local: VF_FAUCET_SECRET (whale funds), STELLAR_KEEPER_SECRET (sweep).
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import dotenv from 'dotenv'

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env.local') })

import { Keypair, scValToNative } from '@stellar/stellar-sdk'
import { rpcServer, readContract, buildInvokeTx } from '../src/stellar/client.js'
import {
  NETWORK_PASSPHRASE,
  SOROBAN_RPC_URL,
  SOROBAN_AUTOFARM_VAULT_ADDRESS,
  SOROBAN_STRATEGY_1_ADDRESS,
  SOROBAN_BLEND_POOL_ADDRESS,
  SOROBAN_TOKEN_ADDRESS,
} from '../src/stellar/config.js'
import { readState, submit } from '../../keeper/src/chain.js'
import { decide } from '../../keeper/src/decide.js'

if (!NETWORK_PASSPHRASE.includes('Test SDF Network')) {
  console.error('whale-sim is TESTNET ONLY — refusing to run against', NETWORK_PASSPHRASE)
  process.exit(1)
}

const VAULT = SOROBAN_AUTOFARM_VAULT_ADDRESS
const USDC = SOROBAN_TOKEN_ADDRESS
const POOL = SOROBAN_BLEND_POOL_ADDRESS
const U7 = 10_000_000n
const APPROVE_EXPIRY_LEDGERS = 10_000

// Mirrors smoke-autofarm.mjs keeperEnv (keeper/wrangler vars not exported by config.js).
const BLND = 'CB22KRA3YZVCNCQI64JQ5WE7UY2VAV7WFLK6A2JN3HEX56T2EDAFO7QF'
const SOROSWAP_ROUTER = 'CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD'
const KEEPER_DECIDE_CONFIG = { minCompound: 1_0000000n, rebalanceBps: 50, cooldownS: 86400, slippageBps: 100 }

function keeperEnv(keeperSecret) {
  return {
    SOROBAN_RPC_URL,
    NETWORK_PASSPHRASE,
    VAULT_ADDRESS: VAULT,
    STRATEGY_1: SOROBAN_STRATEGY_1_ADDRESS,
    STRATEGY_2: '',
    POOL_1: POOL,
    POOL_2: '',
    USDC,
    BLND,
    SOROSWAP_ROUTER,
    STELLAR_KEEPER_SECRET: keeperSecret,
  }
}

const bal = (contract, id, server) =>
  readContract({ contract, method: 'balance', args: id != null ? [{ addr: id }] : [], server })

// Copied verbatim from smoke-autofarm.mjs (scripts are self-contained by convention).
async function invokeAndConfirm({ server, source, signer, contract, method, args, label }) {
  const { tx } = await buildInvokeTx({ source, contract, method, args, server })
  tx.sign(signer)
  const sent = await server.sendTransaction(tx)
  if (sent.status === 'ERROR') {
    throw new Error(`${label} rejected: ${JSON.stringify(sent.errorResult ?? sent)}`)
  }
  const final = await server.pollTransaction(sent.hash)
  if (final.status !== 'SUCCESS') {
    throw new Error(`${label} tx ${sent.hash} did not confirm: status=${final.status}`)
  }
  const value = final.returnValue ? scValToNative(final.returnValue) : null
  console.log(`  [tx] ${label}: ${sent.hash} -> SUCCESS${value !== null ? `  return=${value}` : ''}`)
  return { hash: sent.hash, value }
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}

async function poolLiquidity(server) {
  return BigInt(await bal(USDC, POOL, server))
}

async function setup() {
  const whaleSecret = process.env.VF_FAUCET_SECRET
  const keeperSecret = process.env.STELLAR_KEEPER_SECRET
  if (!whaleSecret || !keeperSecret) {
    throw new Error('VF_FAUCET_SECRET and STELLAR_KEEPER_SECRET must be set in frontend/.env.local')
  }
  const whale = Keypair.fromSecret(whaleSecret)
  const server = await rpcServer()
  const amount = BigInt(arg('--amount', '3000')) * U7

  console.log(`whale: ${whale.publicKey()}  deposit: ${amount} (${arg('--amount', '3000')} USDC)`)
  console.log(`pool liquidity before setup: ${await poolLiquidity(server)}`)

  const latest = await server.getLatestLedger()
  await invokeAndConfirm({
    server,
    source: whale.publicKey(),
    signer: whale,
    contract: USDC,
    method: 'approve',
    args: [
      { addr: whale.publicKey() },
      { addr: VAULT },
      { i128: amount },
      { u32: latest.sequence + APPROVE_EXPIRY_LEDGERS },
    ],
    label: 'whale token.approve(vault)',
  })
  await invokeAndConfirm({
    server,
    source: whale.publicKey(),
    signer: whale,
    contract: VAULT,
    method: 'deposit',
    args: [{ addr: whale.publicKey() }, { i128: amount }],
    label: `whale vault.deposit(${amount})`,
  })

  // Keeper sweep: idle -> Blend strategy (raises the pool's supplied liquidity).
  const env = keeperEnv(keeperSecret)
  const state = await readState(env)
  const compound = decide(state, KEEPER_DECIDE_CONFIG).find((a) => a.type === 'compound')
  if (!compound) throw new Error('expected a compound action after the whale deposit')
  const hash = await submit(env, compound)
  console.log(`  [tx] keeper compound (sweep whale funds into Blend): ${hash} -> SUCCESS`)
  console.log(`pool liquidity after setup: ${await poolLiquidity(server)}`)
  console.log('SETUP DONE — whale position is supplied to the Blend pool. Run --attack when ready.')
}

async function attack() {
  const whale = Keypair.fromSecret(process.env.VF_FAUCET_SECRET)
  const server = await rpcServer()
  const before = await poolLiquidity(server)
  const shares = BigInt(await bal(VAULT, whale.publicKey(), server))
  if (shares <= 0n) throw new Error('whale holds no vault shares — run --setup first')
  console.log(`ATTACK: whale redeems ALL ${shares} shares in one tx`)

  await invokeAndConfirm({
    server,
    source: whale.publicKey(),
    signer: whale,
    contract: VAULT,
    method: 'redeem',
    args: [{ addr: whale.publicKey() }, { i128: shares }],
    label: 'whale vault.redeem(ALL)',
  })

  const after = await poolLiquidity(server)
  const dropBps = before > 0n ? Number(((before - after) * 10_000n) / before) : 0
  console.log(`pool liquidity: ${before} -> ${after}  (drop ${dropBps} bps)`)
  if (dropBps < 3000) {
    console.warn('WARN: drop below the 3000 bps engage threshold — rerun --setup with a larger --amount')
  }
}

const mode = process.argv.includes('--attack') ? attack : process.argv.includes('--setup') ? setup : null
if (!mode) {
  console.log('usage: npx vite-node scripts/whale-sim.mjs --setup [--amount 3000] | --attack')
} else {
  mode().catch((e) => {
    console.error('whale-sim error:', e?.message || e)
    process.exitCode = 1
  })
}
