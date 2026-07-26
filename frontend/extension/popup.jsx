import './shims.js'
import React, { useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import {
  createPasskeyWallet,
  connectPasskeyWallet,
  readBalance,
  depositToVault,
  addAgentSigner,
} from '../src/wallet/account.js'
import { addRecoverySigner } from '../src/wallet/recovery.js'
import { eligibility } from '../src/vfapi/client.js'
import { getTestUsdc } from '../src/wallet/faucet.js'
import { VF_TESTNET_ISSUER } from '../src/wallet/trustline.js'
import { ApproveOverlay } from '../src/wallet/ui/ApproveOverlay.jsx'
import { HonestyLabels } from '../src/wallet/ui/HonestyLabels.jsx'
import { toDisplay } from '../src/stellar/format.js'
import { SOROBAN_VAULT_ADDRESS } from '../src/stellar/config.js'
import HomeScreen from '../src/wallet/ui/classic/HomeScreen.jsx'
import SendScreen from '../src/wallet/ui/classic/SendScreen.jsx'
import ReceiveScreen from '../src/wallet/ui/classic/ReceiveScreen.jsx'
import AddAssetScreen from '../src/wallet/ui/classic/AddAssetScreen.jsx'
import HistoryScreen from '../src/wallet/ui/classic/HistoryScreen.jsx'
import SettingsScreen from '../src/wallet/ui/classic/SettingsScreen.jsx'
import { pickConfirmIndices } from '../src/wallet/ui/classic/backupConfirm.js'
import * as C from '../src/wallet/ui/classic/controller.js'
import { WalletOnboarding } from '../src/wallet/ui/WalletOnboarding.jsx'
import { WalletShell } from '../src/wallet/ui/WalletShell.jsx'
import { WalletHome } from '../src/wallet/ui/WalletHome.jsx'
import { WalletActivity } from '../src/wallet/ui/WalletActivity.jsx'
import { WalletReceive } from '../src/wallet/ui/WalletReceive.jsx'
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
  const amount = Number(toDisplay(balance))
  return {
    total: amount,
    complete: true,
    rows: [{ asset: 'USDC', code: 'USDC', balance: toDisplay(balance), usd: amount }],
  }
}

// Protocol slug of the live deposit vault (autofarm → Blend USDC). The F8 gate resolves facts
// by slug — SOROBAN_VAULT_ADDRESS alone carries none and would fail closed.
const ACTIVE_VAULT_PROTOCOL = 'blend-usdc'

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
  --bg-base:#0a0b09; --bg-canvas:#0e100c; --bg-card:#161813; --bg-elev:#1e201a; --bg-elev-2:#262821;
  --border:rgba(236,235,225,.06); --border-strong:rgba(236,235,225,.12); --border-accent:rgba(207,255,61,.45);
  --text:#f0efe6; --text-muted:#a0a096; --text-faint:#5a5a52;
  --accent:#cfff3d; --accent-soft:rgba(207,255,61,.07); --accent-fg:#0a0b09;
  --accent-glow:rgba(207,255,61,.12); --accent-glow-strong:rgba(207,255,61,.22);
  --info:#7aa2ff; --warn:#f0b54a; --danger:#ff7479; --ok:#6fe39a;
  --font:"Geist",system-ui,-apple-system,sans-serif;
  --mono:"JetBrains Mono","Geist Mono",ui-monospace,"SF Mono",monospace;
  --r-sm:6px; --r-md:10px; --r-lg:16px; --r-xl:20px;
  --ease:cubic-bezier(0.16, 1, 0.3, 1);
}
.vf *{box-sizing:border-box}
.vf{width:360px;min-height:540px;display:flex;flex-direction:column;background:var(--bg-canvas);color:var(--text);
  font-family:var(--font);font-size:13px;line-height:1.45;-webkit-font-smoothing:antialiased}
.vf .tnum{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1,"lnum" 1}
.vf .mono{font-family:var(--mono);letter-spacing:-.01em}

