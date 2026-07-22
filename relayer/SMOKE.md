## Farm smoke — 2026-07-05T17:36:17.437Z
- Stellar burn: fd2c29c37c7019cfac7a0bd44f826482d8eadbdfd4e27d07c846254bf55605f8
- Base mint: 0xcf45174d26777f5a5fed1e3ad1917ff996ab68fa933be4df16cb407e25784506 (minted)
- Deposits: [{"pool":"0x389250872044368759D3db5C09b2706A6628d4e0","status":"fulfilled","value":{"pool":"0x389250872044368759D3db5C09b2706A6628d4e0","userOpHash":"0x4193fd36a1421b0f62fd186d3f68a4bc0065aa9264ec17b7f0246043051fb554","txHash":"0xc56687053f3764c8160ed8c9d685fe6e1219abfb3be2f42afb7ef0f8106538a5"}}]
## Unwind smoke — 2026-07-05T17:57:59.796Z
- Withdraws: [{"status":"fulfilled","value":{"pool":"0x389250872044368759D3db5C09b2706A6628d4e0","userOpHash":"0x1efe87546e9107a9686a3d2d1f69e7c335bf79533fceecbd4a30e10c9368eed6","txHash":"0x59b20fd8a083693181682c7a9ff92567d8d315ba10af156e21437bfdd1eb9393"}}]
- Base burn: 0x29ab855dbc821c13ebb87cbe14cd3aae677cf67c350b394f94461e334bfe9a66
- Stellar mint_and_forward: 0dd1cadfe7cc85fa8826c0915054c03c2324bf4e799715ead3d5530508793a5f (minted)
- Final recipient: GBDQP5E2KCLOBRSI7DHXG7SMD5IQ52DNXYMMQ42DERB3PGQVN6GOJVNZ
## Task 8: router v2 + agent v3 live on testnet (2026-07-22)

Deploy (dual-support — v1 untouched, kept live in `deployments/stellar-testnet.json`):
- `agent_account` v3 wasm (bridge-scope: target/kind/mint_recipient/destination_domain,
  deposit_for_burn enforcement) uploaded — hash `1fdbe175ddeb6d237a178c3c117b4e6c168122eec7d94f06a4b27ee4026efbe1`,
  tx `c8a9bc3b434f4d65e35926dcbe28207ef909d15230c204f94f390f2fb5144451`.
- `funding_router` v2 (multi-token `budgets`, bridge-kind `AgentInit`, per-agent `pull`) deployed
  at `CB675TTSFM6COTGHGB7K2I7IODPQ3HTHOTTTXU2LJHXXNGTS45NOTRSE`, constructor pinned to the hash
  above (verified via `config()` read). Router wasm upload tx
  `fd743a569a27432fbbb26b7488f9a2cac682e357630b7accbfbf8867da739f12`, deploy tx
  `e8e145660c9923ec9433dc5e7906502ee9981977653a5b1907b34f14ead68e18`. Deployer: a fresh
  `vf-deployer` testnet identity generated for this box (this environment's stellar-cli keystore
  did not carry the historical `vf-deployer` secret — deploying a NEW contract does not require
  the historical G-address, only a funded source account).
- `deployments/stellar-testnet.json` updated additively (`fundingRouter.addressV2`,
  `.routerWasmHashV2`, `.agentWasmHashV3New`, `.v2Note`) — every pre-existing key/value untouched.
- `frontend/src/stellar/config.js` (`NETWORKS.testnet.fundingRouter`, `.agentWasmHash`) now
  point at v2 / the new agent hash — this is the app's live router as of this deploy.
