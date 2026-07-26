// frontend/src/wallet/ui/WalletShell.jsx
// VF Wallet Task 9 -- the shared 360px onboarding/account-choice shell (Pocket Crew redesign).
//
// No MV3 page has ever loaded frontend/extension/wallet.css or frontend/src/design/pocket-crew.css
// (popup.html links neither -- see wallet.css's own header, confirmed unchanged by this task).
// This component is therefore its own COMPLETE, self-sufficient copy of the exact contract slice
// onboarding needs, the same convention wallet.css/approval.css already established for MV3 pages
// that cannot share a stylesheet load. Tokens, hex values, radii, spacing, and motion below are
// copied VERBATIM from wallet.css's own verbatim port of the visual contract
// (docs/superpowers/specs/2026-07-23-pocket-crew-visual-contract.css) -- never re-derived, never
// approximated. VF Wallet Task 9 fix loop 1 re-ran a selector-by-selector census against the
// contract and corrected every drifted value found (0 remaining). The only intentional deviations
// from a byte-identical port are declared as separate, additional, scoped rules with a comment
// explaining why (the `.pc-brand-lockup--compact`/`textarea.pc-input` overrides below) -- no
// ported rule's own declared value differs from the contract's.
//
// Every onboarding/account-choice screen (WalletOnboarding.jsx) renders exactly one WalletShell as
// its outermost element, so this is the ONE place in the surface that defines `--pc-*` and the
// primitives those screens share (.pc-button, .pc-field, .pc-input, .pc-brand-lockup,
// .pc-network-badge, .pc-row) -- CreateScreen/ImportScreen/BackupScreen/UnlockScreen/
// OnboardingScreen carry no `<style>` of their own and reference these classes directly.
//
// `critical` marks the wrapper `[data-pocket-critical]` for documentation only (contract:
// "Consent, signing, recovery, revoke, and withdrawal use MOTION_INTENSITY 1-2") -- Task 9 fix
// loop 1 removed the `animation: none !important` rule the contract keys off that attribute,
// because (per VF Wallet Task 8's fix-loop-1 finding) that selector is element-scoped, NOT
// descendant-scoped, so it never stopped a child from animating; keeping a rule that looks like a
// safety net but is not is worse than no rule. The attribute stays as a plain, inert marker of
// which screens are critical. The real guarantee here is structural: nothing in this file's
// <style> (or any screen it wraps) declares an `@keyframes` or `animation` rule at all, proved by
// WalletOnboarding.test.jsx's cross-file source-parse guard.
//
// Props are plain strings/booleans/functions plus `account`, which is fixed to the public shape
// activeAccount.js's accountShape already produces (activeAccount.js:21-23: version/id/network/
// address/kind/signer) -- there is no prop here shaped to carry a mnemonic, secret key, password,
// or session key, so this component structurally cannot receive, hold, or forward one.
//
// Fix loop 2: two contract rules were absent from the port entirely (not drifted -- never copied
// at all), which the loop 1 value-by-value census could not detect because it only re-checked
// values it already knew to be wrong. Both are now ported verbatim, scoped to `.pc-wallet`: the
// global form-control font-family rule (contract :199-207 -- form controls do not inherit
// font-family, so `button`/`input`/`select`/`textarea` computed the UA default face against Geist
// body text) and `color-scheme: dark` (contract :39 -- native controls, e.g. BackupScreen.jsx:84's
// checkbox, rendered light-themed on the dark surface). Confirmed by computed style in real
// Chromium across all 8 onboarding states (WalletOnboarding.test.jsx), not by source diff alone.
// WalletShell.test.jsx's drift guard was also rewritten this loop: it now enumerates every
// contract-anchored selector this file claims to port and asserts each has a shipped counterpart,
// rather than comparing values against a list of previously-found problems -- the shape needed to
// catch an omitted rule, which a value list structurally cannot.
//
// VF Wallet Task 10, Part A1 (owner-directed, closing the VF Wallet Task 9 reviewer's follow-up
// finding): that hand-pinned CONTRACT_PORTED_RULES list itself had the identical blind spot one
// level up -- it could only ever re-check selectors a human remembered to add to it, never notice
// a 26th one. WalletShell.test.jsx's drift guard is now driven by
// walletContractManifest.generated.json, a GENERATED (not hand-transcribed) manifest produced by
// scripts/generate-wallet-contract-manifest.mjs parsing the actual (gitignored, local-only)
// contract file -- see that script's header for the full design. Any future `.pc-wallet-*` rule
// added to the contract is picked up automatically the next time the manifest is regenerated.
//
// Task 10 also adds the rules money-first Home/Send/Receive need (`.pc-wallet-balance`,
// `.pc-wallet-actions`, `.pc-wallet-origin`, `.pc-wallet-consequence`, `.pc-wallet-approval-actions`,
// all ported verbatim -- no rescoping needed, each already carries its own distinguishing class)
// and one thing the contract does NOT specify: an optional bottom tab bar (`.pc-wallet-nav`/
// `.pc-wallet-tab`) for the beginner Home/Activity/Settings navigation model, built entirely from
// already-ported tokens and excluded from the manifest guard (no contract rule to have a
// counterpart to), the same treatment `.bk-prog-*` already established below.

