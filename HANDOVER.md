# HANDOVER — Sesi Rate Limiting Gate Fix

Tanggal: 2026-09-12
Branch: `iq`

## Ringkasan eksekutif

Review gate Rate Limiting awalnya TIDAK LOLOS (relay+faucet in-memory per-isolate, self-mint key tak terbatas, dst). Setelah fix, gate DINYATAKAN LOLOS dengan prasyarat deploy.

Fix berada di commit `iq` (21 file, tanpa `DEPLOY_CHECKLIST.md` — file itu SENGAJA dihapus dari `iq` atas permintaan user; riwayat: pernah ke-push lalu di-revert via force-with-lease, lalu push ulang bersih).

Commit handover ini (`Add session handover`) menjadi HEAD baru `iq` setelah commit fix tersebut.

## Peta branch

- `iq` = fix bersih (HEAD baru setelah commit handover ini).
- `dev` = 23bbd9e8 (masih berisi `DEPLOY_CHECKLIST.md` + versi pra-koreksi — lokal saja).
- `backup-iq-work` = 706b7d80 (cadangan).
- `untitled.md` = file untracked asing, jangan sentuh.

Perhatian: `docs/` di-gitignore — handover ini SENGAJA di root repo (`HANDOVER.md`) agar tracked.

## Perubahan per area (file + perilaku)

Semua di bawah ini adalah isi commit fix `iq` (21 file), bukan commit handover ini:

- `stellar-relay`: durable per-IP 15/mnt + global backstop 1000/hari.
- `faucet`: D1 UPSERT + kompensasi + migrasi 0011.
- `_vfauth`: owner-first + owner cap 1000 + Retry-After.
- `keys`: cap 10/owner + scope caps + throttle.
- `usage`/JWT: throttle.
- `agent-index`: durable reads + cache 15s.
- `relayer` ingress limiter: 60/mnt.
- `faucet` mock: arrow→function (baseline failure HEAD, bukan regresi).

Catatan `DEPLOY_CHECKLIST.md`: SENGAJA tidak ada di `iq` atas permintaan user. Riwayat: pernah ke-push lalu di-revert via force-with-lease, lalu push ulang bersih.

## Verifikasi (angka + batasnya)

Angka di bawah dilaporkan worker, terverifikasi via read:

- 8 suite terarah: 251/251 hijau + eslint 0.
- Rincian: stellar-relay 137, faucet 21, _vfauth 8, keys 7, usage 3, durableRateLimit 18, agent-index 50, ingress 7.
- Full `npm test` TIDAK di-run ulang; klaim full-suite lama dibuang sebagai unverified.

## Status live Cloudflare

Akun: heiseikamenrider20@gmail.com.

- D1 `vf-gate` remote: 0001–0011 applied (0011 applied sesi ini).
- Secrets: 8/8 wajib di production DAN preview (RELAYER_PROXY_KEY disinkron manual user; REPORTER+CURSOR oleh worker).
- Deployments: prod `main@f969d7b` (2 minggu), preview `dev@ddb7402` — branch `iq` BELUM ter-deploy ke env mana pun.

## Yang belum / next steps

1. Deploy `iq` ke Pages (butuh keputusan + gotcha vars dashboard).
2. D1 preview (`vf-gate-preview`) belum wiring di `wrangler.jsonc` (placeholder) + 0011 belum apply ke preview.
3. Relayer tidak sedang jalan (dev-tunnel lokal, start manual).
