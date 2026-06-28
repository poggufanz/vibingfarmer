// frontend/scripts/stellar-attest-smoke.mjs
// Live testnet proof: attest a known hash, fee-bump in-process, assert count rose.
// Run: cd frontend && node scripts/stellar-attest-smoke.mjs
import 'dotenv/config'
import { Keypair, TransactionBuilder, BASE_FEE, rpc } from '@stellar/stellar-sdk'
import { buildInvokeTx } from '../src/stellar/client.js'
import { readAttestationCount } from '../src/stellar/attestation.js'
import {
  SOROBAN_ATTESTATION_ADDRESS,
  NETWORK_PASSPHRASE,
  SOROBAN_RPC_URL,
} from '../src/stellar/config.js'

const relayerSecret = process.env.STELLAR_RELAYER_SECRET
if (!relayerSecret) throw new Error('set STELLAR_RELAYER_SECRET (funded relayer S... secret)')
const attesterSecret = process.env.ATTEST_SMOKE_SECRET || relayerSecret

const relayerKp = Keypair.fromSecret(relayerSecret)
const attesterKp = Keypair.fromSecret(attesterSecret)
const attester = attesterKp.publicKey()
const server = new rpc.Server(SOROBAN_RPC_URL)
const strategyHash = '0x' + 'ab'.repeat(32) // a known, reproducible test hash

const before = (await readAttestationCount(attester, { server })) ?? 0
console.log('count before:', before, 'attester:', attester)

// Build inner attest tx with attester as source, then user(attester)-sign it.
const { tx } = await buildInvokeTx({
  source: attester,
  contract: SOROBAN_ATTESTATION_ADDRESS,
  method: 'attest',
  args: [{ addr: attester }, { bytes32: strategyHash }, { symbol: 'smoke' }],
  server,
})
tx.sign(attesterKp)

// Relayer wraps it in a fee-bump (relayer = fee source) and pays the XLM.
const feeBump = TransactionBuilder.buildFeeBumpTransaction(
  relayerKp,
  (Number(BASE_FEE) * 100).toString(), // generous fee ceiling for a Soroban tx
  tx,
  NETWORK_PASSPHRASE,
)
feeBump.sign(relayerKp)

const sent = await server.sendTransaction(feeBump)
console.log('submitted:', sent.hash, sent.status)
let result = await server.getTransaction(sent.hash)
for (let i = 0; i < 30 && result.status === 'NOT_FOUND'; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  result = await server.getTransaction(sent.hash)
}
console.log('final status:', result.status)
if (result.status !== 'SUCCESS') throw new Error(`attest did not succeed: ${result.status}`)

const after = (await readAttestationCount(attester, { server })) ?? 0
console.log('count after:', after)
if (!(after > before)) throw new Error('FAIL: attestation count did not increase')
console.log('PASS: strategy attested on-chain')
console.log(`https://stellar.expert/explorer/testnet/tx/${sent.hash}`)
