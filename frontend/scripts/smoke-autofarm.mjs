// frontend/scripts/smoke-autofarm.mjs
//
// Task 16 — LIVE end-to-end testnet smoke for the vf-autofarm loop: deposit -> keeper compound
// (sweep idle into the Blend strategy) -> harvest (second compound, honest zero-or-more gain) ->
// rebalance (de-risk-to-idle, since OWN_POOL_VIABLE=false means no pool2 — Task 1 spike) ->
// redeem all. Every step is a REAL --submit transaction, polled to on-chain SUCCESS before the
// next step reads state — sim-pass is not treated as proof (meta-rule from
// onchain-live-submit-error-playbook: a passing simulation does not mean the real submit works).
//
// Reuses the SAME modules the rest of the app trusts rather than a hand-rolled parallel copy:
//   - frontend/src/stellar/client.js  (readContract / buildInvokeTx) for deposit/redeem/rebalance
//     with a plain ed25519 keypair (from == tx source, so Soroban source-account auth applies —
//     no separate auth-entry signing needed, same model Task 11's CLI round-trip used).
//   - keeper/src/chain.js + keeper/src/decide.js (readState/decide/submit) for the keeper tick,
//     the actual Task 13 production code, imported cross-package (both pin
//     @stellar/stellar-sdk@^16.0.1, confirmed resolvable under vite-node).
//
// Identities:
//   - depositor = VF_FAUCET_SECRET (this is vf-deployer's own secret — confirmed live: `stellar
//     keys show vf-deployer` returns the exact same value already sitting in .env.local under
//     that name). Holds Blend testnet USDC (balance verified live before writing this script).
//   - keeper    = STELLAR_RELAYER_SECRET — the SAME relayer G-address the vault's on-chain
//     keeper() is set to (Task 11), so signing with it satisfies require_keeper.
//
// Run (Windows PowerShell, NOT WSL — rollup/win32; WSL is Soroban-CLI-only per CLAUDE.md):
//   cd frontend
//   npx vite-node scripts/smoke-autofarm.mjs --submit
//
// Needs frontend/.env.local: STELLAR_RELAYER_SECRET, VF_FAUCET_SECRET (both already present).

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import dotenv from 'dotenv'

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env.local') })

import { Keypair, scValToNative } from '@stellar/stellar-sdk'
import { rpcServer, readContract, buildInvokeTx } from '../src/stellar/client.js'
import {
  SOROBAN_RPC_URL,
  NETWORK_PASSPHRASE,
  SOROBAN_AUTOFARM_VAULT_ADDRESS,
  SOROBAN_STRATEGY_1_ADDRESS,
  SOROBAN_KEEPER_ADDRESS,
  SOROBAN_BLEND_POOL_ADDRESS,
  SOROBAN_TOKEN_ADDRESS,
} from '../src/stellar/config.js'
// Cross-package reuse of the real Task 13 keeper brain/IO — proven live (task-13-report.md).
import { readState, submit } from '../../keeper/src/chain.js'
import { decide } from '../../keeper/src/decide.js'

const VAULT = SOROBAN_AUTOFARM_VAULT_ADDRESS
const STRATEGY_1 = SOROBAN_STRATEGY_1_ADDRESS
const USDC = SOROBAN_TOKEN_ADDRESS

const DEPOSIT_AMOUNT = 5_000_000n // 5 USDC at 7dp
// Generous rounding guard across pro-rata share math (pps truncation, Blend bToken rounding) —
// still tiny relative to the 5,000,000-unit deposit.
const DUST_TOLERANCE = 2_000n
const REBALANCE_AMOUNT = 1_000_000n // 1 USDC de-risk-to-idle move
const APPROVE_EXPIRY_LEDGERS = 10_000 // ~14h at 5s ledgers — plenty for an immediate follow-up deposit

// keeper/wrangler.jsonc vars not exported from frontend/src/stellar/config.js (Task 11 only
// exported what the frontend UI needs) — mirrored here verbatim for the readState() env object.
const BLND = 'CB22KRA3YZVCNCQI64JQ5WE7UY2VAV7WFLK6A2JN3HEX56T2EDAFO7QF'
const SOROSWAP_ROUTER = 'CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD'

