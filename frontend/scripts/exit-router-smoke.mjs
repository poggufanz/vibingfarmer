// frontend/scripts/exit-router-smoke.mjs
//
// Closes the gap the unit tests can't: a LIVE one-signature exit, end-to-end —
//   fresh G keypair -> Friendbot -> trustline -> ONE grant deploying N agents -> pull + deposit
//   each -> sweepAgents -> assert every agent emptied and the WHOLE thing cost 1 popup.
//
// It counts `sign` calls, because a sign call IS a wallet popup: that number, not a passing unit
// test, is the claim the product makes. It also pins the ceiling behind MAX_AGENTS_PER_SWEEP —
// run it with 6+ and watch the batch halve rather than fail.
//
// Run: cd frontend && node --env-file=.env.local scripts/exit-router-smoke.mjs [agentCount]
import {
  Keypair,
  TransactionBuilder,
  Contract,
  Operation,
  Asset,
  BASE_FEE,
  rpc,
  xdr,
} from '@stellar/stellar-sdk'
import { VF_TESTNET_ISSUER } from '../src/wallet/trustline.js'
import { buildInvokeTx } from '../src/stellar/client.js'
import { signAgentDepositEntries } from '../src/stellar/agentDeposit.js'
import { agentInitScVal } from '../src/stellar/grant.js'
import { sweepAgents, MAX_AGENTS_PER_SWEEP } from '../src/stellar/exit.js'
import { addrScVal, fromScVal } from '../src/stellar/scval.js'
import {
  NETWORK_PASSPHRASE,
  SOROBAN_RPC_URL,
  SOROBAN_TOKEN_ADDRESS,
  SOROBAN_ACTIVE_VAULT_ADDRESS,
  SOROBAN_FUNDING_ROUTER_ADDRESS,
} from '../src/stellar/config.js'

const N = Number(process.argv[2] || 3)
const server = new rpc.Server(SOROBAN_RPC_URL)
const relayer = Keypair.fromSecret(process.env.STELLAR_RELAYER_SECRET)
const faucet = Keypair.fromSecret(process.env.VF_FAUCET_SECRET)
const owner = Keypair.random()

const PER_AGENT = 20_000_000n // 2 USDC @ 7dp
const log = (...a) => console.log(...a)

async function submit(tx, signer) {
  if (signer) tx.sign(signer)
  const sent = await server.sendTransaction(tx)
  if (sent.status === 'ERROR')
    throw new Error(`send ERROR: ${JSON.stringify(sent.errorResult?.result?.().switch?.().name)}`)
  for (let i = 0; i < 30; i++) {
    const r = await server.getTransaction(sent.hash)
    if (r.status === 'SUCCESS') return { ...r, hash: sent.hash }
    if (r.status === 'FAILED') throw new Error(`tx FAILED ${sent.hash}`)
    await new Promise((res) => setTimeout(res, 2000))
  }
  throw new Error(`timeout ${sent.hash}`)
}

async function invoke({ source, signer, contract, method, args }) {
  const { tx } = await buildInvokeTx({ source, contract, method, args, server })
  return submit(tx, signer)
}

