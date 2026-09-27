# Analisis Gap DeFi Vibing Farmer — 2026-09-12

> Bahasa: Bahasa Indonesia. Semua klaim diverifikasi di kode repo (bukan dari klaim docs) dan/atau sumber primer resmi. Setiap klaim mencantumkan sitasinya.

---

## 1. Ringkasan eksekutif

Vibing Farmer adalah **vault/aggregator layer di atas Blend Capital v2 (supply-only, tanpa borrow)** dengan diferensiasi kuat di sisi otorisasi: **grant satu-signature** (`funding_router`), **agen ter-scoped** (`agent_account`), **fee-bump relay allowlist**, **keeper compound**, **lifeboat derisk**, dan **council + eligibility gate F8**. Dari sisi protokol/eksekusi, fondasinya production-grade untuk hackathon/testnet: timelock upgrade + multisig 2-of-3 vault, dead-shares guard, quarantine strategi, revoke kill-switch.

Gap terbesar ada di sisi **aplikasi DeFi standar yang dilihat juri/user**: **tidak ada PnL/earned** (disengaja `unavailable` di kode), **tidak ada APY real-time + histori on-chain** (fetch APR strategi sempat dihapus dari poll utama), **panel risiko user-facing minim** (risiko backstop/oracle/admin ala checklist Blend tidak ditampilkan saat deposit), **visibilitas allowance/expiry tidak persisten**, **riwayat tx terfragmentasi**, dan **belum ada audit pihak ketiga** (disclaimer sudah jujur menuliskannya).

**Rekomendasi P0 (sebelum dinilai/demokan ke juri):** (1) kartu PnL jujur dari riwayat PPS + principal user, (2) APY live dari Blend + grafik histori PPS on-chain, (3) widget sisa allowance + expiry yang selalu terlihat. Semuanya bisa dibangun dari data on-chain yang *sudah ada* — tidak butuh kontrak baru.

---

## 2. Metodologi + sumber

### 2.1 Metode

1. Baca file wajib repo: `prd.md`, `FEATURES.md`, `deployments/stellar-testnet.json`, `soroban/contracts/` (`funding_router`, `autofarm_vault`, `blend_strategy`), `frontend/src/` (`orchestrator/`, `strategy/`, `stellar/`, `money/`, `history/`), `frontend/api/stellar-relay.js`.
2. Verifikasi tiap fitur dengan `grep`/`read` ke simbol/fungsi aktual — klaim tanpa bukti kode ditolak.
3. Bandingkan dengan checklist aplikasi DeFi standar dari sumber primer resmi (Blend, Stellar/Soroban, Circle CCTP).
4. Tiap gap diberi: bukti ada/tidak (path + simbol), dampak user/juri, prioritas P0/P1/P2, rekomendasi konkret (file yang disentuh).

### 2.2 Sumber primer

**Repo (kode = kebenaran utama):**

- `prd.md` — PRD, arsitektur, tabel deployment
- `FEATURES.md` — feature guide (§3.4–3.9, §6–§7 dipakai sebagai peta, diverifikasi ulang ke kode)
- `deployments/stellar-testnet.json` — alamat live: router V2 `CB675TTS…NOTRSE`, vault `CDWHNHIH…YYKM77`, strategy `CAR7XFFR…TAFVBE`, pool Blend `CCEBVDYM…HPQ44HGF`, USDC `CAQCFVLO…SRCJU`, admin multisig `GDYIPNML…XZUQ`
- `soroban/contracts/funding_router/src/lib.rs` — `grant`, `pull`, `grant_v3`/`pull_v3`, event `Grant`/`Deployed`/`Pulled`
- `soroban/contracts/autofarm_vault/src/vault.rs` — `deposit`, `redeem`, `compound`, `rebalance`, `emergency_derisk`, `quarantine_strategy`, `price_per_share`, `total_assets`, `DEAD_SHARES`, timelock (`schedule_upgrade`/`execute_upgrade`/`cancel_upgrade`)
- `soroban/contracts/blend_strategy/src/lib.rs` — `deposit` (supply), `withdraw` (finite), `balance` (live NAV), `harvest` (BLND claim + swap)
- `frontend/src/orchestrator/orchestrator.js` + `frontend/src/orchestrator/worker.js` — dispatch, `verifyMinted`, token eligibility
- `frontend/src/stellar/grant.js` — satu-signature grant, `AGENT_KIND_DEPOSIT`/`AGENT_KIND_BRIDGE`, `SECONDS_PER_LEDGER = 5`
- `frontend/src/stellar/partialWithdraw.js` — `ensureExitSigner`, `partialWithdraw`, `sharesForAmount`
- `frontend/src/agents/agentController.js` — `withdrawFromVault`, `withdrawAllFromVault` (sweep satu tanda tangan)
- `frontend/api/stellar-relay.js` — `assertRelayableTransaction`, `loadStellarRelayConfig`, `FEE_MARGIN`
- `frontend/src/strategy/eligibilityGate.js`, `gates.js`, `council.js`, `councilLoop.js` — gate F8 + dewan
- `frontend/src/store/positionsStore.js` — `reconcilePositionsFromChain`, `mergePositions`, `applyChainPositions`
- `frontend/src/money/readOwnerMoney.js` + `frontend/src/components/money/MoneyHero.jsx` — model uang, status `earned`/`yield`
- `frontend/src/history/apyHistory.js`, `frontend/src/cache/getOrCreate.js` — histori APY
- `frontend/src/wallet/history.js`, `frontend/src/base/baseHistory.js`, `frontend/src/screens/HistoryPanel.jsx`, `frontend/src/components/NotificationCenter.jsx`, `AlertCard.jsx` — riwayat + notifikasi
- `frontend/src/wallet/faucet.js`, `frontend/api/faucet.js`, `frontend/src/wallet/trustline.js` — UX dana testnet
- `frontend/src/strategy/ProtectStage.jsx`, `frontend/src/components/money/AgentTeam.jsx` — visibilitas allowance/expiry
- `frontend/src/screens/ExplorerPage.jsx`, `ReplayPage.jsx`, `frontend/src/app.jsx` — disclaimer