const STYLE = `
.pc-wallet {
  --pc-field: #17251f;
  --pc-grove: #20342b;
  --pc-harvest: #dff56c;
  --pc-rice: #f2f5ef;
  --pc-danger: #e26e67;
  --pc-warning: #e8a33d;
  --pc-canvas: var(--pc-field);
  --pc-workspace: var(--pc-grove);
  --pc-owned: var(--pc-rice);
  --pc-ink: var(--pc-rice);
  --pc-muted: #a8b5ad;
  --pc-owned-ink: var(--pc-field);
  --pc-harvest-ink: var(--pc-field);
  --pc-danger-ink: var(--pc-field);
  --pc-focus: var(--pc-harvest);
  --pc-focus-contrast: var(--pc-field);
  --pc-line: rgb(242 245 239 / 16%);
  --pc-line-strong: #8c9b93;

  --pc-font-body: 'Geist Variable', 'Geist', system-ui, sans-serif;
  --pc-font-mono: 'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, monospace;

  --pc-space-1: 4px;
  --pc-space-2: 8px;
  --pc-space-3: 12px;
  --pc-space-4: 16px;
  --pc-space-5: 20px;
  --pc-space-6: 24px;

  --pc-radius-control: 12px;
  --pc-radius-support: 16px;

  --pc-type-section: clamp(21px, 2vw, 28px);
  --pc-type-body: 16px;
  --pc-type-body-small: 14px;
  --pc-type-label: 13px;
  --pc-type-technical: 12px;
  --pc-leading-body: 1.55;

  --pc-control-height: 48px;
  --pc-touch-target: 44px;
  --pc-duration-fast: 120ms;
  --pc-ease-standard: cubic-bezier(0.4, 0, 0.2, 1);

  width: 360px;
  min-height: 560px;
  overflow-x: clip;
  /* Contract :39 (:root, :root[data-theme='forest']). Scoped here rather than on :root because
     this component owns no document-level selector -- see the file header. */
  color-scheme: dark;
  background: var(--pc-canvas);
  color: var(--pc-ink);
  font-family: var(--pc-font-body);
  font-size: var(--pc-type-body);
  line-height: var(--pc-leading-body);
}

.pc-wallet, .pc-wallet *, .pc-wallet *::before, .pc-wallet *::after { box-sizing: border-box; }

.pc-wallet h1 {
  max-width: 12ch;
  margin: 0 0 var(--pc-space-3);
  font-size: 28px;
  font-weight: 700;
  line-height: 1.12;
  letter-spacing: -0.03em;
}

.pc-wallet h2 {
  margin: 0 0 var(--pc-space-3);
  font-size: var(--pc-type-section);
  font-weight: 650;
  line-height: 1.2;
  letter-spacing: -0.02em;
}

.pc-wallet p { margin: 0; }

/* Contract :199-207. Form controls do not inherit font-family from an ancestor the way h1/h2/h3/p
   do, so without this rule button/input/select/textarea compute the UA default face even though
   .pc-wallet itself correctly declares Geist above. :where() (not a plain descendant selector)
   keeps this rule's specificity at .pc-wallet alone (0,1,0) -- the same trick the coarse-pointer
   media query below already uses -- so it stays BELOW code/pre/.pc-technical's specificity tie
   broken by source order: an input/textarea that also carries .pc-technical (the recovery-phrase
   confirmation input, BackupScreen.jsx; the secret-key/mnemonic import textarea, ImportScreen.jsx)
   must keep rendering in the mono face fix loop 1 verified, not switch to this rule's Geist. A
   plain .pc-wallet input selector has specificity (0,1,1), which would outrank .pc-technical
   alone (0,1,0) and silently regress that -- confirmed empirically in real Chromium before this
   rule shipped (see the fix loop 2 report). */
.pc-wallet :where(h1, h2, h3, button, input, select, textarea) {
  font-family: var(--pc-font-body);
}

.pc-wallet-shell {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  min-height: 560px;
}

.pc-wallet-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 56px;
  padding: 0 18px;
  border-bottom: 1px solid var(--pc-line);
}

.pc-wallet-main {
  display: grid;
  align-content: start;
  gap: var(--pc-space-6);
  padding: 20px 18px 24px;
}

/* VF Wallet Task 10 -- ported verbatim from contract :742-780 for the money-first Home/Send/
   Receive surfaces (WalletHome.jsx and friends). Byte-identical; no rescoping needed since each
   selector already carries its own distinguishing pc-wallet-* class. */
.pc-wallet-balance {
  font-size: 44px;
  font-variant-numeric: tabular-nums;
  font-weight: 720;
  letter-spacing: -0.05em;
  line-height: 1;
}

.pc-wallet-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--pc-space-3);
}

.pc-wallet-actions .pc-button, .pc-wallet-approval-actions .pc-button { width: 100%; }

.pc-wallet-origin {
  display: grid;
  gap: var(--pc-space-2);
  border-top: 1px solid var(--pc-line);
  border-bottom: 1px solid var(--pc-line);
  padding-block: var(--pc-space-4);
}

.pc-wallet-consequence {
  border-radius: var(--pc-radius-support);
  padding: var(--pc-space-5);
  background: var(--pc-owned);
  color: var(--pc-owned-ink);
}

.pc-wallet-approval-actions {
  display: grid;
  grid-template-columns: 1fr 1.35fr;
  gap: var(--pc-space-3);
}

/* Not in the contract (no bottom tab bar is specified there) -- this component invents it, same
   as .bk-prog-*/.pc-standard-form below: built entirely from already-ported tokens (line color,
   spacing, ink/muted, touch target), never a new hex/radius/animation value. Excluded from the
   manifest-driven drift guard (WalletShell.test.jsx) for the same reason .bk-prog-* is: there is no
   contract rule for it to have a counterpart to. Renders as the shell's third grid row (the
   pc-wallet-shell grid already reserves "auto minmax(0, 1fr) auto" -- this is that third row). */
.pc-wallet-nav {
  display: flex;
  justify-content: space-around;
  border-top: 1px solid var(--pc-line);
  padding: var(--pc-space-2);
}

.pc-wallet-tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--pc-space-1);
  min-height: var(--pc-touch-target);
  padding: var(--pc-space-1) var(--pc-space-3);
  border: 0;
  background: transparent;
  color: var(--pc-muted);
  font-size: var(--pc-type-label);
  font-weight: 650;
  cursor: pointer;
}

.pc-wallet-tab[aria-current='page'] { color: var(--pc-ink); }

.pc-brand-lockup {
  display: inline-flex;
  align-items: center;
  gap: var(--pc-space-2);
  color: currentcolor;
}

.pc-brand-lockup img { display: block; width: 24px; height: 24px; flex: none; }
/* The 360px popup header always uses the contract's --compact lockup size (20px), never the
   24px base -- scoped override, not an edit of the ported base rule. */
.pc-brand-lockup--compact img { width: 20px; height: 20px; }

.pc-network-badge {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 28px;
  color: inherit;
  font-size: var(--pc-type-label);
  font-weight: 620;
  white-space: nowrap;
}

.pc-wallet-back { justify-self: start; }

.pc-wallet-account-chip {
  padding: var(--pc-space-2) var(--pc-space-3);
  border-radius: var(--pc-radius-control);
  background: var(--pc-workspace);
  color: var(--pc-muted);
  font-size: var(--pc-type-label);
}

.pc-wallet-account-chip .pc-technical { color: var(--pc-ink); }

.pc-wallet-status {
  min-height: 1.2em;
  font-size: var(--pc-type-body-small);
  color: var(--pc-muted);
}

.pc-wallet-status[data-tone='error'] { color: var(--pc-danger); }

.pc-route-intro { margin-bottom: 0; color: var(--pc-muted); font-size: var(--pc-type-body); }

.pc-backup-warning { color: var(--pc-warning); font-size: var(--pc-type-body-small); }

code, pre, .pc-technical {
  font-family: var(--pc-font-mono);
  font-size: var(--pc-type-technical);
}

.pc-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: max-content;
  min-height: var(--pc-control-height);
  padding: 0 var(--pc-space-6);
  border: 1px solid transparent;
  border-radius: var(--pc-radius-control);
  font-size: var(--pc-type-body-small);
  font-weight: 700;
  line-height: 1;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
  transition:
    transform var(--pc-duration-fast) var(--pc-ease-standard),
    background-color var(--pc-duration-fast) var(--pc-ease-standard),
    border-color var(--pc-duration-fast) var(--pc-ease-standard);
}

.pc-button--primary { background: var(--pc-harvest); color: var(--pc-harvest-ink); }
.pc-button--secondary { border-color: var(--pc-line-strong); background: transparent; color: currentcolor; }
/* VF Wallet Task 11 -- ported verbatim from contract :377-381. The manifest generator's exclusion
   comment for .pc-button--danger explicitly anticipated this: "No destructive/danger-styled
   pc-button exists anywhere in the wallet today ... Port it if a future task adds one." Task 11's
   Reset wallet (classic/SettingsScreen.jsx) is that first real destructive action -- the
   generator's EXCLUDED_TOKEN_BASES entry for this selector is removed in the same change so the
   manifest guard picks it up as a real ported rule instead of silently excusing it forever. */
.pc-button--danger { border-color: var(--pc-danger); background: transparent; color: var(--pc-danger); }
.pc-button:active:not(:disabled) { transform: translateY(1px) scale(0.99); }
.pc-button:disabled, .pc-button[aria-disabled='true'] { cursor: not-allowed; opacity: 0.58; }

.pc-field { display: grid; gap: var(--pc-space-2); }
.pc-field > label { font-size: var(--pc-type-label); font-weight: 650; }
.pc-input {
  width: 100%;
  min-height: var(--pc-control-height);
  border: 1px solid var(--pc-line-strong);
  border-radius: var(--pc-radius-control);
  padding: 0 var(--pc-space-4);
  background: transparent;
  color: currentcolor;
  font-size: var(--pc-type-body);
}
/* The contract's .pc-input has no multi-line variant -- a single-line <input> centers its text
   vertically for free via UA rendering with zero vertical padding, but a <textarea> does not, so
   it needs its own breathing room. Scoped here rather than adding padding to the shared rule. */
textarea.pc-input { min-height: 72px; padding: var(--pc-space-2) var(--pc-space-4); }
.pc-field-help, .pc-field-error { margin: 0; font-size: var(--pc-type-label); }
.pc-field-help { color: var(--pc-muted); }
.pc-field-error { color: var(--pc-danger); }

.pc-standard-form { display: grid; gap: var(--pc-space-4); }

/* VF Wallet Task 10 fix loop 1 (I1) -- ported verbatim from contract :319-323. Found genuinely
   MISSING (no shipped counterpart at all) by the newly-inverted contract manifest guard: the
   Send screen's confirm/review card has always rendered with className="pc-support"
   (classic/SendScreen.jsx), but nothing in this file ever defined it, so it rendered with no
   background/border-radius/color distinction from the surrounding form -- exactly the class of
   silent omission the manifest guard exists to catch. */
.pc-support {
  border-radius: var(--pc-radius-support);
  background: var(--pc-workspace);
  color: var(--pc-ink);
}

.pc-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: var(--pc-space-4);
  align-items: center;
  min-height: 68px;
  padding-block: var(--pc-space-4);
  border-bottom: 1px solid var(--pc-line);
}
.pc-row:last-child { border-bottom: 0; }
.pc-account-picker, .pc-asset-list, .pc-activity-list { list-style: none; margin: 0; padding: 0; }

/* Token icon sizing -- relocated verbatim (visually unchanged) from the pre-Task-10 popup.jsx
   Acid Yield stylesheet, where classic/HomeScreen.jsx's <TokenIcon> (tokenIcons.jsx, off-limits
   for this task) previously got it from the old <Shell> wrapper. TokenIcon's <svg>/<div> renders
   with no explicit width/height of its own -- without an equivalent rule somewhere it would fall
   back to raw browser intrinsic SVG sizing (completely broken), so this has to live wherever
   HomeScreen now renders, which is inside this shell. Not contract-anchored (tokenIcons.jsx
   predates the Pocket Crew redesign) -- deliberately excluded from the manifest guard, the same
   treatment as .bk-prog-*. */
.vf-token-icon {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--pc-font-mono);
  font-weight: 700;
  font-size: 11px;
  color: #fff;
  flex-shrink: 0;
  text-transform: uppercase;
}
svg.vf-token-icon { display: block; overflow: hidden; }
.vf-token-icon.unknown { background: #546e7a; }

/* VF Wallet Task 10 -- real-browser 320px measurement (getBoundingClientRect, not just a
   screenshot) caught a genuine layout bug: a full, untruncated Stellar address (56-59 chars, no
   natural break points) inside code/pre/.pc-technical has no word-break of its own (the contract's
   rule, byte-identical port above, correctly doesn't add one -- most .pc-technical usages are
   short, already-truncated strings). Inside this shell's CSS-grid layout
   (.pc-wallet-shell/.pc-wallet-main have no explicit column track), an unbreakable ~420px-wide
   text node forces the single implicit grid column -- and every row sharing it, header and nav
   included -- to stretch past the fixed 320/360px box despite .pc-wallet's own overflow-x: clip
   (clip hides the paint, it does not stop the grid track's content-based sizing). Not
   contract-anchored (this specific full-address-display need doesn't exist in the contract) --
   excluded from the manifest guard, the same treatment as .bk-prog-*. classic/ReceiveScreen.jsx is
   the one caller. */
.pc-address-full { overflow-wrap: anywhere; word-break: break-all; }

.pc-choice-group { display: grid; gap: var(--pc-space-5); }
.pc-choice { display: grid; gap: var(--pc-space-2); }
.pc-choice p { color: var(--pc-muted); font-size: var(--pc-type-body-small); }

.pc-backup-step { display: grid; gap: var(--pc-space-3); }
.pc-backup-progress { display: grid; gap: var(--pc-space-2); }
.pc-backup-progress ol {
  display: flex;
  gap: var(--pc-space-3);
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: var(--pc-type-label);
  color: var(--pc-muted);
}
.pc-backup-progress li[aria-current='step'] { color: var(--pc-ink); font-weight: 700; }
/* M6 (fix loop 2): .bk-prog-* breaks the pc- prefix every other selector in this file (and the
   contract) follows -- documented rather than renamed to .pc-backup-*. These two classes are not
   contract rules (no .pc-backup-progress-adjacent track/fill exists in the contract for this
   file to port), they are this component's own invention, and BackupScreen.jsx:50-51 is their only
   consumer -- renaming here alone would be safe, but BackupScreen.test.jsx (pre-existing,
   unmodified, and outside this task's authorized file list) queries the DOM by .bk-prog-fill
   directly, so a rename would require editing a file this task is not allowed to touch. Left
   as-is; a future task authorized to touch BackupScreen.test.jsx can rename both. */
.bk-prog-track { height: 3px; background: var(--pc-line); overflow: hidden; }
.bk-prog-fill {
  width: 100%;
  height: 100%;
  background: var(--pc-harvest);
  transform-origin: left;
  transition: transform var(--pc-duration-base, 220ms) var(--pc-ease-standard);
}
.pc-backup-phrase {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--pc-space-2);
  margin: 0;
  padding: var(--pc-space-4);
  border: 1px solid var(--pc-line-strong);
  border-radius: var(--pc-radius-support);
  list-style: decimal inside;
}
.pc-backup-check {
  display: flex;
  align-items: center;
  gap: var(--pc-space-2);
  font-size: var(--pc-type-body-small);
  color: var(--pc-muted);
  cursor: pointer;
}

/* VF Wallet Task 10 fix loop 1 (M1) -- BackupScreen.jsx's "I've saved my recovery phrase
   securely" checkbox (step 2, the SAME screen that displays the twelve/24 .pc-technical recovery
   words above it) carries no class of its own and, without this rule, computes the ordinary
   .pc-wallet :where(...,input,...) form-control body font (Geist) while the words it confirms
   render mono -- a same-flow, two-faces inconsistency in the COMPUTED STYLE. Fixed here, in this
   shared shell, rather than by adding a class in BackupScreen.jsx: that file was not in Task 10's
   authorized file list. Specificity (0,2,0), a class plus a type selector, safely outranks the
   (0,1,0) form-control rule regardless of source order -- no fragile tie to maintain, unlike
   code/pre/.pc-technical's. Not contract-anchored (BackupScreen's confirmation checkbox is this
   component's own invention, like .bk-prog-*) -- excluded from the manifest guard for the same
   reason; guarded instead by WalletShell.test.jsx's own dedicated computed-style test below.
   VF Wallet Task 11 (M6, carried from the VF Wallet Task 10 review): the reviewer who originally
   raised this WITHDREW the finding as a false positive on further review -- a native checkbox
   renders no glyphs of its own, so font-family on it is genuinely unobservable; there was never
   a visible defect here to fix. Left uncorrected, the paragraph above (unchanged since Task 10)
   would keep reading as "this fixes a real, visible inconsistency," and a later reader would infer
   a bug that never existed. It is not: this rule is harmless-but-technically-redundant polish, kept
   for consistency with the words it sits beside, not because dropping it would regress anything a
   user could see. The rule and its guard test are left in place (removing either is equally valid
   per the Task 11 brief; commenting the record straight was the lower-risk of the two options). */
.pc-backup-check input { font-family: var(--pc-font-mono); }

:where(a, button, input, select, textarea, summary):focus-visible {
  outline: 3px solid var(--pc-focus);
  outline-offset: 3px;
  box-shadow: 0 0 0 5px var(--pc-focus-contrast);
}

@media (max-width: 359px) {
  .pc-wallet { width: 100vw; min-width: 320px; }
  .pc-wallet-main { padding-inline: 16px; }
}

@media (hover: none), (pointer: coarse) {
  .pc-wallet :where(button, [role='button'], a[href], summary, input, select, textarea) {
    min-height: var(--pc-touch-target);
  }
}

@media (prefers-reduced-motion: reduce) {
  html:focus-within {
    scroll-behavior: auto;
  }
  .pc-wallet *, .pc-wallet *::before, .pc-wallet *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    transition-delay: 0ms !important;
  }
}
`

