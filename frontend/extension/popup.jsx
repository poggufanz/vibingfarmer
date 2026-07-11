import './shims.js'
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
import CreateScreen from '../src/wallet/ui/classic/CreateScreen.jsx'
import BackupScreen from '../src/wallet/ui/classic/BackupScreen.jsx'
import ImportScreen from '../src/wallet/ui/classic/ImportScreen.jsx'
import OnboardingScreen from '../src/wallet/ui/classic/OnboardingScreen.jsx'
import HomeScreen from '../src/wallet/ui/classic/HomeScreen.jsx'
import SendScreen from '../src/wallet/ui/classic/SendScreen.jsx'
import ReceiveScreen from '../src/wallet/ui/classic/ReceiveScreen.jsx'
import HistoryScreen from '../src/wallet/ui/classic/HistoryScreen.jsx'
import UnlockScreen from '../src/wallet/ui/classic/UnlockScreen.jsx'
import SettingsScreen from '../src/wallet/ui/classic/SettingsScreen.jsx'
import { pickConfirmIndices } from '../src/wallet/ui/classic/backupConfirm.js'
import * as C from '../src/wallet/ui/classic/controller.js'

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
  font-family:var(--font);font-size:13px;line-height:1.45;-webkit-font-smoothing:antialiased;
  background-image:radial-gradient(ellipse 100% 60% at 50% 0%, rgba(207,255,61,0.03) 0%, transparent 70%)}
.vf .tnum{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1,"lnum" 1}
.vf .mono{font-family:var(--mono);letter-spacing:-.01em}

/* ───── header ───── */
.vf-head{display:flex;align-items:center;gap:10px;padding:12px 16px;
  border-bottom:1px solid var(--border);background:rgba(14,16,12,.6);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}
.vf-logo{width:34px;height:34px;flex:0 0 34px;border-radius:var(--r-md);overflow:hidden;display:grid;place-items:center;
  box-shadow:0 0 0 1px rgba(207,255,61,.1),0 2px 8px rgba(0,0,0,.3)}
.vf-logo img{width:100%;height:100%;display:block}
.vf-brand{display:flex;flex-direction:column;line-height:1.2;flex:1;min-width:0}
.vf-brand-name{font-weight:600;font-size:14px;letter-spacing:-.01em}
.vf-brand-sub{font-family:var(--mono);font-size:10px;color:var(--text-faint);letter-spacing:.02em}
.vf-net{font-family:var(--mono);font-size:9.5px;color:var(--ok);padding:3px 8px;letter-spacing:.03em;
  border:1px solid rgba(111,227,154,.15);border-radius:999px;display:flex;align-items:center;gap:5px;
  background:rgba(111,227,154,.04);text-transform:uppercase;font-weight:500}

.net-dot{width:5px;height:5px;border-radius:50%;background:var(--ok);box-shadow:0 0 6px var(--ok);animation:pulse-dot 2s infinite}
@keyframes pulse-dot{
  0%{transform:scale(.9);box-shadow:0 0 0 0 rgba(111,227,154,.6)}
  70%{transform:scale(1);box-shadow:0 0 0 5px rgba(111,227,154,0)}
  100%{transform:scale(.9);box-shadow:0 0 0 0 rgba(111,227,154,0)}
}

/* ───── main ───── */
.vf-main{padding:16px;display:flex;flex-direction:column;gap:14px;flex:1;
  animation:screenIn .4s var(--ease) forwards}
@keyframes screenIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}

/* screen transition */
.vf-screen{display:flex;flex-direction:column;gap:14px;animation:screenIn .35s var(--ease) forwards}

/* ───── typography ───── */
.eyebrow{display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:11px;text-transform:lowercase;color:var(--text-faint)}
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
  border:1px solid var(--border);border-radius:var(--r-md);font-size:13px;transition:all .2s ease}
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
  border:1px solid transparent;cursor:pointer;transition:all .2s var(--ease);text-align:center}
