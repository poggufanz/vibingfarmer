// Builds an UNSIGNED Soroban vault deposit tx. Non-custodial: signing happens on-device.
import { storeFrom } from './_db.js'
import { requireVfKey } from './_vfauth.js'

const json = (res, status, obj) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(obj))
}

export async function buildDepositCore({ from, amount, vault, passphrase, rpcServer }) {
  const { Contract, TransactionBuilder, Address, nativeToScVal, BASE_FEE } =
    await import('@stellar/stellar-sdk')
  const account = await rpcServer.getAccount(from)
  const contract = new Contract(vault)
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(
      contract.call('deposit', new Address(from).toScVal(), nativeToScVal(amount, { type: 'i128' }))
    )
    .setTimeout(300)
    .build()
  const prepared = await rpcServer.prepareTransaction(tx)
  return { xdr: prepared.toXDR() }
}

export default async function handler(req, res) {
  const ctx = await requireVfKey(req, res, storeFrom(req), { scope: 'tx' })
  if (!ctx) return
  const { kind, from, amount } = req.body ?? {}
  const vault = process.env.SOROBAN_VAULT_ADDRESS || ''
  if (!vault) return json(res, 503, { configured: false, error: 'Vault not configured' })
  const { StrKey } = await import('@stellar/stellar-sdk')
  let amt
  try {
    amt = BigInt(amount)
  } catch {
    return json(res, 400, { error: 'Invalid amount' })
  }
  if (kind !== 'deposit' || !StrKey.isValidEd25519PublicKey(from || '') || amt <= 0n) {
    return json(res, 400, { error: 'Invalid build request' })
  }
  try {
    const { rpc } = await import('@stellar/stellar-sdk')
    const rpcServer = new rpc.Server(
      process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org'
    )
    const out = await buildDepositCore({
      from,
      amount: amt,
      vault,
      passphrase: process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
      rpcServer,
    })
    json(res, 200, out)
  } catch {
    json(res, 502, { error: 'upstream' })
  }
}