**Docs resmi (pembanding):**

- Blend Capital: https://docs.blend.capital/ (index), https://docs.blend.capital/users/choosing-pools.md (checklist memilih pool: backstop, collateral, risk params, oracle, admin), https://docs.blend.capital/users/lending-borrowing/lending.md (bunga = borrowing rate × utilisasi; withdraw butuh likuiditas pool + good standing; BLND emissions), https://docs.blend.capital/users.md
- Stellar/Soroban: https://developers.stellar.org/docs/learn/fundamentals/contract-development/overview (wasm hash, instance, storage), https://developers.stellar.org/docs/learn/fundamentals/contract-development/storage/state-archival.md (TTL, persistent/instance/temporary, restore)
- Circle CCTP: https://developers.circle.com/cctp (deposit_for_burn + atestasi Iris — dirujuk sebagai standar; isi flow dikonfirmasi dari `prd.md` §7 dan `frontend/src/stellar/cctpBurn.js`)
- ZeroDev: https://docs.zerodev.app (dirujuk `prd.md` §7 untuk session key Base; kaki Base bukan fokus gap)

> Catatan keterbatasan: web-search egress gagal (semua provider diblokir), sehingga pembanding primer diambil via `read` langsung ke URL docs resmi di atas. Tidak ada klaim docs yang dipakai tanpa URL yang berhasil dibaca, kecuali CCTP yang dinyatakan eksplisit sebagai rujukan `prd.md` + kode.

---

## 3. Fitur saat ini (dengan sitasi kode)

### 3.1 Deposit / pull / grant satu-signature — ADA

- Kontrak: `grant(owner, budgets, expiry_ledger, agents)` + `pull(agent, amount)` di `soroban/contracts/funding_router/src/lib.rs` (`__constructor` pin wasm hash, validasi budgets/agents, nested `token.approve` per budget, deploy `agent_account` via `deploy_v2` dengan salt owner-bound, event `Grant`/`Deployed`/`Pulled`).
- Budget + expiry = **native SEP-41 allowance** (`token.approve(owner, router, budget, expiry_ledger)`), bukan janji UI — komentar modul lib.rs baris 1–13 dan `FEATURES.md` §3.4.
- V3 reusable grant (`grant_v3`/`pull_v3`, `PermissionGrantV3`, event `GrantedV3`/`PulledV3`) ada di source yang sama.
- Klien: `frontend/src/stellar/grant.js` (header menjelaskan single-envelope auth tree; `SECONDS_PER_LEDGER = 5`, `AUTH_TTL_LEDGERS = 360`, `AGENT_KIND_DEPOSIT`/`AGENT_KIND_BRIDGE`).
- Orkestrasi: `frontend/src/orchestrator/orchestrator.js` (reuse agent bila scope + allowance masih cukup → 0 signature repeat run).
- Bukti live: `deployments/stellar-testnet.json` → `fundingRouter.smokeTxs.{grant,pull,deposit}` + router V2 `CB675TTS…NOTRSE`.

### 3.2 Supply Blend v2 — ADA