- Relay dual-support env (worktree-only `frontend/.env.local` + `frontend/.dev.vars`, gitignored):
  `SOROBAN_ROUTER_ADDRESSES=<v2>,<v1>`, `SOROBAN_AGENT_WASM_HASHES=<v3new>,<old d61ceaaa hash>`,
  `SOROBAN_TOKEN_MESSENGER_ADDRESS=CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP`.
  `frontend/vite.config.js` gained the passthrough lines for these three (the existing allowlist
  only forwarded the singular `SOROBAN_ROUTER_ADDRESS` to `process.env` under `vite dev`; Cloudflare
  Pages' `_pagesAdapter.js` already forwards every `context.env` key unconditionally, so production
  needs no code change — only the dashboard/`.dev.vars` values below).
- **Production follow-up (out of this environment's reach):** set the same three keys — plus the
  new `fundingRouter` address if the Cloudflare Pages dashboard pins `SOROBAN_ROUTER_ADDRESS`
  anywhere client-visible — as encrypted env vars for the deployed Pages Functions
  (`wrangler pages secret put SOROBAN_ROUTER_ADDRESSES` etc., or the dashboard UI). This repo
  cannot reach that dashboard; flagged as a user follow-up.
- **Known open item (dev tooling, not touched):** `frontend/scripts/smoke-grant.mjs` and
  `frontend/scripts/exit-router-smoke.mjs` still call `grant.js`'s v1 shape
  (`submitGrant({budgetBaseUnits, agentInits:[{vault,...}]})` /
  `agentInitScVal({vault,...})`) — broken since Task 5 replaced that shape with v2's
  `{budgets, agentInits:[{target,kind,mintRecipient,destinationDomain,...}]}`. Both are dev-only
  scripts (not part of `npm test`, not imported by production code). `relayer/smoke/grant-burn-
  e2e.mjs` below supersedes `smoke-grant.mjs`'s coverage (single-signature grant -> relayed pull
  -> relayed deposit) and additionally proves the multi-token/bridge-agent v2 shape end to end;
  neither old script was rewritten in this task per the brief.
- **Gates:** `cargo +1.91.0 test -p agent_account -p funding_router` 35+24 passed; `cargo +1.91.0
  clippy -p agent_account -p funding_router --all-targets -- -D warnings` clean; `cd frontend &&
  npm test` 193 files / 1296 tests passed; `npm run build` + postbuild guard passed; `cd relayer &&
  npm test` 17 files / 91 tests passed (import-safety test included, no isolated re-run needed —
  it passed first try under the full suite).

## Grant-burn e2e smoke — 2026-07-21T17:42:45.394Z
- Owner (Stellar): GBDQP5E2KCLOBRSI7DHXG7SMD5IQ52DNXYMMQ42DERB3PGQVN6GOJVNZ
- Router v2: CB675TTSFM6COTGHGB7K2I7IODPQ3HTHOTTTXU2LJHXXNGTS45NOTRSE
- Deposit agent: CAMY52BZ5BKTXEQLEQKO7YLGSHVUJJ5WNWOAI4FYVCUJA3A6PEJHQFU2
- Bridge agent: CACZEOKBX3HK7YHQ5BN6BVQEJ767UVSDCKKFVF6FZUHXNHVZEG3B3DOP
- Grant tx (1 signature): d5a9f6ea7b2d129358b9523d8350f86e253c279afa960f50a977c50b47b0f61b
- Pull tx (relayed): 397cbdb832efc9b8a83a29aba531991d7adb26660a43fe846a0058a7aa67cc79
- Burn tx (relayed deposit_for_burn): 67f46837c04d05443f37d4f0a6391bbc5aa2fd4ca4e37fc1d29eda76f7dd4497
- Base smart account (mint recipient): 0x34a3d1c79aD4b3030f5C3c264774D3869f16034F
- Relayer job: 1f71b991-b0c8-4d07-99ee-4f2ce745c76b
- Base mint tx: 0x250262618e7d0eff108403646af9e1ea7a5efc0deaf61342f60d71e40f9c6bf3
- Base pool deposit tx: 0x972225e731d67d8f13e63a973adacc2b96bd546cf3beca70714bae5802d4a5ff (pool 0x389250872044368759D3db5C09b2706A6628d4e0)
- Wall clock: 61.2s
