# Gate Review Caching — Vibing Farmer (2026-09-12)

> Bahasa: Indonesia. Setiap klaim best-practice menyitir **sumber primer** (URL langsung). Non-goal dipatuhi: tidak ubah kode produk, tidak jalankan test/lint/build — hanya baca kode + dokumen primer.

## 1. Ringkasan eksekutif

Sembilan dimensi gate caching production-ready diturunkan dari sumber primer (MDN, RFC 9111, OWASP, web.dev, TanStack Query, SWR, Cloudflare, DeFiLlama). Empat permukaan utama dipetakan observed-vs-expected: (1) `vaultFacts` 6h + `CAPTURED_AT`/30d, (2) money/positions `localStorage`, (3) `agent-index` `max-age=15` + durable rate-limit, (4) APY `Map` in-memory. Bonus: radar keeper 60s + relayer SQLite.

## 2. Checklist gate caching (expected ← sumber primer)

| # | Dimensi gate | Expected (best-practice) | Sumber primer |
|---|---|---|---|
| G1 | TTL / freshness eksplisit | Setiap entry cache punya **freshness lifetime eksplisit** (`max-age`/TTL + `Age`); rumus fresh = `freshness_lifetime > current_age` (§4.2). Tanpa expiry eksplisit hanya boleh heuristik untuk status **heuristically cacheable** + batas worst-case (§4.2.2). `max-age` lebih diutamakan dari `Expires` bila keduanya ada. | RFC 9111 §4.2, §4.2.1, §4.2.2: https://www.rfc-editor.org/rfc/rfc9111.html · MDN HTTP caching — fresh/stale + Expires vs max-age: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching · MDN Cache-Control `max-age`: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control |
| G2 | Stale-while-revalidate (SWR) | Pola standar: sajikan stale dalam jendela `stale-while-revalidate` **sambil revalidasi di background**; di luar jendela wajib ke network. Browser tanpa dukungan mengabaikan direktif dan jatuh ke `max-age`. Varian service-worker memberi kontrol LRU/expiry + broadcast-update; varian header memberi manajemen ukuran otomatis browser. | web.dev stale-while-revalidate: https://web.dev/articles/stale-while-revalidate · RFC 5861 §3: https://tools.ietf.org/html/rfc5861#section-3 · Fetch spec SWR response: https://fetch.spec.whatwg.org/#concept-stale-while-revalidate-response · Cloudflare Cache API (SWR tidak didukung di `cache.put/match`): https://developers.cloudflare.com/workers/runtime-apis/cache/ |
| G3 | Stale vs error / fail-open vs fail-closed | Cache **MUST NOT** menyajikan stale bila dilarang direktif eksplisit (`no-cache`, `must-revalidate`, `s-maxage`/`proxy-revalidate` yang applicable) (§4.2.4). Pengecualian hanya: disconnected, izin eksplisit client/origin (`max-stale`, ekstensi, kontrak out-of-band). Saat validasi dapat 5xx, boleh forward error **atau** perlakukan seolah origin gagal, lalu sajikan stale yang diizinkan / retry (§4.3.3). `must-revalidate` = stale wajib validasi dulu, bila disconnected bangkitkan error (anjuran 504) (§5.2.2.2); dipakai **jika dan hanya jika** kegagalan validasi bisa sebabkan operasi salah (contoh transaksi finansial diam-diam tak tereksekusi). | RFC 9111 §4.2.4, §4.3.3, §5.2.2.2: https://www.rfc-editor.org/rfc/rfc9111.html · MDN `must-revalidate` / `no-cache` vs `no-store`: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control |
| G4 | Invalidation / versioning | Request unsafe (PUT/POST/DELETE, termasuk yang safety-nya unknown) dengan respons non-error **MUST** menginvalidasi target URI; URI `Location`/`Content-Location` **MAY** diinvalidasi, **MUST NOT** bila origin-nya beda (anti-DoS) (§4.4). Praktik client-cache modern: `staleTime` (fresh→stale), `gcTime` (sampah setelah 5 mnt inaktif default), `invalidateQueries` menandai stale + refetch yang sedang dirender; retry gagal default 3x backoff eksponensial. | RFC 9111 §4.4: https://www.rfc-editor.org/rfc/rfc9111.html · TanStack Query Invalidation: https://tanstack.com/query/latest/docs/framework/react/guides/query-invalidation · TanStack Important Defaults (staleTime/gcTime/retry): https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults · TanStack Caching lifecycle: https://tanstack.com/query/latest/docs/framework/react/guides/caching |
| G5 | Stampede / dedupe / collapse | Cache boleh **collapse requests** — gabung banyak request masuk jadi satu forward request saat miss (§4, paragraf collapse). Client modern mendedupe: request kunci-sama dalam `dedupingInterval` (default 2000 ms) digabung; `focusThrottleInterval` (default 5000 ms) menahan revalidasi fokus berulang; polling `refreshInterval` default mati, `refreshWhenHidden/Offline` default mati. | RFC 9111 §4 (collapse requests): https://www.rfc-editor.org/rfc/rfc9111.html · SWR API dedupe/retry: https://swr.vercel.app/docs/api · SWR Revalidation (focus/interval/reconnect, immutable): https://swr.vercel.app/docs/revalidation · SWR Data Fetching (fetcher per key): https://swr.vercel.app/docs/data-fetching |
| G6 | Corrupt / quota / partial | `no-store` = MUST NOT simpan di non-volatile + best-effort hapus dari volatile (§5.2.2.5). Respons inkomplit/parsial hanya boleh disimpan dalam syarat ketat dan **MUST NOT** dipakai menjawab kecuali sudah komplit atau request range tercakup (§3.3); gabung range mensyaratkan strong validator sama (§3.4). Praktik platform: `cache.put` melempar untuk method non-GET / 206 / `Vary: *`, mengembalikan 413 bila direktif melarang atau respons terlalu besar. | RFC 9111 §5.2.2.5, §3.3–§3.4: https://www.rfc-editor.org/rfc/rfc9111.html · Cloudflare Cache API put/match/delete: https://developers.cloudflare.com/workers/runtime-apis/cache/ |
| G7 | Clock-skew | Perhitungan freshness memakai `Date` origin + `Age` untuk mereduksi skew (§4.2.1 note); saat parsing tanggal: case-insensitive (SHOULD), resolusi rendah → bulatkan ke bawah (MUST), zona lokal MUST NOT memengaruhi, zona selain GMT SHOULD dianggap invalid (§4.2). Praktik: jangan percaya timestamp masa-depan tak terbatas; `Expires` invalid/"0" = sudah expired (§5.3). | RFC 9111 §4.2, §4.2.1, §5.3: https://www.rfc-editor.org/rfc/rfc9111.html |
| G8 | Provenance / label + sensitive-data | Cache key minimal = method + target URI; `Vary` memilih respons negosiasi-konten, `Vary: *` selalu gagal match (§2, §4.1). `private` = shared cache MUST NOT simpan (private cache MAY); `public` menandai cacheable eksplisit termasuk margin auth tertentu (§5.2.2.7/§5.2.2.9, §3.5). Isi cache = informasi sensitif yang harus dilindungi; user-agent wajib beri kontrol hapus (§7). Poisoning via shared cache memperluas jangkauan penyerang (§7.1). `Set-Cookie` tidak menghambat caching — server wajib kirim `Cache-Control` yang tepat (§7.3). `no-store`/`private` bukan jaminan privasi terhadap cache jahat/penyadap (§5.2.1.5/§5.2.2.5). Browser storage: hindari data sensitif di `localStorage` (bypass auth lokal, dicuri/ditulis via satu XSS, tanpa batasan path, satu origin berbagi semua app); session identifier jangan di `localStorage` (gunakan cookie `httpOnly`); butuh persisten → `sessionStorage` bila cukup; perlakukan isi storage sebagai input tak tepercaya. | RFC 9111 §2, §4.1, §3.5, §5.2.2.7, §5.2.2.9, §7, §7.1, §7.3: https://www.rfc-editor.org/rfc/rfc9111.html · MDN private vs shared cache + Vary: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching · OWASP Cache Poisoning: https://community.owasp.org/attacks/Cache_Poisoning · OWASP HTML5 Security Cheat Sheet — Storage APIs: https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html |
| G9 | Edge / durable vs per-isolate + D1/KV konsistensi | Isolate V8 = sandbox ringan, tidak long-lived, bisa di-evict; **jangan andalkan mutable global state**, tidak ada jaminan dua request mendarat di instance sama. KV = eventually-consistent, tulis di pusat lalu cache global; perubahan bisa s.d. 60 dtk+ baru terlihat di lokasi lain; negative lookup ikut ter-cache; `cacheTtl` default 60 s; untuk konsistensi tulis butuh Durable Objects. D1 read-replication = replika read-only async + Sessions API untuk sequential consistency (bookmark); tanpa Sessions semua query ke primary. DeFiLlama: dua API terpisah — Free (`https://api.llama.fi`, tanpa auth) vs Pro (`https://pro-api.llama.fi/{KEY}`); jangan campur; endpoint TVL sederhana `GET /tvl/{protocol}`, histori pool `GET /chart/{pool}`. | Cloudflare How Workers works (isolates): https://developers.cloudflare.com/workers/reference/how-workers-works/ · Cloudflare How KV works: https://developers.cloudflare.com/kv/concepts/how-kv-works/ · Cloudflare D1 read replication + Sessions: https://developers.cloudflare.com/d1/best-practices/read-replication/ · DeFiLlama API docs: https://api-docs.defillama.com/ |

