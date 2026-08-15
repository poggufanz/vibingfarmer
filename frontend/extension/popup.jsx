import './shims.js'
import React, { useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import {
  createPasskeyWallet,
  connectPasskeyWallet,
  readBalance,
  depositToVault,
} from '../src/wallet/account.js'
import { addRecoverySigner } from '../src/wallet/recovery.js'
import { eligibility } from '../src/vfapi/client.js'
import { getTestUsdc } from '../src/wallet/faucet.js'
import { VF_TESTNET_ISSUER } from '../src/wallet/trustline.js'
import { ApproveOverlay } from '../src/wallet/ui/ApproveOverlay.jsx'
import { HonestyLabels } from '../src/wallet/ui/HonestyLabels.jsx'
import { SOROBAN_VAULT_ADDRESS } from '../src/stellar/config.js'
import HomeScreen from '../src/wallet/ui/classic/HomeScreen.jsx'
import SendScreen from '../src/wallet/ui/classic/SendScreen.jsx'
import ReceiveScreen from '../src/wallet/ui/classic/ReceiveScreen.jsx'
import AddAssetScreen from '../src/wallet/ui/classic/AddAssetScreen.jsx'
import HistoryScreen from '../src/wallet/ui/classic/HistoryScreen.jsx'
import { pickConfirmIndices } from '../src/wallet/ui/classic/backupConfirm.js'
import * as C from '../src/wallet/ui/classic/controller.js'
import { WalletOnboarding } from '../src/wallet/ui/WalletOnboarding.jsx'
import { WalletShell } from '../src/wallet/ui/WalletShell.jsx'
import { WalletHome } from '../src/wallet/ui/WalletHome.jsx'
import { WalletActivity } from '../src/wallet/ui/WalletActivity.jsx'
import { WalletReceive } from '../src/wallet/ui/WalletReceive.jsx'
import { WalletSettings } from '../src/wallet/ui/WalletSettings.jsx'
import { WalletAdvanced } from '../src/wallet/ui/WalletAdvanced.jsx'
import { PopupResult, PopupSigningPending, toPopupResultModel } from './popupView.js'
import {
  ACTIVE_ACCOUNT_KEY,
  resolveActiveAccount,
  selectActiveAccount,
} from '../src/wallet/activeAccount.js'

// VF Wallet Task 10 -- the Passkey (C) account has no portfolio adapter of its own (account.js's
// readBalance returns a single raw USDC amount, not the {total, complete, rows} shape
// classic/HomeScreen.jsx expects); this is the one-asset equivalent. `balance` is the raw value
// readBalance()/refreshBalance() already produce: null while unread, the literal '-' sentinel on a
// failed read (see refreshBalance below), or a real amount. Both "unread" and "failed" money-truth
// map onto the SAME `null` portfolio (HomeScreen renders that as "Unavailable", never a coerced
// $0.00) -- there is no third UI state for "still loading" in this simple, single-asset model, and
// collapsing loading into "unavailable" is still honest (never a wrong number, only a delayed one).
function passkeyPortfolio(balance) {
  if (balance == null || balance === '-') return null
  const units = typeof balance === 'bigint' ? balance.toString() : String(balance)
  const amount = { token: 'USDC', units, decimals: 7 }
  return {
    amount,
    complete: true,
    rows: [{ asset: 'USDC', code: 'USDC', amount, usd: null }],
  }
}

// Protocol slug of the live deposit vault (autofarm → Blend USDC). The F8 gate resolves facts
// by slug — SOROBAN_VAULT_ADDRESS alone carries none and would fail closed.
const ACTIVE_VAULT_PROTOCOL = 'blend-usdc'

// Ceremony runs in the extension TAB — Face ID closes the popup.
// Post SIGN_REQUEST to the background SW; it opens ceremony.html in a new tab.
// requestedAt (Fix round 1, I3): the real moment this click fired, threaded through
// background.js's SIGN_REQUEST params verbatim so ceremony.js's snapshot TTL check measures
// actual elapsed time since the user acted, not the ceremony tab's own later, much shorter window.
function postSignRequest(action, params) {
  chrome.runtime.sendMessage({
    type: 'SIGN_REQUEST',
    action,
    params: { ...params, requestedAt: Date.now() },
  })
}

// Pure decision: given resolveActiveAccount's status (activeAccount.js) and the classic wallet's
// own bootstrap snapshot, decide which screen the popup opens on. Exported so the resolution
// matrix is unit-testable without rendering React — mirrors approve.js's screenModel pattern.
// legacyWalletType is ONLY consulted for the cosmetic empty-state default (no accounts exist yet
// at all, so there is nothing for resolveActiveAccount itself to migrate) — never to override an
// actual resolved account.
export function resolveEntryScreen(resolved, cw, legacyWalletType = null) {
  if (resolved.status === 'empty') {
    return { screen: legacyWalletType === 'passkey' ? 'welcome' : 'classic-onboarding' }
  }
  if (resolved.status === 'selection-required') {
    return { screen: 'select-account', accounts: resolved.accounts }
  }
  const { account } = resolved
  if (account.kind === 'C') {
    return { screen: 'home', contractId: account.address }
  }
  if (cw.needsBackup || !cw.unlocked) return { screen: 'classic-unlock' }
  return { screen: 'classic-home' }
}

function Popup() {
  const [screen, setScreen] = useState('loading')
  const [wallet, setWallet] = useState(null)
  const [balance, setBalance] = useState(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  // Classic (seed-phrase) wallet state
  const [cw, setCw] = useState({
    ready: false,
    hasWallet: false,
    publicKey: null,
    unlocked: false,
    needsBackup: false,
  })
  const [backup, setBackup] = useState(null) // { mnemonic, indices, publicKey }
  const [selectableAccounts, setSelectableAccounts] = useState([]) // ambiguous-resolution choices
  const [preview, setPreview] = useState(null)
  const [portfolio, setPortfolio] = useState(null)
  const [unfunded, setUnfunded] = useState(false)
  // VF Wallet Task 10 -- null (not []), so "Activity has never been loaded this session" reads as
  // Unavailable (HistoryScreen.jsx) rather than a false "No activity yet". Known residual gap
  // (documented in HistoryScreen.jsx's own header): wallet/history.js's fetchHistory catches its
  // own fetch failures and resolves to `[]` rather than rejecting, so a genuine network failure
  // AFTER a load attempt is still indistinguishable from a confirmed-empty history -- fixing that
  // requires editing fetchHistory itself, which is outside this task's authorized file list.
  const [activity, setActivity] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [autoLockMin, setAutoLockMin] = useState(10)
  const [exportForm, setExportForm] = useState({ open: false, pw: '', secret: null, error: '' })

  // Deposit form
  const [depositAmount, setDepositAmount] = useState('')
  const [depositVerdict, setDepositVerdict] = useState(null)

  // Recovery form
  const [recoveryG, setRecoveryG] = useState('')

  // Result
  const [lastResult, setLastResult] = useState(null)

  function clear() {
    setError('')
    setStatus('')
  }

  function nav(s) {
    clear()
    setDepositVerdict(null)
    setScreen(s)
  }

  function refreshBalance(contractId) {
    readBalance(contractId)
      .then((b) => setBalance(b))
      .catch(() => setBalance('-'))
  }

  // ── Classic (seed-phrase) wallet: bootstrap + nav + handlers ──────────────
  // Classic is the default wallet type. If a classic wallet already exists it routes straight
  // to unlock/home; otherwise it lands on create. The passkey auto-reconnect effect below is
  // untouched — if a passkey wallet is cached it still takes over (pre-existing behavior).
  async function refresh(pk) {
    setErr('')
    try {
      const r = await C.refreshHome(pk)
      setUnfunded(r.unfunded)
      setPortfolio(r.portfolio)
    } catch (e) {
      setErr(String(e?.message || e))
    }
  }

  // ONE authoritative resolution (Task 1 — activeAccount.js) replaces the old split logic (a
  // classic-only bootstrap effect plus a separate passkey-only localStorage-cache effect that
  // could each route independently). chrome.storage.local is the authority; window.localStorage
  // is read here ONLY as a one-time migration hint for resolveActiveAccount — the popup is the
  // one context that legitimately has a window, unlike the MV3 background service worker.
  useEffect(() => {
    C.armAutoLock()
    let legacyWalletType = null
    try {
      legacyWalletType = window.localStorage.getItem('vf_wallet_type')
    } catch {
      legacyWalletType = null
    }
    Promise.all([
      C.bootstrap(),
      resolveActiveAccount({
        storageLocal: chrome.storage?.local,
        legacyStorage: typeof window !== 'undefined' ? window.localStorage : undefined,
      }),
    ]).then(([b, resolved]) => {
      setCw({
        ready: true,
        hasWallet: b.hasWallet,
        publicKey: b.publicKey,
        unlocked: b.unlocked,
        needsBackup: b.needsBackup,
      })
      const entry = resolveEntryScreen(resolved, b, legacyWalletType)
      if (entry.screen === 'home') {
        setWallet({ contractId: entry.contractId })
        setScreen('home')
        refreshBalance(entry.contractId)
      } else if (entry.screen === 'classic-home') {
        setScreen('classic-home')
        refresh(b.publicKey)
      } else if (entry.screen === 'select-account') {
        setSelectableAccounts(entry.accounts)
        setScreen('select-account')
      } else {
        setScreen(entry.screen)
      }
    })
  }, [])

  // Deliberate account switch out of the rare "selection-required" ambiguity (both a classic and
  // a passkey wallet present, no persisted or migratable preference): persists exactly the chosen
  // account, then routes to it. Never touches the OTHER account's stored credentials.
  async function handleSelectAccount(account) {
    clear()
    await selectActiveAccount({ accountId: account.id, storageLocal: chrome.storage.local })
    if (account.kind === 'C') {
      setWallet({ contractId: account.address })
      setScreen('home')
      refreshBalance(account.address)
      return
    }
    const b = await C.bootstrap()
    setCw({
      ready: true,
      hasWallet: b.hasWallet,
      publicKey: b.publicKey,
      unlocked: b.unlocked,
      needsBackup: b.needsBackup,
    })
    if (b.needsBackup || !b.unlocked) {
      setScreen('classic-unlock')
    } else {
      setScreen('classic-home')
      refresh(b.publicKey)
    }
  }

  // Single nav handler for every classic tab. Clears the send preview on every navigation
  // (not just the home → send entry) so a stale clear-sign snapshot can never leak into a
  // fresh visit to Send, wipes any revealed export secret out of state, and loads Activity's
  // history on demand.
  function classicNav(t) {
    setErr('')
    setPreview(null)
    setExportForm({ open: false, pw: '', secret: null, error: '' })
    if (t === 'activity') {
      setScreen('classic-activity')
      C.loadActivity(cw.publicKey)
        .then(setActivity)
        .catch((e) => setErr(String(e?.message || e)))
      return
    }
    setScreen('classic-' + t)
  }

  // VF Wallet Task 10 -- the Passkey (C) equivalent of classicNav, for the same beginner
  // Home/Activity/Settings bottom nav WalletHome/WalletActivity render. 'settings' routes to the
  // NEW 'wallet-settings' screen (id deliberately distinct from classic's 'classic-settings') --
  // Passkey had no Settings screen at all before this task; the account-switch/reset link that
  // used to live on the old passkey home screen now lives there instead, matching where classic's
  // own switch-wallet link already lives (classic-settings, not classic-home) rather than
  // cluttering money-first Home.
  function passkeyNav(t) {
    clear()
    setDepositVerdict(null)
    setScreen(t === 'settings' ? 'wallet-settings' : t)
  }

  // Recover last ceremony result on reopen (popup may have been dismissed during Face-ID)
  useEffect(() => {
    chrome.storage?.session?.get?.('vf_last_result').then((g) => {
      const r = g?.vf_last_result
      if (r) applyResult(r)
    })
    const onMsg = (m) => {
      if (m?.type === 'SIGN_RESULT') applyResult(m)
    }
    chrome.runtime?.onMessage?.addListener(onMsg)
    return () => chrome.runtime?.onMessage?.removeListener(onMsg)
  }, [])

  function applyResult(r) {
    const result = r && typeof r === 'object' ? r : {}
    const model = toPopupResultModel(result)
    setLastResult(result)
    if (result.ok !== true) {
      setError(model.message)
      setScreen('home')
      return
    }
    setError('')
    setStatus('')
    setScreen('result')
  }

  async function handleCreate() {
    clear()
    setScreen('creating')
    try {
      const w = await createPasskeyWallet({ appName: 'VF Wallet', userName: 'VF User' })
      localStorage.setItem('vf_wallet_type', 'passkey')
      setWallet(w)
      setScreen('home')
      refreshBalance(w.contractId)
    } catch (e) {
      setError(e.message)
      setScreen('welcome')
    }
  }

  async function handleConnect() {
    clear()
    try {
      const w = await connectPasskeyWallet()
      localStorage.setItem('vf_wallet_type', 'passkey')
      setWallet(w)
      setScreen('home')
      refreshBalance(w.contractId)
    } catch (e) {
      // No cached wallet → connect falls to passkey discovery (kit prompt:true); SAK throws
      // "Could not determine credential ID" when there's no passkey to restore on this origin.
      const noWallet = /credential|could not determine/i.test(e.message || '')
      setError(
        noWallet
          ? 'No wallet found on this device. Tap "Create new wallet · Face ID" to make one first.'
          : e.message
      )
    }
  }

  async function handleDepositCheck() {
    clear()
    setDepositVerdict(null)
    const amt = parseFloat(depositAmount)
    if (isNaN(amt) || amt <= 0) {
      setError('Amount must be greater than 0')
      return
    }
    try {
      const v = await eligibility({
        vault: SOROBAN_VAULT_ADDRESS,
        protocol: ACTIVE_VAULT_PROTOCOL,
        amount: BigInt(Math.round(amt * 1e7)),
      })
      setDepositVerdict(v)
    } catch (e) {
      setError(e.message)
    }
  }

  async function handleEnableDeposits() {
    clear()
    setStatus('Opening Enable-deposits ceremony…')
    postSignRequest('approve', { contractId: wallet.contractId })
    setScreen('signing-pending')
  }

  async function handleDepositApprove() {
    clear()
    const amt = parseFloat(depositAmount)
    if (isNaN(amt) || amt <= 0) {
      setError('Amount must be greater than 0')
      return
    }
    try {
      // Re-run the F8 gate in-popup for an early verdict; the ceremony re-asserts fail-closed.
      // depositToVault calls eligibility({ vault, amount }) — inject the live vault's protocol
      // slug so the gate resolves real facts (a bare C-address has none → would fail closed).
      await depositToVault({
        contractId: wallet.contractId,
        amount: BigInt(Math.round(amt * 1e7)),
        eligibility: (q) => eligibility({ ...q, protocol: ACTIVE_VAULT_PROTOCOL }),
      })
      postSignRequest('deposit', {
        contractId: wallet.contractId,
        amount: depositAmount,
        protocol: ACTIVE_VAULT_PROTOCOL,
      })
      setStatus('Opening deposit ceremony. Approve with Face ID in the new tab…')
      setDepositVerdict(null)
      setScreen('signing-pending')
    } catch (e) {
      // An allowance/balance trap routes the user to Enable deposits instead of failing.
      if (/allowance|balance|insufficient/i.test(e.message)) {
        setError('Deposits not enabled yet. Tap "Enable deposits" first.')
      } else {
        setError(e.message)
      }
    }
  }

  async function handleAddRecovery() {
    clear()
    if (!/^[G][A-Z2-7]{55}$/i.test(recoveryG)) {
      setError('Invalid recovery G-address')
      return
    }
    try {
      await addRecoverySigner({ accountId: wallet.contractId, recoveryG })
      setStatus('Recovery signer added (VF-custodied; testnet-grade).')
      setRecoveryG('')
    } catch (e) {
      setError(e.message)
    }
  }

  // VF Wallet Task 11 -- handleAddAgent (a live `addAgentSigner` submit path) is deleted outright,
  // not merely hidden: the task's brief forbids exposing it as a live action at all ("its
  // cap-policy contract is undeployed"). WalletAdvanced.jsx's standalone agent-signer section is
  // read-only documentation with no input and no submit control, so there is no prop shape left
  // anywhere in this file that could wire a live call to it back in by accident.

  // Default top-up = 300 USDC (the per-recipient daily faucet cap), in 7-decimal base units.
  // getTestUsdc loops the 100-cap endpoint to reach it.
  const USDC_TOPUP_BASE_UNITS = 300n * 10n ** 7n

  // Passkey (C-address): faucet dispenses the SAC straight to the contract — no trustline needed.
  async function handlePasskeyGetUsdc() {
    clear()
    setStatus('Requesting test USDC…')
    try {
      const r = await getTestUsdc({ to: wallet.contractId, amount: USDC_TOPUP_BASE_UNITS })
      const whole = Number(r.dispensed) / 1e7
      setStatus(
        r.capped
          ? `Daily faucet cap reached — added ${whole} USDC.`
          : `Added ${whole} USDC. Balance updating…`
      )
      refreshBalance(wallet.contractId)
    } catch (e) {
      setError(String(e?.message || e))
    }
  }

  // Classic (G-address): a classic account must trust the USDC issuer before the SAC transfer can
  // land, so add the trustline first if missing (reserves 0.5 XLM — fund via Friendbot first).
  async function handleClassicGetUsdc() {
    setErr('')
    setBusy(true)
    try {
      const balances = await C.refreshHome(cw.publicKey)
      if (balances.unfunded) {
        setErr(
          'Fund the account with XLM first (Fund via Friendbot) — a USDC trustline needs 0.5 XLM.'
        )
        return
      }
      const hasUsdc = (balances.portfolio?.rows ?? []).some(
        (row) => row.code === 'USDC' && row.asset === `USDC:${VF_TESTNET_ISSUER}`
      )
      if (!hasUsdc) await C.doAddAsset('USDC', VF_TESTNET_ISSUER)
      await getTestUsdc({ to: cw.publicKey, amount: USDC_TOPUP_BASE_UNITS })
      await refresh(cw.publicKey)
    } catch (e) {
      setErr(String(e?.message || e))
    } finally {
      setBusy(false)
    }
  }

  // ── CLASSIC (seed-phrase / ed25519) SCREENS ───────────────────────────────
  // Classic is the default wallet type; the passkey screens below are unmodified and remain
  // reachable via the "switch to passkey wallet" links on classic-create/classic-settings.

  // ── Onboarding + account choice (VF Wallet Task 9) ────────────────────────
  // WalletOnboarding is a pure presentational router (no state of its own -- see its own header
  // comment); this popup keeps owning every handler/state exactly as before (busy/err/backup/cw),
  // only the rendering moved onto the shared WalletShell.
  if (screen === 'classic-onboarding') {
    return (
      <WalletOnboarding
        view="choose"
        onChooseStandard={() => setScreen('classic-create')}
        onChoosePasskey={() => {
          localStorage.setItem('vf_wallet_type', 'passkey')
          setScreen('welcome')
        }}
      />
    )
  }

  if (screen === 'classic-create') {
    return (
      <WalletOnboarding
        view="standard-create"
        onBack={() => setScreen('classic-onboarding')}
        createBusy={busy}
        createError={err}
        onGoImport={() => {
          setErr('')
          setScreen('classic-import')
        }}
        onCreate={async (label, pw) => {
          setBusy(true)
          setErr('')
          try {
            const r = await C.doCreate(label, pw)
            setBackup({ mnemonic: r.mnemonic, indices: r.indices, publicKey: r.publicKey })
            setScreen('classic-backup')
          } catch (e) {
            setErr(String(e?.message || e))
          } finally {
            setBusy(false)
          }
        }}
      />
    )
  }

  if (screen === 'classic-backup') {
    return (
      <WalletOnboarding
        view="standard-backup"
        mnemonic={backup.mnemonic}
        indices={backup.indices}
        backupError={err}
        onConfirmBackup={async () => {
          setErr('')
          await C.confirmBackup(backup.publicKey)
          setCw((s) => ({
            ...s,
            hasWallet: true,
            publicKey: backup.publicKey,
            unlocked: true,
            needsBackup: false,
          }))
          setBackup(null) // decrypted mnemonic never outlives the backup screen
          setScreen('classic-home')
          refresh(backup.publicKey)
        }}
        onSkipBackup={async () => {
          setErr('')
          await C.confirmBackup(backup.publicKey)
          setCw((s) => ({
            ...s,
            hasWallet: true,
            publicKey: backup.publicKey,
            unlocked: true,
            needsBackup: false,
          }))
          setBackup(null) // decrypted mnemonic never outlives the backup screen
          setScreen('classic-home')
          refresh(backup.publicKey)
        }}
      />
    )
  }

  if (screen === 'classic-import') {
    return (
      <WalletOnboarding
        view="standard-import"
        onBack={() => setScreen('classic-onboarding')}
        importBusy={busy}
        importError={err}
        onImport={async (input, pw, label) => {
          setBusy(true)
          setErr('')
          try {
            const r = await C.doImport(input, pw, label)
            setCw({ ready: true, hasWallet: true, publicKey: r.publicKey, unlocked: true })
            setScreen('classic-home')
            refresh(r.publicKey)
          } catch (e) {
            setErr(String(e?.message || e))
          } finally {
            setBusy(false)
          }
        }}
      />
    )
  }

  if (screen === 'classic-unlock') {
    return (
      <WalletOnboarding
        view="standard-unlock"
        account={{ kind: 'G', address: cw.publicKey }}
        publicKey={cw.publicKey}
        unlockBusy={busy}
        unlockError={err}
        onUnlock={async (pw) => {
          setBusy(true)
          setErr('')
          try {
            await C.doUnlock(cw.publicKey, pw)
          } catch (e) {
            setErr('Wrong password.')
            setBusy(false)
            return
          }
          setCw((s) => ({ ...s, unlocked: true }))
          if (!cw.needsBackup) {
            setScreen('classic-home')
            refresh(cw.publicKey)
            setBusy(false)
            return
          }
          try {
            // Pending backup survived a popup close — decrypt the mnemonic with the
            // password just used to unlock, then route through the same backup-confirm
            // gate a fresh create would, so it can never be silently skipped.
            const mnemonic = await C.revealBackup(cw.publicKey, pw)
            setBackup({
              mnemonic,
              indices: pickConfirmIndices(24, 3),
              publicKey: cw.publicKey,
            })
            setScreen('classic-backup')
          } catch (e) {
            // The password was already proven correct above — this failure means the
            // backup blob itself is missing/corrupt, so the words are unrecoverable and
            // retrying the password cannot help. Do not wedge a healthy, already-unlocked
            // wallet behind a dead backup gate: clear it, route home, and tell the truth
            // instead of the misleading "Wrong password." from the outer catch.
            await C.confirmBackup(cw.publicKey)
            setCw((s) => ({ ...s, needsBackup: false }))
            setScreen('classic-home')
            refresh(cw.publicKey)
            setErr('Backup phrase unavailable. Use Settings > Export secret as your wallet backup.')
          } finally {
            setBusy(false)
          }
        }}
      />
    )
  }

  if (screen === 'classic-home') {
    return (
      <WalletHome
        account={{ kind: 'G', address: cw.publicKey }}
        onNav={classicNav}
        securityLabel={cw.unlocked ? 'Unlocked' : 'Locked'}
        status={err ? { tone: 'error', message: err } : null}
        portfolio={portfolio}
        unfunded={unfunded}
        busy={busy}
        onSend={() => {
          setPreview(null)
          setErr('')
          setScreen('classic-send')
        }}
        onReceive={() => setScreen('classic-receive')}
        onGetUsdc={handleClassicGetUsdc}
        onAddAsset={() => {
          setErr('')
          setScreen('classic-add-asset')
        }}
        onFund={async () => {
          setBusy(true)
          setErr('')
          try {
            await C.doFund(cw.publicKey)
            await refresh(cw.publicKey)
          } catch (e) {
            setErr(String(e?.message || e))
          } finally {
            setBusy(false)
          }
        }}
      >
        <HonestyLabels scope="global" />
      </WalletHome>
    )
  }

  if (screen === 'classic-send') {
    return (
      <WalletShell
        heading="Send"
        account={{ kind: 'G', address: cw.publicKey }}
        onBack={() => {
          setErr('')
          setScreen('classic-home')
        }}
        status={err ? { tone: 'error', message: err } : null}
      >
        <SendScreen
          from={cw.publicKey}
          preview={preview}
          busy={busy}
          error={err}
          onPreview={async (params) => {
            // Preview is ONLY ever set here, from a successful controller call — never
            // injected from any other path — and always cleared first so a failed refresh
            // can't leave a stale confirm-card on screen.
            setPreview(null)
            setBusy(true)
            setErr('')
            try {
              const r = await C.doPreview(params)
              setPreview(r)
            } catch (e) {
              setErr(String(e?.message || e))
            } finally {
              setBusy(false)
            }
          }}
          onConfirm={async (params) => {
            setBusy(true)
            setErr('')
            try {
              await C.doSend(params)
              setPreview(null)
              await refresh(cw.publicKey)
              const items = await C.loadActivity(cw.publicKey)
              setActivity(items)
              setScreen('classic-activity')
            } catch (e) {
              setErr(String(e?.message || e))
              // Drop the stale confirm card on failure too — one error message, and the
              // user must re-Review (re-run preview/clear-sign) rather than re-confirming
              // a preview that may no longer match reality.
              setPreview(null)
            } finally {
              setBusy(false)
            }
          }}
        />
      </WalletShell>
    )
  }

  if (screen === 'classic-receive') {
    return (
      <WalletReceive
        account={{ kind: 'G', address: cw.publicKey }}
        onBack={() => setScreen('classic-home')}
      />
    )
  }

  if (screen === 'classic-add-asset') {
    // VF Wallet Task 11 -- wrapped in the shared WalletShell; AddAssetScreen.jsx renders pc-*
    // markup and WalletShell's own Back control replaces the hand-rolled "← Back" button.
    return (
      <WalletShell
        heading="Add asset"
        account={{ kind: 'G', address: cw.publicKey }}
        onBack={() => {
          setErr('')
          setScreen('classic-home')
        }}
        status={err ? { tone: 'error', message: err } : null}
      >
        <AddAssetScreen
          busy={busy}
          error={err}
          onAddAsset={async (code, issuer) => {
            setBusy(true)
            setErr('')
            try {
              await C.doAddAsset(code, issuer)
              await refresh(cw.publicKey)
              setScreen('classic-home')
            } catch (e) {
              setErr(String(e?.message || e))
            } finally {
              setBusy(false)
            }
          }}
        />
      </WalletShell>
    )
  }

  // VF Wallet Task 11 (M2, see the passkey 'activity' screen below for the full decision):
  // `baseItems` is not passed here either, for the same reason -- no authoritative source.
  if (screen === 'classic-activity') {
    return (
      <WalletActivity
        account={{ kind: 'G', address: cw.publicKey }}
        onNav={classicNav}
        status={err ? { tone: 'error', message: err } : null}
        items={activity}
      />
    )
  }

  if (screen === 'classic-settings') {
    // VF Wallet Task 11 -- migrated onto WalletSettings, the
    // same pc-* redesign classic-home/classic-activity already use. The export-secret reveal
    // (popup.jsx-owned state, unchanged) is restyled onto pc-* classes as WalletSettings children:
    // the revealed secret carries .pc-address-full -- a 56-char S-key is exactly the
    // unbreakable-long-technical-string case that guard exists for.
    return (
      <WalletSettings
        account={{ kind: 'G', address: cw.publicKey }}
        onNav={classicNav}
        status={err ? { tone: 'error', message: err } : null}
        securityLabel={cw.unlocked ? 'Unlocked' : 'Locked'}
        autoLockMin={autoLockMin}
        onSetAutoLock={setAutoLockMin}
        onLock={async () => {
          await C.doLock()
          setCw((s) => ({ ...s, unlocked: false }))
          setExportForm({ open: false, pw: '', secret: null, error: '' })
          setScreen('classic-unlock')
        }}
        onExport={() => setExportForm({ open: true, pw: '', secret: null, error: '' })}
        onReset={async () => {
          await chrome.storage.local.clear()
          await chrome.storage.session?.clear()
          window.location.reload()
        }}
        onSwitchAccount={() => {
          setExportForm({ open: false, pw: '', secret: null, error: '' })
          localStorage.setItem('vf_wallet_type', 'passkey')
          setScreen('welcome')
        }}
        switchLabel="Switch to passkey wallet"
        onOpenAdvanced={() => setScreen('classic-advanced')}
      >
        <HonestyLabels scope="session-key" />

        {exportForm.open && (
          <div className="pc-support" data-testid="export-secret-form">
            {!exportForm.secret ? (
              <>
                <div className="pc-field">
                  <label htmlFor="export-secret-password">Password</label>
                  <input
                    id="export-secret-password"
                    className="pc-input"
                    type="password"
                    autoComplete="current-password"
                    value={exportForm.pw}
                    onChange={(e) =>
                      setExportForm((f) => ({ ...f, pw: e.target.value, error: '' }))
                    }
                  />
                </div>
                {exportForm.error && <p className="pc-field-error">{exportForm.error}</p>}
                <div className="pc-wallet-actions">
                  <button
                    type="button"
                    className="pc-button pc-button--secondary"
                    onClick={() => setExportForm({ open: false, pw: '', secret: null, error: '' })}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="pc-button pc-button--primary"
                    disabled={!exportForm.pw}
                    onClick={async () => {
                      try {
                        const secret = await C.doExport(cw.publicKey, exportForm.pw)
                        setExportForm((f) => ({ ...f, secret, pw: '', error: '' }))
                      } catch {
                        setExportForm((f) => ({ ...f, error: 'Wrong password.' }))
                      }
                    }}
                  >
                    Reveal secret
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="pc-backup-warning">
                  This is your ONLY secret key. Anyone with it controls this wallet. Shown once — it
                  will not be shown again.
                </p>
                <code className="pc-technical pc-address-full">{exportForm.secret}</code>
                <button
                  type="button"
                  className="pc-button pc-button--primary"
                  onClick={() => setExportForm({ open: false, pw: '', secret: null, error: '' })}
                >
                  Done — hide it
                </button>
              </>
            )}
          </div>
        )}
      </WalletSettings>
    )
  }

  if (screen === 'classic-advanced') {
    // VF Wallet Task 11 -- consolidates friendbot/faucet + "restore a different wallet" for the
    // Standard (G) account model. No direct-vault-deposit or recovery-signer section: both are
    // kit-based Passkey ceremonies (account.js/recovery.js) with no Standard equivalent -- omitted
    // entirely rather than rendered disabled (no dead button; fail closed).
    return (
      <WalletAdvanced
        account={{ kind: 'G', address: cw.publicKey }}
        onBack={() => setScreen('classic-settings')}
        status={err ? { tone: 'error', message: err } : null}
        busy={busy}
        onGetUsdc={handleClassicGetUsdc}
        onFundXlm={async () => {
          setBusy(true)
          setErr('')
          try {
            await C.doFund(cw.publicKey)
            await refresh(cw.publicKey)
          } catch (e) {
            setErr(String(e?.message || e))
          } finally {
            setBusy(false)
          }
        }}
        importBusy={busy}
        importError={err}
        onImportWallet={async (input, pw, label) => {
          setBusy(true)
          setErr('')
          try {
            const r = await C.doImport(input, pw, label)
            setCw({ ready: true, hasWallet: true, publicKey: r.publicKey, unlocked: true })
            setScreen('classic-home')
            refresh(r.publicKey)
          } catch (e) {
            setErr(String(e?.message || e))
          } finally {
            setBusy(false)
          }
        }}
      />
    )
  }

  // Ambiguous resolution: both a classic and a passkey wallet exist with no persisted or
  // migratable preference (activeAccount.js status 'selection-required'). Never silently picks
  // one — the user must choose, and switching never touches the OTHER account's credentials.
  if (screen === 'select-account') {
    return (
      <WalletOnboarding
        view="select-account"
        accounts={selectableAccounts}
        onSelectAccount={handleSelectAccount}
      />
    )
  }

  // ── SCREENS (passkey) ──────────────────────────────────────────────────────

  if (screen === 'welcome') {
    return (
      <WalletOnboarding
        view="passkey-choose"
        onBack={() => {
          localStorage.setItem('vf_wallet_type', 'classic')
          setScreen('classic-onboarding')
          C.bootstrap().then((b) => {
            if (b.hasWallet) {
              setScreen(b.needsBackup || !b.unlocked ? 'classic-unlock' : 'classic-home')
            }
          })
        }}
        passkeyError={error}
        onCreatePasskey={handleCreate}
        onConnectPasskey={handleConnect}
      />
    )
  }

  if (screen === 'creating') {
    return <WalletOnboarding view="passkey-creating" />
  }

  if (screen === 'signing-pending') {
    return (
      <PopupSigningPending
        account={{ kind: 'C', address: wallet?.contractId }}
        origin="VF Wallet (this extension)"
        status={status || 'Waiting for Face ID'}
        onBack={() => nav('home')}
      />
    )
  }

  if (screen === 'result') {
    return (
      <PopupResult
        account={{ kind: 'C', address: wallet?.contractId }}
        origin="VF Wallet (this extension)"
        result={lastResult}
        onDone={() => nav('home')}
      />
    )
  }

  // VF Wallet Task 10 -- money-first Home, recomposed for the Passkey (C) account onto the same
  // WalletHome surface classic accounts use. `onAddAsset`/`onFund` are simply never passed: this
  // account kind has no real add-asset or friendbot-fund support (autoFund already happens at
  // creation, account.js:29), so HomeScreen never renders those buttons -- no dead buttons, fail
  // closed, the same rule Send below is built around.
  if (screen === 'home') {
    return (
      <WalletHome
        account={{ kind: 'C', address: wallet?.contractId }}
        onNav={passkeyNav}
        securityLabel="Secured by Face ID"
        status={
          error
            ? { tone: 'error', message: error }
            : status
              ? { tone: 'info', message: status }
              : null
        }
        portfolio={passkeyPortfolio(balance)}
        onReceive={() => setScreen('receive')}
        onGetUsdc={handlePasskeyGetUsdc}
      >
        <HonestyLabels scope="global" />
      </WalletHome>
    )
  }

  // Passkey had no Settings screen at all before VF Wallet Task 10 (only a link buried on Home) --
  // the beginner nav (Home/Activity/Settings) needs a real destination for its third tab. VF
  // Wallet Task 11 migrates it onto WalletSettings (the same Base-mandate summary and
  // Advanced/Testnet link classic-settings now gets) -- Passkey has no lock/password model, so
  // WalletSettings renders none of classic/SettingsScreen.jsx's controls for this account kind
  // (no onLock is ever passed here).
  if (screen === 'wallet-settings') {
    return (
      <WalletSettings
        account={{ kind: 'C', address: wallet?.contractId }}
        onNav={passkeyNav}
        securityLabel="Secured by Face ID"
        onSwitchAccount={async () => {
          localStorage.removeItem('vf_wallet_contract')
          localStorage.removeItem('vf_wallet_credential')
          localStorage.setItem('vf_wallet_type', 'classic')
          if (typeof chrome !== 'undefined' && chrome.storage?.local) {
            // Reset (not a benign switch — this button deletes the passkey account outright), so
            // the stale active-account pointer must go with it rather than linger for the next
            // resolveActiveAccount call to self-heal around.
            await chrome.storage.local.remove([
              'vf_wallet_contract',
              'vf_wallet_credential',
              ACTIVE_ACCOUNT_KEY,
            ])
          }
          setWallet(null)
          setScreen('classic-onboarding')
          C.bootstrap().then((b) => {
            if (b.hasWallet) {
              setScreen(b.needsBackup || !b.unlocked ? 'classic-unlock' : 'classic-home')
            }
          })
        }}
        switchLabel="Switch to classic wallet / Reset"
        onOpenAdvanced={() => setScreen('wallet-advanced')}
      />
    )
  }

  if (screen === 'wallet-advanced') {
    // VF Wallet Task 11 -- consolidates the direct vault deposit, VF-custodied recovery signer,
    // and read-only agent-signer preview for the Passkey (C) account model. No friendbot XLM
    // section: Passkey accounts auto-fund at creation (account.js's createPasskeyWallet) and have
    // no exposed friendbot-XLM path elsewhere either -- omitted rather than rendered disabled.
    return (
      <WalletAdvanced
        account={{ kind: 'C', address: wallet?.contractId }}
        onBack={() => setScreen('wallet-settings')}
        status={
          error
            ? { tone: 'error', message: error }
            : status
              ? { tone: 'info', message: status }
              : null
        }
        onGetUsdc={handlePasskeyGetUsdc}
        depositAmount={depositAmount}
        onDepositAmountChange={(v) => {
          setDepositAmount(v)
          setDepositVerdict(null)
        }}
        depositVerdict={depositVerdict}
        onCheckEligibility={handleDepositCheck}
        onEnableDeposits={handleEnableDeposits}
        onApproveDeposit={handleDepositApprove}
        onRejectDeposit={() => setDepositVerdict(null)}
        recoveryAddress={recoveryG}
        onRecoveryAddressChange={setRecoveryG}
        onAddRecoverySigner={handleAddRecovery}
      />
    )
  }

  // VF Wallet Task 10, Step 2 -- Passkey (C) Send has no real submit path yet (the old handler
  // above only ever built unsigned XDR and said so out loud: "On-chain send isn't wired in this
  // build"). Transaction BUILDING is not a submit path, so this renders SendScreen's
  // `supported={false}` state -- a plain, honest message, not a dead form that fails on submit.
  // Reached as a Home ACTION (Back to Home), not a nav tab, same as Receive.
  if (screen === 'send') {
    return (
      <WalletShell
        heading="Send"
        account={{ kind: 'C', address: wallet?.contractId }}
        onBack={() => setScreen('home')}
      >
        <SendScreen
          from={wallet?.contractId}
          supported={false}
          preview={null}
          onPreview={() => {}}
          onConfirm={() => {}}
        />
      </WalletShell>
    )
  }

  // VF Wallet Task 10, Step 2 -- Receive is a supported action for every account kind; Passkey had
  // no Receive screen at all before this task.
  if (screen === 'receive') {
    return (
      <WalletReceive
        account={{ kind: 'C', address: wallet?.contractId }}
        onBack={() => setScreen('home')}
      />
    )
  }

  // VF Wallet Task 11 -- the old 'deposit'/'signers'/'recovery'/'agent' screens are deleted
  // outright, not just unlinked. They were already unreachable dead code before this task (Task
  // 10's beginner Home/Activity/Settings nav only links to Send/Receive/Add asset/Get test USDC --
  // nothing routed INTO this cluster once Home stopped rendering the old 7-tab NavBar), and the
  // 'agent' screen additionally exposed `addAgentSigner` as a LIVE submit control years before its
  // cap-policy contract is deployed, exactly what this task's brief forbids. Their real
  // functionality is not lost: direct vault deposit and the recovery-signer form are now real,
  // reachable sections of WalletAdvanced.jsx (`screen === 'wallet-advanced'`, wired above with the
  // same handleDepositCheck/handleEnableDeposits/handleDepositApprove/handleAddRecovery this file
  // already owned), and the agent-signer section there is read-only documentation with no input
  // and no submit control at all -- see WalletAdvanced.jsx's own header for why that is the
  // correct shape rather than a disabled version of the old live form. 'signers' had no functional
  // content beyond restating the account chip's own "Passkey" label and is not migrated anywhere.

  // VF Wallet Task 10, Step 3 -- Passkey (C) Activity. `items={null}` (Unavailable, not a false
  // "no activity"): Horizon's payments collection (wallet/history.js's data source) only lists
  // classic `payment`/`create_account` operations, never Soroban `invoke_host_function` calls --
  // the ONLY way this account kind moves funds -- so calling it for a C-address would not fail,
  // it would just silently return an empty list that looks identical to "confirmed no activity"
  // while actually meaning "this data source cannot see this account's activity at all". That is
  // exactly the money-truth distinction Step 3 asks for; the honest answer here is Unavailable,
  // not a fabricated empty read. The direct Stellar Expert account link (unaffected, pre-existing)
  // stays available as a real alternative.
  //
  // VF Wallet Task 11 (M2, carried from the VF Wallet Task 10 review, "wire it or remove it"):
  // `baseItems` is deliberately never passed here, and this is now a closed decision, not a
  // pending gap -- this extension has NO authoritative source to wire it to. baseBinding.js's
  // owner/mandate records live in the WEB APP's window.localStorage (a different origin from this
  // chrome-extension:// popup) and the relayer's Base activity is reachable only through the web
  // app's own request flow; nothing in this codebase gives the extension a read path to either.
  // "Wire it" would mean fabricating or heuristically guessing Base activity, which is exactly the
  // money-truth violation this whole task is about (the same MM13 dead-branch failure this brief
  // warns against, one level up: rendering a claim no trigger can honestly produce). WalletActivity
  // already handles the unpopulated case correctly on its own (baseItems==null or [] renders
  // nothing -- an absence of a claim, never a false "no Base activity" or a false "unavailable"),
  // so nothing needed to change in this file's call sites below; this comment exists so the next
  // reader does not treat the silence as leftover work.
  if (screen === 'activity') {
    return (
      <WalletActivity
        account={{ kind: 'C', address: wallet?.contractId }}
        onNav={passkeyNav}
        items={null}
      >
        {wallet?.contractId && (
          <a
            className="pc-field-help"
            href={`https://stellar.expert/explorer/testnet/account/${wallet.contractId}`}
            target="_blank"
            rel="noreferrer"
          >
            View on Stellar Expert
          </a>
        )}
      </WalletActivity>
    )
  }

  return (
    <WalletShell
      heading="Loading wallet…"
      status={{ tone: 'neutral', message: 'Loading wallet…' }}
    />
  )
}

// Guarded so importing this module (e.g. to unit-test resolveEntryScreen, mirroring approve.js's
// screenModel pattern) never tries to mount into a #root that only exists in popup.html.
if (typeof document !== 'undefined' && document.getElementById('root')) {
  createRoot(document.getElementById('root')).render(<Popup />)
}
