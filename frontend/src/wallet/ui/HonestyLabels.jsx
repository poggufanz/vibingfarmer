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
// The shared wallet stylesheet owns the warning surface and tokenized Forest/Day Field colors.
// No emoji per DESIGN §1.
//
// All six labels are plain-English safety prose, not technical data (no address/hash ever
// appears here) -- the shared class below MUST NOT set font-family. VF Wallet Task 9 fix loop 1
// found these labels rendering in "JetBrains Mono" (rejection-checklist item 5: "Body or friendly
// copy uses monospace") on 5 of 8 onboarding states, including the sentence that tells a user
// generating a real recovery phrase that the wallet is testnet-grade only. Mono is reserved for
// addresses/hashes (.pc-technical); this component never renders either, so it inherits the
// caller's body font instead. HonestyLabels.test.jsx guards this with a source-parse check.

const LABELS = {
  deposit:
    'F8 eligibility is app-layer only, not enforced on-chain (off-chain check, fail-closed).',
  recovery: 'VF-custodied recovery key is a centralisation trade-off. Guard this key carefully.',
  testnet: 'Everything here is testnet-grade only. Do not use real funds.',
  protocol:
    'Passkey-on-Stellar is mainnet-live at the protocol layer, but these wallet contracts are testnet PoC-grade.',
  agent:
    'Agent spending cap is not yet enforced on-chain (cap policy contract undeployed). Testnet PoC.',
  session_key:
    'While unlocked, this wallet keeps a key in chrome.storage.session (in-memory). Someone already running code on your machine could read it. Lock this wallet when done. Testnet PoC.',
}

/**
 * @param {{ scope?: 'global' | 'deposit' | 'recovery' | 'agent' | 'session-key' }} props
 */
export function HonestyLabels({ scope = 'global' }) {
  if (scope === 'deposit') {
    return (
      <p data-testid="honesty-deposit" className="pc-honesty-label">
        {LABELS.deposit}
      </p>
    )
  }
  if (scope === 'recovery') {
    return (
      <p data-testid="honesty-recovery" className="pc-honesty-label">
        {LABELS.recovery}
      </p>
    )
  }
  if (scope === 'agent') {
    return (
      <p data-testid="honesty-agent" className="pc-honesty-label">
        {LABELS.agent}
      </p>
    )
  }
  if (scope === 'session-key') {
    return (
      <p data-testid="honesty-session-key" className="pc-honesty-label">
        {LABELS.session_key}
      </p>
    )
  }
  // global
  return (
    <div data-testid="honesty-global">
      <p className="pc-honesty-label">{LABELS.testnet}</p>
      <p className="pc-honesty-label">{LABELS.protocol}</p>
    </div>
  )
}