.btn-primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
.btn-primary:hover:not(:disabled){background:#dbff66;transform:translateY(-1px);box-shadow:0 4px 16px var(--accent-glow-strong)}
.btn-primary:active:not(:disabled){transform:translateY(0);box-shadow:0 2px 8px var(--accent-glow)}
.btn-ghost{background:transparent;color:var(--text);border-color:var(--border-strong)}
.btn-ghost:hover:not(:disabled){background:var(--bg-elev);transform:translateY(-1px)}
.btn:disabled{opacity:.4;cursor:not-allowed}
.btn-row{display:flex;gap:8px;flex-wrap:wrap}
.btn-row .btn{flex:1}
.btn-row.col{flex-direction:column}
.copy{font-family:var(--mono);font-size:11px;color:var(--text-muted);background:transparent;
  border:1px solid var(--border);border-radius:var(--r-sm);padding:4px 8px;cursor:pointer;transition:all .15s ease}
.copy:hover{color:var(--text);border-color:var(--border-strong);background:rgba(236,235,225,0.03)}

/* approve overlay */
.approve{display:flex;flex-direction:column;gap:12px;background:var(--bg-card);border:1px solid var(--border-strong);
  border-radius:var(--r-lg);padding:16px}
.approve-verdict{margin:0;font-size:12px}
.approve-verdict.ok{color:var(--ok)}.approve-verdict.bad{color:var(--danger)}

/* pending marker */
.pending{display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:12px;color:var(--text-muted)}
.marker{width:9px;height:9px;border-radius:50%;background:var(--accent)}
.blink{animation:blink 1.1s ease-in-out infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.25}}

/* ───── bottom nav — frosted glass ───── */
.vf-nav{display:flex;justify-content:space-around;padding:6px 8px 8px;
  background:rgba(10,11,9,.75);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
  border-top:1px solid var(--border)}
.vf-tab{display:flex;flex-direction:column;align-items:center;gap:3px;font-family:var(--font);
  font-size:9.5px;font-weight:500;text-transform:capitalize;color:var(--text-faint);
  padding:6px 8px;border:none;background:transparent;cursor:pointer;transition:all .2s ease;position:relative;
  letter-spacing:.02em}
.vf-tab:hover{color:var(--text-muted)}
.vf-tab.active{color:var(--accent)}
.vf-tab-icon{width:20px;height:20px;display:flex;align-items:center;justify-content:center;transition:transform .2s var(--ease)}
.vf-tab:hover .vf-tab-icon{transform:translateY(-1px)}
.vf-tab.active .vf-tab-icon{transform:scale(1.1)}
.vf-tab.active::after{content:'';position:absolute;bottom:0;left:25%;right:25%;height:2px;
  background:var(--accent);box-shadow:0 0 8px var(--accent);border-radius:2px}

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
  transition:all .2s ease}
.vf-screen input:focus,.vf-screen textarea:focus{border-color:var(--border-accent);outline:none;
  box-shadow:0 0 0 3px var(--accent-soft)}
.vf-screen input[type=password]{font-family:var(--mono)}
.vf-screen input[type=number]{width:76px;font-family:var(--mono)}

/* buttons (classic) */
.vf-btn{font-family:var(--font);font-size:13px;font-weight:600;padding:12px 18px;border-radius:var(--r-md);
  border:1px solid var(--border-strong);background:var(--bg-elev);color:var(--text);cursor:pointer;
  transition:all .2s var(--ease);text-align:center;letter-spacing:-.01em}
.vf-btn:hover:not(:disabled){background:var(--bg-elev-2);transform:translateY(-1px);
  box-shadow:0 4px 16px rgba(0,0,0,.3)}
.vf-btn:active:not(:disabled){transform:translateY(0)}
.vf-btn:disabled{opacity:.35;cursor:not-allowed}
.vf-btn.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent);
  box-shadow:0 2px 12px var(--accent-glow)}
