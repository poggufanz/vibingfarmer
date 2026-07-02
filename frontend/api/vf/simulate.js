import { storeFrom } from './_db.js'
import { requireVfKey } from './_vfauth.js'

const json = (res, status, obj) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(obj))
}

export async function simulateCore({ xdr, passphrase, rpcServer, parse }) {
  const tx = parse(xdr, passphrase)
  const sim = await rpcServer.simulateTransaction(tx)
  return { ok: !sim.error, error: sim.error ? 'simulation failed' : undefined, latestLedger: sim.latestLedger }
}

export default async function handler(req, res) {
  const ctx = await requireVfKey(req, res, storeFrom(req), { scope: 'tx' })
  if (!ctx) return
  const xdr = req.body?.xdr
  if (typeof xdr !== 'string' || !xdr) return json(res, 400, { error: 'Missing xdr' })
  try {
    const sdk = await import('@stellar/stellar-sdk')
    const rpcServer = new sdk.rpc.Server(process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org')
    const passphrase = process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015'
    const out = await simulateCore({
      xdr, passphrase, rpcServer,
      parse: (x, p) => sdk.TransactionBuilder.fromXDR(x, p),
    })
    json(res, 200, out)
  } catch {
    json(res, 502, { error: 'upstream' })
  }
}