async function balanceOf(id) {
  const tx = new TransactionBuilder(await server.getAccount(relayer.publicKey()), {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(new Contract(SOROBAN_TOKEN_ADDRESS).call('balance', addrScVal(id)))
    .setTimeout(30)
    .build()
  const sim = await server.simulateTransaction(tx)
  return BigInt(fromScVal(sim.result.retval))
}

// ── 1. fresh owner ──────────────────────────────────────────────────────────
log(`owner: ${owner.publicKey()} (${N} agents)`)
await fetch(`https://friendbot.stellar.org?addr=${owner.publicKey()}`).then((r) => r.text())
// The token is a classic asset behind a SAC — a G-address holds nothing without a trustline.
const trust = new TransactionBuilder(await server.getAccount(owner.publicKey()), {
  fee: BASE_FEE,
  networkPassphrase: NETWORK_PASSPHRASE,
})
  .addOperation(Operation.changeTrust({ asset: new Asset('USDC', VF_TESTNET_ISSUER) }))
  .setTimeout(60)
  .build()
await submit(trust, owner)
await invoke({
  source: faucet.publicKey(),
  signer: faucet,
  contract: SOROBAN_TOKEN_ADDRESS,
  method: 'transfer',
  args: [{ addr: faucet.publicKey() }, { addr: owner.publicKey() }, { i128: PER_AGENT * BigInt(N) }],
})
log(`funded owner with ${await balanceOf(owner.publicKey())} base units USDC`)

// ── 2. ONE grant deploys N agents ───────────────────────────────────────────
const sessions = Array.from({ length: N }, () => Keypair.random())
const latest = await server.getLatestLedger()
const nowSec = Math.floor(Date.now() / 1000)
const inits = sessions.map((s) =>
  agentInitScVal({
    signer: s.rawPublicKey(),
    salt: crypto.getRandomValues(new Uint8Array(32)),
    cap: PER_AGENT,
    vault: SOROBAN_ACTIVE_VAULT_ADDRESS,
    periodDuration: 86_400,
    expiry: nowSec + 86_400,
  })
)
const grant = await invoke({
  source: owner.publicKey(),
  signer: owner,
  contract: SOROBAN_FUNDING_ROUTER_ADDRESS,
  method: 'grant',
  args: [
    { addr: owner.publicKey() },
    { i128: PER_AGENT * BigInt(N) },
    { u32: latest.sequence + 17_280 },
    xdr.ScVal.scvVec(inits),
  ],
})
const agents = fromScVal(grant.returnValue)
log(`grant ${grant.hash} -> agents ${agents.join(', ')}`)

// ── 3. fund + deposit each agent (session key signs, relayer sources) ───────
for (let i = 0; i < N; i++) {
  const sessionKey = {
    rawPublicKey: sessions[i].rawPublicKey(),
    sign: (p) => sessions[i].sign(Buffer.from(p)),
  }
  for (const [contract, method, args] of [
    [SOROBAN_FUNDING_ROUTER_ADDRESS, 'pull', [{ addr: agents[i] }, { i128: PER_AGENT }]],
    [SOROBAN_ACTIVE_VAULT_ADDRESS, 'deposit', [{ addr: agents[i] }, { i128: PER_AGENT }]],
  ]) {
    const { tx } = await buildInvokeTx({
      source: relayer.publicKey(),
      contract,
      method,
      args,
      server,
    })
    const { xdr: signedXdr } = await signAgentDepositEntries({
      tx,
      sessionKey,
      validUntilLedger: (await server.getLatestLedger()).sequence + 360,
      agentAddress: agents[i],
      server,
    })
    const prepared = await server.prepareTransaction(
      TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE)
    )
    const r = await submit(prepared, relayer)
    log(`  agent ${i} ${method} ${r.hash}`)
  }
}

const ownerBeforeSweep = await balanceOf(owner.publicKey())
log(`owner USDC before sweep: ${ownerBeforeSweep}`)

// ── 4. THE POINT: the real sweepAgents path — count the popups it costs ────
// Every call to `sign` IS a wallet popup in the browser. Counting them here is the only honest
// measure of "one approval": the tx count, the auth-entry count, and the credential type all have
// to line up, or the user gets a second Freighter prompt no unit test would have caught.
let popups = 0
const badCredentials = []
const signAsOwner = async (unsignedXdr) => {
  popups++
  const tx = TransactionBuilder.fromXDR(unsignedXdr, NETWORK_PASSPHRASE)
  for (const e of tx.operations[0].auth || []) {
    const kind = e.credentials().switch().name
    log(`  auth entry credentials: ${kind}`)
    if (kind !== 'sorobanCredentialsSourceAccount') badCredentials.push(kind)
  }
  tx.sign(owner)
  return tx.toEnvelope().toXDR('base64')
}

log('')
const { swept, txHashes } = await sweepAgents({
  owner: owner.publicKey(),
  agentAddresses: agents,
  to: owner.publicKey(),
  // No `server` on purpose: submitUserTx treats an injected server as the unit tests' fake one
  // (it posts raw xdr). The default path is the real one the browser takes anyway.
  sign: signAsOwner,
})
log(`WALLET POPUPS: ${popups} for ${N} agents`)
log(`sweep txs: ${[...new Set(txHashes)].join(', ')}`)
log(`swept per agent: ${JSON.stringify(swept.map(String))}`)

// ── 5. assert ───────────────────────────────────────────────────────────────
let bad = 0
const expectedPopups = Math.ceil(N / MAX_AGENTS_PER_SWEEP)
if (popups > expectedPopups) {
  console.error(`FAIL: ${popups} popups for ${N} agents — expected at most ${expectedPopups}`)
  bad++
}
if (badCredentials.length) {
  console.error(`FAIL: ${badCredentials.join(', ')} needs its own signature — a second popup`)
  bad++
}
for (let i = 0; i < N; i++) {
  const left = await balanceOf(agents[i])
  if (left !== 0n && left !== 0) {
    console.error(`FAIL: agent ${i} still holds ${left}`)
    bad++
  }
}
const ownerAfter = await balanceOf(owner.publicKey())
log(`owner USDC after sweep: ${ownerAfter} (+${BigInt(ownerAfter) - BigInt(ownerBeforeSweep)})`)
if (BigInt(ownerAfter) <= BigInt(ownerBeforeSweep)) {
  console.error('FAIL: no USDC reached the owner')
  bad++
}
console.log(bad ? `\n${bad} FAILURES` : `\nOK — ${N} agents exited on ${popups} signature(s)`)
process.exit(bad ? 1 : 0)
