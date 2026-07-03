// Key-authed gasless relay. Reuses the reviewed relay core (fee-bump + deposit-only
// assertVaultDeposit guard live inside feeBumpAndSubmit). Non-custodial: the XDR is
// already signed on-device; the server only pays the fee.
import { storeFrom } from './_db.js'
import { requireVfKey } from './_vfauth.js'

const json = (res, status, obj) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(obj))
}

export async function submitCore({ xdr, deps }) {
  return deps.relay({ xdr })
}

export default async function handler(req, res) {
  const ctx = await requireVfKey(req, res, storeFrom(req), { scope: 'submit' })
  if (!ctx) return
  const xdr = req.body?.xdr
  if (typeof xdr !== 'string' || !xdr) return json(res, 400, { error: 'Missing xdr' })
  const secret = process.env.STELLAR_RELAYER_SECRET || ''
  if (!secret) return json(res, 503, { configured: false, error: 'Relay not configured' })
  try {
    const sdk = await import('@stellar/stellar-sdk')
    const { feeBumpAndSubmit } = await import('../stellar-relay.js')
    const rpcServer = new sdk.rpc.Server(
      process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org'
    )
    const out = await submitCore({
      xdr,
      deps: {
        relay: ({ xdr: x }) =>
          feeBumpAndSubmit({
            xdr: x,
            secret,
            passphrase:
              process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
            vaultAddr: process.env.SOROBAN_VAULT_ADDRESS || '',
            sdk,
            rpcServer,
          }),
      },
    })
    json(res, 200, out)
  } catch {
    json(res, 502, { error: 'upstream' })
  }
}
