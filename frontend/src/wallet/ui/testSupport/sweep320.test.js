// frontend/src/wallet/ui/testSupport/sweep320.test.js
// VF Wallet Task 12, Part A1 -- mutation proof for the shared 320px sweep. Standing rule this
// wave learned the hard way (see the task report): verify every guard with a POSITIVE CONTROL --
// inject the exact defect the guard claims to catch, confirm it actually reports it, then remove
// the defect and confirm green again. Two fixtures below reproduce the two concrete overflow
// mechanisms named in the Part A1 brief:
//   1. `.pc-button`'s `white-space: nowrap` + `min-width: max-content` meeting a long label.
//   2. An untruncated technical string (address/hash) with no word-break rule.
// Both fixtures wrap their content in a `overflow-x: hidden` box on purpose: that is what makes
// this a real test of the STRONGER per-element check (getBoundingClientRect().right), not the
// weaker document.scrollWidth check it replaces -- a hidden/clip overflow container can keep
// `document.documentElement.scrollWidth` pinned at 320 while a child element's own box still
// pokes out past 320.5px (the exact `.pc-wallet { overflow-x: clip }` failure mode
// WalletShell.jsx and WalletSettings.test.jsx both document). If sweep320 only checked
// document-level scrollWidth, both mutated fixtures below would read as a false green.
import { describe, expect, it } from 'vitest'
import { sweep320 } from './sweep320.js'

const BOX_OPEN = '<div style="width:320px;box-sizing:border-box;overflow-x:hidden;padding:8px">'
const BOX_CLOSE = '</div>'

// Mechanism 1: a .pc-button-shaped element (white-space: nowrap + min-width: max-content) with a
// long, unbreakable label.
function buttonFixture({ injectLongLabel }) {
  const label = injectLongLabel
    ? 'ThisIsAnExtremelyLongUnbreakableButtonLabelInjectedByTheMutation'
    : 'Approve'
  return `${BOX_OPEN}<button style="display:inline-flex;white-space:nowrap;min-width:max-content;height:48px;padding:0 24px;border:1px solid transparent;">${label}</button>${BOX_CLOSE}`
}

// Mechanism 2: a raw technical string (address/hash shape) with no word-break rule, inside a
// CSS-grid parent -- the actual shape of the historical bug (WalletShell.jsx's own header:
// ".pc-wallet-main/.pc-wallet-shell have no explicit column track" -- a CSS grid's implicit
// column genuinely sizes to its content's min-content width, which grows the GRID CONTAINER's own
// layout box, unlike a plain block box wrapping unbreakable text (which clips invisibly without
// changing any element's own boundingClientRect). A grid parent is what makes this mutation
// observable via getBoundingClientRect at all, exactly reproducing why the real bug escaped a
// naive box model and needed real layout to catch.
function addressFixture({ injectUntruncatedAddress }) {
  const address = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXY'
  const wordBreak = injectUntruncatedAddress ? '' : 'overflow-wrap:anywhere;word-break:break-all;'
  return `${BOX_OPEN}<div style="display:grid;"><span style="font-family:monospace;${wordBreak}">${address}</span></div>${BOX_CLOSE}`
}

describe('sweep320 — mutation-proof (positive control) for the long-label overflow mechanism', () => {
  it('passes on the clean fixture (short label, no overflow)', async () => {
    await expect(
      sweep320([['clean-button', buttonFixture({ injectLongLabel: false })]])
    ).resolves.toBeUndefined()
  }, 60000)

  it('RED: fails when a long unbreakable label is injected into the .pc-button-shaped element', async () => {
    await expect(
      sweep320([['mutated-button', buttonFixture({ injectLongLabel: true })]])
    ).rejects.toThrow(/widest element right edge/)
  }, 60000)

  it('GREEN: passes again once the injected long label is removed', async () => {
    await expect(
      sweep320([['clean-button-again', buttonFixture({ injectLongLabel: false })]])
    ).resolves.toBeUndefined()
  }, 60000)
})

describe('sweep320 — mutation-proof (positive control) for the untruncated-address overflow mechanism', () => {
  it('passes on the clean fixture (word-break applied)', async () => {
    await expect(
      sweep320([['clean-address', addressFixture({ injectUntruncatedAddress: false })]])
    ).resolves.toBeUndefined()
  }, 60000)

  it('RED: fails when the word-break rule is removed from a full, untruncated address', async () => {
    await expect(
      sweep320([['mutated-address', addressFixture({ injectUntruncatedAddress: true })]])
    ).rejects.toThrow(/widest element right edge/)
  }, 60000)

  it('GREEN: passes again once the word-break rule is restored', async () => {
    await expect(
      sweep320([['clean-address-again', addressFixture({ injectUntruncatedAddress: false })]])
    ).resolves.toBeUndefined()
  }, 60000)
})