/* ───── header ───── */
.vf-head{display:flex;align-items:center;gap:10px;padding:12px 16px;
  border-bottom:1px solid var(--border);background:var(--bg-canvas)}
.vf-logo{width:34px;height:34px;flex:0 0 34px;border-radius:var(--r-md);overflow:hidden;display:grid;place-items:center;
  border:1px solid var(--border-strong)}
.vf-logo img{width:100%;height:100%;display:block}
.vf-brand{display:flex;flex-direction:column;line-height:1.2;flex:1;min-width:0}
.vf-brand-name{font-weight:600;font-size:14px;letter-spacing:-.01em}
.vf-brand-sub{font-family:var(--mono);font-size:10px;color:var(--text-faint);letter-spacing:.02em}
.vf-net{font-family:var(--mono);font-size:9.5px;color:var(--ok);padding:3px 8px;letter-spacing:.03em;
  border:1px solid rgba(111,227,154,.15);border-radius:999px;display:flex;align-items:center;gap:5px;
  background:rgba(111,227,154,.04);text-transform:uppercase;font-weight:500}

/* ───── main ───── */
.vf-main{padding:16px;display:flex;flex-direction:column;gap:14px;flex:1}

/* screen transition -- VF Wallet Task 9: a critical wallet screen must not animate content on
   entry (rejection-checklist item 7); the old entry-animation keyframe applied to every
   .vf-screen (including seed/backup/import/unlock) is removed, not merely disabled. */
.vf-screen{display:flex;flex-direction:column;gap:14px}

/* ───── typography ───── */
.eyebrow{display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:11px;color:var(--text-faint)}
.eyebrow .dot{color:var(--accent)}.eyebrow .sec{color:var(--text-muted)}.eyebrow .rule{flex:1;height:1px;background:var(--border)}
.vf-h{margin:0;font-size:21px;font-weight:600;letter-spacing:-.02em;text-wrap:balance}
.lede{margin:0;font-size:13px;color:var(--text-muted);text-wrap:pretty}
.note{margin:0;font-size:11.5px;color:var(--text-faint);line-height:1.5}
.info{margin:0;font-size:12px;color:var(--text-muted)}
.err{margin:0;font-size:12px;color:var(--danger)}
.link{font-family:var(--mono);font-size:11.5px;color:var(--accent);text-decoration:none;border-bottom:1px solid transparent}
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

/* ───── fields ───── */
.field{display:flex;flex-direction:column;gap:6px}
.field .row-k{min-width:0}
.input{width:100%;padding:10px 12px;background:var(--bg-elev);color:var(--text);
  border:1px solid var(--border);border-radius:var(--r-md);font-size:13px;transition:border-color 160ms ease,box-shadow 160ms ease}
.input.mono{font-family:var(--mono);font-size:12px}
.input:focus{border-color:var(--border-accent);outline:none;box-shadow:0 0 0 3px var(--accent-soft)}
.input::placeholder{color:var(--text-faint)}
.vf :focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:var(--r-sm)}

/* amount-input */
.amount-row{display:flex;align-items:baseline;gap:10px;border-bottom:1px solid var(--border-strong);padding-bottom:8px}
.amount-row:focus-within{border-bottom-color:var(--border-accent)}
.amount{flex:1;min-width:0;background:none;border:none;color:var(--text);
  font-family:var(--mono);font-weight:500;font-size:clamp(30px,11vw,42px);letter-spacing:-.02em}
.amount::placeholder{color:var(--text-faint)}
.amount::-webkit-outer-spin-button,.amount::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.amount{-moz-appearance:textfield}

/* ───── buttons (passkey) ───── */
.btn{font-family:var(--font);font-size:13px;font-weight:500;padding:11px 18px;border-radius:var(--r-md);
  border:1px solid transparent;cursor:pointer;transition:background-color 160ms ease,border-color 160ms ease,color 160ms ease,transform 160ms var(--ease);text-align:center}
