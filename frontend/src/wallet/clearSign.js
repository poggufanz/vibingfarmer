// Clear-sign decoding for the confirm screen. ONLY payment and createAccount are decoded to
// human-readable fields; every other op type (Soroban invokeHostFunction included) is returned
// opaque — deposits keep the existing relay/ApproveOverlay flow instead of clear-signed text.
import { TransactionBuilder } from '@stellar/stellar-sdk'
import { NETWORK_PASSPHRASE } from '../stellar/config.js'

export function assetLabel(asset) {
  if (!asset || asset.isNative?.()) return 'XLM'
  return `${asset.getCode()}:${asset.getIssuer()}`
}

function decodeOp(op) {
  if (op.type === 'payment') {
    return {
      type: 'payment',
      decodable: true,
      destination: op.destination,
      asset: assetLabel(op.asset),
      amount: op.amount,
    }
  }
  if (op.type === 'createAccount') {
    return { type: 'createAccount', decodable: true, destination: op.destination, amount: op.startingBalance }
  }
  // Soroban invokeHostFunction and everything else: DO NOT decode to text.
  return { type: op.type, decodable: false }
}

export function decodeForConfirm(xdr, networkPassphrase = NETWORK_PASSPHRASE) {
  const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase)
  const ops = tx.operations.map(decodeOp)
  const memo = tx.memo && tx.memo.value ? String(tx.memo.value) : ''
  return {
    source: tx.source,
    fee: tx.fee,
    memo,
    ops,
    kind: ops[0]?.type ?? 'other',
    decodable: ops.length > 0 && ops.every((o) => o.decodable),
  }
}
