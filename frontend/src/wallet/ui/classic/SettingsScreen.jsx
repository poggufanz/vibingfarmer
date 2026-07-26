// frontend/src/wallet/ui/classic/SettingsScreen.jsx
// VF Wallet Task 11 -- recomposed onto the shared WalletShell/pc-* primitives, the same treatment
// Task 9 gave BackupScreen/ImportScreen: dropped the vf-* classes, every inline style, and the
// decorative stroke icons; every existing control keeps its exact prior wiring (lock, auto-lock
// minutes, VF API key F8-gate save, export secret, reset wallet).
//
// Reset's confirmation moved OFF a native window.confirm() -- no Cancel of its own, no visible
// account/network context, easy to blow through with a reflex "OK" -- onto an inline pc-support
// panel with real consequence copy and an explicit Cancel, matching this task's brief for quiet
// destructive screens ("show consequence, active account, network, Cancel, explicit completion").
// Active account + network context comes for free from the WalletShell this screen is always
// rendered inside (WalletSettings.jsx) -- this component only owns the consequence copy and the
// two-step confirm/cancel itself.
import { useState } from 'react'
import { getVfApiKey, setVfApiKey } from '../../vfKey.js'

export default function SettingsScreen({ onLock, onExport, onReset, autoLockMin, onSetAutoLock }) {
  const [vfKey, setVfKeyInput] = useState(getVfApiKey())
  const [vfKeySaved, setVfKeySaved] = useState(false)
  const [confirmingReset, setConfirmingReset] = useState(false)

  return (
    <div className="pc-standard-form" data-testid="classic-settings">
      <h2>Security</h2>

      <button type="button" className="pc-button pc-button--secondary" onClick={onLock}>
        Lock now
      </button>

      <div className="pc-field">
        <label htmlFor="auto-lock-min">Auto-lock (minutes)</label>
        <input
          id="auto-lock-min"
          className="pc-input pc-technical"
          type="number"
          min={1}
          max={60}
          value={autoLockMin}
          onChange={(e) => onSetAutoLock(Number(e.target.value))}
        />
      </div>

      <div className="pc-field">
        <label htmlFor="vf-api-key">VF API key (F8 gate)</label>
        <input
          id="vf-api-key"
          className="pc-input pc-technical"
          type="password"
          placeholder="vf_…"
          value={vfKey}
          onChange={(e) => {
            setVfKeyInput(e.target.value)
            setVfKeySaved(false)
          }}
        />
        <button
          type="button"
          className="pc-button pc-button--secondary"
          onClick={() => {
            setVfApiKey(vfKey)
            setVfKeyInput(getVfApiKey())
            setVfKeySaved(true)
          }}
        >
          Save
        </button>
        <p className="pc-field-help">
          {vfKeySaved
            ? 'Saved. Vault eligibility (F8) now checks via the VF gateway.'
            : 'Generate at /developers → Keys (scope: market). Empty = local F8 check.'}
        </p>
      </div>

      <h2>Backup and reset</h2>

      <button type="button" className="pc-button pc-button--secondary" onClick={onExport}>
        Export secret
      </button>

      {!confirmingReset ? (
        <button
          type="button"
          className="pc-button pc-button--danger"
          onClick={() => setConfirmingReset(true)}
        >
          Reset wallet
        </button>
      ) : (
        <div className="pc-support" data-testid="reset-confirm">
          <p>
            This deletes every local key on this device. If you have not backed up your recovery
            phrase or exported your secret key, funds on this wallet cannot be recovered.
          </p>
          <div className="pc-wallet-actions">
            <button
              type="button"
              className="pc-button pc-button--secondary"
              onClick={() => setConfirmingReset(false)}
            >
              Cancel
            </button>
            <button type="button" className="pc-button pc-button--danger" onClick={onReset}>
              Yes, reset this wallet
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