/* VF Wallet Task 9: dropped the gradient background-image + infinite btn-lava keyframe animation
   this primary button used to carry (rejection-checklist item 6: no button may use a gradient,
   outer glow, shimmer, pulse, or infinite animation) -- a flat, solid accent fill instead. */
.btn-primary{color:var(--accent-fg);border-color:transparent;background-color:var(--accent)}
.btn-primary:active:not(:disabled){transform:scale(.97)}
.btn-ghost{background:transparent;color:var(--text);border-color:var(--border-strong)}
.btn-ghost:hover:not(:disabled){background-color:var(--bg-elev)}
.btn:disabled{opacity:.4;cursor:not-allowed}
.btn-row{display:flex;gap:8px;flex-wrap:wrap}
.btn-row .btn{flex:1}
.btn-row.col{flex-direction:column}
.copy{font-family:var(--mono);font-size:11px;color:var(--text-muted);background:transparent;
  border:1px solid var(--border);border-radius:var(--r-sm);padding:4px 8px;cursor:pointer;transition:color 150ms ease,border-color 150ms ease,background-color 150ms ease,transform 160ms var(--ease)}
.copy:hover{color:var(--text);border-color:var(--border-strong);background:rgba(236,235,225,0.03)}
.copy:active{transform:scale(.97)}

/* approve overlay */
.approve{display:flex;flex-direction:column;gap:12px;background:var(--bg-card);border:1px solid var(--border-strong);
  border-radius:var(--r-lg);padding:16px}
.approve-verdict{margin:0;font-size:12px}
.approve-verdict.ok{color:var(--ok)}.approve-verdict.bad{color:var(--danger)}

/* pending status line -- VF Wallet Task 9: friendly copy ("working…", "loading…", ceremony
   status) must not be styled in monospace (rejection-checklist item 5); monospace stays reserved
   for real technical/secret data (.mono/.addr/.tnum elsewhere in this file). The decorative
   .marker/.blink dot is dropped outright, not just its animation. */
.pending{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-muted)}

/* ───── bottom nav — frosted glass ───── */
.vf-nav{display:flex;justify-content:space-around;padding:6px 8px 8px;
  background:var(--bg-base);
  border-top:1px solid var(--border)}
.vf-tab{display:flex;flex-direction:column;align-items:center;gap:3px;font-family:var(--font);
  font-size:9.5px;font-weight:500;text-transform:capitalize;color:var(--text-faint);
  padding:6px 8px;border:none;background:transparent;cursor:pointer;transition:color 160ms ease,transform 160ms var(--ease);position:relative;
  letter-spacing:.02em}
.vf-tab:hover{color:var(--text-muted)}
.vf-tab.active{color:var(--accent)}
.vf-tab-icon{width:20px;height:20px;display:flex;align-items:center;justify-content:center;transition:transform .2s var(--ease)}
.vf-tab.active .vf-tab-icon{transform:scale(1.1)}
.vf-tab.active::after{content:'';position:absolute;bottom:0;left:25%;right:25%;height:2px;
  background:var(--accent);border-radius:2px}

/* inline link button */
button.link{background:none;border:none;padding:0;cursor:pointer;font:inherit}

/* ════════════════════════════════════════════════════════════════════ */
/* Classic (seed / ed25519) wallet screens                            */
/* ════════════════════════════════════════════════════════════════════ */
.vf-screen{display:flex;flex-direction:column;gap:14px}
.vf-screen h2{margin:0;font-size:17px;font-weight:600;letter-spacing:-.01em;color:var(--text)}
.vf-screen > label{display:flex;flex-direction:column;gap:5px;font-family:var(--mono);font-size:10.5px;
  color:var(--text-faint);letter-spacing:.01em;text-transform:uppercase}