- `soroban/contracts/blend_strategy/src/lib.rs`: `deposit` (transfer_from vault → `blend::supply`), `withdraw` (finite, clamp ke live position — anti-overflow `b_rate`), `balance` (live NAV `floor(b_tokens*b_rate/1e12)`, fail-closed), `harvest` (drain finite + `try_claim` BLND best-effort + swap Soroswap dengan `min_out`/`deadline`, re-supply principal, forward yield).
- Pool live: `CCEBVDYM…HPQ44HGF`, USDC `CAQCFVLO…SRCJU` (`deployments/stellar-testnet.json` → `strategy1`, `vault.token`).
- Konsisten dengan standar Blend: bunga lender = borrowing rate × utilisasi; withdraw butuh likuiditas pool (https://docs.blend.capital/users/lending-borrowing/lending.md) — dicerminkan `withdraw` finite + `ensure_idle` drain-berurutan di vault.

### 3.3 Keeper compound — ADA

- Kontrak: `compound` di `soroban/contracts/autofarm_vault/src/vault.rs` (keeper-only via `require_keeper`, cooldown `set_compound_cooldown`, isolasi fault per-strategi, event `Compound`).
- Identitas keeper terpisah dari relayer: `deployments/stellar-testnet.json` → `keeper: GA2CMBS…HRCBU`, `keeperNote` (secret hanya di env), cron 15 mnt (dirujuk `prd.md` §4 + `frontend/src/money/automationEvidence.js` yang menyamakan cadence cron keeper).
- UI: `frontend/src/components/console/KeeperZone.jsx` (`pricePerShare`, delta antar-compound, APR strategi), feed `compound_executed` di `AlertCard.jsx` + `app.jsx` (~baris 293–294, 1781–1782).
- Bukti live: compound idle-sweep tx `4e993949…3b268` (`stellar-testnet.json` → `hardenedRedeploy`).

### 3.4 Lifeboat derisk — ADA

- Kontrak: `emergency_derisk`/`resume`, `set_mandate_authority`/`set_mandate_expiry`, state `derisked` di `soroban/contracts/autofarm_vault/src/vault.rs` (+ event `LifeboatEngaged`/`LifeboatResumed`, tipe `LifeboatState`, `MandateSet`).
- Tanpa mandat hidup: hanya alarm fail-closed (`prd.md` §4, `FEATURES.md` §3.9; UI `MandateZone.jsx`: "Revocable: Yes, anytime on-chain. Expiry uses the SEP-41 allowance.").
- Bukti live: derisk tx `00628504…94c2` (drained 20000999), resume `3f2b8085…8c25` (`stellar-testnet.json` → `hardenedRedeploy`, `autofarmVault.note`).

### 3.5 Withdraw / redeem — ADA (penuh + parsial)

- Vault: `redeem(from, shares)` di `vault.rs` — **tidak pause-gated** (holder selalu bisa keluar), pro-rata `shares*total_assets/supply`, `ensure_idle` drain strategi berurutan dengan `try_withdraw` (satu strategi brick tidak menjatuhkan redeem).
- Full exit satu tanda tangan: `exit_router.sweep` (`stellar-testnet.json` → `exitRouter CDGDIPHB…32IRS2J` + note) via `sweepAgents` → `withdrawAllFromVault` di `frontend/src/agents/agentController.js` (~baris 132–167).
- Parsial: `partialWithdraw` + `ensureExitSigner` + `sharesForAmount` di `frontend/src/stellar/partialWithdraw.js` (2 tx relayed: redeem → transfer saldo aktual, dust-free; agen tetap hidup).
- Base unwind: `buildUnwindCalls`/`signAndSubmitUnwind` (`frontend/src/base/withdrawBatch.js`), polling `pollUnwindStatus`, screen Withdraw Base (`app.jsx`, `Withdraw.test.jsx`).

### 3.6 Cross-chain CCTP + YieldRouter — ADA (dengan catatan jujur)

- Stellar→Base: `frontend/src/stellar/cctpBurn.js` (`STELLAR_TOKEN_MESSENGER_MINTER`, `CCTP_BASE_DOMAIN`, `evmAddrToBytes32`, `deriveCctpTransferUnits`), `AgentInit.kind==1` Bridge di router (validasi `mint_recipient`/`destination_domain`), relayer Node + SQLite + polling Iris (`prd.md` §7; `orchestrator.js` impor `cctpBurn`, `baseLeg.js`, `crossChainFarm.js`).
- Base: `YieldRouter` + `AaveV3Adapter4626` + ZeroDev session key (`deployments/base-sepolia.json`, `prd.md` §7; ABI `deposit`/`withdraw` di `frontend/src/base/config.js` ~baris 305–351).
- Kejujuran terdokumentasi: testnet Base = vault uji jujur (tidak ada protokol lending riil terima Circle USDC di Base Sepolia — Aave testnet pakai faucet token sendiri); adapter Aave **mainnet-ready & fork-proven**, flip mainnet = perubahan config (`prd.md` §7 honesty note).

### 3.7 Fee-bump relay — ADA

- `frontend/api/stellar-relay.js`: relay **tidak mengotorisasi aksi** (inner tx sudah bawa auth), hanya membayar fee XLM; `assertRelayableTransaction` = allowlist fail-closed berversi (vault deposit/redeem, router grant/pull v2+v3, exit sweep dengan `to==owner`, CCTP deposit_for_burn, token transfer agen→owner-shaped, approve-revoke nol, revoke/owner_withdraw/set_exit_signer, deploy pinned); `FEE_MARGIN = 1_000_000n`; replay guard + rate limit + backstop sponsor harian; `loadStellarRelayConfig` pin alamat/wasm hash deployment.
- Fallback jujur: grant bisa direct user-paid bila relay down (`prd.md` Critical Failure Modes; `FEATURES.md` §3.6).

### 3.8 Council / gate F8 — ADA

- Eligibility F8: `frontend/src/strategy/eligibilityGate.js` (fail-closed; anti-ponzi `annualizedDistributed/protocolRevenue < 1.5`; skor sekuriti terbobot threshold 60; audit = hard gate; ekstensi lifeboat: pool curated, oracle circuit_breaker, likuiditas ≥ $250k, konsentrasi supplier ≤ 40%; token 15 mnt di-cek ulang di `worker.js` via `MAX_TOKEN_AGE_MS`).
- Pre-gate ringan: `frontend/src/strategy/gates.js` (blokir aksi ofensif saat kondisi buruk, aksi defensif selalu lolos).
- Council: `frontend/src/strategy/council.js` (Yield/Risk/Market, veto Risk > 0.85) + `councilLoop.js` (debat proposer/risk/validator maks 2 ronde atas VaR/CVaR) — deterministik-first, maksimal 1 AI call tie-breaker.

---

## 4. Gap temuan

### 4.1 Tabel ringkas

| # | Area checklist DeFi standar | Status | Bukti singkat | Prioritas |
|---|---|---|---|---|
| G1 | Posisi/portfolio & **PnL** | ❌ kurang | `readOwnerMoney.js:913-917` earned selalu `unavailable`; `MoneyHero.jsx:137-215` baris Earned mati di produksi; `positionsStore.js` `unclaimedRewards:'0'` hardcoded | **P0** |
| G2 | **APY/APR real-time + histori** | ❌ kurang | `apyHistory.js` hanya chart DeFiLlama 7-hari untuk pool non-Stellar; fetch APR strategi dihapus dari poll (`app.jsx:~1847-1852`); `MoneyHero` sembunyikan APY bila `unavailable` (`MoneyHero.test.jsx:254-301`) | **P0** |
| G3 | Risiko: backstop/oracle/admin pool (checklist Blend) | ❌ kurang | Tidak ada tampilan backstop/oracle/admin di alur deposit; lifeboat pantau utilisasi/oracle tapi user-facing hanya badge (`agents.jsx:1261`, `KeeperZone.jsx`) | **P0** |
| G4 | Risiko: health factor / LTV / likuidasi | ➖ N/A sebagian | Supply-only → tak ada borrow → tak ada likuidasi (sesuai https://docs.blend.capital/users/lending-borrowing/lending.md). Tapi risiko likuiditas withdraw (utilisasi tinggi) tidak divisualkan | P2 |
| G5 | Risiko: visibilitas **allowance/expiry** | ⚠️ sebagian | Ada kalimat boundary (`ProtectStage.jsx:979-982,507-515`) + Cap/Expires per-agen (`AgentTeam.jsx`) + `allowanceExpiryProof`, tapi tak ada widget persisten sisa budget + countdown | **P1** |
| G6 | Slippage visibility | ⚠️ sebagian | Kaki Base: `slippageBps` default 50 di `base/quotes.js:11-30`, `readPositions.js:42-45`, `dashboardPositions.js:21`; kaki Stellar: deposit langsung tanpa swap (jujur di `worker.js`: swap `skipped`). Gap = estimasi slippage tak ditampilkan pre-sign | P2 |
| G7 | Withdraw parsial multi-agen & fallback relay | ⚠️ sebagian | `partialWithdraw.js` = 1 agen + relay-only (throw bila relay unreachable); registrasi exit signer = 1 popup tambahan; full sweep ada (`exit_router`) | **P1** |
| G8 | Notifikasi/keeper transparansi | ⚠️ sebagian | `NotificationCenter.jsx` + `AlertCard.jsx` + feed keeper ada; channel hanya Discord/Telegram webhook (`app.jsx:302-320`); tak ada push/email/status eksternal; `keeperLedgerRef` dedup (`app.jsx:1514-1517`) bagus | P2 |
| G9 | Audit/keamanan formal | ❌ kurang (prod) | "Unaudited (hackathon scope)" (`ExplorerPage.jsx:461-463`); timelock+multisig vault ADA (`stellar-testnet.json` adminNote); tak ada bug bounty / audit pihak ketiga | **P1** (P0 bila mainnet) |
| G10 | UX dana: estimasi biaya saat relay down + riwayat terpadu | ⚠️ sebagian | Faucet ADA (`wallet/faucet.js`, `api/faucet.js`, cap 100 USDC/call), trustline ADA (`wallet/trustline.js`, `AddAssetScreen.jsx`), Friendbot ADA; tapi tak ada estimasi fee fallback; riwayat = Horizon payments saja (`wallet/history.js:1-40`) + Base terpisah (`baseHistory.js`) — tx Soroban tersebar di memori/localStorage | **P1** |
| G11 | Dokumentasi risiko + disclaimer | ⚠️ sebagian | Disclaimer ADA tersebar (`ExplorerPage.jsx:461-463`, `ReplayPage.jsx:366-368`, `app.jsx:2215-2216` "APR illustrative; realized yield may be ~0"); tapi tak ada halaman risiko khusus di alur deposit | **P1** |

### 4.2 Detail per gap

#### G1 — Tidak ada PnL / earned (P0)

- **Bukti:** `frontend/src/money/readOwnerMoney.js` ~913–917: `earned: { state: 'unavailable', amount: null }` + komentar "No principal/share-price history is tracked … an 'earned' figure would have to be invented". `frontend/src/components/money/MoneyHero.jsx` ~137–215: `hasValidEarned` hanya render bila `state==='known'` — "dead in production"; test `MoneyHero.test.jsx:298-301` mengunci perilaku ini. `frontend/src/store/positionsStore.js`: `unclaimedRewards: '0'` hardcoded.
- **Standar yang dilanggar:** aplikasi DeFi production-grade menampilkan posisi + PnL (nilai kini vs cost basis). Vault ERC-4626-style (`vault.rs` `price_per_share`, `PPS_SCALE = 1e7`) menyediakan bahannya: shares per agen + PPS historis → nilai kini; yang hilang hanya **jejak principal per user**.
- **Dampak user/juri:** user tak bisa menjawab "saya untung berapa"; juri DeFi menganggap ini fitur tabel-stakes.
- **Rekomendasi konkret:** simpan `depositLedger[{agent, shares, assetsIn, ppsAtDeposit, txHash}]` di `positionsStore.js` (localStorage + optional agent-index); hitung `currentValue = Σ shares × PPS_live` via `readPricePerShare` (`stellar/vaultReads.js`), `earned ≈ currentValue − Σ assetsIn`; tampilkan berlabel "unrealized, sebelum fee/slippage" + link explorer per tx. Tanpa perubahan kontrak.

#### G2 — APY/APR real-time + histori (P0)

- **Bukti:** `frontend/src/history/apyHistory.js` — hanya `yields.llama.fi/chart/{poolId}` 7-hari, TTL 10 mnt, fail-soft null; untuk katalog umum, **bukan** vault Blend testnet sendiri. `frontend/src/app.jsx` ~1847–1856: fetch strategi + estimasi supply-APR **dihapus** dari poll 15-detik ("panel showing '--', never a fake number"). `KeeperZone.jsx:8-12` hanya pakai `strategies[].aprPct` operan. `MoneyHero` sembunyikan baris APY bila `yield.unavailable`.
- **Standar yang dilanggar:** DeFi standar = APY live (utilisasi × borrowing rate, lih. https://docs.blend.capital/users/lending-borrowing/lending.md) + grafik histori.
- **Dampak user/juri:** angka APY di kartu strategi (`agents.jsx:247-248,771-772,798-800`) adalah snapshot katalog, bukan angka pool live; klaim "APY-first onboarding" (`app.jsx:4650`) lemah tanpa angka live.
- **Rekomendasi konkret:** (a) baca reserve Blend live (pool `CCEBVDYM…`) → supply-APR = borrowRate × utilization, tampilkan di `KeeperZone`/`PositionsZone` + timestamp; (b) grafik histori PPS: poll `price_per_share` tiap 15 mnt → deret lokal (atau event `Deposit`/`Compound`) → sparkline 7/30-hari + APY trailing (CAGR dari PPS). Read-only, tanpa kontrak baru.

#### G3 — Risiko pool ala checklist Blend tidak ditampilkan (P0)

- **Bukti:** tidak ada tampilan backstop/oracle/admin di alur deposit (grep nihil); yang ada hanya badge monitor (`agents.jsx:1261`) dan `KeeperZone` PPS/APR.
- **Standar yang dilanggar:** https://docs.blend.capital/users/choosing-pools.md mewajibkan user memeriksa: (1) backstop cukup + tidak banyak antre withdraw, (2) collateral aman, (3) risk params wajar, (4) **oracle reliable**, (5) **pool admin trustworthy / immutable**. Gate F8 memeriksa sebagian di balik layar (`eligibilityGate.js`) tapi **hasilnya tak ditampilkan** saat user memutuskan deposit.
- **Dampak user/juri:** keamanan tak dinilai bila tak terlihat; juri akan bertanya "bagaimana user tahu pool ini aman?".
- **Rekomendasi konkret:** panel "Pool safety" di layar review: TVL (DeFiLlama, `defiLlama.js` sudah ada), utilisasi live, ukuran backstop + % antre keluar, jenis oracle, admin pool, tanggal audit; tiap baris + sumber + freshness. Data dari RPC Blend + `vaultFactsLive.js`.

#### G4 — Health factor / LTV / likuidasi: N/A sebagian (P2)

- **Bukti:** strategi hanya `supply` (`blend_strategy/lib.rs::deposit`), tak pernah borrow — tak ada posisi utang yang bisa dilikuidasi.
- **Standar (sebagian):** https://docs.blend.capital/users/lending-borrowing/lending.md — withdraw butuh (a) likuiditas pool cukup, (b) good-standing bila meminjam. Syarat (b) tak relevan; (a) **relevan**: pada utilisasi sangat tinggi withdraw bisa tertunda.
- **Rekomendasi konkret:** tampilkan utilisasi live + pesan jujur "withdraw butuh likuiditas pool; pada utilisasi ekstrem bisa antre" + status lifeboat (`derisked`/idle) di layar withdraw. Tanpa kontrak baru.

#### G5 — Visibilitas allowance/expiry tidak persisten (P1)

- **Bukti ada (parsial):** kalimat boundary `ProtectStage.jsx:979-982` + formatter ledger-vs-date `ProtectStage.jsx:507-515,770-789`, Cap/Expires per agen di `AgentTeam.jsx` (+ test `AgentTeam.test.jsx:184-270`), proof `allowanceExpiryProof{ gapFree, noLaterMutation }` (`ProtectStage.test.jsx:216-235`, `coreRouteAdapters.js:191-195`), label `MandateZone.jsx:69-71`.
- **Gap:** semua di tahap Protect/review, **bukan widget persisten** pasca-deposit. Setelah kembali, tak ada satu tempat yang menjawab "sisa budget berapa, kedaluwarsa kapan, revoke di mana" — padahal datanya on-chain (SEP-41 allowance + `scope_of`).
- **Rekomendasi konkret:** kartu "Grant aktif" persisten (My Money): `remaining = readAllowance(owner, router)` (`stellar/grant.js::readAllowance`), expiry ledger → estimasi tanggal (×5 detik, label "estimasi"), tombol Revoke 1-tanda-tangan (`revokeGrant` = approve 0, direct submit).

#### G6 — Slippage visibility (P2)

- **Bukti:** kaki Stellar tak butuh slippage (deposit langsung, swap `skipped` di `worker.js`); kaki Base menerapkan `slippageBps` default 50 (0,5%) di `base/quotes.js:11-30` (`estimateMinShares`), `base/readPositions.js:42-45` (`minAssets`), `base/dashboardPositions.js:21`; kontrak `YieldRouter.minShares` enforcement final (`quotes.js:3-6`). Presign summary disebut di `app.jsx:2555-2556`.
- **Gap:** angka dihitung tapi belum tentu **ditampilkan pre-sign** di UI leg Base/CCTP.
- **Rekomendasi konkret:** tampilkan `minShares`/`minAssets` + toleransi bps di layar konfirmasi Base, catat di receipt. Kecil, P2.

#### G7 — Withdraw parsial: satu agen + relay-only (P1)

- **Bukti:** `partialWithdraw.js`: butuh `ensureExitSigner` dulu (1 otorisasi owner tambahan via `registerExitSigner`), hanya 1 agen per panggilan, `throw` bila relay unreachable ("partial withdraw needs it", tanpa fallback user-paid).
- **Dampak:** alur exit paling sering dipakai justru paling rapuh: 2 popup + mati total bila relay down; parsial multi-agen ("tarik 30% dari semua agen") tidak ada.
- **Rekomendasi konkret:** (a) daftarkan exit signer **saat grant** (satu popup yang sama menampung `set_exit_signer`); (b) mode "parsial proporsional multi-agen" di `WithdrawModal.jsx`; (c) pesan + antrean retry jelas saat relay down.

#### G8 — Notifikasi & transparansi keeper (P2)

- **Bukti ada:** `NotificationCenter.jsx` (bell global + filter severity), `AlertCard.jsx` (termasuk `compound_executed`, `blnd_held`, `vault_upgrade_scheduled`), poll keeper 15-detik + `keeperLedgerRef` anti-duplikat (`app.jsx:1514-1517,1761-1826`), APY-drift/risk/harvest alerts (`app.jsx:255-320`).
- **Gap:** channel keluar hanya webhook Discord/Telegram (`app.jsx:302-320`) — tak ada push browser/email/SMS; tak ada halaman status keeper publik; alarm "mandat kedaluwarsa" hanya di UI.
- **Rekomendasi konkret:** notifikasi browser (Notification API) untuk `risk_alert` + `vault_upgrade_scheduled` + mandat-kedaluwarsa; halaman `/status` publik (keeper heartbeat, compound terakhir, mandat vault). P2.

#### G9 — Audit formal (P1; P0 bila mainnet)

- **Bukti ada (kekuatan):** vault admin = multisig 2-of-3 (`GDYIPNML…` + 2 signer, threshold 2), upgrade **timelocked 3 hari** (`schedule→execute`, `cancel`, `pending_upgrade`) — `deployments/stellar-testnet.json` → `autofarmVault.adminNote` + smoke `scripts/soroban/upgrade-timelock-smoke.sh`; `redeem` tak pernah pause-gated; `quarantine_strategy` tanpa memanggil strategi brick; `DEAD_SHARES = 1000` + `MIN_FIRST_DEPOSIT` (`vault.rs`); TTL storage di-extend tiap mutasi (konsisten https://developers.stellar.org/docs/learn/fundamentals/contract-development/storage/state-archival.md).
- **Gap:** "Unaudited (hackathon scope). Production deployment requires third-party audit." (`ExplorerPage.jsx:461-463`) — tepat untuk hackathon, **tidak cukup untuk mainnet**. Tak ada bug bounty / audit eksternal.
- **Rekomendasi konkret:** testnet/hackathon: cukup + jadikan selling point (tampilkan timelock/multisig di UI — kini hanya di JSON + event `AlertCard`). Mainnet: audit pihak ketiga (scope: router, vault, strategy, agent auth) + bug bounty. Jangan klaim "audited" dari test internal.

#### G10 — Estimasi biaya fallback + riwayat terpadu (P1)

- **Bukti ada:** faucet testnet (`frontend/src/wallet/faucet.js` loop cap-100, `frontend/api/faucet.js`, tombol `WalletAdvanced.jsx:65-78` + Friendbot XLM), trustline (`wallet/trustline.js::changeTrust`, `AddAssetScreen.jsx`, pesan reserve 0,5 XLM), fee preview (`SendScreen.jsx:160` stroops; `clearSign.js:39-43`), explorer links (TopBar `stellar.expert/.../account`, `SkillDetailModal.jsx:85-89` kontrak, `HistoryScreen.jsx:147-150` op, `WalletActivity.jsx:108-114`, attestation `explorerUrl` di `agents.jsx:903-908`).
- **Gap:** (a) tak ada **estimasi biaya** bila relay down dan user harus bayar sendiri (grant direct); (b) riwayat **terfragmentasi**: `wallet/history.js` hanya Horizon payments (gagal jaringan → `[]`, tak dibedakan dari kosong — diakui sebagai KNOWN GAP di `HistoryScreen.jsx:16-22`); leg Base terpisah (`baseHistory.js` via Blockscout; extension belum diisi — `WalletActivity.jsx:9-15`); tx Soroban (grant/pull/deposit hashes) tersebar di memori/localStorage per agen.
- **Rekomendasi konkret:** (a) tampilkan simulasi fee (`minResourceFee` dari `simulateTransaction` — pola ada di `wallet/submit.js:89`) di layar grant sebagai "biaya bila relay down"; (b) satu feed `/history` terpadu: Horizon payments + event kontrak (`Grant`/`Pulled`/`Deposit`/`Redeem`/`Compound`) + Base tokentx, tiap baris + explorer link + status final. Perbaiki `fetchHistory` gagal-jaringan → `null`, bukan `[]`.

#### G11 — Halaman risiko khusus (P1)

- **Bukti ada (tersebar):** `ExplorerPage.jsx:461-463` (unaudited), `ReplayPage.jsx:366-368` ("does not predict future outcomes"), `app.jsx:2215-2216` ("testnet. APR illustrative; realized yield may be ~0"), Monte Carlo 200-run 30-hari + VaR/CVaR (`FEATURES.md` §3.1, `strategy/simulation.js`), `ProtectStage` boundary sentence.
- **Gap:** tak ada **satu halaman risiko** yang merangkum: smart-contract risk (unaudited), oracle risk, liquidity/utilization risk, testnet-reset risk (runbook ada `docs/runbooks/testnet-reset.md` tapi tak dirujuk UI), CCTP delay risk (ditangani relayer persistent jobs — `prd.md` Critical Failure Modes — tapi tak dijelaskan ke user).
- **Rekomendasi konkret:** halaman/modal "Risks" dibuka sekali sebelum grant pertama (checkbox "saya paham") + tautan permanen di footer: 6 risiko di atas, masing-masing 2 kalimat + mitigasi yang sudah ada (lifeboat, timelock, revoke). Copy dari `prd.md` Critical Failure Modes.

---

## 5. Prioritas & rekomendasi

### P0 — tutup sebelum demo/penilaian (semua read-only, tanpa kontrak baru)

| # | Rekomendasi | File yang disentuh | Usaha |
|---|---|---|---|
| 1 | Kartu PnL jujur: `earned_unrealized = Σ shares×PPS_live − Σ principal`; label "unrealized" + explorer links | `store/positionsStore.js`, `money/readOwnerMoney.js`, `components/money/MoneyHero.jsx` | S |
| 2 | APY live Blend (borrowRate × utilization dari reserve pool) + sparkline histori PPS (poll `price_per_share`, simpan deret) | `stellar/vaultReads.js`, `components/console/KeeperZone.jsx`, `components/console/PositionsZone.jsx`, `history/apyHistory.js` | M |
| 3 | Panel "Pool safety" di layar review: TVL, utilisasi, backstop, oracle, admin, audit | layar strategi + `strategy/vaultFactsLive.js`, `strategy/defiLlama.js` | M |

### P1 — naikkan ke production-grade testnet

| # | Rekomendasi | File yang disentuh | Usaha |
|---|---|---|---|
| 4 | Widget "Grant aktif" persisten: sisa allowance (`readAllowance`), countdown expiry, tombol Revoke | `stellar/grant.js`, My Money route, `components/money/*` | S |
| 5 | Exit-signer didaftarkan saat grant; parsial proporsional multi-agen; UI retry saat relay down | `stellar/grant.js`, `stellar/partialWithdraw.js`, `components/WithdrawModal.jsx` | M |
| 6 | Feed `/history` terpadu + `fetchHistory` gagal → `null`; estimasi fee fallback dari simulasi | `wallet/history.js`, `screens/HistoryPanel.jsx`, `wallet/submit.js`, layar grant | M |
| 7 | Halaman "Risks" + checkbox pra-grant pertama | route baru + footer, copy dari `prd.md` | S |
| 8 | Rencana audit eksternal + tampilkan timelock/multisig di UI | `screens/ExplorerPage.jsx`, docs | S (persiapan) |

### P2 — polish juri & operator

| # | Rekomendasi | File yang disentuh | Usaha |
|---|---|---|---|
| 9 | Banner utilisasi + pesan likuiditas-withdraw di layar withdraw; tampilkan status `derisked` | layar Withdraw, `stellar/vaultReads.js` | S |
| 10 | Tampilkan `minShares`/`minAssets` + bps pre-sign di leg Base | `base/quotes.js`, UI Base | S |
| 11 | Notifikasi browser + halaman `/status` keeper publik | `app.jsx`, route baru | M |

**Urutan eksekusi yang disarankan:** 4 → 1 → 2 → 3 (semua menaikkan skor demo), lalu 7 → 6 → 5, lalu P2.

---

## 6. Bukan-gap (fitur yang dikira kurang tapi sudah ada + bukti)

1. **"Grant satu-signature tidak ada" — ADA.** `funding_router::grant` + nested SEP-41 approve satu envelope (`soroban/contracts/funding_router/src/lib.rs`, `frontend/src/stellar/grant.js`). Smoke tx di `deployments/stellar-testnet.json::fundingRouter.smokeTxs`.
2. **"Fee masih dibayar user" — TIDAK (disponsori).** `frontend/api/stellar-relay.js` fee-bump + `FEE_MARGIN`; TopBar eksplisit (`components.jsx:263`).
3. **"Tidak ada kill switch" — ADA.** Revoke = `approve(router, 0)` 1 signature (`FEATURES.md` §3.4, `grant.js` header) + `agent_account.revoke()` on-chain + Registry mirror.
4. **"Vault bisa di-upgrade sepihak" — TIDAK.** Timelock 3-hari + multisig 2-of-3 + smoke script (`stellar-testnet.json::autofarmVault.adminNote`); `redeem` tak pause-gated; event upgrade di `AlertCard.jsx:20-24`.
5. **"Inflation attack / first-depositor" — DITANGANI.** `DEAD_SHARES = 1000` + `MIN_FIRST_DEPOSIT` (`vault.rs`), terobservasi di smoke 1-USDC (`stellar-testnet.json::hardenedRedeploy`).
6. **"Strategi brick menjatuhkan redeem" — TIDAK.** `try_withdraw` loop + `quarantine_strategy` tanpa panggil strategi (`vault.rs`).
7. **"Withdraw parsial tidak ada" — ADA.** `partialWithdraw.js` (`sharesForAmount`, 2-leg redeem→transfer, agen tetap hidup).
8. **"Exit N agen = N signature" — TIDAK.** `exit_router.sweep` satu invokasi (`stellar-testnet.json::exitRouter`, `agentController.js:132-167`).
9. **"Unwind Base tidak ada" — ADA.** `base/withdrawBatch.js`, `pollUnwindStatus`, layar Withdraw Base + test (`Withdraw.test.jsx:273-277`).
10. **"Keeper tak terlihat" — ADA (in-app).** `KeeperZone.jsx`, feed `compound_executed`/`rebalance_executed`, `keeperLedgerRef` anti-duplikat, `classifyKeeperAutomation` jujur (`money/automationEvidence.js:4-7` — absen sinyal = `unavailable`, bukan "healthy").
11. **"Faucet/trustline tak ada" — ADA (testnet).** Faucet cap-100 (`wallet/faucet.js`, `api/faucet.js`), Friendbot XLM, `changeTrust` (`wallet/trustline.js`), `AddAssetScreen.jsx`.
12. **"Tak ada slippage protection" — ADA di kaki yang butuh.** `slippageBps` 50 + `minShares`/`minAssets` + enforcement kontrak (`base/quotes.js`, `readPositions.js`, `config.js` ABI); kaki Stellar memang tak butuh (tanpa swap).
13. **"CCTP belum dibuktikan" — TERBUKTI dua kaki** (`prd.md` §7: burn + mint live-proven; relayer persistent jobs + resumable IDs), dengan catatan jujur testnet-vs-mainnet.
14. **"Tak ada filter keamanan protokol" — ADA.** F8 (`eligibilityGate.js`) + `gates.js` + council veto (`council.js`, `councilLoop.js`) + Monte Carlo (`strategy/simulation.js`). Yang kurang hanya *tampilannya* (G3), bukan logikanya.

---

## 7. Lampiran: peta sitasi cepat

| Klaim | Sitasi |
|---|---|
| Alamat live + multisig + timelock | `deployments/stellar-testnet.json` (fundingRouter, autofarmVault.adminNote, strategy1, exitRouter, keeper) |
| Grant/pull/allowance | `soroban/contracts/funding_router/src/lib.rs`, `frontend/src/stellar/grant.js` |
| Deposit/supply/harvest | `soroban/contracts/blend_strategy/src/lib.rs`, `soroban/contracts/autofarm_vault/src/vault.rs` |
| Redeem/exit/parsial | `vault.rs::redeem`, `agents/agentController.js`, `stellar/partialWithdraw.js` |
| Relay allowlist | `frontend/api/stellar-relay.js` |
| Council/gate | `strategy/eligibilityGate.js`, `gates.js`, `council.js`, `councilLoop.js` |
| PnL/APY gap | `money/readOwnerMoney.js:913-917`, `components/money/MoneyHero.jsx:137-215`, `history/apyHistory.js`, `app.jsx:~1847-1856` |
| Allowance visibility parsial | `strategy/ProtectStage.jsx`, `components/money/AgentTeam.jsx` |
| Riwayat/notifikasi | `wallet/history.js`, `base/baseHistory.js`, `screens/HistoryPanel.jsx`, `components/NotificationCenter.jsx`, `AlertCard.jsx` |
| Dana testnet | `wallet/faucet.js`, `api/faucet.js`, `wallet/trustline.js` |
| Disclaimer | `screens/ExplorerPage.jsx:461-463`, `screens/ReplayPage.jsx:366-368`, `app.jsx:2215-2216` |
| Standar Blend | https://docs.blend.capital/users/choosing-pools.md, https://docs.blend.capital/users/lending-borrowing/lending.md |
| Standar Stellar | https://developers.stellar.org/docs/learn/fundamentals/contract-development/overview, https://developers.stellar.org/docs/learn/fundamentals/contract-development/storage/state-archival.md |
| Standar CCTP | https://developers.circle.com/cctp (via `prd.md` §7 + `stellar/cctpBurn.js`) |

*Akhir laporan. Tidak ada klaim tanpa sitasi; tidak ada perubahan kode dalam riset ini.*
