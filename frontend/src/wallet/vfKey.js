// Wallet-held VF gateway API key (vf_…) — generated at /developers → Keys, stored locally.
// NOT a wallet secret (never a seed/private key): it only authenticates the wallet to the VF
// gateway. Presence switches the wallet's F8 checks from the local gate to the server gateway
// (rate-limited, usage-logged, server-authoritative facts).
const STORAGE_KEY = 'vf_wallet_api_key'

function defaultStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

export function getVfApiKey(storage = defaultStorage()) {
  try {
    return storage?.getItem(STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

export function setVfApiKey(value, storage = defaultStorage()) {
  try {
    const v = (value || '').trim()
    if (v) storage?.setItem(STORAGE_KEY, v)
    else storage?.removeItem(STORAGE_KEY)
  } catch {
    /* quota/private mode — key just won't persist */
  }
}