.vf-screen input,.vf-screen textarea{font-family:var(--font);font-size:13px;color:var(--text);
  background:var(--bg-elev);border:1px solid var(--border);border-radius:var(--r-md);padding:11px 12px;
  transition:border-color 160ms ease,box-shadow 160ms ease}
.vf-screen input:focus,.vf-screen textarea:focus{border-color:var(--border-accent);outline:none;
  box-shadow:0 0 0 3px var(--accent-soft)}
.vf-screen input[type=password]{font-family:var(--mono)}
.vf-screen input[type=number]{width:76px;font-family:var(--mono)}

/* buttons (classic) */
.vf-btn{font-family:var(--font);font-size:13px;font-weight:600;padding:12px 18px;border-radius:var(--r-md);
  border:1px solid var(--border-strong);background:var(--bg-elev);color:var(--text);cursor:pointer;
  transition:background-color 160ms ease,border-color 160ms ease,color 160ms ease,transform 160ms var(--ease);text-align:center;letter-spacing:-.01em}
.vf-btn:hover:not(:disabled){background:var(--bg-elev-2)}
.vf-btn:active:not(:disabled){transform:scale(.97)}
.vf-btn:disabled{opacity:.35;cursor:not-allowed}
/* VF Wallet Task 9: dropped the gradient background-image + infinite btn-lava keyframe animation
   these classic buttons used to carry -- flat, solid fills only (rejection-checklist item 6). */
.vf-btn.primary{color:var(--accent-fg);border-color:transparent;background-color:var(--accent)}
.vf-btn.primary:active:not(:disabled){transform:scale(.97)}
.vf-btn.ghost{background:transparent;border-color:transparent;color:var(--text-muted)}
.vf-btn.ghost:hover:not(:disabled){color:var(--text);background-color:var(--bg-elev)}

/* feedback text */
.vf-hint{margin:0;font-size:11.5px;color:var(--text-faint)}
.vf-error{margin:0;font-size:12px;color:var(--danger)}
.vf-muted{color:var(--text-faint);font-family:var(--mono);font-size:11px}
.vf-warn{margin:0;font-family:var(--mono);font-size:11px;line-height:1.5;color:var(--warn);
  background:rgba(240,181,74,.06);border:1px solid rgba(240,181,74,.2);border-radius:var(--r-md);padding:10px 12px}

/* backup phrase grid + confirm */
.vf-phrase{display:grid;grid-template-columns:repeat(3,1fr);gap:8px 10px;padding:14px;
  background:var(--bg-card);border:1px solid var(--border-strong);border-radius:var(--r-lg)}
.vf-phrase.blurred{display:flex;justify-content:center;padding:24px 12px}
.vf-word{font-family:var(--mono);font-size:12px;display:flex;gap:4px;color:var(--text)}
.vf-word-idx{color:var(--text-faint)}.vf-word-text{color:var(--text)}
.vf-confirm{display:flex;flex-direction:column;gap:10px;padding-top:8px;border-top:1px solid var(--border)}

/* ───── home: balance card ───── */
.vf-balance-card{display:flex;flex-direction:column;gap:8px;padding:22px 20px;position:relative;overflow:hidden;
  background:var(--bg-card);border:1px solid var(--border-strong);border-radius:var(--r-xl)}
.vf-portfolio{font-family:var(--mono);font-weight:600;font-size:clamp(30px,10vw,40px);
  letter-spacing:-.03em;color:var(--text)}
.vf-address{font-family:var(--mono);font-size:11px;color:var(--text-faint)}
.vf-address-container{display:flex;align-items:center;gap:8px}
.vf-address-copy-btn{background:rgba(236,235,225,.04);border:1px solid var(--border);color:var(--text-faint);cursor:pointer;
  display:flex;align-items:center;gap:4px;padding:3px 8px;border-radius:999px;transition:color 150ms ease,border-color 150ms ease,background-color 150ms ease,transform 160ms var(--ease);font-family:var(--mono);font-size:10px}
