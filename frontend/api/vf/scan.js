// Scan-before-send: StrKey classification + known-vault check + F8 eligibility verdict.
// HONESTY: app-layer verdict only — not on-chain-verifiable.
import { StrKey } from '@stellar/stellar-sdk'
import { evaluate } from '../../src/strategy/eligibilityGate.js'
import { resolve as resolveVaultFacts } from '../../src/strategy/vaultFacts.js'
import { storeFrom } from './_db.js'
import { requireVfKey } from './_vfauth.js'

const bigintSafe = (_, v) => (typeof v === 'bigint' ? v.toString() : v)

export default async function handler(req, res) {
  const ctx = await requireVfKey(req, res, storeFrom(req), { scope: 'scan' })
  if (!ctx) return
  const target = String(req.body?.target || '')
  const protocol = req.body?.protocol || 'blend-usdc'
  const kind = StrKey.isValidEd25519PublicKey(target)
    ? 'account'
    : StrKey.isValidContract(target)
      ? 'contract'
      : 'invalid'
  const isKnownVault = kind === 'contract' && target === (process.env.SOROBAN_VAULT_ADDRESS || '')
  const out = { kind, isKnownVault }
  if (isKnownVault) {
    const { facts } = resolveVaultFacts(protocol)
    out.eligibility = evaluate({ vault: target, amount: 10000000n, facts })
  }
  res.statusCode = 200
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(out, bigintSafe))
}
