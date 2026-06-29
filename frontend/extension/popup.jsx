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
function postSignRequest(xdr) {
  chrome.runtime.sendMessage({
    type: 'SIGN_REQUEST',
    challenge: xdr,
    rpId: location.hostname || 'localhost',
  })
}

const S = {
  wrap: {
    padding: 12,
    minWidth: 300,
    maxWidth: 340,
    fontFamily: 'system-ui, sans-serif',
    fontSize: 13,
    lineHeight: 1.4,
  },
  h1: { margin: '0 0 8px', fontSize: 15, fontWeight: 600 },
  btn: {
    margin: '3px 2px',
    padding: '5px 10px',
    cursor: 'pointer',
    fontSize: 12,
    borderRadius: 4,
  },
  btnPrimary: {
    margin: '3px 2px',
    padding: '5px 10px',
    cursor: 'pointer',
    fontSize: 12,
    borderRadius: 4,
    background: '#0066cc',
    color: '#fff',
    border: 'none',
  },
  input: {
    display: 'block',
    width: '100%',
    margin: '3px 0',
    padding: '5px',
    boxSizing: 'border-box',
    fontSize: 12,
    borderRadius: 3,
    border: '1px solid #ccc',
  },
  err: { color: '#c00', fontSize: 11, margin: '3px 0' },
  info: { color: '#555', fontSize: 11, margin: '3px 0', fontStyle: 'italic' },
  addr: { fontFamily: 'monospace', fontSize: 10, wordBreak: 'break-all' },
  nav: {
    borderTop: '1px solid #ddd',
    marginTop: 8,
    paddingTop: 5,
    display: 'flex',
    flexWrap: 'wrap',
    gap: 2,
  },
  navBtn: { padding: '3px 7px', fontSize: 11, cursor: 'pointer', borderRadius: 3 },
}

