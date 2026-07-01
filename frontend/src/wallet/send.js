// frontend/src/wallet/send.js
// Classic ed25519 payment path: build a Stellar payment, clear-sign it for the confirm screen,
// attach the F8 eligibility verdict when the destination is a known VF vault, then sign LOCALLY
// (withSecret) and submit via Horizon. Classic pays its OWN gas — the VF relayer is NOT used here
// and never receives a classic secret.
import { TransactionBuilder, Operation, Asset, Memo, BASE_FEE } from '@stellar/stellar-sdk'
import { NETWORK_PASSPHRASE } from '../stellar/config.js'
import { VAULT_CATALOG } from '../config.js'
import { eligibility } from '../vfapi/client.js'
import { decodeForConfirm } from './clearSign.js'
import { horizonServer, withSecret } from './classicAccount.js'

export function isKnownVault(address) {
  const vault = VAULT_CATALOG.find((v) => v.address === address)
  return vault ? { hit: true, vault } : { hit: false }
}

function toAsset(asset) {
  return asset === 'XLM' ? Asset.native() : new Asset(asset.code, asset.issuer)
}

export async function buildPaymentXdr({ from, to, asset, amount, memo, horizon = horizonServer() }) {
  const account = await horizon.loadAccount(from)
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.payment({ destination: to, asset: toAsset(asset), amount: String(amount) }))
    .setTimeout(300)
  if (memo) builder.addMemo(Memo.text(memo))
  const tx = builder.build()
  return { xdr: tx.toXDR(), tx }
}

export async function previewSend({ from, to, asset, amount, memo, horizon = horizonServer() }) {
  const { xdr } = await buildPaymentXdr({ from, to, asset, amount, memo, horizon })
  const confirm = decodeForConfirm(xdr)
  const known = isKnownVault(to)
  let vault = { hit: false }
  if (known.hit) {
    const e = await eligibility({ vault: known.vault.protocol, amount })
    vault = { hit: true, name: known.vault.name, allow: e.allow, reasons: e.reasons }
  }
  return { confirm, vault }
}

export async function sendPayment({ from, to, asset, amount, memo, horizon = horizonServer() }) {
  const { tx } = await buildPaymentXdr({ from, to, asset, amount, memo, horizon })
  await withSecret(async (kp) => tx.sign(kp))
  const res = await horizon.submitTransaction(tx)
  return { hash: res.hash, status: 'SUCCESS' }
}