## 3. Observed-vs-expected (4 permukaan utama + 2 pendukung)

### P1 — vaultFacts live overlay (TTL 6h) + snapshot CAPTURED_AT + gate 30d

Observed (`frontend/src/strategy/vaultFactsLive.js`): `TTL_MS = 6*60*60*1000`, `CACHE_KEY='vf_vault_facts_live_v1'`, baca `fetchedAt` → pakai bila `now()-fetchedAt < TTL_MS`; `catch{}` → corrupt = refetch; tulis dibungkus `try{}` → quota/non-fatal; fetch per-slug `Promise.all`, satu slug gagal tidak meracuni sisanya; hanya angka `tvl` yang di-overlay, kualitatif tetap snapshot; fail-open ke snapshot.

Observed (`frontend/src/strategy/vaultFactsSnapshot.js:48`): `CAPTURED_AT = Date.parse('2026-09-01T00:00:00Z')`, `asOf` = tanggal capture, bukan `Date.now()`; komentar recapture eksplisit: satu `CAPTURED_AT` mencap seluruh file, `*-base` carried-forward ("re-affirmed, NOT re-measured").

Observed (`frontend/src/strategy/eligibilityGate.js:14-15,24-29`): `MAX_FACT_AGE_MS = 30*86_400_000`, `MAX_TOKEN_AGE_MS = 15*60_000`; `factPresent` menolak `value==null` dan `asOf` bukan number dan umur > 30d; `evaluate` fail-closed (alasan missing/outdated, audit, skor, lifeboat screen).

