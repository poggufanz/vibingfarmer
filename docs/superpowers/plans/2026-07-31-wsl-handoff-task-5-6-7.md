# WSL handoff — IQ Alter Remediation, Tasks 5 (rest) / 6 / 7

Paste everything below the line into a fresh Claude Code session on the WSL machine.

## Before you paste it — two things this machine must do first

1. **Push the branch.** `sdd/iq-alter-t567` has 12 commits and no upstream, so the WSL machine
   cannot see any of the work:
   ```
   git push -u origin sdd/iq-alter-t567
   ```
2. **Optional but recommended — carry the ledger.** `.superpowers/` is gitignored
   (`.gitignore:75`), so it does not travel with the push. Copy
   `.superpowers/sdd/2026-07-29-iq-alter-remediation/` to the WSL machine if you want the full
   run history: every ruling, ~15 deferred minors, and the seven tests-that-cannot-fail findings
   with their evidence. The prompt below is written to work without it.

---

Lanjutkan IQ Alter Remediation di repo vibing-farmer. Rencana ada di
`docs/superpowers/plans/2026-07-29-iq-alter-remediation.md` (tracked di git).

Baca dulu bagian "Global Constraints" dan Task 4-7 di file itu. Jangan baca seluruh plan ke
context — ambil per task.

## Posisi sekarang

Branch: `sdd/iq-alter-t567` (12 commit di atas `1923078`). Task 5 SELESAI dan review-nya bersih:
14 file, suite frontend penuh 4457 lulus, ESLint dalam baseline 585w/523fp.

Task 4 (Router V3 + agent_account V4) sudah ada di source Rust dan lolos cargo test, TAPI BELUM
DI-DEPLOY. Baca `v3Note` di `deployments/stellar-testnet.json` — dia sendiri bilang "SOURCE ONLY".

Akibatnya Task 5 SEPARUH JADI. Yang hidup: deterministic execution ID, prover
`proveReusablePermission`, dispatch pull V3, dormansi. Yang mati: seluruh separuh TULIS —
`buildGrantV3Tx` nol caller, `buildReusableApproval` nol caller, lane receipt V3 nol caller,
kontrol ceiling di Protect tak pernah terkirim ke mana pun. Satu-satunya pintu masuk ke state V3
adalah `grant_v3`, dan tak ada jalur produksi yang bisa mengirimnya.

Verifikasi sendiri sebelum percaya: grep caller `buildGrantV3Tx` dan `buildReusableApproval` di
`frontend/src`.

## Kerjakan dengan urutan ini. Urutannya penting.

### 1. Verifikasi kontrak (WSL — ini alasan utama kamu di mesin ini)

```
wsl -e bash -lc "cd <repo>/soroban && stellar contract build"
wsl -e bash -lc "cd <repo>/soroban && cargo test"
wsl -e bash -lc "cd <repo>/soroban && cargo clippy --all-targets -- -D warnings"
```

Kalau ada yang merah, berhenti dan lapor. Jangan lanjut ke deploy.

### 2. Tutup gerbang eligibility SEBELUM mendaftarkan alamat

`frontend/src/stellar/agentCreatorManifest.js` punya
`AGENT_GENERATIONS_ELIGIBLE_FOR_PERMISSION_V3 = []` dan predikat `isEligibleForPermissionV3()`.
Predikat itu NOL CALLER PRODUKSI.

Header `permissionGrantV3.js:10-17` mengklaim aktivasi butuh DUA kunci (daftar `ROUTER_SCHEMAS` +
daftar generasi). Kenyataannya cuma satu. Kalau alamat V3 didaftarkan sekarang, prover terbuka
untuk SEMUA generasi agent, termasuk yang manifest tandai tidak eligible — bertentangan dengan
teks Task 4 "mark V1-V3 agents fresh-only for reuse".

Perbaiki di `proveReusablePermission`: setelah membaca `rows`, petakan `row.code` ke
`AGENT_WASM_GENERATIONS[].generation` dan kembalikan
`freshDecision(base, 'agent-generation-ineligible')` untuk row yang tidak eligible. Tiga baris.
Wajib ada test yang merah tanpanya.