.vf-address-copy-btn:hover{color:var(--accent);border-color:rgba(207,255,61,.2);background:var(--accent-soft)}
.vf-address-copy-btn:active{transform:scale(.97)}

.vf-fund{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px dashed var(--border-strong);
  border-radius:var(--r-md);font-size:12px;color:var(--text-muted)}
.vf-actions{display:flex;gap:8px}
.vf-actions .vf-btn{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;border-radius:var(--r-lg)}

/* ───── token list ───── */
.vf-tokens{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.vf-token-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 10px;
  border-radius:var(--r-md);transition:background-color 160ms ease;cursor:default}
.vf-token-row:hover{background:rgba(236,235,225,.03)}
.vf-token-left{display:flex;align-items:center;gap:10px;flex:1;min-width:0}
.vf-token-icon{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;
  justify-content:center;font-family:var(--mono);font-weight:700;font-size:11px;color:#fff;
  flex-shrink:0;text-transform:uppercase;box-shadow:0 2px 8px rgba(0,0,0,.25)}
/* brand mark (tokenIcons.jsx); the marks carry their own round background */
svg.vf-token-icon{display:block;overflow:hidden}
.vf-token-icon.unknown{background:#546e7a;border:1px solid rgba(120,144,156,.2)}
.vf-token-meta{display:flex;flex-direction:column;line-height:1.3;min-width:0}
.vf-token-code{font-family:var(--font);font-weight:600;font-size:13px;color:var(--text)}
.vf-token-name{font-size:11px;color:var(--text-muted)}
.vf-token-right{display:flex;flex-direction:column;align-items:flex-end;line-height:1.3;font-family:var(--mono)}
.vf-token-balance{font-weight:500;font-size:13px;color:var(--text)}
.vf-token-usd{font-size:11px;color:var(--text-faint)}

/* ───── send confirm card ───── */
.vf-confirm-card{display:flex;flex-direction:column;gap:12px;padding:16px;
  background:var(--bg-card);border:1px solid var(--border-strong);border-radius:var(--r-lg)}
.vf-confirm-card h3{margin:0 0 4px 0;font-size:13px;font-weight:600;color:var(--accent);
  display:flex;align-items:center;gap:6px;letter-spacing:-.01em}
.vf-confirm-card dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:6px 12px}
.vf-confirm-card dt{font-family:var(--mono);font-size:10.5px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.02em}
.vf-confirm-card dd{margin:0;font-family:var(--mono);font-size:12px;color:var(--text);word-break:break-all}

/* ───── receive ───── */
.vf-qr{display:block;margin:0 auto;border-radius:var(--r-lg);background:#fff;padding:10px;
  border:1px solid var(--border-strong);transition:transform 160ms var(--ease)}
.vf-address-full{display:block;font-family:var(--mono);font-size:10.5px;word-break:break-all;
  color:var(--text-muted);background:var(--bg-elev);border:1px solid var(--border);
  border-radius:var(--r-md);padding:10px 12px;user-select:all;line-height:1.5}

