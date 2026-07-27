// frontend/src/wallet/ui/HonestyLabels.jsx
// Honesty labels rendered as first-class UI per project policy ("prove claims in code").
// Six claims, scoped so only the relevant subset appears on each screen.
//
// scope "global"      → labels 3 + 4 (welcome, home footer)
// scope "deposit"     → label 1 (near ApproveOverlay)
// scope "recovery"    → label 2 (recovery screen)
// scope "agent"       → label 5 (agent screen)
// scope "session-key" → label 6 (classic wallet Settings screen, near the lock controls)
//
// Self-contained dark-warn styling (Acid Yield --warn) so it stays legible on the
// wallet popup without depending on the popup stylesheet. No emoji per DESIGN §1.
//
// All six labels are plain-English safety prose, not technical data (no address/hash ever
// appears here) -- the shared style below MUST NOT set font-family. VF Wallet Task 9 fix loop 1
// found these labels rendering in "JetBrains Mono" (rejection-checklist item 5: "Body or friendly
// copy uses monospace") on 5 of 8 onboarding states, including the sentence that tells a user
// generating a real recovery phrase that the wallet is testnet-grade only. Mono is reserved for
// addresses/hashes (.pc-technical); this component never renders either, so it inherits the
// caller's body font instead. HonestyLabels.test.jsx guards this with a source-parse check.

const LABELS = {
  deposit:
    'F8 eligibility is app-layer only, not enforced on-chain (off-chain check, fail-closed).',
  recovery: 'Recovery key is VF-custodied, a centralisation trade-off. Guard this key carefully.',
  testnet: 'Everything here is testnet-grade only. Do not use real funds.',
  protocol:
    'Passkey-on-Stellar is mainnet-live at the protocol layer, but these wallet contracts are testnet PoC-grade.',
  agent:
    'Agent spending cap is not yet enforced on-chain (cap policy contract undeployed). Testnet PoC.',
  session_key:
    'While unlocked, this wallet keeps a key in chrome.storage.session (in-memory). Someone already running code on your machine could read it. Lock this wallet when done. Testnet PoC.',
}

// VFW14 fix round 1 (reviewer finding), completed in fix round 2 (deferred-minor finding):
// `#f0b54a` is visibly off-token in the frozen Home baseline (WalletOnboarding/WalletSettings/
// WalletAdvanced all render inside `.pc-wallet`, which declares `--pc-warning: #e8a33d`) -- a
// different amber, not a token, serving exactly the role a token exists for. `var(--pc-warning,
// #f0b54a)` routes it through the real token wherever one is in scope, while keeping the identical
// literal `#f0b54a` as the fallback for the one caller outside the Pocket Crew wallet tree that has
// no `--pc-warning` in scope at all (extension/popup.jsx's legacy Acid Yield screens -- this file's
// own header comment: "stays legible on the wallet popup without depending on the popup
// stylesheet"), so that surface's rendering is untouched. Round 1 only routed `color`; round 2
// finishes `background`/`border` the same way -- `color-mix(in srgb, var(--pc-warning, #f0b54a)
// N%, transparent)` mixes the SAME token-or-fallback color down to N% opacity against transparent,
// so the fallback path renders byte-identically to the old literal `rgba(240,181,74, N/100)` (both
// are just the RGB of #f0b54a at N% alpha), while the Pocket Crew path now tints from the real
// token instead of a second, independently-hardcoded copy of the old off-token color.
const s = {
  fontSize: 11,
  lineHeight: 1.5,
  color: 'var(--pc-warning, #f0b54a)',
  background: 'color-mix(in srgb, var(--pc-warning, #f0b54a) 8%, transparent)',
  border: '1px solid color-mix(in srgb, var(--pc-warning, #f0b54a) 28%, transparent)',
  borderRadius: 6,
  padding: '7px 9px',
  margin: '4px 0',
}

/**
 * @param {{ scope?: 'global' | 'deposit' | 'recovery' | 'agent' | 'session-key' }} props
 */
export function HonestyLabels({ scope = 'global' }) {
  if (scope === 'deposit') {
    return (
      <p data-testid="honesty-deposit" style={s}>
        {LABELS.deposit}
      </p>
    )
  }
  if (scope === 'recovery') {
    return (
      <p data-testid="honesty-recovery" style={s}>
        {LABELS.recovery}
      </p>
    )
  }
  if (scope === 'agent') {
    return (
      <p data-testid="honesty-agent" style={s}>
        {LABELS.agent}
      </p>
    )
  }
  if (scope === 'session-key') {
    return (
      <p data-testid="honesty-session-key" style={s}>
        {LABELS.session_key}
      </p>
    )
  }
  // global
  return (
    <div data-testid="honesty-global">
      <p style={s}>{LABELS.testnet}</p>
      <p style={s}>{LABELS.protocol}</p>
    </div>
  )
}
