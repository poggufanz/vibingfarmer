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

// Vault eligibility verdict for a destination. Non-vault addresses are not gated — shared by
// previewSend (UI hint) and sendPayment (fail-closed enforcement before signing).
async function vaultVerdict(to, amount) {
  const known = isKnownVault(to)
  if (!known.hit) return { hit: false }
  const e = await eligibility({ vault: known.vault.protocol, amount })
  return { hit: true, name: known.vault.name, allow: e.allow, reasons: e.reasons }
}

function toAsset(asset) {
  return asset === 'XLM' ? Asset.native() : new Asset(asset.code, asset.issuer)
}

export async function buildPaymentXdr({
  from,
  to,
  asset,
  amount,
  memo,
  horizon = horizonServer(),
}) {
  const account = await horizon.loadAccount(from)
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({ destination: to, asset: toAsset(asset), amount: String(amount) })
    )
    .setTimeout(300)
  if (memo) builder.addMemo(Memo.text(memo))
  const tx = builder.build()
  return { xdr: tx.toXDR(), tx }
}

export async function previewSend({ from, to, asset, amount, memo, horizon = horizonServer() }) {
  // Vault check FIRST: catalog vaults are Soroban C-addresses, which Operation.payment
  // rejects ("destination is invalid") — building the XDR first would throw before the
  // F8 verdict + "use Deposit" guard could ever render. Nothing is signed on this path.
  const vault = await vaultVerdict(to, amount)
  if (vault.hit) {
    return {
      confirm: {
        fee: BASE_FEE,
        memo: memo || '',
        ops: [
          { destination: to, asset: asset === 'XLM' ? 'XLM' : asset.code, amount: String(amount) },
        ],
        kind: 'vault',
        decodable: false,
      },
      vault,
    }
  }
  const { xdr } = await buildPaymentXdr({ from, to, asset, amount, memo, horizon })
  return { confirm: decodeForConfirm(xdr), vault }
}

export async function sendPayment({ from, to, asset, amount, memo, horizon = horizonServer() }) {
  const vault = await vaultVerdict(to, amount) // F8 fail-closed BEFORE any signing
  if (vault.hit && !vault.allow) {
    throw new Error(`ineligible: ${(vault.reasons ?? []).join('; ')}`)
  }
  const { tx } = await buildPaymentXdr({ from, to, asset, amount, memo, horizon })
  await withSecret(async (kp) => tx.sign(kp))
  const res = await horizon.submitTransaction(tx)
  return { hash: res.hash, status: 'SUCCESS' }
}
