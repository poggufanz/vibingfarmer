// frontend/src/wallet/ui/HonestyLabels.jsx
// Honesty labels rendered as first-class UI per project policy ("prove claims in code").
// Four claims, scoped so only the relevant subset appears on each screen.
//
// scope "global"   → labels 3 + 4 (welcome, home footer)
// scope "deposit"  → label 1 (near ApproveOverlay)
// scope "recovery" → label 2 (recovery screen)

const LABELS = {
  deposit:
    '⚠ F8 eligibility is app-layer only — not enforced on-chain (off-chain check, fail-closed).',
  recovery:
    '⚠ Recovery key is VF-custodied — a centralisation trade-off; guard this key carefully.',
  testnet: '⚠ Everything here is testnet-grade only — do not use real funds.',
  protocol:
    '⚠ Passkey-on-Stellar is mainnet-live at the protocol layer, but these wallet contracts are testnet PoC-grade.',
}

/**
 * @param {{ scope?: 'global' | 'deposit' | 'recovery' }} props
 */
export function HonestyLabels({ scope = 'global' }) {
  const s = {
    fontSize: 11,
    color: '#856404',
    background: '#fff3cd',
    border: '1px solid #ffc107',
    borderRadius: 4,
    padding: '4px 6px',
    margin: '4px 0',
  }
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
  // global
  return (
    <div data-testid="honesty-global">
      <p style={s}>{LABELS.testnet}</p>
      <p style={s}>{LABELS.protocol}</p>
    </div>
  )
}
