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
.pc-account-picker { list-style: none; margin: 0; padding: 0; }

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
      </div>
    </div>
  )
}
