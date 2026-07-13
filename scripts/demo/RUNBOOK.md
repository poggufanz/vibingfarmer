# /agent Operations Console — Stress-Test Runbook

Drive every console zone with real testnet state and watch it live. All commands from repo
root unless noted. Chain actions use `keeper/.dev.vars` (gitignored).

Your demo address (= `vf-deployer` = `demoAgentOwner`):
`GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS`

---

## 0. One-time setup (already done — skip unless on a fresh clone)

- `keeper/.dev.vars` exists with the public config block (SOROBAN_RPC_URL, NETWORK_PASSPHRASE,
  VAULT_ADDRESS, STRATEGY_1, POOL_1, USDC, BLND, SOROSWAP_ROUTER) **plus** the secret line
  `STELLAR_KEEPER_SECRET=...` copied from `frontend/.env.local`. (Non-secret values live in
  `keeper/wrangler.jsonc`; the secret is the keeper identity `GA2CMBS3…`.)
- Live vault is on the lifeboat wasm (`set_mandate` / `emergency_derisk` / `resume` /
  `lifeboat_state` exist on-chain). Upgraded 2026-07-12 — permanent, don't repeat.
- Mandate authority is set to your address — permanent. Only the **mandate itself** expires
  (24h); renew each session (step 2).

## 1. Start the app + open the console

```bash
cd frontend && npm run dev        # note the port it prints (5173, or 5174 if busy)
```

Open (swap the port if different):
`http://localhost:5174/agent?as=GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS`

`?as=G...` is the dev-only view-as override (DEV builds only — stripped from prod). It opens
the console reading **that address's** on-chain state: positions, mandate, lifeboat.

## 2. Renew the mandate (lifeboat + whale-attack need it live)

Check state:
```bash
node --env-file=keeper/.dev.vars scripts/demo/console-demo.mjs status
```
If `mandate_expiry` is in the past (lifeboat shows DISARMED), renew — either click
**"renew 24h mandate"** in the lifeboat zone (signs with your wallet), or via CLI:
```bash
wsl -e bash -lc 'V=CB5VKYDUIYX3RZWGVLKKNBPG7V7Z5JIHF2QPNQKWKAHVA3IPSLFZJDYU; \
  EXP=$(($(date +%s)+86400)); \
  stellar contract invoke --network testnet --source-account vf-deployer --id $V -- set_mandate --expiry $EXP'
```
Reload the page → lifeboat should show **ARMED** with the radar sweeping.

## 3. Positions zone — deposit (user-signed)

Positions read the view-as address's own vault shares. Deposit as `vf-deployer` (= your
address). 50 USDC = `500000000` base units (7dp). Approve then deposit:
```bash
wsl -e bash -lc 'U=CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU; \
  V=CB5VKYDUIYX3RZWGVLKKNBPG7V7Z5JIHF2QPNQKWKAHVA3IPSLFZJDYU; \
  G=GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS; \
  L=$(curl -s -X POST https://soroban-testnet.stellar.org -H "content-type: application/json" \
     -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getLatestLedger\"}" | grep -o "\"sequence\":[0-9]*" | grep -o "[0-9]*"); \
  stellar contract invoke --network testnet --source-account vf-deployer --id $U -- \
    approve --from $G --spender $V --amount 500000000 --expiration_ledger $((L+100000)); \
  stellar contract invoke --network testnet --source-account vf-deployer --id $V -- \
    deposit --from $G --amount 500000000'
```
Reload → positions shows a card, strip shows the portfolio figure. (Withdraw is the in-app
button, or `redeem --from $G --shares 500000000`.)

## 4. Keeper zone — compound + rebalance (keeper-signed)

```bash
node --env-file=keeper/.dev.vars scripts/demo/console-demo.mjs compound    # dial + pps + last-action row
node --env-file=keeper/.dev.vars scripts/demo/console-demo.mjs rebalance   # swarm edge pulse + rebalanced row
```
Both are picked up by the app's 15s poll — no reload needed. (Compound has a 600s cooldown;
if it says "nothing to harvest," let interest accrue.)

## 5. Monitor + Council zones — seed the loop journal

```bash
node scripts/demo/console-demo.mjs seed-council 40
```
Paste the printed snippet into the browser devtools console on `/agent`, Enter → EKG fills,
council bench/stamp populate, decision log paginates. (Seed mirrors the real pipeline:
gated/idle cycles get no decision record; the EKG trace draws while the loop is running.)

## 6. Lifeboat zone — whale-attack drill

```bash
node --env-file=keeper/.dev.vars scripts/demo/console-demo.mjs whale-attack 2   # ENGAGED (danger)
node --env-file=keeper/.dev.vars scripts/demo/console-demo.mjs all-clear        # back to ARMED
```
`whale-attack [1|2|3]`: 1 utilization spike · 2 liquidity drop / whale drain (default) ·
3 oracle divergence. Watch the lifeboat flip within ~15s.

---

## Quick reference

| Zone | Command | Signs as |
|---|---|---|
| positions / strip | approve + deposit (step 3) | you (vf-deployer) |
| keeper | `compound` / `rebalance` | keeper |
| monitor / council | `seed-council [n]` → devtools paste | localStorage |
| lifeboat | `whale-attack` / `all-clear` | keeper (mandate-gated) |
| mandate | 4+ scopes on chain → pager; renew via `set_mandate` | you |
| swarm | pulses on `rebalance` | — |
| status | `status` | read-only |

`node scripts/demo/console-demo.mjs` with no args prints the same help.
