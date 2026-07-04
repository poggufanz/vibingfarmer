// frontend/scripts/smoke-lifeboat.mjs — end-to-end lifeboat smoke (TESTNET, live txs).
// Sequence: assert armed -> start in-process radar (demo config) -> whale --attack ->
// expect LifeboatEngaged within ~2 ledgers -> expect resume after ~10 calm ledgers -> PASS.
// Run (PowerShell, from frontend/): npx vite-node scripts/smoke-lifeboat.mjs --submit
// Precondition: whale-sim --setup already ran (whale position supplied), mandate granted.
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawn } from 'node:child_process'
import dotenv from 'dotenv'

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env.local') })

import { rpcServer } from '../src/stellar/client.js'
import { readLifeboatState } from '../src/stellar/vaultReads.js'
import {
  SOROBAN_RPC_URL,
  NETWORK_PASSPHRASE,
  SOROBAN_AUTOFARM_VAULT_ADDRESS,
  SOROBAN_STRATEGY_1_ADDRESS,
  SOROBAN_BLEND_POOL_ADDRESS,
  SOROBAN_TOKEN_ADDRESS,
} from '../src/stellar/config.js'
import { runRadar } from '../../keeper/src/radar.js'
import { defaultConfig } from '../../keeper/src/lifeboat.js'
import { readLifeboatChainState, submit } from '../../keeper/src/chain.js'

const BLND = 'CB22KRA3YZVCNCQI64JQ5WE7UY2VAV7WFLK6A2JN3HEX56T2EDAFO7QF'
const SOROSWAP_ROUTER = 'CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD'

const env = {
  SOROBAN_RPC_URL,
  NETWORK_PASSPHRASE,
  VAULT_ADDRESS: SOROBAN_AUTOFARM_VAULT_ADDRESS,
  STRATEGY_1: SOROBAN_STRATEGY_1_ADDRESS,
  STRATEGY_2: '',
  POOL_1: SOROBAN_BLEND_POOL_ADDRESS,
  POOL_2: '',
  USDC: SOROBAN_TOKEN_ADDRESS,
  BLND,
  SOROSWAP_ROUTER,
  STELLAR_KEEPER_SECRET: process.env.STELLAR_KEEPER_SECRET,
  LIFEBOAT_ALL_CLEAR_LEDGERS: '10', // demo window (~1 min), not the production 100
}

async function latestLedger() {
  const res = await fetch(SOROBAN_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestLedger' }),
  })
  return Number((await res.json()).result.sequence)
}

const until = async (label, fn, timeoutMs, everyMs = 2000) => {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return Date.now() - t0
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`)
    await new Promise((r) => setTimeout(r, everyMs))
  }
}

async function main() {
  await rpcServer() // fail fast on RPC
  const s0 = await readLifeboatState()
  if (!s0) throw new Error('lifeboat_state read failed — is the wasm upgraded?')
  if (s0.derisked) throw new Error('vault already derisked — resume it before running the smoke')
  if (s0.mandateExpiry <= Math.floor(Date.now() / 1000)) {
    throw new Error('mandate expired/not granted — grant it (UI button or CLI set_mandate) first')
  }
  console.log('armed:', s0)

  const ac = new AbortController()
  const radar = runRadar({
    env,
    deps: { read: readLifeboatChainState, submit, latestLedger, log: console },
    config: defaultConfig(env),
    signal: ac.signal,
  })

  console.log('radar live — launching whale attack…')
  const t0 = Date.now()
  await new Promise((resolve, reject) => {
    const p = spawn('npx', ['vite-node', 'scripts/whale-sim.mjs', '--attack'], {
      stdio: 'inherit',
      shell: true,
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    })
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`whale attack exit ${code}`))))
  })

  const engageMs = await until('LifeboatEngaged (derisked=true)', async () => (await readLifeboatState())?.derisked === true, 60_000)
  console.log(`PASS: lifeboat ENGAGED ${((Date.now() - t0) / 1000).toFixed(1)}s after attack start (poll saw it at +${(engageMs / 1000).toFixed(1)}s)`)

  const resumeMs = await until('auto resume (derisked=false)', async () => (await readLifeboatState())?.derisked === false, 180_000)
  console.log(`PASS: auto-RESUMED after ${(resumeMs / 1000).toFixed(1)}s of calm (allClear=10 ledgers)`)

  ac.abort()
  await radar
  console.log('\n=== LIFEBOAT SMOKE: ALL STEPS PASSED ===')
}

if (process.argv.includes('--submit')) {
  main().catch((e) => {
    console.error('lifeboat smoke error:', e?.message || e)
    process.exitCode = 1
  })
} else {
  console.log('dry: module loaded, pass --submit to run live')
}