/* ───── history ───── */
.vf-history{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.vf-history li{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 10px;
  border-radius:var(--r-md);transition:background-color 160ms ease;cursor:default}
.vf-history li:hover{background:rgba(236,235,225,.03)}
.vf-history-row{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%}
.vf-history-left{display:flex;align-items:center;gap:10px;flex:1;min-width:0}
.vf-history-badge{width:32px;height:32px;border-radius:var(--r-md);display:flex;align-items:center;
  justify-content:center;font-size:14px;font-weight:600;flex-shrink:0}
.vf-history-badge.in{background:rgba(111,227,154,.08);color:var(--ok);border:1px solid rgba(111,227,154,.15)}
.vf-history-badge.out{background:rgba(236,235,225,.04);color:var(--text-muted);border:1px solid rgba(236,235,225,.06)}
.vf-history-meta{display:flex;flex-direction:column;line-height:1.3;min-width:0}
.vf-history-title{font-weight:500;font-size:13px;color:var(--text)}
.vf-history-address{font-family:var(--mono);font-size:10.5px;color:var(--text-faint)}
.vf-history-right{display:flex;flex-direction:column;align-items:flex-end;line-height:1.3;font-family:var(--mono)}
.vf-history-amount{font-weight:500;font-size:13px}
.vf-history-amount.in{color:var(--ok)}.vf-history-amount.out{color:var(--text)}
.vf-history-time{font-size:10px;color:var(--text-faint)}

/* unlock / settings / export */
.vf-unlock,.vf-settings,.vf-export{gap:16px}
.vf-settings label{flex-direction:row;align-items:center;justify-content:space-between;
  font-family:var(--font);font-size:13px;color:var(--text);text-transform:none}

/* screen-root tweaks */
.vf-create{gap:16px}
.vf-backup h2{color:var(--warn)}
.vf-import textarea{font-family:var(--mono);font-size:12px;resize:vertical}
.vf-home{gap:16px}
.vf-send label{gap:5px}
.vf-receive{align-items:center;text-align:center}
.vf-receive .vf-address-full{text-align:left}

@media (hover:hover) and (pointer:fine){
  .btn-primary:hover:not(:disabled),.btn-ghost:hover:not(:disabled),
  .vf-btn:hover:not(:disabled){transform:translateY(-1px)}
  .btn:active:not(:disabled),.vf-btn:active:not(:disabled){transform:scale(.97)}
  .vf-tab:hover .vf-tab-icon{transform:translateY(-1px)}
  .vf-qr:hover{transform:scale(1.02)}
}

@media (prefers-reduced-motion:reduce){
  .btn,.copy,.vf-tab,.vf-tab-icon,.vf-btn,.vf-address-copy-btn,.vf-qr{transition:color 160ms ease,background-color 160ms ease,border-color 160ms ease,opacity 160ms ease}
  .btn:hover,.btn:active,.vf-btn:hover,.vf-btn:active,.vf-tab:hover .vf-tab-icon,.vf-tab.active .vf-tab-icon,.vf-qr:hover,.vf-address-copy-btn:active,.copy:active{transform:none}
  .btn:active:not(:disabled),.vf-btn:active:not(:disabled){opacity:.82}
}

@media (prefers-contrast:more){
  .vf-head,.vf-nav{border-color:var(--border-strong)}
}
`

const NAV_TABS = ['home', 'send', 'deposit', 'signers', 'recovery', 'activity', 'agent']
// Classic (seed-phrase) wallet has its own, smaller tab set — deposit-only-via-Send,
// no signer/agent ceremonies. Kept as a separate const per the plan rather than branching
// NAV_TABS itself, so the passkey tab list is untouched.
const NAV_TABS_CLASSIC = ['home', 'send', 'receive', 'activity', 'settings']

// SVG icon paths for the classic nav tabs (Feather-icon style, 20×20 viewBox)
const TAB_ICONS = {
  home: <path d="M3 10.5L10 4l7 6.5V17a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6.5z" />,
  send: (
    <>
      <path d="M17 3L3 10l5 2 2 5 7-14z" />
      <line x1="17" y1="3" x2="8" y2="12" />
    </>
  ),
  receive: (
    <>
      <path d="M4 16v1a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-1" />
      <polyline points="7 10 10 13 13 10" />
      <line x1="10" y1="3" x2="10" y2="13" />
    </>
  ),
  activity: <polyline points="3 14 7 10 11 13 17 6" />,
  settings: (
    <>
      <circle cx="10" cy="10" r="3" />
      <path d="M17.4 11.4a1.2 1.2 0 0 0 .24 1.32l.04.04a1.44 1.44 0 1 1-2.04 2.04l-.04-.04a1.2 1.2 0 0 0-1.32-.24 1.2 1.2 0 0 0-.72 1.08v.12a1.44 1.44 0 0 1-2.88 0v-.06a1.2 1.2 0 0 0-.78-1.08 1.2 1.2 0 0 0-1.32.24l-.04.04a1.44 1.44 0 1 1-2.04-2.04l.04-.04a1.2 1.2 0 0 0 .24-1.32 1.2 1.2 0 0 0-1.08-.72H5.28a1.44 1.44 0 0 1 0-2.88h.06a1.2 1.2 0 0 0 1.08-.78 1.2 1.2 0 0 0-.24-1.32L6.14 5.66a1.44 1.44 0 1 1 2.04-2.04l.04.04a1.2 1.2 0 0 0 1.32.24h.06A1.2 1.2 0 0 0 10.32 2.82V2.7a1.44 1.44 0 0 1 2.88 0v.06a1.2 1.2 0 0 0 .72 1.08 1.2 1.2 0 0 0 1.32-.24l.04-.04a1.44 1.44 0 1 1 2.04 2.04l-.04.04a1.2 1.2 0 0 0-.24 1.32v.06a1.2 1.2 0 0 0 1.08.72h.12a1.44 1.44 0 0 1 0 2.88h-.06a1.2 1.2 0 0 0-1.08.72z" />
    </>
  ),
}

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

function NavBar({ tabs = NAV_TABS, onNav, active }) {
  return (
    <nav className="vf-nav">
      {tabs.map((t) => (
        <button
          key={t}
          className={'vf-tab' + (t === active ? ' active' : '')}
          aria-current={t === active ? 'page' : undefined}
          onClick={() => onNav(t)}
        >
          <span className="vf-tab-icon">
            <svg
              width="18"
              height="18"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {TAB_ICONS[t] || <circle cx="10" cy="10" r="6" />}
            </svg>
          </span>
          {t}
        </button>
      ))}
    </nav>
  )
}

function Shell({ children, nav, active, tabs, onNav, sub = 'passkey · secp256r1' }) {
  return (
    <div className="vf">
      <style>{CSS}</style>
      <header className="vf-head">
        <div className="vf-logo">
          <img src="./vibing_farmer.logo.svg" alt="Vibing Farmer" />
        </div>
        <div className="vf-brand">
          <div className="vf-brand-name">VF Wallet</div>
          <div className="vf-brand-sub">{sub}</div>
        </div>
        <span className="vf-net">testnet</span>
      </header>
      <div className="vf-main">{children}</div>
      {nav && <NavBar tabs={tabs} onNav={onNav} active={active} />}
    </div>
  )
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

  async function handleAddAgent() {
    clear()
    if (!/^[G][A-Z2-7]{55}$/i.test(agentAddress)) {
      setError('Invalid agent G-address')
      return
    }
    const capVal = parseFloat(agentCap)
    if (isNaN(capVal) || capVal <= 0) {
      setError('Spending cap must be greater than 0')
      return
    }
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
            setErr('Backup phrase unavailable. Use Settings → Export secret as your wallet backup.')
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
    return (
      <Shell sub="classic · ed25519">
        <button
          type="button"
          className="vf-btn ghost"
          style={{ alignSelf: 'flex-start', padding: '6px 4px' }}
          onClick={() => {
            setErr('')
            setScreen('classic-home')
          }}
        >
          ← Back
        </button>
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
      </Shell>
    )
  }

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
    return (
      <Shell
        nav
        active="settings"
        tabs={NAV_TABS_CLASSIC}
        onNav={classicNav}
        sub="classic · ed25519"
      >
        <SettingsScreen
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
        />
        <HonestyLabels scope="session-key" />

        {exportForm.open && (
          <div className="vf-screen vf-export">
            {!exportForm.secret ? (
              <>
                <label>
                  Password
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={exportForm.pw}
                    onChange={(e) =>
                      setExportForm((f) => ({ ...f, pw: e.target.value, error: '' }))
                    }
                  />
                </label>
                {exportForm.error && <p className="vf-error">{exportForm.error}</p>}
                <div className="vf-actions">
                  <button
                    className="vf-btn primary"
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
                  <button
                    className="vf-btn ghost"
                    onClick={() => setExportForm({ open: false, pw: '', secret: null, error: '' })}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="vf-warn">
                  This is your ONLY secret key. Anyone with it controls this wallet. Shown once — it
                  will not be shown again.
                </p>
                <code className="vf-address-full">{exportForm.secret}</code>
                <button
                  className="vf-btn primary"
                  onClick={() => setExportForm({ open: false, pw: '', secret: null, error: '' })}
                >
                  Done — hide it
                </button>
              </>
            )}
          </div>
        )}

        <p className="vf-hint">
          <button
            className="link"
            onClick={() => {
              setExportForm({ open: false, pw: '', secret: null, error: '' })
              localStorage.setItem('vf_wallet_type', 'passkey')
              setScreen('welcome')
            }}
          >
            Switch to passkey wallet
          </button>
        </p>
      </Shell>
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
      <Shell>
        <Eyebrow sec="ceremony" meta="face id" />
        <h1 className="vf-h">Approve in the ceremony tab</h1>
        <div className="pending">{status}</div>
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
        onSend={() => setScreen('send')}
        onReceive={() => setScreen('receive')}
        onGetUsdc={handlePasskeyGetUsdc}
      >
        <HonestyLabels scope="global" />
      </WalletHome>
    )
  }

  // NEW: Passkey had no Settings screen at all before this task (only a link buried on Home) --
  // the beginner nav (Home/Activity/Settings) needs a real destination for its third tab, so the
  // account-switch/reset action now lives here instead, matching where classic's own equivalent
  // link already lives (classic-settings, not classic-home).
  if (screen === 'wallet-settings') {
    return (
      <WalletShell
        heading="Settings"
        account={{ kind: 'C', address: wallet?.contractId }}
        nav={{
          tabs: [
            { id: 'home', label: 'Home' },
            { id: 'activity', label: 'Activity' },
            { id: 'settings', label: 'Settings' },
          ],
          active: 'settings',
          onNav: passkeyNav,
        }}
      >
        <button
          type="button"
          className="pc-button pc-button--secondary"
          onClick={async () => {
            localStorage.removeItem('vf_wallet_contract')
            localStorage.removeItem('vf_wallet_credential')
            localStorage.setItem('vf_wallet_type', 'classic')
            if (typeof chrome !== 'undefined' && chrome.storage?.local) {
              // Reset (not a benign switch — this button deletes the passkey account outright),
              // so the stale active-account pointer must go with it rather than linger for the
              // next resolveActiveAccount call to self-heal around.
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
        >
          Switch to classic wallet / Reset
        </button>
      </WalletShell>
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

  // VF Wallet Task 10, Step 3 -- Passkey (C) Activity. `items={null}` (Unavailable, not a false
  // "no activity"): Horizon's payments collection (wallet/history.js's data source) only lists
  // classic `payment`/`create_account` operations, never Soroban `invoke_host_function` calls --
  // the ONLY way this account kind moves funds -- so calling it for a C-address would not fail,
  // it would just silently return an empty list that looks identical to "confirmed no activity"
  // while actually meaning "this data source cannot see this account's activity at all". That is
  // exactly the money-truth distinction Step 3 asks for; the honest answer here is Unavailable,
  // not a fabricated empty read. The direct Stellar Expert account link (unaffected, pre-existing)
  // stays available as a real alternative.
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
            View on Stellar Expert →
          </a>
        )}
      </WalletActivity>
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
      <div className="pending">loading…</div>
    </Shell>
  )
}

// Guarded so importing this module (e.g. to unit-test resolveEntryScreen, mirroring approve.js's
// screenModel pattern) never tries to mount into a #root that only exists in popup.html.
if (typeof document !== 'undefined' && document.getElementById('root')) {
  createRoot(document.getElementById('root')).render(<Popup />)
}