### 3. Sambungkan `currentLedger`

Ini BUKAN kapabilitas yang hilang. Sumbernya sudah ada dan dipakai lima tempat:
`server.getLatestLedger().sequence` di `grant.js:165,364,508,710` dan `allowanceProof.js:34`.
Yang kurang cuma penyambungan.

`buildReusableApproval` butuh `currentLedger` untuk menyerialkan absolute `liveUntilLedger`.
`proveReusablePermission` butuhnya untuk cek expiry — dan guard itu sekarang fail-closed, jadi
TANPA penyambungan ini dia mengembalikan `permission-expired` di tiap panggilan nyata.

Baca sequence di jalur Protect/preflight, teruskan ke keduanya. Kecil. Tak butuh WSL, tapi
kerjakan saja di sini.

### 4. Deploy V3/V4 — butuh keputusan owner dulu

PENTING: `funding_router` TIDAK punya fungsi upgrade. Cuma `__constructor(env, agent_wasm_hash)`
di `lib.rs:105`. Jadi V3 adalah KONTRAK BARU DI ALAMAT BARU, bukan upgrade di tempat. V2 tetap
hidup.

Konsekuensinya: alamat baru = SETIAP USER HARUS TANDA TANGAN GRANT BARU. Allowance V2 yang sudah
ada tidak ikut pindah. Tanyakan ini ke owner sebelum deploy, jangan putuskan sendiri.

Tak ada script yang men-deploy router. `ls scripts/soroban/` tidak punya satu pun yang menyebut
`funding_router` — V2 dulu di-deploy manual dengan perintah `stellar contract`, tercatat di
`v2Note` deployments JSON (upload tx, deploy tx, identity deployer).

Urutan deploy:

- a. upload wasm `agent_account` → catat hash (ini generasi v4)
- b. upload wasm `funding_router` → catat hash
- c. deploy router, constructor arg = hash agent v4 dari (a) → catat alamat

Lalu penyambungan, urutannya penting:

- d. catat alamat + kedua hash di `deployments/stellar-testnet.json`
- e. daftarkan alamat di `ROUTER_SCHEMAS` (`frontend/src/stellar/routerSchema.js`) dengan bentuk
  `ROUTER_SCHEMA_V3_SHAPE`. INI KUNCI DORMANSI UTAMA — sebelum langkah ini seluruh jalur V3 mati,
  sesudahnya hidup.
- f. tambahkan generasi agent ke `AGENT_GENERATIONS_ELIGIBLE_FOR_PERMISSION_V3`
- g. tambahkan router + wasm hash ke allowlist CSV relay (`SOROBAN_ROUTER_ADDRESSES`,
  `SOROBAN_AGENT_WASM_HASHES`). KALAU LEWAT, relay tolak semua tx V3 dan gas abstraction mati
  total.

### 5. `submitGrantV3` (separuh tulis)

`grant.js` punya `buildGrantV3Tx` (bangun tx) tapi tak ada padanan `submitGrant`.
`orchestrator.js:563-571` sekarang fail-closed dengan `VF_V3_FRESH_GRANT_UNSUPPORTED` — itu benar,
jangan diganti dengan salah-rute ke `submitGrant` V2.

Bangun `submitGrantV3` mengikuti bentuk `submitGrant`: OwnerAuthorizationV1, fee-bump relay untuk
owner G, auth entry passkey untuk owner C. Baca `submitGrant` dulu seluruhnya.

### 6. Task 6 lalu Task 7

Ambil teks lengkapnya dari plan. Task 6 butuh Task 5 selesai; Task 7 butuh Task 6.

## Aturan yang mengikat

- Jangan pernah masukkan alamat/hash yang belum di-deploy ke `deployments/stellar-testnet.json`.
  Sudah ada aturannya di `routerSchema.js:47-54`.
- Jalur V2 live harus terbukti tak berubah. Buktikan dengan test, jangan klaim di komentar.
- Unit aset selalu string desimal integer bigint-safe. JANGAN `Number()` pada nilai unit.
  `Number()` pada ledger sequence (u32) boleh.
