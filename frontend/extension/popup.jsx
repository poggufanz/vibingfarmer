import React, { useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import {
  createPasskeyWallet,
  connectPasskeyWallet,
  readBalance,
  sendToken,
  depositToVault,
  addAgentSigner,
} from '../src/wallet/account.js'
import { addRecoverySigner } from '../src/wallet/recovery.js'
import { eligibility } from '../src/vfapi/client.js'
import { ApproveOverlay } from '../src/wallet/ui/ApproveOverlay.jsx'
import { HonestyLabels } from '../src/wallet/ui/HonestyLabels.jsx'
import { toDisplay } from '../src/stellar/format.js'
import { SOROBAN_VAULT_ADDRESS } from '../src/stellar/config.js'

// Ceremony runs in the extension TAB — Face ID closes the popup.
// Post SIGN_REQUEST to the background SW; it opens ceremony.html in a new tab.
function postSignRequest(action, params) {
  chrome.runtime.sendMessage({ type: 'SIGN_REQUEST', action, params })
}

// Acid Yield design system (DESIGN.md §2/§3/§6) ported to the wallet popup:
// dark warm-near-black canvas, one acid-lime accent per screen, Geist for prose,
// JetBrains Mono for every number/address, document-grade rows divided by borders.
const CSS = `
:root{
  --bg-base:#0e0f0c; --bg-canvas:#131410; --bg-card:#1a1b16; --bg-elev:#22231d; --bg-elev-2:#2a2b23;
  --border:rgba(236,235,225,.07); --border-strong:rgba(236,235,225,.14); --border-accent:rgba(207,255,61,.5);
  --text:#ecebe1; --text-muted:#95958a; --text-faint:#56564f;
  --accent:#cfff3d; --accent-soft:rgba(207,255,61,.09); --accent-fg:#0e0f0c;
  --info:#7aa2ff; --warn:#f0b54a; --danger:#ff7479; --ok:#6fe39a;
  --font:"Geist",system-ui,-apple-system,sans-serif;
  --mono:"JetBrains Mono","Geist Mono",ui-monospace,"SF Mono",monospace;
  --r-sm:4px; --r-md:8px; --r-lg:14px;
}
.vf *{box-sizing:border-box}
.vf{width:360px;background:var(--bg-canvas);color:var(--text);font-family:var(--font);
  font-size:13px;line-height:1.45;-webkit-font-smoothing:antialiased}
.vf .tnum{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1,"lnum" 1}
.vf .mono{font-family:var(--mono);letter-spacing:-.01em}

/* header */
.vf-head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--border)}
.vf-logo{width:32px;height:32px;flex:0 0 32px;border-radius:var(--r-sm);overflow:hidden;display:grid;place-items:center}
.vf-logo img{width:100%;height:100%;display:block}
.vf-brand{display:flex;flex-direction:column;line-height:1.2;flex:1;min-width:0}
.vf-brand-name{font-weight:500;font-size:14px}
.vf-brand-sub{font-family:var(--mono);font-size:10px;color:var(--text-faint)}
.vf-net{font-family:var(--mono);font-size:10px;color:var(--text-faint);padding:3px 7px;
  border:1px solid var(--border);border-radius:999px}

/* main */
.vf-main{padding:18px;display:flex;flex-direction:column;gap:14px;animation:enter .32s cubic-bezier(.2,.8,.2,1)}
@keyframes enter{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}

/* eyebrow lockup */
.eyebrow{display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:11px;
  text-transform:lowercase;color:var(--text-faint)}
.eyebrow .dot{color:var(--accent)}
.eyebrow .sec{color:var(--text-muted)}
.eyebrow .rule{flex:1;height:1px;background:var(--border)}

/* type */
.vf-h{margin:0;font-size:21px;font-weight:600;letter-spacing:-.02em;text-wrap:balance}
.lede{margin:0;font-size:13px;color:var(--text-muted);text-wrap:pretty}
.note{margin:0;font-size:11.5px;color:var(--text-faint);line-height:1.5}
.info{margin:0;font-size:12px;color:var(--text-muted)}
.err{margin:0;font-size:12px;color:var(--danger)}
.link{font-family:var(--mono);font-size:11.5px;color:var(--accent);text-decoration:none;
  border-bottom:1px solid transparent}
.link:hover{border-bottom-color:var(--accent)}

/* signature figure */
.figure-block{display:flex;align-items:baseline;gap:8px}
.figure{font-family:var(--mono);font-weight:500;font-size:clamp(34px,12vw,46px);letter-spacing:-.02em;line-height:1}
.ticker{font-family:var(--mono);font-size:14px;color:var(--text-faint)}

/* document rows */
.doc{border-top:1px solid var(--border)}
.row{display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid var(--border)}
.row-k{font-family:var(--mono);font-size:11px;color:var(--text-faint);min-width:88px}
.row-v{font-size:13px;color:var(--text);flex:1;min-width:0}
.addr{font-family:var(--mono);font-size:12px;word-break:break-all}

/* fields */
.field{display:flex;flex-direction:column;gap:6px}
.field .row-k{min-width:0}
.input{width:100%;padding:10px 12px;background:var(--bg-elev);color:var(--text);
  border:1px solid var(--border);border-radius:var(--r-md);font-size:13px}
.input.mono{font-family:var(--mono);font-size:12px}
.input:focus{border-color:var(--border-accent)}
.input::placeholder{color:var(--text-faint)}
/* visible keyboard focus (never suppress the native ring) */
.vf :focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:var(--r-sm)}

/* amount-input signature pattern */
.amount-row{display:flex;align-items:baseline;gap:10px;border-bottom:1px solid var(--border-strong);padding-bottom:8px}
.amount-row:focus-within{border-bottom-color:var(--border-accent)}
.amount{flex:1;min-width:0;background:none;border:none;color:var(--text);
  font-family:var(--mono);font-weight:500;font-size:clamp(30px,11vw,42px);letter-spacing:-.02em}
.amount::placeholder{color:var(--text-faint)}
.amount::-webkit-outer-spin-button,.amount::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.amount{-moz-appearance:textfield}

/* buttons */
.btn{font-family:var(--font);font-size:13px;font-weight:500;padding:11px 18px;border-radius:var(--r-md);
  border:1px solid transparent;cursor:pointer;transition:background .12s ease,border-color .12s ease;text-align:center}
.btn-primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
.btn-primary:hover:not(:disabled){background:#dbff66}
.btn-ghost{background:transparent;color:var(--text);border-color:var(--border-strong)}
.btn-ghost:hover:not(:disabled){background:var(--bg-elev)}
.btn:disabled{opacity:.4;cursor:not-allowed}
.btn-row{display:flex;gap:8px;flex-wrap:wrap}
.btn-row .btn{flex:1}
.btn-row.col{flex-direction:column}
.copy{font-family:var(--mono);font-size:11px;color:var(--text-muted);background:transparent;
  border:1px solid var(--border);border-radius:var(--r-sm);padding:4px 8px;cursor:pointer}
.copy:hover{color:var(--text);border-color:var(--border-strong)}

/* approve overlay (rendered in deposit) */
.approve{display:flex;flex-direction:column;gap:12px;background:var(--bg-card);border:1px solid var(--border-strong);
  border-radius:var(--r-lg);padding:16px}
.approve-verdict{margin:0;font-size:12px}
.approve-verdict.ok{color:var(--ok)}
.approve-verdict.bad{color:var(--danger)}

/* pending marker */
.pending{display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:12px;color:var(--text-muted)}
.marker{width:9px;height:9px;border-radius:50%;background:var(--accent)}
.blink{animation:blink 1.1s ease-in-out infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.25}}

/* bottom nav */
.vf-nav{display:flex;flex-wrap:wrap;gap:2px;padding:8px 12px;border-top:1px solid var(--border);background:var(--bg-base)}
.vf-tab{font-family:var(--mono);font-size:11px;text-transform:lowercase;color:var(--text-faint);
  background:transparent;border:none;border-bottom:1px solid transparent;padding:6px 9px;cursor:pointer}
.vf-tab:hover{color:var(--text-muted)}
.vf-tab.active{color:var(--text);border-bottom-color:var(--accent)}

@media (prefers-reduced-motion:reduce){
  .vf-main{animation:none}.blink{animation:none}
}
`

const NAV_TABS = ['home', 'send', 'deposit', 'signers', 'recovery', 'activity', 'agent']

function Eyebrow({ sec, meta }) {
  return (
    <div className="eyebrow">
      <span className="dot">·</span>
      <span className="sec">{sec}</span>
      <span className="rule" />
      <span>{meta}</span>
    </div>
  )
}

function NavBar({ onNav, active }) {
  return (
    <nav className="vf-nav">
      {NAV_TABS.map((t) => (
        <button
          key={t}
          className={'vf-tab' + (t === active ? ' active' : '')}
          aria-current={t === active ? 'page' : undefined}
          onClick={() => onNav(t)}
        >
          {t}
        </button>
      ))}
    </nav>
  )
}

function Shell({ children, nav, active, onNav }) {
  return (
    <div className="vf">
      <style>{CSS}</style>
      <header className="vf-head">
        <div className="vf-logo">
          <img src="./vibing_farmer.logo.svg" alt="Vibing Farmer" />
        </div>
        <div className="vf-brand">
          <div className="vf-brand-name">VF Wallet</div>
          <div className="vf-brand-sub">passkey · secp256r1</div>
        </div>
        <span className="vf-net">testnet</span>
      </header>
      <div className="vf-main">{children}</div>
      {nav && <NavBar onNav={onNav} active={active} />}
    </div>
  )
}

function Popup() {
  const [screen, setScreen] = useState('welcome')
  const [wallet, setWallet] = useState(null)
  const [balance, setBalance] = useState(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  // Send form
  const [sendTo, setSendTo] = useState('')
  const [sendAmount, setSendAmount] = useState('')

  // Deposit form
  const [depositAmount, setDepositAmount] = useState('')
  const [depositVerdict, setDepositVerdict] = useState(null)

  // Recovery form
  const [recoveryG, setRecoveryG] = useState('')

  // Agent form
  const [agentAddress, setAgentAddress] = useState('')
  const [agentCap, setAgentCap] = useState('')

  // Result
  const [lastTx, setLastTx] = useState(null)

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

  // Restore cached wallet on mount (no-arg = reads vf_wallet_contract from localStorage)
  useEffect(() => {
    connectPasskeyWallet()
      .then((w) => {
        setWallet(w)
        setScreen('home')
        refreshBalance(w.contractId)
      })
      .catch(() => {
        // No cached wallet — remain on welcome screen
      })
  }, [])

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
    if (!r.ok) {
      setError(r.error || 'Ceremony failed')
      setScreen('home')
      return
    }
    if (r.action === 'deposit') {
      const minted = BigInt(r.sharesAfter ?? '0') - BigInt(r.sharesBefore ?? '0')
      setStatus(`Minted ${minted} shares. tx: ${r.hash}`)
    } else if (r.action === 'approve') {
      setStatus('Deposits enabled. You can deposit now.')
    }
    setLastTx(r.hash || null)
    setScreen('result')
  }

  async function handleCreate() {
    clear()
    setScreen('creating')
    try {
      const w = await createPasskeyWallet({ appName: 'VF Wallet', userName: 'VF User' })
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

  async function handleSend() {
    clear()
    try {
      await sendToken({
        contractId: wallet.contractId,
        to: sendTo,
        amount: sendAmount,
      })
      setStatus(
        "Built the unsigned transfer XDR. On-chain send isn't wired in this build. Deposit is the live on-chain path."
      )
    } catch (e) {
      setError(e.message)
    }
  }

  async function handleDepositCheck() {
    clear()
    setDepositVerdict(null)
    try {
      const v = await eligibility({
        vault: SOROBAN_VAULT_ADDRESS,
        amount: BigInt(Math.round(parseFloat(depositAmount) * 1e7)),
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
    try {
      // Re-run the F8 gate in-popup for an early verdict; the ceremony re-asserts fail-closed.
      await depositToVault({
        contractId: wallet.contractId,
        amount: BigInt(Math.round(parseFloat(depositAmount) * 1e7)),
        eligibility,
      })
      postSignRequest('deposit', { contractId: wallet.contractId, amount: depositAmount })
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
    try {
      await addRecoverySigner({ accountId: wallet.contractId, recoveryG })
      setStatus('Recovery signer added (VF-custodied; testnet-grade).')
      setRecoveryG('')
    } catch (e) {
      setError(e.message)
    }
  }

  async function handleAddAgent() {
    clear()
    try {
      await addAgentSigner({
        agentAddress,
        cap: agentCap,
        vault: SOROBAN_VAULT_ADDRESS,
        expiry: Math.floor(Date.now() / 1000) + 86400 * 7,
      })
      setStatus('Agent scope granted. Ceremony required on next deposit.')
      setAgentAddress('')
      setAgentCap('')
    } catch (e) {
      setError(e.message)
    }
  }

  // ── SCREENS ──────────────────────────────────────────────────────────────

  if (screen === 'welcome') {
    return (
      <Shell>
        <Eyebrow sec="welcome" meta="face id" />
        <h1 className="vf-h">A passkey wallet on Stellar.</h1>
        <p className="lede">
          No seed phrase. Your Face ID is the key: a secp256r1 signer on a Soroban smart account.
        </p>
        {error && <p className="err">{error}</p>}
        <div className="btn-row col">
          <button className="btn btn-primary" onClick={handleCreate}>
            Create new wallet · Face ID
          </button>
          <button className="btn btn-ghost" onClick={handleConnect}>
            Connect / restore
          </button>
        </div>
        <HonestyLabels scope="global" />
      </Shell>
    )
  }

  if (screen === 'creating') {
    return (
      <Shell>
        <Eyebrow sec="creating" meta="testnet" />
        <h1 className="vf-h">Setting up your wallet…</h1>
        <p className="lede">
          Creating the passkey and Friendbot-funding on Stellar testnet. Approve Face ID if
          prompted.
        </p>
        <div className="pending">
          <span className="marker blink" /> working…
        </div>
      </Shell>
    )
  }

  if (screen === 'signing-pending') {
    return (
      <Shell>
        <Eyebrow sec="ceremony" meta="face id" />
        <h1 className="vf-h">Approve in the ceremony tab</h1>
        <div className="pending">
          <span className="marker blink" /> {status}
        </div>
        <p className="note">
          Face ID opens in a new tab. This popup may close, so reopen it to see the result.
        </p>
        <button className="btn btn-ghost" onClick={() => nav('home')}>
          Back to home
        </button>
      </Shell>
    )
  }

  if (screen === 'result') {
    return (
      <Shell nav active={null} onNav={nav}>
        <Eyebrow sec="result" meta="testnet" />
        <h1 className="vf-h">Done.</h1>
        <p data-testid="result-status" className="info">
          {status}
        </p>
        {lastTx && (
          <a
            className="link"
            href={`https://stellar.expert/explorer/testnet/tx/${lastTx}`}
            target="_blank"
            rel="noreferrer"
          >
            View on Stellar Expert →
          </a>
        )}
        <button className="btn btn-primary" onClick={() => setScreen('home')}>
          Done
        </button>
      </Shell>
    )
  }

  if (screen === 'home') {
    let figure = '-'
    let sub = null
    if (balance === null) sub = 'reading balance…'
    else if (balance === '-') sub = 'balance unavailable'
    else
      figure = parseFloat(toDisplay(balance).toFixed(7)).toLocaleString('en-US', {
        maximumFractionDigits: 7,
      })
    const short = wallet?.contractId
      ? `${wallet.contractId.slice(0, 6)}…${wallet.contractId.slice(-4)}`
      : '-'
    return (
      <Shell nav active="home" onNav={nav}>
        <Eyebrow sec="balance" meta="usdc · testnet" />
        <div className="figure-block">
          <span className="figure tnum">{figure}</span>
          <span className="ticker">USDC</span>
        </div>
        {sub && <p className="note">{sub}</p>}
        <div className="doc">
          <div className="row">
            <span className="row-k">address</span>
            <span className="row-v addr">{short}</span>
            <button
              className="copy"
              aria-label="Copy address"
              onClick={() => navigator.clipboard?.writeText(wallet?.contractId ?? '')}
            >
              copy
            </button>
          </div>
        </div>
        {error && <p className="err">{error}</p>}
        {status && <p className="info">{status}</p>}
        <HonestyLabels scope="global" />
      </Shell>
    )
  }

  if (screen === 'send') {
    return (
      <Shell nav active="send" onNav={nav}>
        <Eyebrow sec="send" meta="usdc" />
        <h1 className="vf-h">Send USDC</h1>
        <div className="field">
          <label className="row-k">to</label>
          <input
            className="input mono"
            placeholder="G-address or C-address"
            value={sendTo}
            onChange={(e) => setSendTo(e.target.value)}
          />
        </div>
        <div className="amount-row">
          <input
            className="amount tnum"
            type="number"
            placeholder="0"
            aria-label="Amount to send, in USDC"
            value={sendAmount}
            onChange={(e) => setSendAmount(e.target.value)}
          />
          <span className="ticker">USDC</span>
        </div>
        {error && <p className="err">{error}</p>}
        <button className="btn btn-primary" onClick={handleSend} disabled={!sendTo || !sendAmount}>
          Approve with Face ID
        </button>
        <p className="note">
          Builds unsigned XDR locally. On-chain send isn't wired in this build. Deposit is the live
          on-chain path.
        </p>
      </Shell>
    )
  }

  if (screen === 'deposit') {
    return (
      <Shell nav active="deposit" onNav={nav}>
        <Eyebrow sec="deposit" meta="vault · blend usdc" />
        <h1 className="vf-h">Deposit to vault</h1>
        <div className="amount-row">
          <input
            className="amount tnum"
            type="number"
            placeholder="0"
            aria-label="Amount to deposit, in USDC"
            value={depositAmount}
            onChange={(e) => {
              setDepositAmount(e.target.value)
              setDepositVerdict(null)
            }}
          />
          <span className="ticker">USDC</span>
        </div>
        {error && <p className="err">{error}</p>}
        <div className="btn-row">
          {!depositVerdict && (
            <button
              className="btn btn-ghost"
              onClick={handleDepositCheck}
              disabled={!depositAmount}
            >
              Check eligibility
            </button>
          )}
          <button className="btn btn-ghost" onClick={handleEnableDeposits}>
            Enable deposits
          </button>
        </div>
        {depositVerdict && (
          <ApproveOverlay
            verdict={depositVerdict}
            simulate={null}
            onApprove={handleDepositApprove}
            onReject={() => setDepositVerdict(null)}
          />
        )}
        <HonestyLabels scope="deposit" />
      </Shell>
    )
  }

  if (screen === 'signers') {
    return (
      <Shell nav active="signers" onNav={nav}>
        <Eyebrow sec="signers" meta="multi-sig" />
        <h1 className="vf-h">Signers</h1>
        <div className="doc">
          <div className="row">
            <span className="row-k">primary</span>
            <span className="row-v">Passkey · Face ID</span>
          </div>
          <div className="row">
            <span className="row-k">curve</span>
            <span className="row-v mono">secp256r1 · on-device</span>
          </div>
        </div>
        <p className="note">Additional signers are managed on the recovery and agent screens.</p>
        {error && <p className="err">{error}</p>}
        {status && <p className="info">{status}</p>}
      </Shell>
    )
  }

  if (screen === 'recovery') {
    return (
      <Shell nav active="recovery" onNav={nav}>
        <Eyebrow sec="recovery" meta="vf-custodied" />
        <h1 className="vf-h">Recovery signer</h1>
        <div className="field">
          <label className="row-k">recovery address</label>
          <input
            className="input mono"
            placeholder="Recovery G-address"
            value={recoveryG}
            onChange={(e) => setRecoveryG(e.target.value)}
          />
        </div>
        {error && <p className="err">{error}</p>}
        {status && <p className="info">{status}</p>}
        <button className="btn btn-primary" onClick={handleAddRecovery} disabled={!recoveryG}>
          Add recovery signer
        </button>
        <HonestyLabels scope="recovery" />
      </Shell>
    )
  }

  if (screen === 'activity') {
    return (
      <Shell nav active="activity" onNav={nav}>
        <Eyebrow sec="activity" meta="stellar expert" />
        <h1 className="vf-h">Activity</h1>
        <p className="lede">On-chain history lives on Stellar Expert (testnet).</p>
        {wallet?.contractId && (
          <a
            className="link"
            href={`https://stellar.expert/explorer/testnet/account/${wallet.contractId}`}
            target="_blank"
            rel="noreferrer"
          >
            View on Stellar Expert →
          </a>
        )}
      </Shell>
    )
  }

  if (screen === 'agent') {
    return (
      <Shell nav active="agent" onNav={nav}>
        <Eyebrow sec="agent" meta="scoped · 7d expiry" />
        <h1 className="vf-h">Agent signer</h1>
        <div className="field">
          <label className="row-k">agent address</label>
          <input
            className="input mono"
            placeholder="Agent G-address"
            value={agentAddress}
            onChange={(e) => setAgentAddress(e.target.value)}
          />
        </div>
        <div className="amount-row">
          <input
            className="amount tnum"
            type="number"
            placeholder="0"
            aria-label="Agent spending cap, in USDC"
            value={agentCap}
            onChange={(e) => setAgentCap(e.target.value)}
          />
          <span className="ticker">USDC cap</span>
        </div>
        {error && <p className="err">{error}</p>}
        {status && <p className="info">{status}</p>}
        <button
          className="btn btn-primary"
          onClick={handleAddAgent}
          disabled={!agentAddress || !agentCap}
        >
          Grant agent scope · ceremony
        </button>
        <p className="note">Scope: 7-day expiry, capped at the entered amount, vault-restricted.</p>
        <HonestyLabels scope="agent" />
      </Shell>
    )
  }

  return (
    <Shell>
      <Eyebrow sec="loading" meta="" />
      <div className="pending">
        <span className="marker blink" /> loading…
      </div>
    </Shell>
  )
}

createRoot(document.getElementById('root')).render(<Popup />)
