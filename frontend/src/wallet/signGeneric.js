// Generic Soroban signing for VF Wallet's smart-account passkey signer — the piece that lets VF
// Wallet plug into @creit.tech/stellar-wallets-kit as an ordinary ModuleInterface
// (frontend/src/stellar/vfWalletModule.js) even though its account is a Soroban smart contract
// (contractId, secp256r1 passkey), not a classic keypair G-account.
//
// VF Wallet cannot sign a classic transaction ENVELOPE the way Freighter/xBull do — a contract
// address can never be a tx source (only a funded G-account can pay fees / hold a sequence
// number). What it CAN sign is a Soroban auth entry that requires ITS contractId's authorization
// — the exact primitive wallet/submit.js and stellar/agentDeposit.js already use for
// deposit/approve (kit.signAuthEntry). This module generalizes that pattern:
//
//   signTransactionForContract — given an ALREADY-ASSEMBLED unsigned tx (as handed to a
//     wallet-kit module's signTransaction()), finds any auth entries credentialed to
//     `contractId`, signs each via the passkey ceremony, and returns the re-serialized envelope.
//     Mirrors stellar/agentDeposit.js's signAgentDepositEntries loop shape (same
//     entry.credentials().switch().name / .address() accessors) — those entries are decoded as
//     LIVE references into the transaction's own xdr tree (see @stellar/stellar-base's
//     Operation.fromXDRObject: `result.auth = attrs.auth()`, no clone), so mutating them in
//     place and re-serializing via tx.toEnvelope() is the same proven approach, not a new one.
//
//   signAuthEntryString — signs a single entry, base64 XDR string in/out (the shape
//     @creit.tech/stellar-wallets-kit's ModuleInterface.signAuthEntry expects), wrapping the
//     same kit.signAuthEntry ceremony which works with decoded SDK objects.
import { makeKit } from './account.js'

/**
 * Signs every Soroban auth entry in `tx` that requires `contractId`'s authorization, in place,
 * leaving any other entries (e.g. a relayer's own) untouched.
 * @param {{tx:object, contractId:string, kit?:object, sdk?:object}} p
 * @returns {Promise<string>} base64 signed transaction envelope XDR
 */
export async function signTransactionForContract({ tx, contractId, kit, sdk }) {
  kit = kit ?? (await makeKit())
  const { Address } = sdk ?? (await import('@stellar/stellar-sdk'))
  const wantScAddress = Address.fromString(contractId).toScAddress().toXDR('base64')

  let signedAny = false
  for (const op of tx.operations) {
    const entries = op.auth || []
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      if (entry.credentials().switch().name !== 'sorobanCredentialsAddress') continue
      const creds = entry.credentials().address()
      if (creds.address().toXDR('base64') !== wantScAddress) continue // not this account
      entries[i] = await kit.signAuthEntry(entry) // Face-ID; SAK owns the ceremony
      signedAny = true
    }
  }
  if (!signedAny) {
    throw new Error("VF Wallet found no auth entry in this transaction for its own account")
  }
  return tx.toEnvelope().toXDR('base64')
}

/**
 * Signs a single Soroban auth entry, base64 XDR string in/out.
 * @param {{authEntry:string, kit?:object, sdk?:object}} p
 * @returns {Promise<string>} base64 signed auth entry XDR
 */
export async function signAuthEntryString({ authEntry, kit, sdk }) {
  kit = kit ?? (await makeKit())
  const { xdr } = sdk ?? (await import('@stellar/stellar-sdk'))
  const decoded = xdr.SorobanAuthorizationEntry.fromXDR(authEntry, 'base64')
  const signed = await kit.signAuthEntry(decoded)
  return signed.toXDR('base64')
}
