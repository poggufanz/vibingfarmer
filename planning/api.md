# VF API Gateway — One Key, All Services — Scope for AI Agent

> **Handoff doc.** Replace "wallet needs many API keys (OpenAI, Tavily, DeFiLlama, price, RPC…)"
> with **ONE VF API key**. VF's server holds all upstream secrets and proxies requests. The wallet
> (and third-party devs) authenticate with a single scoped VF key — never see upstream keys.
> **Precedent:** Fradium API Developer (single-key auth). **Matches:** VF "one brain" API + revenue model.
> **Timing:** post-hackathon backend/infra. Does NOT block 15 Jul submission.

---

## 0. Concept

```
Wallet / dev app  ──[ Authorization: Bearer vf_live_xxx ]──►  VF API Gateway (server)
                                                                  │ holds real secrets server-side:
                                                                  ├─► OpenAI-compatible LLM (AI strategist)
                                                                  ├─► Tavily (market context)
                                                                  ├─► DeFiLlama (APY / TVL / revenue)
                                                                  ├─► price feed (USD values)
                                                                  ├─► Soroban RPC
                                                                  └─► fee-bump relayer (deposit only)
```

- **One credential** (`vf_...` key) unlocks all wallet/agent features.
- Upstream provider keys live ONLY on the server, behind the gateway. Never in the client bundle.
- The gateway keeps the existing non-custodial rule: it returns analysis + UNSIGNED tx only; it
  never receives a user secret and never signs for the user.

---

## 1. Goal

1. VF issues a scoped API key (`vf_test_...` / `vf_live_...`).
2. The wallet + any third-party dev calls VF endpoints with just that key.
3. The gateway authenticates the key, enforces rate limits + usage metering, then proxies to the
   correct upstream (LLM / Tavily / DeFiLlama / price / RPC) using server-held secrets.
4. Keys can be issued, scoped, rate-limited, rotated, and revoked.

---

## 2. In scope / Out of scope

**In scope:**
- Gateway service: single-key auth, per-key rate limit + usage metering, upstream routing.
- Endpoints that bundle current multi-service calls behind VF paths (see §4).
- API key lifecycle: issue / list / rotate / revoke (server-side store, hashed keys).
- Upstream secret vault (server env only) for OpenAI, Tavily, DeFiLlama, price, RPC, relayer.
- Client change: wallet uses one `VF_API_KEY` instead of many provider keys.

**Out of scope (later):**
- Public developer portal / self-serve signup UI (issue keys manually first).
- On-chain metered billing / token-gated access (Fradium-style) — design later.
- Multi-tenant orgs, per-endpoint pricing tiers.

---

## 3. Security requirements (NON-NEGOTIABLE)

1. **Upstream secrets server-only.** OpenAI/Tavily/etc. keys live in server env / secret store,
   NEVER shipped to the client, NEVER returned in any response.
2. **VF API keys hashed at rest.** Store only a hash (e.g. SHA-256) of each `vf_...` key; compare
   on auth. Show the plaintext key once at issuance.
3. **Scoped keys.** Each key has: allowed endpoints/scopes, rate limit, expiry, enabled flag.
   Reject out-of-scope calls.
4. **Rate limit + abuse guard** per key (reuse existing `_guard.js` origin/rate-limit pattern),
   plus a global upstream budget cap so a leaked key can't drain provider quota.
5. **Non-custodial preserved.** Gateway returns analysis + UNSIGNED tx only. No user secret ever
   passes through it. Signing stays on-device; relayer only fee-bumps deposits.
6. **No secret in logs.** Never log the VF key or upstream keys; log a key *id* + usage only.

---

## 4. Endpoints (bundle current multi-service calls)

All under `/api/vf/*`, auth `Authorization: Bearer vf_...`.