| Gate | Expected | Observed | Nilai |
|---|---|---|---|
| G1 TTL eksplisit | freshness lifetime eksplisit per entry | TTL 6h overlay + `asOf` per fakta + 30d gate + token 15 mnt | ✅ lolos |
| G3 fail-open/closed | `must-revalidate` untuk finansial; arah gagal harus sadar | Overlay fail-open ke snapshot, gate fail-closed; token 15 mnt menutup jendela | ✅ lolos dengan catatan |
| G5 stampede | collapse/dedupe | `Promise.all` per-slug tanpa dedupe lintas-tab; tanpa `AbortSignal.timeout` di file ini | ⚠️ celah kecil: burst antar-tab + fetch gantung |
| G6 corrupt/quota | tangani corrupt + quota | `catch` corrupt→refetch, `catch` quota non-fatal | ✅ lolos |
| G7 clock-skew | jangan percaya future tak terbatas | Tidak ada clamp future di overlay (bandingkan `freshness.js` yang punya `MAX_CLOCK_SKEW_MS`) | ⚠️ inkonsisten — adopsi clamp 60s |
| G8 provenance | key + label + Vary/private | Overlay `{refreshed:{tvl}, asOf}` + `source:'snapshot'/'live'`; mapping `LLAMA_SLUG` eksplisit | ✅ lolos |
| G9 upstream | hormati rate-limit upstream | DeFiLlama Free tanpa auth; 6h menekan call; pola 60s untuk feed gratis | ✅ lolos |

### P2 — money/positions `localStorage` (freshness.js + myMoneyModel + app.jsx + positionsStore + scopeRehydrate)

Observed (`frontend/src/money/freshness.js`): `DEFAULT_STALE_AFTER_MS=2*60*1000` (headroom di atas poll 15s app.jsx), `MAX_CLOCK_SKEW_MS=60*1000` (future kecil = current, selebihnya = unavailable — anti "healthy" palsu Fix 6); `classifyFreshness` (current/stale/unavailable); `withCacheFallback` (fresh gagal → cache jadi stale "Last confirmed", tidak pernah nol tebakan); token rekonsiliasi anti-overwrite baca basi pasca-aksi.

Observed (`frontend/src/app.jsx:979-1001`): `MONEY_CACHE_SCHEMA_VERSION=2`; `loadMoneyCache` menolak versi tak dikenal → `{}` (miss penuh, tak pernah percaya parsial); `saveMoneyCache` non-fatal saat quota; key per-owner case-insensitive.