.vf-btn.primary:hover:not(:disabled){background:#dbff66;box-shadow:0 6px 24px var(--accent-glow-strong);transform:translateY(-1px)}
.vf-btn.primary:active:not(:disabled){transform:translateY(0);box-shadow:0 2px 8px var(--accent-glow)}
.vf-btn.ghost{background:transparent;border-color:transparent;color:var(--text-muted)}
.vf-btn.ghost:hover:not(:disabled){color:var(--text);background:var(--bg-elev);transform:none;box-shadow:none}

/* feedback text */
.vf-hint{margin:0;font-size:11.5px;color:var(--text-faint)}
.vf-error{margin:0;font-size:12px;color:var(--danger)}
.vf-muted{color:var(--text-faint);font-family:var(--mono);font-size:11px}
.vf-warn{margin:0;font-family:var(--mono);font-size:11px;line-height:1.5;color:var(--warn);
  background:rgba(240,181,74,.06);border:1px solid rgba(240,181,74,.2);border-radius:var(--r-md);padding:10px 12px}

/* backup phrase grid + confirm */
.vf-phrase{display:grid;grid-template-columns:repeat(3,1fr);gap:8px 10px;padding:14px;
  background:var(--bg-card);border:1px solid var(--border-strong);border-radius:var(--r-lg);
  box-shadow:0 4px 16px rgba(0,0,0,.25)}
.vf-phrase.blurred{display:flex;justify-content:center;padding:24px 12px}
.vf-word{font-family:var(--mono);font-size:12px;display:flex;gap:4px;color:var(--text)}
.vf-word-idx{color:var(--text-faint)}.vf-word-text{color:var(--text)}
.vf-confirm{display:flex;flex-direction:column;gap:10px;padding-top:8px;border-top:1px solid var(--border)}

/* ───── home: balance card ───── */
.vf-balance-card{display:flex;flex-direction:column;gap:8px;padding:22px 20px;position:relative;overflow:hidden;
  background:linear-gradient(145deg, #1a1e14 0%, #12140e 50%, #0e100c 100%);
  border:1px solid rgba(207,255,61,.08);border-radius:var(--r-xl);
  box-shadow:0 12px 40px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.04)}
.vf-balance-card::before{content:'';position:absolute;top:-40%;right:-20%;width:200px;height:200px;
  background:radial-gradient(circle, rgba(207,255,61,.06) 0%, transparent 70%);pointer-events:none}
.vf-portfolio{font-family:var(--mono);font-weight:600;font-size:clamp(30px,10vw,40px);
  letter-spacing:-.03em;color:var(--text);text-shadow:0 0 40px rgba(207,255,61,.08)}
.vf-address{font-family:var(--mono);font-size:11px;color:var(--text-faint)}
.vf-address-container{display:flex;align-items:center;gap:8px}
.vf-address-copy-btn{background:rgba(236,235,225,.04);border:1px solid var(--border);color:var(--text-faint);cursor:pointer;
  display:flex;align-items:center;gap:4px;padding:3px 8px;border-radius:999px;transition:all .15s ease;font-family:var(--mono);font-size:10px}
.vf-address-copy-btn:hover{color:var(--accent);border-color:rgba(207,255,61,.2);background:var(--accent-soft)}

.vf-fund{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px dashed var(--border-strong);
  border-radius:var(--r-md);font-size:12px;color:var(--text-muted)}
.vf-actions{display:flex;gap:8px}
.vf-actions .vf-btn{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;border-radius:var(--r-lg)}

/* ───── token list ───── */
.vf-tokens{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.vf-token-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 10px;
  border-radius:var(--r-md);transition:all .2s var(--ease);cursor:default}
.vf-token-row:hover{background:rgba(236,235,225,.03)}
.vf-token-left{display:flex;align-items:center;gap:10px;flex:1;min-width:0}
.vf-token-icon{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;
  justify-content:center;font-family:var(--mono);font-weight:700;font-size:11px;color:#fff;
  flex-shrink:0;text-transform:uppercase;box-shadow:0 2px 8px rgba(0,0,0,.25)}
.vf-token-icon.xlm{background:linear-gradient(135deg, #5c6bc0 0%, #283593 100%);border:1px solid rgba(92,107,192,.25)}
.vf-token-icon.usdc{background:linear-gradient(135deg, #42a5f5 0%, #1565c0 100%);border:1px solid rgba(66,165,245,.25)}
.vf-token-icon.unknown{background:linear-gradient(135deg, #78909c 0%, #37474f 100%);border:1px solid rgba(120,144,156,.2)}
.vf-token-meta{display:flex;flex-direction:column;line-height:1.3;min-width:0}
.vf-token-code{font-family:var(--font);font-weight:600;font-size:13px;color:var(--text)}
.vf-token-name{font-size:11px;color:var(--text-muted)}
.vf-token-right{display:flex;flex-direction:column;align-items:flex-end;line-height:1.3;font-family:var(--mono)}
.vf-token-balance{font-weight:500;font-size:13px;color:var(--text)}
.vf-token-usd{font-size:11px;color:var(--text-faint)}

/* ───── send confirm card ───── */
.vf-confirm-card{display:flex;flex-direction:column;gap:12px;padding:16px;
  background:var(--bg-card);border:1px solid var(--border-strong);border-radius:var(--r-lg);
  box-shadow:0 8px 32px rgba(0,0,0,.35)}
.vf-confirm-card h3{margin:0 0 4px 0;font-size:13px;font-weight:600;color:var(--accent);
  display:flex;align-items:center;gap:6px;letter-spacing:-.01em}
.vf-confirm-card dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:6px 12px}
.vf-confirm-card dt{font-family:var(--mono);font-size:10.5px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.02em}
.vf-confirm-card dd{margin:0;font-family:var(--mono);font-size:12px;color:var(--text);word-break:break-all}

/* ───── receive ───── */
.vf-qr{display:block;margin:0 auto;border-radius:var(--r-lg);background:#fff;padding:10px;
  box-shadow:0 12px 40px rgba(0,0,0,.4), 0 0 0 1px rgba(207,255,61,.1);
  transition:transform .2s var(--ease)}
.vf-qr:hover{transform:scale(1.02)}
.vf-address-full{display:block;font-family:var(--mono);font-size:10.5px;word-break:break-all;
  color:var(--text-muted);background:var(--bg-elev);border:1px solid var(--border);
  border-radius:var(--r-md);padding:10px 12px;user-select:all;line-height:1.5}

/* ───── history ───── */
.vf-history{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.vf-history li{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 10px;
  border-radius:var(--r-md);transition:all .2s var(--ease);cursor:default}
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

@media (prefers-reduced-motion:reduce){
  .vf-main,.vf-screen{animation:none}.blink{animation:none}
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
  send: <><path d="M17 3L3 10l5 2 2 5 7-14z" /><line x1="17" y1="3" x2="8" y2="12" /></>,
  receive: <><path d="M4 16v1a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-1" /><polyline points="7 10 10 13 13 10" /><line x1="10" y1="3" x2="10" y2="13" /></>,
  activity: <polyline points="3 14 7 10 11 13 17 6" />,
  settings: <><circle cx="10" cy="10" r="3" /><path d="M17.4 11.4a1.2 1.2 0 0 0 .24 1.32l.04.04a1.44 1.44 0 1 1-2.04 2.04l-.04-.04a1.2 1.2 0 0 0-1.32-.24 1.2 1.2 0 0 0-.72 1.08v.12a1.44 1.44 0 0 1-2.88 0v-.06a1.2 1.2 0 0 0-.78-1.08 1.2 1.2 0 0 0-1.32.24l-.04.04a1.44 1.44 0 1 1-2.04-2.04l.04-.04a1.2 1.2 0 0 0 .24-1.32 1.2 1.2 0 0 0-1.08-.72H5.28a1.44 1.44 0 0 1 0-2.88h.06a1.2 1.2 0 0 0 1.08-.78 1.2 1.2 0 0 0-.24-1.32L6.14 5.66a1.44 1.44 0 1 1 2.04-2.04l.04.04a1.2 1.2 0 0 0 1.32.24h.06A1.2 1.2 0 0 0 10.32 2.82V2.7a1.44 1.44 0 0 1 2.88 0v.06a1.2 1.2 0 0 0 .72 1.08 1.2 1.2 0 0 0 1.32-.24l.04-.04a1.44 1.44 0 1 1 2.04 2.04l-.04.04a1.2 1.2 0 0 0-.24 1.32v.06a1.2 1.2 0 0 0 1.08.72h.12a1.44 1.44 0 0 1 0 2.88h-.06a1.2 1.2 0 0 0-1.08.72z" /></>,
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
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor"
              strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
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
        <span className="vf-net">
          <span className="net-dot"></span>
          testnet
        </span>
      </header>
      <div className="vf-main">{children}</div>
      {nav && <NavBar tabs={tabs} onNav={onNav} active={active} />}
    </div>
  )
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
  const [preview, setPreview] = useState(null)
  const [portfolio, setPortfolio] = useState(null)
  const [unfunded, setUnfunded] = useState(false)
  const [activity, setActivity] = useState([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [autoLockMin, setAutoLockMin] = useState(10)
  const [exportForm, setExportForm] = useState({ open: false, pw: '', secret: null, error: '' })

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

  useEffect(() => {
    C.armAutoLock()
    C.bootstrap().then((b) => {
      setCw({
        ready: true,
        hasWallet: b.hasWallet,
        publicKey: b.publicKey,
        unlocked: b.unlocked,
        needsBackup: b.needsBackup,
      })
      // A pending backup always routes through unlock first — even if the session is already
      // unlocked — because the password is what re-derives the mnemonic from its encrypted
      // blob (revealBackup). This is the popup-reopen path: create → close popup before
      // confirming → reopen → still gated, never silently dropped into home.
      if (b.hasWallet && (b.needsBackup || !b.unlocked)) setScreen('classic-unlock')
      else if (b.hasWallet) {
        setScreen('classic-home')
        refresh(b.publicKey)
      } else setScreen('classic-onboarding')
    })
  }, [])

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

  // Restore cached wallet on mount (no-arg = reads vf_wallet_contract from localStorage)
  useEffect(() => {
    connectPasskeyWallet()
      .then((w) => {
        setWallet(w)
        setScreen('home')
        refreshBalance(w.contractId)
      })
      .catch(() => {
        // No cached wallet — remain on whatever the classic bootstrap above decided
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

  // ── CLASSIC (seed-phrase / ed25519) SCREENS ───────────────────────────────
  // Classic is the default wallet type; the passkey screens below are unmodified and remain
  // reachable via the "switch to passkey wallet" links on classic-create/classic-settings.

  if (screen === 'classic-onboarding') {
    return (
      <Shell sub="classic · onboarding">
        <OnboardingScreen onGetStarted={() => setScreen('classic-create')} />
      </Shell>
    )
  }

  if (screen === 'classic-create') {
    return (
      <Shell sub="classic · ed25519">
        <CreateScreen
          busy={busy}
          error={err}
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
        <p className="vf-hint">
          Prefer Face ID?{' '}
          <button className="link" onClick={() => setScreen('welcome')}>
            Use a passkey wallet instead
          </button>
        </p>
      </Shell>
    )
  }

  if (screen === 'classic-backup') {
    return (
      <Shell sub="classic · ed25519">
        <BackupScreen
          mnemonic={backup.mnemonic}
          indices={backup.indices}
          error={err}
          onConfirm={async () => {
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
          onSkip={async () => {
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
      </Shell>
    )
  }

  if (screen === 'classic-import') {
    return (
      <Shell sub="classic · ed25519">
        <ImportScreen
          busy={busy}
          error={err}
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
      </Shell>
    )
  }

  if (screen === 'classic-unlock') {
    return (
      <Shell sub="classic · ed25519">
        <UnlockScreen
          publicKey={cw.publicKey}
          busy={busy}
          error={err}
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
              setErr(
                'Backup phrase unavailable. Use Settings → Export secret as your wallet backup.'
              )
            } finally {
              setBusy(false)
            }
          }}
        />
      </Shell>
    )
  }

  if (screen === 'classic-home') {
    return (
      <Shell nav active="home" tabs={NAV_TABS_CLASSIC} onNav={classicNav} sub="classic · ed25519">
        <HomeScreen
          publicKey={cw.publicKey}
          portfolio={portfolio}
          unfunded={unfunded}
          busy={busy}
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
          onSend={() => {
            setPreview(null)
            setErr('')
            setScreen('classic-send')
          }}
          onReceive={() => setScreen('classic-receive')}
        />
        {err && <p className="vf-error">{err}</p>}
        <HonestyLabels scope="global" />
      </Shell>
    )
  }

  if (screen === 'classic-send') {
    return (
      <Shell nav active="send" tabs={NAV_TABS_CLASSIC} onNav={classicNav} sub="classic · ed25519">
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
        {err && <p className="vf-error">{err}</p>}
      </Shell>
    )
  }

  if (screen === 'classic-receive') {
    return (
      <Shell
        nav
        active="receive"
        tabs={NAV_TABS_CLASSIC}
        onNav={classicNav}
        sub="classic · ed25519"
      >
        <ReceiveScreen publicKey={cw.publicKey} />
      </Shell>
    )
  }

  if (screen === 'classic-activity') {
    return (
      <Shell
        nav
        active="activity"
        tabs={NAV_TABS_CLASSIC}
        onNav={classicNav}
        sub="classic · ed25519"
      >
        {err && <p className="vf-error">{err}</p>}
        <HistoryScreen items={activity} />
      </Shell>
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
              setScreen('welcome')
            }}
          >
            Switch to passkey wallet
          </button>
        </p>
      </Shell>
    )
  }

  // ── SCREENS (passkey) ──────────────────────────────────────────────────────

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