export function WalletShell({
  heading,
  children,
  account = null,
  onBack = null,
  backLabel = 'Back',
  status = null,
  critical = false,
  // VF Wallet Task 10: an optional bottom tab bar for the beginner navigation model (exactly
  // Home/Activity/Settings -- see WalletHome.jsx/WalletActivity.jsx). Shape: { tabs: [{id,
  // label}], active: id, onNav: fn }. Omitted by every onboarding/account-choice screen (the
  // VFW9 surface this component originally shipped for) -- backward compatible, renders nothing
  // extra when absent, so none of WalletShell.test.jsx's existing assertions change.
  nav = null,
}) {
  return (
    <div className="pc-wallet" data-pocket-critical={critical ? '' : undefined}>
      <style>{STYLE}</style>
      <div className="pc-wallet-shell">
        <header className="pc-wallet-header">
          <span className="pc-brand-lockup pc-brand-lockup--compact">
            <img src="./vibing_farmer.logo.svg" alt="" />
            VF Wallet
          </span>
          <span className="pc-network-badge">Stellar testnet</span>
        </header>
        <main className="pc-wallet-main">
          {onBack && (
            <button
              type="button"
              className="pc-button pc-button--secondary pc-wallet-back"
              onClick={onBack}
            >
              {backLabel}
            </button>
          )}
          {account && (
            <p className="pc-wallet-account-chip" data-testid="wallet-account-chip">
              {account.kind === 'C' ? 'Passkey' : 'Standard'} ·{' '}
              <span className="pc-technical">
                {account.address.slice(0, 6)}…{account.address.slice(-4)}
              </span>
            </p>
          )}
          <h1>{heading}</h1>
          {children}
          <p
            role="status"
            aria-live="polite"
            className="pc-wallet-status"
            data-tone={status?.tone ?? 'info'}
          >
            {status?.message ?? ''}
          </p>
        </main>
        {nav && (
          <nav className="pc-wallet-nav" aria-label="Wallet">
            {nav.tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className="pc-wallet-tab"
                aria-current={tab.id === nav.active ? 'page' : undefined}
                onClick={() => nav.onNav(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        )}
      </div>
    </div>
  )
}