Observed (`frontend/src/store/positionsStore.js`): `yv_positions_<addr>`/`yv_agents_<addr>`; `reconcilePositionsFromChain` wajib `agents` eksplisit (tanpa fallback demo), `null` bila semua gagal (caller pertahankan snapshot), saldo `'0'` = entry eksplisit untuk prune, `agentStatus` non-enumerable; `mergePositions` hanya-naik, `applyChainPositions` otoritatif (hanya saat chain proven-current).

Observed (`frontend/src/stellar/scopeRehydrate.js`): union 3 sumber (event `Deployed` router + cache browser + registry legacy) didedupe per alamat, lalu **chain otoritatif** via `scope_of` per agen (`allSettled` + drop null); `warnIfRetentionShort` bila retensi RPC < grant 7d.

| Gate | Expected | Observed | Nilai |
|---|---|---|---|
| G1/G2 | stale eksplisit + SWR | Triple `checkedAt/confirmedLedger\|Block/source` + label current/stale/unavailable; fallback stale berlabel | ✅ lolos — pola SWR berlabel terbaik di repo |
| G3 | arah gagal sadar | Gagal → stale/unavailable, tak pernah nol; klaim "all" hanya bila `status==='complete'` | ✅ lolos |
| G4 | unsafe → invalidate; versioning | Schema-version 2 + miss-penuh; token rekonsiliasi pasca-mutasi | ✅ lolos |
| G6 | corrupt/quota/partial | `try/catch` JSON + quota non-fatal; partial discovery dipertahankan sebagai partial | ✅ lolos |
| G7 | clock-skew | `MAX_CLOCK_SKEW_MS` 60s + `confirmedLedger 0` tak pernah dipakai sebagai "sudah cek" | ✅ lolos — jadikan standar repo |
| G8 | minimalisasi localStorage | Posisi/saldo + scope (bukan secret) di cache; LegacyAutoExitCleanup hanya-inspeksi + hapus eksplisit | ✅ lolos dengan catatan: audit berkala `localStorage` tetap wajib per OWASP |

### P3 — agent-index API (`max-age=15` + durable rate-limit)

Observed (`frontend/api/agent-index.js:29`): `PUBLIC_GET_CACHE='public, max-age=15'` — GET publik boleh di-cache 15s menyerap polling; komentar menegaskan durable-limited (baris D1 per IP+route, bukan memori per-isolate).

Observed (`frontend/api/durableRateLimit.js`): tier `strictWrite 30/mnt`, `authenticatedStatus 120/mnt`, `publicRead 240/mnt`; upsert atomik satu-statement (`ON CONFLICT ... RETURNING`); validasi baris + toleransi rollback jam yang hanya sah pasca-increment.

| Gate | Expected | Observed | Nilai |
|---|---|---|---|
| G1 | `max-age` + `Age` | `public, max-age=15` untuk GET baca-berat | ✅ lolos |
| G4/G5 | invalidation + anti-stampede | Rate-limit durable per IP+route (bukan memori isolate) + upsert atomik | ✅ lolos — jawaban benar untuk topologi Workers |
| G8 | `private` untuk personal; `Vary`/key | GET dibaca publik + otoritas segar via `readContract`, bukan petunjuk browser/lokal | ✅ lolos; pastikan respons personal tak ikut `public` bila ada |
| G9 | isolate vs durable; KV eventual | Komentar kode tepat: shared-D1-row, bukan per-isolate memory | ✅ lolos |

### P4 — APY history `Map` in-memory (tanpa TTL)

Observed (`frontend/src/history/apyHistory.js:5-48`): `const cache = new Map()`, `TIMEOUT_MS=8000`, `CHART_ENDPOINT='https://yields.llama.fi/chart'`, `HISTORY_DAYS=7`; `fetchApyHistory` never-throw (null saat gagal), `cache.has→get` tanpa expiry/evict, `fetchApyHistoryBatch` via `Promise.all` tanpa concurrency-limit; komentar "In-memory cache only (no localStorage) — one network fetch per pool per session".

