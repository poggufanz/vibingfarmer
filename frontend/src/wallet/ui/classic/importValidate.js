import { StrKey } from '@stellar/stellar-sdk'
import { validate as validMnemonic } from '../../classicKeypair.js'

export function classifyImport(input) {
  const s = (input || '').trim().replace(/\s+/g, ' ')
  if (StrKey.isValidEd25519SecretSeed(s)) return { kind: 'secret', normalized: s }
  const words = s.split(' ').filter(Boolean)
  if (words.length === 12 || words.length === 24) {
    if (validMnemonic(s)) return { kind: 'mnemonic', normalized: s }
    return {
      kind: 'invalid',
      error: 'Recovery phrase checksum failed. Check for a mistyped word.',
    }
  }
  return { kind: 'invalid', error: 'Enter a 12/24-word recovery phrase or an S… secret key.' }
}
