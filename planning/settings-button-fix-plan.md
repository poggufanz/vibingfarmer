# Plan: Fix Non-Working Settings Buttons

**Scope:** `frontend/src/components/SettingsPage.jsx` + wiring in `frontend/src/app.jsx`
**Status:** draft
**Owner:** dev-iq

---

## Root-cause finding (from code trace, not guessing)

All parent callbacks ARE wired correctly (`app.jsx:1080-1100`). Handlers are real
(`handleConnect`, `handleSwitchNetwork`, `handleRevoke`, etc.). SkillDrawer mounts.
So "buttons don't work" is **NOT** an unwired-prop problem. Three real causes:

### Cause A — Buttons genuinely broken (functional bug)
| Button | File:line | Why it fails |
|--------|-----------|--------------|
| **Test connection — Venice** | `SettingsPage.jsx:119` `testVenice` | Direct browser `fetch('https://api.venice.ai/.../models')`. Venice sends no CORS headers → browser blocks → always lands in `catch` → shows "⚠ unreachable". Never "✓ connected". |
| **Test connection — Tavily** | `SettingsPage.jsx:134` `testTavily` | Same. Browser `POST https://api.tavily.com/search` → CORS block → always "unreachable". Also leaks Tavily key into a cross-origin request from the client. |

These are the only two buttons that are wired but architecturally cannot succeed
from the browser. Fix = route through a server proxy (the repo already does this for
DeepSeek via `frontend/api/ai.js`).

### Cause B — State desync makes a control LOOK dead (model preference)
- `settingsStore.js:19` default `modelPreference: 'flash'`; key comment says `'flash' | 'pro' | 'venice'`.
- `SettingsPage.jsx:225-226` radios only offer `'auto'` and `'venice'`.
- On first load stored value is `'flash'` → **neither radio is highlighted**. User clicks
  "Auto", it highlights, but the orphaned `'flash'`/`'pro'` legacy value and the missing
  `'auto'` default read as "this control is broken / doesn't remember."

### Cause C — Wallet buttons give NO visible feedback (feels dead)
`handleSwitchNetwork` (`app.jsx:905`), `handleRevoke` (`app.jsx:890`),
`handleDisconnect` (`app.jsx:900`) only write to `addLog(...)`. On success or failure
there is no toast, no inline state change on the button itself. Without MetaMask Flask
connected, `switchToSepolia()` throws, gets swallowed into a log line the user never sees
→ "I clicked, nothing happened." Same class for **Revoke all** (only flips local
`permActive`, no on-chain call, no confirmation UI).

---

## Phase 0 — Runtime click-audit (confirm the full list)
Before coding, enumerate EVERY settings button at runtime so nothing is missed.
1. `cd frontend && npm run dev`.
2. Playwright click-through of all Settings controls, both states: wallet-disconnected
   and wallet-connected (Flask).
3. Record per button: visible effect? localStorage write? console error?
4. Produce `planning/settings-audit-results.md` checklist.

**Exit:** confirmed table of {button → pass/fail → cause}. Adjust phases below if audit
surfaces buttons beyond A/B/C.

## Phase 1 — Fix Test-connection buttons (Cause A)
1. Add server proxy routes mirroring `api/ai.js`:
   - `frontend/api/test-venice.js` → server-side GET `venice.ai/.../models` with key, return `{ ok }`.
   - `frontend/api/test-tavily.js` → server-side POST `tavily.com/search`, return `{ ok }`.
   - Wire both into `vite.config.js` dev middleware (same pattern as `aiProxy`).
   - Register `maxDuration` in `vercel.json` `functions`.
2. Repoint `testVenice` / `testTavily` in `SettingsPage.jsx` to `fetch('/api/test-venice')` etc.
3. Keep the 8s `withTimeout`. Map states: `ok` / `fail` (bad key) / `unreachable` (proxy down).
4. **Security:** key for the test stays client-entered (user's own key, localStorage) — pass
   it in the request body to the proxy over same-origin; do NOT log it server-side.

## Phase 2 — Fix model-preference desync (Cause B)
Pick ONE (recommend option 1):
1. Align UI to store: change `SETTINGS_DEFAULTS.modelPreference` to `'auto'`, update key
   comment to `'auto' | 'venice'`, add a one-time migration in `loadSettings()` mapping
   legacy `'flash'`/`'pro'` → `'auto'`.
2. OR align store to UI only (no migration) — leaves orphaned legacy values; weaker.
- Verify the selected radio highlights on reload.

## Phase 3 — Add feedback to wallet buttons (Cause C)
1. Switch network / Revoke / Disconnect: add inline button state (e.g. `Switching…`,
   `✓ Sepolia`, `✗ failed — open Flask`) using local `useState`, same pattern as the
   existing `copied` / `test` states.
2. Surface `handleSwitchNetwork` catch to the UI, not just `addLog`.
3. **Revoke all** decision: confirm whether it should make an on-chain
   `revokeAgentPermission` call or stay local-only. If demo-only, relabel to
   "Clear local permission" so it is not misread as on-chain revoke. (Needs product call.)
4. Disabled-when-no-wallet: grey out Switch/Revoke when `!userAddress` so a dead click
   is impossible.

## Phase 4 — Minor / polish
- **GitHub button** (`SettingsPage.jsx:350`): hidden entirely when `VITE_GITHUB_URL`
  unset. Either set the env var or always render with the repo URL fallback.
- Sweep every remaining `onClick` for missing visible feedback.

## Phase 5 — Verify
- Playwright: click every Settings button, assert visible effect or localStorage mutation.
- Manual: with Flask connected — switch network, revoke, disconnect, test both keys.
- `npm run build` green; smoke-test on a Vercel preview deploy (Test buttons need the
  serverless functions live, won't fully work on static-only).

---

## Open questions (need user decision)
1. **Revoke all** — on-chain call or local-only for the demo?
2. Keep Venice/Tavily **Test connection** at all? They need 2 extra serverless functions.
   Alternative: drop the test buttons, validate the key lazily on first real use.
3. Set `VITE_GITHUB_URL` now, or hardcode the repo URL?
