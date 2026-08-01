// Key-authed gasless relay. Reuses the reviewed relay core (fee-bump + deposit-only
// assertVaultDeposit guard live inside feeBumpAndSubmit). Non-custodial: the XDR is
// already signed on-device; the server only pays the fee.
import { storeFrom } from './_db.js'
import { requireVfKey } from './_vfauth.js'
import {
  RelaySubmissionUnknownError,
  feeBumpAndSubmit,
  relayResultHttpResponse,
  relayUnknownHttpResponse,
} from '../stellar-relay.js'

const json = (res, status, obj) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(obj))
}

async function liveRelay({ xdr, secret }) {
  const sdk = await import('@stellar/stellar-sdk')
  const rpcServer = new sdk.rpc.Server(
    process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org'
  )
  return feeBumpAndSubmit({
    xdr,
    secret,
    passphrase: process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
    vaultAddr: process.env.SOROBAN_VAULT_ADDRESS || '',
    sdk,
    rpcServer,
  })
}

/** Live handler with one narrow relay seam so the routed contract is testable with the real core. */
export async function handleSubmit(req, res, { relay = liveRelay } = {}) {
  const ctx = await requireVfKey(req, res, storeFrom(req), { scope: 'submit' })
  if (!ctx) return
  const xdr = req.body?.xdr
  if (typeof xdr !== 'string' || !xdr) return json(res, 400, { error: 'Missing xdr' })
  const secret = process.env.STELLAR_RELAYER_SECRET || ''
  if (!secret) return json(res, 503, { configured: false, error: 'Relay not configured' })
  try {
    const response = relayResultHttpResponse(await relay({ xdr, secret }))
    json(res, response.status, response.body)
  } catch (error) {
    if (error instanceof RelaySubmissionUnknownError || error?.code === 'VF_SUBMISSION_UNKNOWN') {
      const response = relayUnknownHttpResponse(error)
      return json(res, response.status, response.body)
    }
    json(res, 502, { error: 'upstream' })
  }
}

export default function handler(req, res) {
  return handleSubmit(req, res)
}
