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

const s = {
  fontFamily: '"JetBrains Mono", ui-monospace, monospace',
  fontSize: 11,
  lineHeight: 1.5,
  color: '#f0b54a',
  background: 'rgba(240,181,74,0.08)',
  border: '1px solid rgba(240,181,74,0.28)',
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
