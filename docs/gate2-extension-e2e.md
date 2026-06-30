# Gate 2 — VF Wallet extension end-to-end (manual, Chrome + Windows Hello)

Gate 1 (headless, `scripts/m3plus-fund-approve-deposit-smoke.mjs --submit`) already proves the
on-chain path through the **production** `submit.js` assemblers. Gate 2 is the one thing that
cannot run headless: the packed MV3 extension UI — popup → ceremony tab → WebAuthn (Windows Hello)
→ background message-passing → real testnet deposit.

This is a **demonstration/finding gate**, not a unit test. The open question it answers is the TODO
at `extension/ceremony.js` (≈L18): does the default `kit.signAuthEntry` passkey path complete a
WebAuthn ceremony from a `chrome-extension://` origin?

---

## Wiring fixed (so the extension can reach the backend)

These were dead until now and are required before any click-through works:

- `extension/manifest.json` `host_permissions` → real origins (localhost dev API + Soroban RPC +
  Friendbot). Was the invalid placeholder `https://<VF_API_HOST>/*`.
- `extension/vite.config.extension.js` → `root` set so HTML emits flat at the dist root, a
  `closeBundle` hook copies `manifest.json` in, and `define` inlines `VF_API_BASE`.
- `src/stellar/config.js` → `RELAY_PROXY_URL` / `FAUCET_PROXY_URL` become absolute when
  `VF_API_BASE` is set at build time (relative paths resolve to `chrome-extension://<id>/api/...`
  and 404). Web app + headless smokes are unchanged (env unset → relative / `VF_RELAY_URL`).
- `extension/ceremony.js` → faucet fetch uses `FAUCET_PROXY_URL` instead of the hardcoded relative
  `/api/faucet`.

---

## All-local run (fastest)

### 1. Build the extension pointed at the local backend

```powershell
cd frontend
$env:VF_API_BASE='http://localhost:5173'   # baked into the bundle
npm run build:ext
# -> extension-dist/ : manifest.json, popup.html/js, ceremony.html/js, background.js, assets/
```

> Deployed variant: `$env:VF_API_BASE='https://<your-app>.pages.dev'`, and replace
> `http://localhost:5173/*` in `manifest.json` host_permissions with that origin.

### 2. Start the backend with funded secrets

`frontend/.dev.vars` (already used for the Gate 1 smoke):

```
STELLAR_RELAYER_SECRET=S...        # funded testnet XLM (pays gas)
VF_FAUCET_SECRET=S...              # treasury funded with testnet Blend USDC
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
SOROBAN_VAULT_ADDRESS=...          # from deployments/stellar-testnet.json
SOROBAN_TOKEN_ADDRESS=...          # Blend USDC SAC
ALLOWED_ORIGIN=                    # set in step 4 (extension id)
```

```powershell
cd frontend
npm run dev          # serves the app + /api/* at http://localhost:5173
```

### 3. Load the unpacked extension

`chrome://extensions` → enable **Developer mode** → **Load unpacked** → select
`frontend/extension-dist`. Note the **ID** Chrome assigns (it's stable for this path).

### 4. Allow the extension origin through CORS, then restart the backend

`_guard.js applyCors` rejects any `Origin` not in the allowlist. The extension's pages send
`Origin: chrome-extension://<id>`. Add it:

```
ALLOWED_ORIGIN=chrome-extension://<id-from-step-3>
```

Restart `npm run dev` (env is read at process start). In dev, localhost origins are still trusted
automatically; this only adds the extension.

> For a stable ID across machines, add a `"key"` to `manifest.json` (Chrome docs:
> "keep a consistent extension ID"). Not needed for a single-machine demo.

### 5. WebAuthn — the actual unknown

`RP_ID` defaults to `localhost` (`src/wallet/config.js`, override `VITE_VF_RP_ID`). A WebAuthn
ceremony requires `rpId` to be a registrable suffix of the **caller origin**. The ceremony tab's
origin is `chrome-extension://<id>`, for which `localhost` is **not** valid → the OS prompt may
never appear and `navigator.credentials` throws a `SecurityError`.

Run the experiment and record the outcome — that *is* the Gate 2 finding:

- **Deterministic (recommended first):** DevTools (F12 on the ceremony tab) → ⋮ → **More tools →
  WebAuthn** → **Enable virtual authenticator environment** → Add: protocol `ctap2`, transport
  `internal`, **Resident keys ON**, **User verification ON**. This makes `navigator.credentials`
  succeed without hardware, isolating the rpId/origin question from the biometric hardware.
- **Real:** Windows 11 Windows Hello (face/fingerprint/PIN). Win11, not "Face-ID".

If the extension origin rejects `rpId=localhost`, rebuild with the extension id as the RP ID and
retry: `$env:VITE_VF_RP_ID='<id>'` (note: WebAuthn support for `chrome-extension://` rpIds is
version-dependent — capture the exact console error if it fails; that error is the deliverable).

### 6. Click through

1. Click the VF Wallet toolbar icon → popup.
2. **Create wallet** → deploys the smart account (RPC + Friendbot). Confirm an account address.
3. **Enable deposits** → ceremony tab opens: faucet dispense (Blend USDC) → approve (WebAuthn) →
   "Deposits enabled."
4. **Deposit** an amount → ceremony tab: WebAuthn → relayed deposit → "Minted N shares."
5. Popup result screen shows the real tx hash + Stellar Expert link + Δshares.

### Expected (success)

Same end state as Gate 1: faucet SUCCESS → approve SUCCESS → deposit relayed SUCCESS → vault
shares increased — but driven by the browser UI + a real (or virtual) WebAuthn ceremony.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Faucet/relay/RPC request fails, `net::ERR_BLOCKED` | host_permissions missing the origin | add it to `manifest.json`, rebuild, reload extension |
| `/api/*` → 404 `chrome-extension://<id>/api/...` | built without `VF_API_BASE` | rebuild with `$env:VF_API_BASE='http://localhost:5173'` |
| `/api/*` → 403 Forbidden | extension origin not in CORS allowlist | add `chrome-extension://<id>` to `ALLOWED_ORIGIN`, restart dev |
| Faucet 503 `configured:false` | `VF_FAUCET_SECRET` unset/unfunded | fund + set in `.dev.vars` |
| Faucet 429 | daily cap hit (300/recipient, 5000 global) | new recipient or wait 24h (resets on dev restart too) |
| Relay rejected | `STELLAR_RELAYER_SECRET` unset/unfunded | fund + set in `.dev.vars` |
| WebAuthn `SecurityError` / no prompt | `rpId` invalid for `chrome-extension://` origin | see step 5 — this is the gate's finding |
| Popup result never updates | background ↔ ceremony message-passing | check the ceremony tab + service-worker consoles (`chrome://extensions` → Inspect views) |