| Endpoint | Bundles (upstream) | Returns |
|----------|--------------------|---------|
| `POST /api/vf/strategy` | LLM + Tavily + DeFiLlama | allocation plan + reasoning (AI Council) |
| `POST /api/vf/eligibility` | DeFiLlama + snapshot | F8 verdict (yield-real? security score) |
| `GET  /api/vf/vault-facts` | DeFiLlama | vault facts (APY, TVL, revenue, utilization) |
| `GET  /api/vf/prices` | price feed | USD prices for portfolio value |
| `POST /api/vf/build-tx` | RPC (build only) | UNSIGNED XDR (deposit/send/approve) |
| `POST /api/vf/simulate` | RPC | sim result (shares out, balance delta) |
| `POST /api/vf/submit` | relayer | fee-bump + submit (deposit-only relay) |
| `POST /api/vf/scan` | risk engine (F8/riskAgent) | address/vault risk verdict (scan-before-send) |

Existing modules (`vfapi/client.js`, `strategy/*`, `stellar/relay.js`) become the gateway's
internal callers — the endpoints wrap them + add key-auth + metering.

---

## 5. Tasks (ordered)

### T1 — API key store + auth middleware (TDD)
- `api/keys/store.js` — issue(`{scopes, rateLimit, expiry}`) → `{ id, plaintextKeyOnce }` +
  save `{ id, hash, scopes, rateLimit, expiry, enabled }`; `verify(key)`; `revoke(id)`; `list()`.
- `api/_auth.js` — Bearer middleware: hash incoming key → lookup → check enabled/expiry/scope →
  attach `{ keyId, scopes }` or 401/403.
- Unit tests: valid/invalid/expired/revoked/out-of-scope, hash-not-plaintext stored.

### T2 — Upstream secret config + provider clients
- `api/upstream/*.js` — thin server clients for LLM, Tavily, DeFiLlama, price, RPC. Read secrets
  from server env (`OPENAI_API_KEY`, `TAVILY_API_KEY`, …). 503 `{configured:false}` if unset.
- Never expose these to client; never include in responses.

### T3 — Gateway endpoints (§4)
- Implement each `/api/vf/*` route: `_auth` → rate-limit/meter → call internal module/upstream →
  return. Reuse existing `strategy/*` + `vfapi` + `relay` logic.
- `assertVaultDeposit` stays on `/submit` (relay deposit-only).

### T4 — Usage metering + rate limit
- `api/keys/meter.js` — per-key request counter (window + total), enforce `rateLimit`, record
  usage for later billing. Global upstream budget cap.

### T5 — Client swap (wallet)
- Replace scattered provider calls in the wallet with a single `vfClient` that sends
  `Authorization: Bearer ${VF_API_KEY}` to `/api/vf/*`. Remove any upstream keys from client env.
- One env var: `VITE_VF_API_KEY` (test key for the wallet build).

### T6 — Admin issue/rotate script
- `scripts/vf-keys.mjs` — CLI to issue/list/rotate/revoke keys (manual until a portal exists).

### T7 — Tests + smoke
- Unit: T1 auth/scope/expiry, T4 rate-limit trips, endpoint returns no upstream secret.
- Smoke: issue a test key → call `/api/vf/eligibility` + `/api/vf/prices` with it → 200; call with
  bad key → 401; exceed rate limit → 429.

---

## 6. Acceptance criteria

- [ ] One `vf_...` key authenticates all wallet features; wallet ships with NO upstream provider keys.
- [ ] Upstream secrets never appear in any client bundle, response, or log.
- [ ] Keys are hashed at rest; plaintext shown once at issuance.
- [ ] Out-of-scope / expired / revoked keys are rejected (403/401).
- [ ] Rate limit + global upstream budget enforced (429 on exceed).
- [ ] `/api/vf/*` endpoints return correct data by proxying upstreams; `/submit` stays deposit-only.
- [ ] Non-custodial preserved: no user secret passes through the gateway; signing stays on-device.
- [ ] Existing wallet + relay paths still work; prior tests green.

---

## 7. Honest notes (agent + pitch)

- This is the **secure** pattern: it *removes* upstream keys from the client, tightening the
  server-only-secret rule you already follow.
- **Revenue angle** (matches VF revenue model): the VF API key can later be metered/tiered or
  token-gated (Fradium-style) — issue-manually now, monetize later.
- **Composability story** for pitch: "VF is not just an app — one API key gives any wallet or dApp
  protective yield + risk scanning + gasless deposit." Same framing as Fradium API / OHMS.
- Testnet/dev-grade until audit. Do not enable mainnet upstreams with real funds in this scope.