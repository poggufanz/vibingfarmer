# Approach C — SP3 End-to-End Gate

Filled in with real results after running `frontend/scripts/smoke-mandate.mjs` (Task 3.7) and one
full manual walk (login → mandate → farm → withdraw) against Base Sepolia + Stellar Testnet.
Mirrors the `spikes/SP0-GATE.md` / `RESULT.md` recording convention already used in this repo —
this file is a template until a real run fills it in, not a permanently-empty placeholder.

## Automated smoke (`smoke-mandate.mjs`)

| Scenario | Result | Evidence (tx hash / userOp hash) |
|---|---|---|
| Onboard (Stellar + Base passkeys via virtual authenticator) | _(fill in)_ | |
| Mandate created (per-pool cap + expiry) | _(fill in)_ | |
| In-policy deposit executes | _(fill in)_ | |
| Wrong selector (sweep-equivalent) rejected | _(fill in)_ | |
| Wrong target rejected | _(fill in)_ | |
| **Over-cap rejected (NEW vs. SP0)** | _(fill in)_ | |
| **Expired mandate rejected (NEW vs. SP0)** | SKIP until a separately-issued expired approval is wired into `window.__vfDevMandateFixture.expired` — a skip here is NOT proof of rejection, see `frontend/scripts/smoke-mandate.mjs` | |

## Manual walk (real device passkey, real Face-ID/Windows-Hello/security key)

1. Login (email/Google) → register device passkey → both wallets provisioned. Stellar address: `___`. Base address: `___`.
2. Mandate: one passkey approval, pools `___`, caps `___`, expiry `___`.
3. Farm: amount `___` USDC → Stellar burn tx `___` → Base mint (relayer) → per-pool deposit tx hashes `___`.
4. Withdraw: one passkey approval → unwind tx `___` → Base burn-with-hook tx `___` → Stellar reverse mint tx `___`.
5. Final USDC balance at the Stellar address matches the deposited amount minus any realized yield/slippage: `___`.

## Verdict

GATE SP3: **PASS / FAIL** _(fill in)_
