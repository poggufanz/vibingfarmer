// TEMP harness: transfer Circle USDC (SAC, 7dp) from the SMOKE classic account to a fresh
// passkey wallet C-address so the live farm smoke has something to burn. Testnet only.
// Usage: node --env-file=.dev.vars .fund-usdc.tmp.mjs <C-address> <amount7dp>
import { rpc, Contract, TransactionBuilder, Address, nativeToScVal, Keypair, BASE_FEE } from '@stellar/stellar-sdk'

const USDC_SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const [, , to, amountRaw] = process.argv
if (!to || !amountRaw) throw new Error('usage: .fund-usdc.tmp.mjs <C-address> <amount7dp>')

const server = new rpc.Server(process.env.SOROBAN_RPC_URL)
const passphrase = process.env.STELLAR_NETWORK_PASSPHRASE
const kp = Keypair.fromSecret(process.env.SMOKE_STELLAR_SECRET)
const sourcePub = process.env.SMOKE_STELLAR_PUBLIC

const op = new Contract(USDC_SAC).call(
  'transfer',
  Address.fromString(sourcePub).toScVal(),
  Address.fromString(to).toScVal(),
  nativeToScVal(BigInt(amountRaw), { type: 'i128' })
)
const source = await server.getAccount(sourcePub)
const built = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: passphrase })
  .addOperation(op)
  .setTimeout(120)
  .build()
const prepared = await server.prepareTransaction(built)
prepared.sign(kp)
const sent = await server.sendTransaction(prepared)
if (sent.status === 'ERROR') throw new Error('send ERROR: ' + JSON.stringify(sent.errorResult ?? sent))
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 2000))
  const got = await server.getTransaction(sent.hash)
  if (got.status === 'NOT_FOUND') continue
  console.log(JSON.stringify({ hash: sent.hash, status: got.status }))
  process.exit(got.status === 'SUCCESS' ? 0 : 1)
}
throw new Error('not confirmed: ' + sent.hash)
