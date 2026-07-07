# Approach C — Deploy Checklist (SP3 additions)

Testnet (Base Sepolia + Stellar Testnet) checklist for the wallet/mandate/farm/withdraw flows
this plan ships. Existing Stellar-only checklist items (Cloudflare env vars, relayer secret) are
unchanged — see CLAUDE.md's Environment Variables section. This file adds ONLY the Base leg.

## 1. ZeroDev dashboard (Base Sepolia project)

- [ ] Create (or reuse) a ZeroDev project for Base Sepolia. Copy the **Project ID** into
      `VITE_ZERODEV_PROJECT_ID`.
- [ ] **Configure a gas-sponsorship policy for this chain.** This is the SP0 gotcha
      (`spikes/SP0-GATE.md`): without an explicit sponsorship policy in the dashboard, the
      paymaster 400s with `"no gas sponsoring policy"` even though the RPC/project ID are
      otherwise correct. Dashboard → Paymaster → Base Sepolia → add a policy (start permissive
      for testnet: sponsor all userOps from this project).
- [ ] Set up the **Passkey** feature for this project and copy the passkey server URL into
      `VITE_ZERODEV_PASSKEY_SERVER_URL`. Confirm the paired `PasskeyValidatorContractVersion`
      for Kernel v3.1 in the dashboard's compatibility notes. NOTE (resolved 2026-07-06): the
      installed `@zerodev/passkey-validator` exposes only `V0_0_1_UNPATCHED`, `V0_0_2_UNPATCHED`,
      and `V0_0_3_PATCHED`; `wallet/passkeyBase.js` pins `V0_0_3_PATCHED` (the only patched
      option). Re-verify against the deployed Kernel v3.1 factory before the first live run.
- [ ] Restrict the project's allowed origins to your deployed domain(s) (defense in depth — the
      project ID is designed to be client-embeddable, but origin restriction costs nothing).

## 2. Base contracts (SP1 dependency)

- [ ] Confirm `base-contracts/` (SP1) is deployed to Base Sepolia and `deployments/base-sepolia.json`
      has a `YieldRouter` address.
- [ ] Set `VITE_YIELD_ROUTER_ADDRESS` to that address.
- [ ] Confirm the whitelisted pool addresses (`setPool(pool, true)` calls from SP1 Task 1.6) and
      set `VITE_BASE_POOL_1_ADDRESS` / `_2_` / `_3_` accordingly. These MUST be the exact pools
      `YieldRouter.allowedPool` whitelists on-chain — `frontend/src/config.js`'s
      `BASE_POOL_CATALOG` and `wallet/mandate.js`'s per-pool policy both trust this list; a
      mismatch means the mandate scopes a pool the router itself will reject (deposit reverts,
      not a security hole, but a broken demo).

## 3. Relayer (SP2 dependency)

- [ ] Confirm SP2's relayer exposes `POST /api/vf-cross/farm`, `GET /api/vf-cross/status/:jobId`,
      `POST /api/vf-cross/unwind` (or update `VITE_CROSS_RELAYER_BASE` / `frontend/src/base/
      relayerClient.js` if SP2 landed a different path — see that file's `// VERIFY:`).
- [ ] Confirm the relayer holds the session private key `wallet/mandate.js` hands off, in its own
      secure store (never in frontend code, never logged).

## 4. Env vars (`.env.local`, Vite dev — gitignored)

```bash
VITE_ZERODEV_PROJECT_ID=
VITE_ZERODEV_PASSKEY_SERVER_URL=
VITE_BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
VITE_YIELD_ROUTER_ADDRESS=
VITE_BASE_POOL_1_ADDRESS=
VITE_BASE_POOL_2_ADDRESS=
VITE_BASE_POOL_3_ADDRESS=
VITE_CROSS_RELAYER_BASE=
```

## 5. Smoke before demo

- [ ] Run `cd frontend && npm test` — full suite green.
- [ ] Run the Task 3.7 smoke (`frontend/scripts/smoke-mandate.mjs`) against the REAL deployed
      `YieldRouter` and record tx hashes in `docs/gate-approach-c-e2e.md`.
- [ ] Manually walk login → mandate → farm → withdraw once in a real browser (passkey ceremonies
      cannot be fully scripted — see Task 3.7).