function NavBar({ onNav }) {
  const tabs = ['home', 'send', 'deposit', 'signers', 'recovery', 'activity', 'agent']
  return (
    <div style={S.nav}>
      {tabs.map((t) => (
        <button key={t} style={S.navBtn} onClick={() => onNav(t)}>
          {t}
        </button>
      ))}
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
      .catch(() => {})
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
      setError(e.message)
    }
  }

  async function handleSend() {
    clear()
    try {
      const { xdr } = await sendToken({
        contractId: wallet.contractId,
        to: sendTo,
        amount: sendAmount,
      })
      // Builds UNSIGNED xdr → ceremony tab signs → submit in user-greenlit demo batch
      postSignRequest(xdr)
      setStatus('signing in ceremony tab… (testnet submit runs in the demo batch)')
      setScreen('signing-pending')
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

  async function handleDepositApprove() {
    clear()
    try {
      // depositToVault re-checks eligibility internally (fail-closed F8 gate)
      const { xdr } = await depositToVault({
        contractId: wallet.contractId,
        amount: BigInt(Math.round(parseFloat(depositAmount) * 1e7)),
        eligibility,
      })
      postSignRequest(xdr)
      setStatus('signing in ceremony tab… (testnet submit runs in the demo batch)')
      setDepositVerdict(null)
      setScreen('signing-pending')
    } catch (e) {
      setError(e.message)
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
      setStatus('Agent scope granted — ceremony required on next deposit.')
      setAgentAddress('')
      setAgentCap('')
    } catch (e) {
      setError(e.message)
    }
  }

  // ── SCREENS ──────────────────────────────────────────────────────────────

  if (screen === 'welcome') {
    return (
      <div style={S.wrap}>
        <h2 style={S.h1}>VF Wallet</h2>
        {error && <p style={S.err}>{error}</p>}
        <button style={S.btnPrimary} onClick={handleCreate}>
          Create new wallet (Face ID)
        </button>
        <button style={S.btn} onClick={handleConnect}>
          Connect / Restore
        </button>
        <HonestyLabels scope="global" />
      </div>
    )
  }

  if (screen === 'creating') {
    return (
      <div style={S.wrap}>
        <h2 style={S.h1}>VF Wallet</h2>
        <p style={S.info}>Creating wallet + Friendbot-funding on testnet&hellip;</p>
      </div>
    )
  }

  if (screen === 'signing-pending') {
    return (
      <div style={S.wrap}>
        <h2 style={S.h1}>VF Wallet</h2>
        <p style={S.info}>{status}</p>
        <p style={S.info}>The ceremony tab handles Face ID. This popup may be dismissed.</p>
        <button style={S.btn} onClick={() => nav('home')}>
          Back to home
        </button>
      </div>
    )
  }

  if (screen === 'home') {
    return (
      <div style={S.wrap}>
        <h2 style={S.h1}>VF Wallet</h2>
        <p>
          <strong>Address</strong>
          <br />
          <span style={S.addr}>{wallet?.contractId}</span>
        </p>
        <button
          style={S.navBtn}
          onClick={() => navigator.clipboard?.writeText(wallet?.contractId ?? '')}
        >
          Copy address
        </button>
        <p>
          <strong>Balance:</strong>{' '}
          {balance !== null ? `${toDisplay(balance).toFixed(7)} USDC` : 'loading…'}
        </p>
        {error && <p style={S.err}>{error}</p>}
        {status && <p style={S.info}>{status}</p>}
        <HonestyLabels scope="global" />
        <NavBar onNav={nav} />
      </div>
    )
  }

  if (screen === 'send') {
    return (
      <div style={S.wrap}>
        <h2 style={S.h1}>Send USDC</h2>
        <input
          style={S.input}
          placeholder="To (G-address or C-address)"
          value={sendTo}
          onChange={(e) => setSendTo(e.target.value)}
        />
        <input
          style={S.input}
          type="number"
          placeholder="Amount (USDC)"
          value={sendAmount}
          onChange={(e) => setSendAmount(e.target.value)}
        />
        {error && <p style={S.err}>{error}</p>}
        <button style={S.btnPrimary} onClick={handleSend} disabled={!sendTo || !sendAmount}>
          Approve with Face ID
        </button>
        <p style={S.info}>
          Builds unsigned XDR &rarr; ceremony tab &rarr; submit in demo batch.
        </p>
        <NavBar onNav={nav} />
      </div>
    )
  }

  if (screen === 'deposit') {
    return (
      <div style={S.wrap}>
        <h2 style={S.h1}>Deposit to Vault</h2>
        <input
          style={S.input}
          type="number"
          placeholder="Amount (USDC)"
          value={depositAmount}
          onChange={(e) => {
            setDepositAmount(e.target.value)
            setDepositVerdict(null)
          }}
        />
        {error && <p style={S.err}>{error}</p>}
        {!depositVerdict && (
          <button style={S.btn} onClick={handleDepositCheck} disabled={!depositAmount}>
            Check eligibility
          </button>
        )}
        {depositVerdict && (
          <ApproveOverlay
            verdict={depositVerdict}
            simulate={null}
            onApprove={handleDepositApprove}
            onReject={() => setDepositVerdict(null)}
          />
        )}
        <HonestyLabels scope="deposit" />
        <NavBar onNav={nav} />
      </div>
    )
  }

  if (screen === 'signers') {
    return (
      <div style={S.wrap}>
        <h2 style={S.h1}>Signers</h2>
        <p>
          <strong>Primary:</strong> Passkey (Face ID) &mdash; on-device secp256r1.
        </p>
        <p style={S.info}>
          Additional signers are managed on the Recovery and Agent screens.
        </p>
        {error && <p style={S.err}>{error}</p>}
        {status && <p style={S.info}>{status}</p>}
        <NavBar onNav={nav} />
      </div>
    )
  }

  if (screen === 'recovery') {
    return (
      <div style={S.wrap}>
        <h2 style={S.h1}>Recovery</h2>
        <input
          style={S.input}
          placeholder="Recovery G-address"
          value={recoveryG}
          onChange={(e) => setRecoveryG(e.target.value)}
        />
        {error && <p style={S.err}>{error}</p>}
        {status && <p style={S.info}>{status}</p>}
        <button style={S.btn} onClick={handleAddRecovery} disabled={!recoveryG}>
          Add recovery signer
        </button>
        <HonestyLabels scope="recovery" />
        <NavBar onNav={nav} />
      </div>
    )
  }

  if (screen === 'activity') {
    return (
      <div style={S.wrap}>
        <h2 style={S.h1}>Activity</h2>
        <p style={S.info}>On-chain activity is visible in Stellar Expert (testnet).</p>
        {wallet?.contractId && (
          <a
            href={`https://stellar.expert/explorer/testnet/account/${wallet.contractId}`}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: 11 }}
          >
            View on Stellar Expert &rarr;
          </a>
        )}
        <NavBar onNav={nav} />
      </div>
    )
  }

  if (screen === 'agent') {
    return (
      <div style={S.wrap}>
        <h2 style={S.h1}>Agent Signer</h2>
        <input
          style={S.input}
          placeholder="Agent G-address"
          value={agentAddress}
          onChange={(e) => setAgentAddress(e.target.value)}
        />
        <input
          style={S.input}
          type="number"
          placeholder="Cap (USDC)"
          value={agentCap}
          onChange={(e) => setAgentCap(e.target.value)}
        />
        {error && <p style={S.err}>{error}</p>}
        {status && <p style={S.info}>{status}</p>}
        <button
          style={S.btnPrimary}
          onClick={handleAddAgent}
          disabled={!agentAddress || !agentCap}
        >
          Grant agent scope (ceremony required)
        </button>
        <p style={S.info}>Scope: 7-day expiry, capped at entered amount, vault-restricted.</p>
        <NavBar onNav={nav} />
      </div>
    )
  }

  return (
    <div style={S.wrap}>
      <p style={S.info}>Loading&hellip;</p>
    </div>
  )
}

createRoot(document.getElementById('root')).render(<Popup />)