// Mirrors keeper/src/index.js's DEFAULT_* constants exactly (docs/superpowers/specs/
// 2026-07-03-vf-autofarm-design.md §5.2/§7).
const KEEPER_DECIDE_CONFIG = {
  minCompound: 1_0000000n,
  rebalanceBps: 50,
  cooldownS: 86400,
  slippageBps: 100,
}

function keeperEnv(relayerSecret) {
  return {
    SOROBAN_RPC_URL,
    NETWORK_PASSPHRASE,
    VAULT_ADDRESS: VAULT,
    STRATEGY_1,
    STRATEGY_2: '',
    POOL_1: SOROBAN_BLEND_POOL_ADDRESS,
    POOL_2: '',
    USDC,
    BLND,
    SOROSWAP_ROUTER,
    STELLAR_RELAYER_SECRET: relayerSecret,
  }
}

function bal(contract, id, server) {
  return readContract({ contract, method: 'balance', args: id != null ? [{ addr: id }] : [], server })
}

/** Build (source=signer) -> sign -> send -> poll to SUCCESS -> decode the return value. Throws
 * on rejection or non-SUCCESS confirmation (no silent "probably worked"). */
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

async function main() {
  console.log('=== Autofarm end-to-end testnet smoke (Task 16) ===')

  const depositorSecret = process.env.VF_FAUCET_SECRET // = vf-deployer's own secret (holds Blend USDC)
  if (!depositorSecret) throw new Error('VF_FAUCET_SECRET not set in frontend/.env.local')
  const relayerSecret = process.env.STELLAR_RELAYER_SECRET
  if (!relayerSecret) throw new Error('STELLAR_RELAYER_SECRET not set in frontend/.env.local')

  const depositor = Keypair.fromSecret(depositorSecret)
  const relayer = Keypair.fromSecret(relayerSecret)
  if (relayer.publicKey() !== SOROBAN_KEEPER_ADDRESS) {
    throw new Error(`STELLAR_RELAYER_SECRET does not match the vault's on-chain keeper() (${SOROBAN_KEEPER_ADDRESS})`)
  }

  const server = await rpcServer()
  console.log('depositor (vf-deployer):', depositor.publicKey())
  console.log('keeper (relayer):       ', relayer.publicKey())
  console.log('vault:', VAULT, ' strategy1:', STRATEGY_1)

  const usdcStart = await bal(USDC, depositor.publicKey(), server)
  const sharesStart = await bal(VAULT, depositor.publicKey(), server)
  console.log(`baseline: depositor USDC=${usdcStart} shares=${sharesStart}`)

  // ================= Step 1: deposit 5 USDC =================
  console.log('\n--- Step 1: deposit 5 USDC ---')
  const latest1 = await server.getLatestLedger()
  await invokeAndConfirm({
    server,
    source: depositor.publicKey(),
    signer: depositor,
    contract: USDC,
    method: 'approve',
    args: [
      { addr: depositor.publicKey() },
      { addr: VAULT },
      { i128: DEPOSIT_AMOUNT },
      { u32: latest1.sequence + APPROVE_EXPIRY_LEDGERS },
    ],
    label: 'token.approve(vault, 5 USDC)',
  })
  const depositResult = await invokeAndConfirm({
    server,
    source: depositor.publicKey(),
    signer: depositor,
    contract: VAULT,
    method: 'deposit',
    args: [{ addr: depositor.publicKey() }, { i128: DEPOSIT_AMOUNT }],
    label: 'vault.deposit(5 USDC)',
  })
  const sharesMinted = BigInt(depositResult.value)
  const sharesAfterDeposit = BigInt(await bal(VAULT, depositor.publicKey(), server))
  if (sharesAfterDeposit !== BigInt(sharesStart) + sharesMinted) {
    throw new Error(`share balance mismatch: expected ${BigInt(sharesStart) + sharesMinted}, got ${sharesAfterDeposit}`)
  }
  console.log(`PASS: deposit minted ${sharesMinted} shares (depositor shares ${sharesStart} -> ${sharesAfterDeposit})`)

  // ================= Step 2: keeper tick #1 -> compound sweeps idle =================
  console.log('\n--- Step 2: keeper tick #1 (compound sweeps idle into strategy1) ---')
  const env = keeperEnv(relayerSecret)
  const idleBefore = await bal(USDC, VAULT, server)
  const stratBefore = await bal(STRATEGY_1, null, server)
  console.log(`pre-tick: idle=${idleBefore} strategy1=${stratBefore}`)

  const state1 = await readState(env)
  const actions1 = decide(state1, KEEPER_DECIDE_CONFIG)
  console.log('decide() ->', JSON.stringify(actions1, (_, v) => (typeof v === 'bigint' ? v.toString() : v)))
  const compoundAction = actions1.find((a) => a.type === 'compound')
  if (!compoundAction) throw new Error('expected a compound action (idle > 0 after the deposit) but decide() returned none')
  const compoundHash1 = await submit(env, compoundAction)
  const compoundTx1 = await server.getTransaction(compoundHash1)
  const compoundGain1 = compoundTx1.returnValue ? scValToNative(compoundTx1.returnValue) : null
  console.log(`  [tx] keeper compound #1: ${compoundHash1} -> SUCCESS  total_gain=${compoundGain1}`)

  const idleAfter = BigInt(await bal(USDC, VAULT, server))
  const stratAfter = BigInt(await bal(STRATEGY_1, null, server))
  console.log(`post-tick: idle=${idleAfter} strategy1=${stratAfter}`)
  if (!(stratAfter > BigInt(stratBefore))) throw new Error('strategy1 balance did not rise — compound did not sweep idle')
  if (idleAfter > 1000n) throw new Error(`vault idle did not sweep to ~0 (got ${idleAfter})`)
  console.log('PASS: compound swept idle into strategy1')

  // ================= Step 3: second tick -> harvest (honest, may be 0 gain) =================
  console.log('\n--- Step 3: keeper tick #2 (harvest) ---')
  // decide() would return [] here — idle is now ~0 and pendingInterest is a documented
  // hardcoded-0 read (keeper/src/chain.js), so decideCompound's gate never re-fires on its own.
  // Drive the SAME on-chain vault.compound(min_outs) action directly through keeper/chain.js's
  // submit() instead of decide()'s gate (per the brief's explicit allowance) — this exercises
  // the real harvest path (blend_strategy.rs harvest(): full withdraw + resupply through Blend).
  // Real Blend interest over a short hold is very likely 0, and BLND emissions are off for USDC
  // supply (Task 1 spike) — an honest 0 gain with a SUCCESSFUL tx is the expected PASS here, not
  // a failure. Reuses submit() (not a hand-rolled invoke) — chain.js's own i128VecScVal builds
  // the Vec<i128> arg via a raw Contract.call, sidestepping a real bug found while writing this
  // script: client.js's encodeArgs sniffs wrapper shapes via `'i128' in a` / `'addr' in a`, but
  // js-xdr's Union codegen defines a generic accessor for EVERY possible arm name on the
  // prototype of every ScVal instance (union.js: `ChildUnion.prototype[armsName] = function
  // get() {...}` for each arm, regardless of which arm is actually set) — so `'i128' in
  // aScvVecInstance` is true even though its switch is `scvVec`, and a hand-built raw ScVal
  // passed through encodeArgs's "already an ScVal" passthrough branch gets misrouted into
  // i128ScVal(a.i128), where `a.i128` is that accessor FUNCTION itself, not a value.
  const harvestAction = { type: 'compound', minOuts: state1.strategies.map(() => 0n) }
  const harvestHash = await submit(env, harvestAction)
  const harvestTx = await server.getTransaction(harvestHash)
  const harvestGain = harvestTx.returnValue ? BigInt(scValToNative(harvestTx.returnValue)) : null
  console.log(`  [tx] keeper harvest (compound #2): ${harvestHash} -> SUCCESS  total_gain=${harvestGain}`)
  if (harvestGain === null || harvestGain < 0n) throw new Error(`harvest returned an invalid gain: ${harvestGain}`)
  console.log(`PASS: harvest tx confirmed — honest gain = ${harvestGain} (0 is expected and OK)`)

  // ================= Step 4: rebalance (de-risk-to-idle) =================
  console.log('\n--- Step 4: rebalance (de-risk-to-idle: strategy1 -> vault idle) ---')
  const stratBeforeRebalance = BigInt(await bal(STRATEGY_1, null, server))
  const idleBeforeRebalance = BigInt(await bal(USDC, VAULT, server))
  const maxMovable = (stratBeforeRebalance * 5000n) / 10_000n // on-chain DEFAULT_MAX_MOVE_BPS = 50%
  const rebalanceAmount = REBALANCE_AMOUNT < maxMovable ? REBALANCE_AMOUNT : maxMovable
  console.log(`strategy1 balance=${stratBeforeRebalance}, max movable (50% cap)=${maxMovable}, moving ${rebalanceAmount}`)
  if (rebalanceAmount <= 0n) throw new Error('nothing movable within the rebalance cap — strategy1 balance too small')

  await invokeAndConfirm({
    server,
    source: relayer.publicKey(),
    signer: relayer,
    contract: VAULT,
    method: 'rebalance',
    args: [{ addr: STRATEGY_1 }, { addr: VAULT }, { i128: rebalanceAmount }],
    label: 'vault.rebalance(strategy1 -> vault idle)',
  })

  const stratAfterRebalance = BigInt(await bal(STRATEGY_1, null, server))
  const idleAfterRebalance = BigInt(await bal(USDC, VAULT, server))
  if (!(stratAfterRebalance < stratBeforeRebalance)) throw new Error('strategy1 balance did not drop after rebalance')
  if (!(idleAfterRebalance > idleBeforeRebalance)) throw new Error('vault idle did not rise after rebalance')
  console.log(
    `PASS: rebalance moved funds out of strategy1 (${stratBeforeRebalance} -> ${stratAfterRebalance}) into vault idle (${idleBeforeRebalance} -> ${idleAfterRebalance})`
  )

  // ================= Step 5: redeem all remaining shares =================
  console.log('\n--- Step 5: redeem all remaining shares ---')
  const sharesToRedeem = BigInt(await bal(VAULT, depositor.publicKey(), server))
  const ppsBeforeRedeem = BigInt(await readContract({ contract: VAULT, method: 'price_per_share', args: [], server }))
  const usdcBeforeRedeem = BigInt(await bal(USDC, depositor.publicKey(), server))
  console.log(`redeeming ALL ${sharesToRedeem} shares held by depositor (price_per_share=${ppsBeforeRedeem})`)

  const redeemResult = await invokeAndConfirm({
    server,
    source: depositor.publicKey(),
    signer: depositor,
    contract: VAULT,
    method: 'redeem',
    args: [{ addr: depositor.publicKey() }, { i128: sharesToRedeem }],
    label: 'vault.redeem(all shares)',
  })
  const assetsRedeemed = BigInt(redeemResult.value)
  const usdcAfterRedeem = BigInt(await bal(USDC, depositor.publicKey(), server))
  if (usdcAfterRedeem - usdcBeforeRedeem !== assetsRedeemed) {
    throw new Error('redeem payout did not match depositor USDC balance delta')
  }

  // The depositor (vf-deployer) already held shares from prior task runs (Task 13's live
  // integration test) before this smoke's own 5-USDC deposit, so "redeem all" cashes out that
  // entire position, not just this run's slice. Isolate THIS deposit's round-trip honestly by
  // pricing just the shares it minted at the pre-redeem exchange rate.
  const mySliceAssets = (sharesMinted * ppsBeforeRedeem) / 10_000_000n
  console.log(`my 5-USDC deposit's slice at redemption: ${sharesMinted} shares -> ~${mySliceAssets} assets`)
  if (mySliceAssets < DEPOSIT_AMOUNT - DUST_TOLERANCE) {
    throw new Error(`my deposit's slice (${mySliceAssets}) fell below deposit-minus-dust (${DEPOSIT_AMOUNT - DUST_TOLERANCE})`)
  }
  console.log(`PASS: my slice's assets (${mySliceAssets}) >= deposit - dust (${DEPOSIT_AMOUNT - DUST_TOLERANCE})`)

  const netDelta = usdcAfterRedeem - BigInt(usdcStart)
  console.log(`\nfinal depositor USDC: ${usdcAfterRedeem} (started ${usdcStart}, net delta across the whole run = ${netDelta})`)
  console.log(`total assets redeemed this step (ALL shares, incl. pre-existing prior-task position): ${assetsRedeemed}`)
  console.log('\n=== ALL STEPS PASSED ===')
}

if (process.argv.includes('--submit')) {
  main().catch((e) => {
    console.error('autofarm smoke error:', e?.message || e)
    process.exitCode = 1
  })
} else {
  console.log('dry: module loaded, pass --submit to run live (needs STELLAR_RELAYER_SECRET + VF_FAUCET_SECRET in .env.local)')
}
