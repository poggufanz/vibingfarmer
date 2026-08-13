// frontend/src/wallet/ui/WalletAdvanced.jsx
// VF Wallet Task 11 -- consolidates every genuinely-advanced/testnet-only wallet action behind one
// screen, reached from Settings (never from the beginner Home/Activity/Settings bottom nav): a
// friendbot/faucet action available to both account models, and three actions that only ever
// existed for the Passkey (C) account model (direct vault deposit, VF-custodied recovery signer,
// account.js/recovery.js are both kit-based ceremonies with no Standard/G equivalent) plus a
// recovery/import tool for the Standard (G) model. Every section below is gated on the caller
// actually supplying real support for it -- the same "no dead button, fail closed" rule
// WalletHome.jsx already established for onAddAsset/onFund -- so this screen never renders a
// control it cannot honor for the account it is showing.
//
// This screen REPLACES the old, pre-redesign 'deposit'/'signers'/'recovery'/'agent' Shell screens
// in popup.jsx. Those screens had no route in from the beginner nav Task 10 shipped (Home only
// links to Send/Receive/Add asset/Get test USDC) -- they were dead, unreachable code -- and, more
// seriously, the old 'agent' screen exposed `addAgentSigner` as a LIVE submit control (a real
// on-chain call attempt) years before its cap-policy contract is deployed, exactly what this
// task's brief forbids ("Do not expose addAgentSigner as a live action"). The standalone
// agent-signer section below is read-only documentation instead: no input, no button, no way to
// trigger `addAgentSigner` from this UI at all -- the required warning
// "Preview only — the required on-chain cap policy is not deployed" is the only thing this
// section says about it.
import { WalletShell } from './WalletShell.jsx'
import { ApproveOverlay } from './ApproveOverlay.jsx'
import { HonestyLabels } from './HonestyLabels.jsx'
import ImportScreen from './classic/ImportScreen.jsx'

function isEligibleVerdict(verdict) {
  return (
    verdict !== null &&
    typeof verdict === 'object' &&
    typeof verdict.allow === 'boolean' &&
    Array.isArray(verdict.reasons) &&
    verdict.allow
  )
}

export function WalletAdvanced({
  account,
  onBack,
  status = null,
  busy = false,
  onGetUsdc = null,
  onFundXlm = null,
  depositAmount = '',
  onDepositAmountChange = null,
  depositVerdict = null,
  onCheckEligibility = null,
  onEnableDeposits = null,
  onApproveDeposit = null,
  onRejectDeposit = null,
  recoveryAddress = '',
  onRecoveryAddressChange = null,
  onAddRecoverySigner = null,
  onImportWallet = null,
  importBusy = false,
  importError = null,
}) {
  return (
    <WalletShell heading="Advanced / Testnet" account={account} onBack={onBack} status={status}>
      <p className="pc-route-intro">
        Tools here are for testing this testnet build, not everyday use. Home, Send, and Receive
        stay the supported Pocket Crew route.
      </p>

      {(onFundXlm || onGetUsdc) && (
        <div className="pc-support" data-testid="advanced-faucet">
          <h2>Faucet</h2>
          {onFundXlm && (
            <button
              type="button"
              className="pc-button pc-button--secondary"
              disabled={busy}
              onClick={onFundXlm}
            >
              Fund via Friendbot (XLM)
            </button>
          )}
          {onGetUsdc && (
            <button
              type="button"
              className="pc-button pc-button--secondary"
              disabled={busy}
              onClick={onGetUsdc}
            >
              {busy ? 'Working…' : 'Get test USDC'}
            </button>
          )}
        </div>
      )}

      {account?.kind === 'C' && onCheckEligibility && (
        <div className="pc-support" data-testid="advanced-direct-deposit">
          <h2>Direct vault deposit (single wallet account)</h2>
          <p className="pc-field-help">
            Deposits straight into the vault contract, bypassing the Pocket Crew agent flow. The
            same F8 eligibility gate still applies.
          </p>
          <div className="pc-field">
            <label htmlFor="advanced-deposit-amount">Amount (USDC)</label>
            <input
              id="advanced-deposit-amount"
              className="pc-input pc-technical"
              type="number"
              placeholder="0"
              value={depositAmount}
              onChange={(e) => onDepositAmountChange?.(e.target.value)}
            />
          </div>
          <div className="pc-wallet-actions">
            {!depositVerdict && (
              <button
                type="button"
                className="pc-button pc-button--secondary"
                disabled={busy || !depositAmount}
                onClick={onCheckEligibility}
              >
                Check eligibility
              </button>
            )}
            <button
              type="button"
              className="pc-button pc-button--secondary"
              disabled={busy || !isEligibleVerdict(depositVerdict) || !onEnableDeposits}
              onClick={onEnableDeposits}
            >
              Enable deposits
            </button>
          </div>
          {depositVerdict !== null && depositVerdict !== undefined && (
            <ApproveOverlay
              verdict={depositVerdict}
              simulate={null}
              onApprove={onApproveDeposit}
              onReject={onRejectDeposit}
            />
          )}
          <HonestyLabels scope="deposit" />
        </div>
      )}

      {account?.kind === 'C' && onAddRecoverySigner && (
        <div className="pc-support" data-testid="advanced-recovery-signer">
          <h2>Recovery signer</h2>
          <p className="pc-field-help">
            Adds a VF-custodied recovery address as a delegated signer, a centralization trade-off,
            not a self-custodied backup.
          </p>
          {!recoveryAddress && (
            <p className="pc-field-help" data-testid="recovery-signer-status">
              Recovery signer: Unavailable
            </p>
          )}
          <div className="pc-field">
            <label htmlFor="advanced-recovery-address">Recovery G-address</label>
            <input
              id="advanced-recovery-address"
              className="pc-input pc-technical"
              placeholder="G..."
              value={recoveryAddress}
              onChange={(e) => onRecoveryAddressChange?.(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="pc-button pc-button--secondary"
            disabled={!recoveryAddress}
            onClick={onAddRecoverySigner}
          >
            Add recovery signer
          </button>
          <HonestyLabels scope="recovery" />
        </div>
      )}

      {account?.kind === 'G' && onImportWallet && (
        <div className="pc-support" data-testid="advanced-import">
          <p className="pc-backup-warning">
            Restoring a different wallet replaces the wallet on this device. Back up or export this
            one first if you want to keep using it.
          </p>
          <ImportScreen
            heading="Restore a different Standard wallet"
            busy={importBusy}
            error={importError}
            onImport={onImportWallet}
          />
        </div>
      )}

      <div className="pc-support" data-testid="advanced-agent-preview">
        <h2>Standalone agent signer (preview)</h2>
        <p className="pc-field-help">
          A future agent signer would let a scoped agent spend from this wallet within a policy
          boundary. There is nothing to fill in or submit here. This is documentation only.
        </p>
        <div className="pc-preview-facts">
          <div className="pc-preview-fact">
            <p className="pc-technical">Scope: vault-only agent spending</p>
            <p className="pc-backup-warning">Preview only: this cap policy is not deployed.</p>
          </div>
          <div className="pc-preview-fact">
            <p className="pc-technical">Cap: user-selected spending ceiling</p>
            <p className="pc-backup-warning">Preview only: this cap policy is not deployed.</p>
          </div>
          <div className="pc-preview-fact">
            <p className="pc-technical">Expiry: seven days</p>
            <p className="pc-backup-warning">Preview only: this cap policy is not deployed.</p>
          </div>
        </div>
      </div>
    </WalletShell>
  )
}
