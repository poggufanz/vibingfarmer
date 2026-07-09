import { Keypair, StrKey } from '@stellar/stellar-sdk'
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import { derivePath } from 'ed25519-hd-key'

// Uint8Array -> lowercase hex (avoids relying on a Buffer polyfill)
function toHex(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0')
  return s
}

export function generate24() {
  return generateMnemonic(wordlist, 256) // 256 bits => 24 words
}

export function validate(mnemonic) {
  return validateMnemonic((mnemonic || '').trim(), wordlist)
}

export function keypairFromMnemonic(mnemonic, index = 0) {
  const m = (mnemonic || '').trim().replace(/\s+/g, ' ')
  if (!validateMnemonic(m, wordlist)) throw new Error('invalid mnemonic')
  const seed = mnemonicToSeedSync(m) // Uint8Array (64 bytes)
  const { key } = derivePath(`m/44'/148'/${index}'`, toHex(seed)) // SLIP-0010 ed25519, 32-byte key
  return Keypair.fromRawEd25519Seed(key)
}

export function keypairFromSecret(secret) {
  const s = (secret || '').trim()
  if (!StrKey.isValidEd25519SecretSeed(s)) throw new Error('invalid secret')
  return Keypair.fromSecret(s)
}

export function randomKeypair() {
  return Keypair.random()
}