| Gate | Expected | Observed | Nilai |
|---|---|---|---|
| G1 | TTL/freshness eksplisit | Tanpa TTL/invalidasi — entry hidup selama sesi; heuristik implisit "sekali per sesi" | ⚠️ **tidak lolos penuh**: tambah TTL (mis. 5–15 mnt) + cap ukuran/LRU |
| G4 | gc/invalidation | Tanpa `gcTime`/evict; `Map` tumbuh per poolId | ⚠️ tambah batas + hapus per key/batch |
| G5 | dedupe/collapse | Dedup alami hanya untuk call berurutan pasca-isi; request konkuren sama-key = fetch ganda (tanpa inflight-map); batch tanpa limit | ⚠️ tambah inflight-dedupe + batasi konkurensi |
| G6 | timeout/partial | `AbortController` 8s + null-saat-gagal + `filter null` di batch | ✅ lolos |
| G8 | poisoning | `encodeURIComponent(poolId)`, hanya baca GET publik DeFiLlama | ✅ lolos |
| G9 | hormati upstream | Yields `chart/{pool}` endpoint publik; tanpa TTL = tiap sesi 1x masih sopan, tapi tab ganda/session panjang menumpuk | ⚠️ lihat G1 |

### P5 (pendukung) — keeper radar `refprices` 60s

Observed (`keeper/src/refprices.js:5-31`): `CACHE_MS=60_000` per-URL dot-path; gagal-semua → `null` (detektor mati, bukan trigger); hanya isi cache bila `prices.length>0` (anti-poison kosong); evaluasi per-ledger (~6s), poll 2s.

Nilai: ✅ lolos — TTL eksplisit + all-failed-null + no-empty-poison selaras RFC 9111 §4.2 dan KV cacheTtl 60s; catatan: cache module-level satu-proses dan tanpa inflight-dedupe (kecil, tick per-ledger).

### P6 (pendukung) — relayer store (SQLite durable + file atomic)

Observed (`relayer/src/store.mjs`): tanpa `set/has/all` generik — semua mutasi compare-and-transition; file-backend tulis-sibling-lengkap + fsync + atomic-rename (crash-safe satu-proses, **bukan** eksklusi multi-proses); produksi memakai SQLite `cctpRelays`; legacy `pending/minted` → terminal `blocked/legacy_record_unrecoverable` (fail-closed).

Nilai: ✅ lolos — CAS atomik + durabilitas terdokumentasi selaras peringatan Workers isolates dan perlunya D1 Sessions untuk konsistensi tulis.

## 4. Keputusan gate per permukaan

| Permukaan | Keputusan | Syarat sisa (kecil, non-blokir kecuali APY) |
|---|---|---|
| vaultFacts 6h + 30d | ✅ Lolos bersyarat | Clamp clock-skew 60s di overlay (samakan `freshness.js`); pertimbangkan `AbortSignal.timeout` + revalidasi fokus/interval ala SWR. |
| money/positions localStorage | ✅ Lolos | Pertahankan pola label-freshness + schema-version + token; audit `localStorage` berkala (OWASP). |
| agent-index 15s | ✅ Lolos | Verifikasi tak ada payload personal di respons `public`. |
| APY Map | ⚠️ Lolos sebagian — wajib TTL + evict + inflight-dedupe | TTL 5–15 mnt, cap/LRU, inflight `Map<key,Promise>`, limit konkurensi batch. |
| radar 60s / relayer SQLite | ✅ Lolos | Catat batas satu-proses di komentar (sudah ada). |

## 5. Daftar sumber primer

- https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching
- https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control
- https://www.rfc-editor.org/rfc/rfc9111.html
- https://tools.ietf.org/html/rfc5861#section-3
- https://fetch.spec.whatwg.org/#concept-stale-while-revalidate-response
- https://web.dev/articles/stale-while-revalidate
- https://tanstack.com/query/latest/docs/framework/react/guides/caching
- https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults
- https://tanstack.com/query/latest/docs/framework/react/guides/query-invalidation
- https://swr.vercel.app/docs/data-fetching
- https://swr.vercel.app/docs/revalidation
- https://swr.vercel.app/docs/api
- https://community.owasp.org/attacks/Cache_Poisoning
- https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html
- https://developers.cloudflare.com/workers/reference/how-workers-works/
- https://developers.cloudflare.com/workers/runtime-apis/cache/
- https://developers.cloudflare.com/kv/concepts/how-kv-works/
- https://developers.cloudflare.com/d1/best-practices/read-replication/
- https://api-docs.defillama.com/

*Catatan keterbatasan: isi kode dikutip dari working-tree per 2026-09-12; bila tree bergeser, cari konstanta (`TTL_MS`, `CAPTURED_AT`, `MAX_FACT_AGE_MS`, `MONEY_CACHE_SCHEMA_VERSION`, `PUBLIC_GET_CACHE`, `CACHE_MS`, `new Map()`) sebagai jangkar.*
