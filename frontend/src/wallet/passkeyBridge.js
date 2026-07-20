// frontend/src/wallet/passkeyBridge.js
// One resolver for "who owns the Base smart account." The Task-1 spike
// (docs/superpowers/spikes/2026-07-17-vf-passkey-zerodev.md) concluded reuse = false: VF Wallet
// never durably persists the P-256 public key behind its Stellar passkey credential — only the
// opaque credentialId survives past registration (localStorage.vf_wallet_credential); the SDK's
// own capture of the public key lives in an in-heap MemoryStorage Map that dies with the page.
// Without pubX/pubY there is no way to reconstruct a ZeroDev webAuthnKey from the VF credential,
// so it can NEVER be reused as the Base owner. Every wallet — VF or otherwise — therefore gets
// ONE ZeroDev passkey ceremony, recorded here so it never repeats. This owner key guards Base
// withdraw (drain-proof by omission) — it must stay a real passkey, never a derived/stored secret.
//
// No top-level import of passkeyBase.js: isVfWallet (below) is reached EAGERLY, at app boot,
// via mergeFlowHelpers.js -> app.jsx — a static import here would drag the whole ZeroDev/viem
// chain into that eager path even though isVfWallet never touches it (proven empirically: it
// showed up in the eager dist chunk). The dynamic import inside ensureBaseOwner (mirrors
// orchestrator.js's baseLeg.js gating from Task 8) keeps that chain lazy — loaded only when a
// Base ceremony/login actually runs.
const OWNER_KEY = 'vf_base_owner'

export function isVfWallet(connectedAddress) {
  return !!connectedAddress && localStorage.getItem('vf_wallet_contract') === connectedAddress
}

export async function ensureBaseOwner({ connectedAddress, deps = {} }) {
  if (!connectedAddress) throw new Error('ensureBaseOwner: connectedAddress is required')
  let { createBaseSmartAccount } = deps
  if (!createBaseSmartAccount) {
    ;({ createBaseSmartAccount } = await import('./passkeyBase.js'))
  }

  // A corrupt/tampered record must self-heal into a fresh register ceremony, not crash resolution.
  let stored = null
  try {
    stored = JSON.parse(localStorage.getItem(OWNER_KEY) || 'null')
  } catch {
    stored = null
  }
  const mode = stored ? 'login' : 'register'
  const passkeyName = stored?.passkeyName || `vibing-farmer-base-${connectedAddress.slice(0, 8)}`

  // Two-way fallback — the OWNER_KEY record is a per-browser hint, not the truth. The truth is
  // the passkey itself (synced/phone-held), and login is DISCOVERABLE: the same credential
  // always derives the same kernel account, so both directions recover without any server-side
  // record:
  //   no record + register refused (credential already exists — new laptop, same wallet) → login
  //   record present + login failed (credential gone — wiped authenticator, stale record) → register
  // Deliberately swallows the first error only to try the one other mode; a double failure
  // rethrows the ORIGINAL error so a user cancel reads as a cancel, not a mystery.
  let account
  try {
    account = await createBaseSmartAccount({ passkeyName, mode })
  } catch (err) {
    const fallbackMode = mode === 'login' ? 'register' : 'login'
    try {
      account = await createBaseSmartAccount({ passkeyName, mode: fallbackMode })
    } catch {
      throw err
    }
  }

  const ownerMode = 'ceremony'
  localStorage.setItem(OWNER_KEY, JSON.stringify({ mode: ownerMode, passkeyName }))
  // Persisted separately from OWNER_KEY so the dashboard can read positions (dashboardPositions.js)
  // without ever touching the passkey — only an actual withdraw calls back into this ceremony.
  localStorage.setItem('vf_base_owner_address', account.address)
  return { ...account, ownerMode }
}
