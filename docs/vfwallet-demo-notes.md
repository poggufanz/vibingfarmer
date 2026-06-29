# VF Wallet — Demo Notes

**Branch:** `feature/wallet` | **Task:** M6 packaging (Task 15, final)

---

## Demo path

1. **Open extension popup** — welcome screen appears; honesty labels #3 + #4 shown.
2. **Create** — click "Create new wallet (Face ID)".  
   - `createPasskeyWallet()` deploys a SAK smart-account on Stellar testnet and Friendbot-funds it.  
   - Face-ID ceremony runs in the **extension tab** (background SW opens `ceremony.html`).
3. **Home** — wallet C-address and USDC balance shown; copy-address button.
4. **Send** — enter recipient + amount → "Approve with Face ID" → builds unsigned XDR → SIGN_REQUEST posted to background SW → popup shows honest pending state (`signing in ceremony tab…`).
5. **Deposit** — enter USDC amount → "Check eligibility" → F8 gate runs (app-layer) → `ApproveOverlay` shows verdict (eligible / not eligible + reasons) — "Approve with Face ID" is **disabled until eligible**; on approve → `depositToVault` builds unsigned XDR → SIGN_REQUEST posted.
6. **Recovery** — enter a G-address recovery key → `addRecoverySigner` called; honesty label #2 shown.
7. **Agent** — enter agent G-address + cap → `addAgentSigner` called (7-day expiry, vault-restricted).
8. **Activity** — link to Stellar Expert (testnet) for on-chain history.

---

## Milestone proof status

| Milestone | Status | Notes |
|-----------|--------|-------|
| M0a — SAK account wiring | sim-verified | `connectPasskeyWallet` / `makeKit` wired to SAK 0.2.10 bindings |
| M0b — secp256r1 verifier | sim-verified (ABI-confirmed) | webauthn-verifier address in `stellar-testnet.json` |
| M2 — balance read | headless ABI-confirmed | `readBalance` → Horizon API |
| M3 — send XDR build | headless ABI-confirmed | `sendToken` returns unsigned `{ xdr }` |
| M4 — agent ed25519 co-signer | unit-proven (smoke green) | `addAgentSigner` wired; on-chain `--submit` pending demo batch |
| M5 — recovery signer | unit-proven (smoke green) | `addRecoverySigner` wired; on-chain `--submit` pending demo batch |
| M6 — extension packaging | this task | popup wired, build green, 403 tests pass |

**Signed on-chain submit** (send, deposit) is deferred to a user-greenlit testnet batch. The popup builds the unsigned XDR and triggers the ceremony; it does not fake a `{ status: 'SUCCESS' }` response.

---

## Honesty labels (verbatim, per project policy)

1. **F8 eligibility is app-layer only** — not enforced on-chain (off-chain check, fail-closed). *(deposit screen)*
2. **Recovery key is VF-custodied** — a centralisation trade-off; guard this key carefully. *(recovery screen)*
3. **Everything here is testnet-grade only** — do not use real funds. *(welcome + home footer)*
4. **Passkey-on-Stellar is mainnet-live at the protocol layer, but these wallet contracts are testnet PoC-grade.** *(welcome + home footer)*

---

## Manual gate (user, not CI)

Load `extension-dist/` as an unpacked Chrome 122+ extension:  
`chrome://extensions` → "Load unpacked" → select `frontend/extension-dist/`.  
Walk the demo path above and verify each screen renders without console errors.