- ESLint pakai baseline fingerprint, bukan zero-warning. Nol warning baru.
- `makeAllocationExecution` mencetak `executionId` DETERMINISTIK — tanpa nonce, salt, atau counter.
  Router merekam `execution_id` hanya saat `pull_v3` SUKSES, jadi kirim ulang ID yang sama setelah
  submission yang hasilnya tak diketahui itu aman: duplikat ditolak kalau yang pertama mendarat,
  sukses kalau tidak. ID yang dicetak ulang akan menggerakkan uang dua kali di skenario retry itu.
  Task 7 recovery mengandalkan properti ini.
- Preset durasi `1h` di ProtectStage TETAP. Batasan 24h/7d hanya untuk expiry REUSABLE dan sudah
  ditegakkan di dalam `buildReusableApproval`.

## Peringatan disiplin test

Dalam Task 5 ditemukan TUJUH test yang tak bisa gagal, semuanya lolos review sebelum ketahuan.
Tiga di antaranya klaim mutasi di laporan yang tak pernah dijalankan.

Bentuk yang berulang: assertion menembak nilai turunan bukan nilai yang jadi pokok constraint;
regex guard pakai `.match(RE)?.[0]` non-global sehingga kebocoran kedua tak terlihat; `\b` yang
gagal saat karakter sebelumnya angka; fixture yang kebetulan menyembunyikan bug (nilai
`'1000000000'` round-trip lewat `Number` dengan sempurna, jadi test "byte-for-byte" tak
membedakan apa pun); dan dua file yang test-nya sama-sama hijau karena sepakat pada FIXTURE, bukan
pada SEAM di antara mereka.

Untuk tiap assertion penting: rusak kode yang dijaganya, lihat merah, kembalikan, lihat hijau, dan
catat kedua hasilnya. Kalau tidak dimutasi, tulis "not mutated, unverified" — itu jauh lebih
berharga daripada klaim yang tak berlaku.

## Cara kerja

Pakai `superpowers:subagent-driven-development`. SATU implementer per chunk, lalu SATU reviewer
(spec + quality). Jangan fan-out banyak agent review. Model: sonnet untuk implementasi, opus untuk
review.

Perintah:

```
cd frontend && npm test -- --run
cd frontend && npx eslint <file>
wsl -e bash -lc "cd <repo>/soroban && cargo test"
```

---

## Utang tercatat yang sengaja TIDAK diperbaiki di Task 5

Ada di ledger lengkapnya; ini ringkasannya supaya sesi WSL tak mengira ini bug baru.

**Menyentuh jalur V2 live (produksi hari ini):**

- Alamat kontrak 56-karakter dirender sebagai teks biasa di permukaan Protect reuse V2
  (`ProtectStage.jsx:604`). Sudah ada sebelum Task 5, disengaja dan terdokumentasi; guard
  kebocoran sekarang mencantumkannya sebagai entri yang diharapkan, jadi kebocoran BARU akan
  merah. Keputusan produk, bukan bug.
- Komparator `selectAgents` (`reusePreflight.js`) tak pernah mengembalikan 0, dan tidak menyalin
  penolakan alamat duplikat yang dipasangkan V3 dengan komparator yang sama. `loadCachedAgents`
  membaca localStorage mentah tanpa validasi; penulis aplikasinya sendiri men-dedupe, jadi
  duplikat tak bisa muncul dari pemakaian normal — tapi cache yang korup akan menghidupkan lagi
  ketergantungan urutan-baca yang baru saja ditutup.

**Dorman (menunggu V3 hidup):**

- Kontrol ceiling di Protect dan seluruh permukaan tulis V3 adalah kode mati sampai langkah 3-5
  di atas selesai.
- `fetchCredential` di prover memeriksa keberadaan saja, bukan bahwa credential itu milik agent
  yang terikat. Fail-closed di auth on-chain, jadi bukan misdirection.
- `ceilingError` lengket kalau `routerVersion` berpindah dari 3 — input dan alert-nya unmount tapi
  tombol tetap disabled tanpa alasan terlihat. Tak terjangkau selama `app.jsx` tak mengirim
  `routerVersion`.
