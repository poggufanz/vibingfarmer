// frontend/src/wallet/trustline.js
// Classic trustline (change_trust) path: without a trustline, sending any non-native asset to
// the classic address fails with op_no_trust. Mirrors send.js's structure — classic pays its
// OWN gas, no relay, and signs LOCALLY via withSecret.
import { TransactionBuilder, Operation, Asset, BASE_FEE, StrKey } from '@stellar/stellar-sdk'
import { NETWORK_PASSPHRASE } from '../stellar/config.js'
import { horizonServer, withSecret } from './classicAccount.js'
import { getUnlocked } from './session.js'

// The app's own USDC issuer (VF faucet/testnet) — quick-add chip in AddAssetScreen.
export const KNOWN_ASSETS = [
  {
    code: 'USDC',
    issuer: 'GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56',
    label: 'USDC (Vibing Farmer testnet)',
  },
]

// Pure validation, no network/session access — safe to call on every keystroke.
export function classifyTrustAsset(code, issuer) {
  const c = (code || '').trim()
  const iss = (issuer || '').trim()
  if (!/^[A-Za-z0-9]{1,12}$/.test(c)) {
    return { ok: false, error: 'Asset code must be 1-12 alphanumeric characters.' }
  }
  if (!StrKey.isValidEd25519PublicKey(iss)) {
    return { ok: false, error: 'Invalid issuer address.' }
  }
  return { ok: true, code: c, issuer: iss }
}

export async function buildChangeTrustXdr({
  account,
  code,
  issuer,
  limit,
  horizon = horizonServer(),
}) {
  const acc = await horizon.loadAccount(account)
  const builder = new TransactionBuilder(acc, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.changeTrust({
        asset: new Asset(code, issuer),
        ...(limit !== undefined ? { limit } : {}),
      })
    )
    .setTimeout(300)
  const tx = builder.build()
  return { xdr: tx.toXDR(), tx }
}

export async function addTrustline({ code, issuer, limit, horizon = horizonServer() }) {
  const classified = classifyTrustAsset(code, issuer)
  if (!classified.ok) throw new Error(classified.error)

  const u = await getUnlocked()
  if (!u) throw new Error('locked')

  const { tx } = await buildChangeTrustXdr({
    account: u.publicKey,
    code: classified.code,
    issuer: classified.issuer,
    limit,
    horizon,
  })
  await withSecret(async (kp) => tx.sign(kp))
  try {
    const res = await horizon.submitTransaction(tx)
    return { hash: res.hash, status: 'SUCCESS', code: classified.code, issuer: classified.issuer }
  } catch (e) {
    const codes = e?.response?.data?.extras?.result_codes
    if (codes?.operations?.includes('op_low_reserve')) {
      throw new Error('Not enough XLM: each trustline reserves 0.5 XLM.')
    }
    if (codes) {
      const summary = [codes.transaction, ...(codes.operations ?? [])].filter(Boolean).join(', ')
      throw new Error(`Trustline failed: ${summary}`)
    }
    throw e
  }
}
