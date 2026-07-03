# Vibing Farmer — Master Strategy Document

> **Riset Pemenang · Roadmap · Feature Spec · Innovation Thesis · Scorecard**
> Untuk: APAC Stellar Hackathon — Final Submission 15 Juli 2026
> Chain: Single-chain Stellar / Soroban (real yield via Blend Capital) · Track: DeFi & Liquidity
> Disiapkan untuk Faiq · 27 Juni 2026

---

## Daftar Isi

- [Ringkasan Eksekutif](#ringkasan-eksekutif)
- [Bagian 1 — Riset Pemenang WCHL25](#bagian-1--riset-pemenang-wchl25)
- [Bagian 2 — Innovation Thesis](#bagian-2--innovation-thesis)
- [Bagian 3 — Feature Spec & Roadmap](#bagian-3--feature-spec--roadmap)
- [Bagian 4 — Judging Scorecard](#bagian-4--judging-scorecard)
- [Bagian 5 — Catatan Keamanan Implementasi](#bagian-5--catatan-keamanan-implementasi)
- [Sumber](#sumber)

---

## Ringkasan Eksekutif

Dokumen ini menggabungkan seluruh hasil riset & strategi Vibing Farmer (VF) menjadi satu artefak. Disusun dari pembedahan langsung 20 project pemenang WCHL25 (DoraHacks) + riset perilaku & pasar dari X dan media, dipetakan ke kriteria juri APAC Stellar Hackathon.

> **Posisi VF dalam satu kalimat:**
> VF adalah **yield aggregator (track DeFi)** yang menang bukan dengan "menang lebih banyak", tapi dengan **melindungi**: satu izin di awal → tolak yang berbahaya sebelum masuk → jaga batas ruginya → jelaskan tiap langkah → keluar kapan saja.

### Lima Temuan Kunci

1. **Differentiator VF kosong di pasar.** Dari 7 pemenang + StellarYield (kompetitor terdekat di Stellar), tidak ada yang punya human-in-the-loop + explainability + proteksi sebagai inti. Itu milik VF.
2. **Risiko terbesar = kredibilitas, bukan fitur.** GAP-1 (balance 10× salah) & GAP-2 (yield mock) langsung menjeblokkan kriteria Technical 25% ("does it run"). **Update 28 Jun:** GAP-1 fixed (7-dp helper) + GAP-3 fixed (jejak EVM dibersihkan); GAP-2 SELESAI — Blend real yield live di testnet (cutover 28 Jun, round trip supply→harvest→redeem terbukti on-chain). Ketiga gap kredibilitas tertutup.
3. **Performance fee 10–15% sudah tervalidasi pemenang** (RotateChain 15%, Plantify 7.5%+2.5%, Yearn 20%).
4. **Lima masalah nyata (X+news) kini tertutup penuh** oleh ide inovasi 3-lapis perlindungan.
5. **Skor prediksi: ~43.5 → ~78** (realistis ~70 dengan diskon hackathon); 61% kenaikan dari 2 kriteria berbobot 25%.

> **Prioritas absolut (ROI tertinggi):**
> 1. ~~**Tuntaskan GAP-2 (Blend live cutover)**~~ ✅ DONE 28 Jun — GAP-1/2/3 semua fixed; real yield live di testnet → Technical 25% terkunci.
> 2. **Re-frame user nyata** (+10 poin, nyaris tanpa kode) — "orang takut IL/rug/kelelahan", bukan degen.
> 3. **Tonjolkan 3-lapis perlindungan** (+6 poin) — "not a clone".

---

## Bagian 1 — Riset Pemenang WCHL25

20 project pemenang lintas 5 region (Americas, Europe, Africa, India, Asia). Hadiah: 1st $7k · 2nd $4k · 3rd $2k · HM $500. Yang ditandai ★ = linear dengan VF.

| Region | Project linear dgn VF (★) | Pelajaran inti |
|--------|---------------------------|----------------|
| Asia 1st | **SplitSafe** | Positioning bersih ("no bridges, no wrappers") + demo live + test asset ke juri |
| Asia 2nd | **Fradium** | Deteksi risiko SEBELUM transaksi; trust sbg produk; problem berbasis angka |
| Asia 3rd | **Plantify** | AI Co-Pilot yang menjelaskan; compliance/KYC; revenue jelas |
| Europe 2nd | **BIT10** | 1 token = basket; auto-rebalancing; RugGuard AI risk alerts |
| Africa 2nd | **OHMS** | Agent on-chain auditable; human-approval & policy engine (di roadmap) |
| Africa 3rd | **RotateChain** | Performance fee 15% eksplisit; "real payments, not simulations"; arisan on-chain |
| Americas 3rd | **Prometheus** | Satu visi koheren, eksekusi penuh ("we built it all") |

### 7 Pola Kemenangan (lintas project)

1. **Real asset, bukan simulasi** — RotateChain & SplitSafe jual "real, not simulations" → VF fix GAP-2 via Blend real yield (contract done; cutover nyalain di live).
2. **Live & deployable demo** — Canister/testnet ID + video 2–5 menit → VF butuh demo end-to-end live.
3. **Problem statement tajam + angka** — Fradium buka dgn $2.5B scam → VF pakai data IL/hack + kutipan X.
4. **Revenue model eksplisit** — RotateChain 15%, Plantify 7.5%+2.5% → VF performance fee 10–15%.
5. **Composability, bukan reinvent** — BIT10 6+ partner, oracle → VF frame Blend Capital + DeFiLlama sbg integrasi.
6. **Trust/safety sebagai produk** — Fradium & Prometheus jual trust → VF angkat risk+permission ke headline.
7. **Eksekusi > ambisi** — Prometheus "built it all" → VF demo 1 alur penuh > 4 fitur setengah.

> *Catatan: WCHL25 = ekosistem ICP, bukan Stellar. Yang dipindah adalah POLA-nya (framing, revenue, kualitas demo, positioning), bukan detail teknis.*

---

## Bagian 2 — Innovation Thesis

> *Metode: data sebagai kompas, bukan rem. Sinyal yang "mengarah" → cukup. Ide yang jelas memecahkan masalah nyata tapi datanya tipis → tetap jalan.*

### Lima Masalah Nyata (X + news)

| # | Masalah | Bukti |
|---|---------|-------|
| 1 | Impermanent Loss | "APY 500%, harvest sekali, LP rugi 30% ke IL" |
| 2 | Smart contract exploit / hack | $2.9B hilang 2025 (bug, oracle, reentrancy) |
| 3 | Rug pull / ponzi APY | "the farms died, the ponzis collapsed" |
| 4 | Manual / exhausting | monitor, harvest, rebalance = full-time job |
| 5 | Volatility / capital idle | capital nyangkut/idle, miss peluang |

### 7 Lensa Pemenang → Ide VF

| Lensa | Cara mereka selesaikan masalah | Pinjaman VF |
|-------|-------------------------------|-------------|
| BIT10 | Hapus pilihan yang bikin lumpuh | Satu keputusan, bukan dashboard |
| RotateChain | Pindahkan perilaku yang sudah ada | Mental model familiar ("nitip ke yg ngerti") |
| SplitSafe | Trust jadi struktur, bukan janji | Proteksi fail-closed, bukan klaim |
| Fradium | Deteksi bahaya SEBELUM transaksi | Risk check sbg gerbang pra-eksekusi |
| Plantify | Alat untuk yakin sebelum komit | "Tanya kenapa" → berani putuskan tenang |
| Prometheus | Satu visi, eksekusi penuh | Pilih 1 masalah inti, tuntas |
| StellarYield | Selesaikan sampai uang keluar | Exit ditonjolkan di depan |

**Pola meta:** semua pemenang menyelesaikan masalah dengan **mengurangi beban mental user di titik keputusan** — bukan dengan lebih banyak fitur atau AI lebih canggih.

### Ide Inovasi: One-Decision Vault — 3 Lapis Perlindungan

**🔴 Lapis 1 — SEBELUM MASUK: Gerbang Kelayakan** *(menambal #4 & #5)*
- **Tes 1 — Yield real atau ponzi?** Bandingkan yield dibagikan vs revenue protokol (DeFiLlama/Token Terminal). Bagi $10M tapi revenue $3M → sinyal ponzi.
- **Tes 2 — Rawan hack/rug?** Skor 0–100 dari audit, umur contract, TVL, admin key, rekam jejak. Di bawah ambang → ditolak otomatis.

**🔵 Lapis 2 — SELAMA JALAN: Target Max Loss + penjelasan** *(menambal #1 & #3)*
- "Tenang/Seimbang/Berani" jadi **kontrak**, bukan label. Risk agent berusaha menarik dana sebelum batas rugi tembus. *(Pakai "target", bukan "dijamin" — lihat Bagian 5.)*
- Tiap aksi + 1 kalimat + tombol "kenapa?" → user berani diam (lawan panic-sell).

**🟢 Lapis 3 — KAPAN SAJA: One Decision + Exit Mudah** *(menambal #2 & capital-stuck)*
- Masuk = satu pertanyaan familiar. Agent rakit sisanya.
- Exit dijual di depan: "Masuk satu keputusan. Keluar satu ketukan."

> **Permission layer jadi berbobot** — satu kalimat izin mengandung ketiga lapis:
> *"Aku mau taruh di vault X. Yield-nya real (ditutup revenue Aave), skor keamanan 92/100, target batas rugi −5%. Lanjut?"*

### Peta Penutupan Masalah

| # | Masalah | Tertutup oleh | Lapis |
|---|---------|---------------|-------|
| 1 | Impermanent Loss | Target max loss | 2 |
| 2 | Manual / exhausting | One decision + agent otonom | 3 |
| 3 | Volatility / capital idle | Max loss + exit mudah | 2+3 |
| 4 | Smart contract exploit | Gerbang Kelayakan: skor keamanan | 1 |
| 5 | Rug pull / ponzi APY | Gerbang Kelayakan: yield-reality check | 1 |

---

## Bagian 3 — Feature Spec & Roadmap

Effort = ideal dev-days. Tim 3+ devs, kapasitas ~42 dev-days (14 hari efektif). Total fitur 34, MVP terkunci 25.

### Daftar Fitur, Prioritas & Effort

| Fitur | Prio | Effort | Status (audit 28 Jun) | Acuan |
|-------|:----:|:------:|------------------------|-------|
| F1 Fix decimal 1e6→1e7 (GAP-1) | **P0** | 1 | ✅ done (sub-proj #1) | Kredibilitas demo |
| F2 Cleanup jejak EVM (GAP-3) | **P0** | 2 | ✅ done (sub-proj #1) | Kredibilitas demo |
| F4 Real Yield Vault — Blend Capital (Stellar, GAP-2) | **P0** | 6 | ✅ done — Blend real yield live di testnet (cutover 28 Jun; supply→harvest→redeem terbukti live) | RotateChain, SplitSafe |
| F5 Audit trail / on-chain proof | **P0** | 3 | ✅ done — Soroban attestation deployed testnet (CDDOW2FZ…D7DUO2K6) + frontend wired (relayer fee-bump 0 XLM, non-blocking); live smoke tx 8ceb03ee (28 Jun) | OHMS, SplitSafe |
| F6 Permission Layer (headline) | P1 | 2 | ✅ done | unik VF |
| F7 AI Council branded + reasoning | P1 | 3 | ✅ done | Plantify |
| F8 Regulation-aware Risk agent | P1 | 2 | ✅ done — fail-closed pre-exec eligibility gate (ponzi<1.5/audit/staleness 30d) + basket filter + worker assert; ⚠️ vaultFacts snapshot placeholder → run refreshVaultFacts.mjs pre-demo | Fradium, Plantify |
| F9 Auto-Rebalancing engine | P2 | 4 | ⬜ belum (cuma jadi action yg di-reasoning council) | BIT10 |
| F10 Real-time Risk Alerts | P2 | 3 | ⬜ belum (AlertCard UI doang, no pipeline) | BIT10×RugGuard |
| F11 Demo video + faucet/guide | **P0** | 2 | ⬜ open (non-kode) | syarat wajib |
| F12 Pitch deck + one-liner | **P0** | 2 | ⬜ open (one-liner sudah ada) | SplitSafe |

> **F3 (CCTP bridge Stellar→Base) DIHAPUS** — dual-chain ditolak; single-chain Blend. CCTP cuma transport (mindahin USDC), bukan yield source.

**MVP terkunci:** F1, F2, F4, F5, F6, F7 + F11 + F12 — semua kode ✅.  **Stretch:** F8 ✅ done, F9 ⬜, F10 ⬜.
**Sisa MVP nyata (kode):** kosong — F4 live cutover + F5 on-chain attestation + F8 risk gate semua ✅ done 28 Jun. Sisa open = non-kode: F11 (demo video + faucet/guide), F12 (pitch deck).

### Timeline 18 Hari (3 Track Paralel)

| Fase (tanggal) | Track A (real yield — Blend) | Track B (AI/diff) | Track C (cleanup+submit) |
|----------------|------------------------------|-------------------|--------------------------|
| 1 (28 Jun–3 Jul) | Blend cutover §7 (redeploy + wiring + faucet) → smoke | Permission + Council UI polish | ✅ GAP-1/GAP-3 done; mulai pitch |
| 2 (4–9 Jul) | Frontend Blend wiring + audit trail (F5) ✅ done 28 Jun | Risk agent (F8) ✅ done 28 Jun + mulai rebalance | Pitch + faucet/guide |
| 3 (10–13 Jul) | Stabilkan + bugfix | Risk Alerts (stretch) | Rekam demo video + dry-run |
| 4 (14–15 Jul) | Code freeze → submit pagi 15 Jul | — | Isi form submission |

> **Decision gate — Hari 6 (3 Juli):**
> **JIKA** Blend cutover sukses (supply→harvest→redeem 1× di pool Blend testnet, APR > 0 atau di-seed) → demo "real yield live".
> **JIKA TIDAK** (pool tipis / ABI drift / waktu habis) → fallback jujur: contract layer + mock-pool tests sbg bukti capability, label "real mechanism, testnet rate", demo tetap bersih.

### Yang Sengaja TIDAK Dibangun

- Bridge / dual-chain (CCTP) — single-chain Stellar utk submission ini; CCTP = transport, bukan yield (dirujuk sbg "future rail"). SplitSafe menang krn menghindari bridge.
- MiroFish deep mode (conceptual; sebut sbg "future").
- Multi-vault fiksi (akar GAP-2).
- Fitur #4 & #5 priority table (Auto-Compounding, Advanced Monte Carlo) — roadmap "next".

---

## Bagian 4 — Judging Scorecard

> **Prediksi skor (dari 100):** Sekarang **43.5** → Setelah perbaikan **78.0** (realistis ~70 dgn diskon hackathon).
> 61% kenaikan datang dari 2 kriteria berbobot 25% — dan separuhnya murni framing, bukan kode.

| Kriteria | Bobot | Now | After | Gain |
|----------|:-----:|:---:|:-----:|:----:|
| Technical impl & Stellar usage | 25% | 4 | 8.5 | **+11.25** |
| Real-world fit & use case | 25% | 5 | 9 | **+10.0** |
| Innovation / differentiation | 20% | 6 | 9 | +6.0 |
| Viability & go-to-market | 10% | 4 | 8 | +4.0 |
| UX & accessibility | 5% | 4 | 8.5 | +2.25 |
| Team & ability to continue | 5% | 6 | 8 | +1.0 |
| **TOTAL** | **100%** | | | **+34.5** |

### Di Mana Usaha = Poin Terbanyak

1. **Technical (GAP-1 & GAP-2)** → +11.25 poin, effort kecil. ROI tertinggi mutlak.
2. **Real-world fit (re-framing user)** → +10 poin, nyaris tanpa kode. ROI per jam tertinggi.
3. **Innovation (tonjolkan 3-lapis)** → +6 poin. Sebagian sudah ada, tinggal dirangkai.
4. **Viability (slide revenue+market)** → +4 poin. Satu slide pakai data riset.

> **Fix GAP + re-frame user saja sudah memindahkan VF dari 43.5 ke ~64.** *(Update 28 Jun: GAP-1/GAP-3 sudah dibereskan + Blend contract layer jadi → sebagian "after" sudah dibank; sisa angkat = Blend live cutover + framing.)*

---

## Bagian 5 — Catatan Keamanan Implementasi

Untuk komponen yang dilingkari di FigJam (Risk Alerts + Emergency Withdraw, dan Council → WAJIB BERHENTI → Permission Layer). **Aman untuk testnet/simulasi** dengan syarat berikut.

### Risk Alerts + Emergency Withdraw + Max Drawdown

- **Emergency Withdraw — scope session key WAJIB sempit:** hanya withdraw ke alamat user sendiri, tidak ke alamat lain, tidak untuk fungsi lain. Scope luas = pintu exploit.
- **Jangan janji "dijamin tidak rugi > X%".** Gap turun cepat / likuiditas kering / oracle telat bisa bikin agent telat tarik. Pakai **"target max drawdown"**, bukan "dijamin". Trust asimetris: 1 janji pecah menghapus 100 keberhasilan.
- **Push notif Telegram/Discord = kabar saja.** Jangan taruh kontrol eksekusi di sana (jangan "balas YES untuk withdraw").

### Council Loop → WAJIB BERHENTI → Permission Layer

- **Desain paling aman (fail-closed).** Selama gerbang "WAJIB BERHENTI" tidak bisa dilewati tanpa approval, ini benar & jadi nilai plus di mata juri.
- **Loop reasoning WAJIB ada max iterations** (mis. 3–5 putaran; kalau belum konvergen → default konservatif / minta input user). Tanpa batas = loop tak berujung + biaya LLM membengkak.
- **Validator harus fail-closed:** kalau angka tidak konsisten dgn simulasi → tolak/berhenti, jangan lanjut.
- **Risk/Compliance (OJK/SEC RAG):** aman utk hackathon; utk produk hati-hati agar output tidak jadi "nasihat finansial" berimplikasi regulasi.

> **Kesimpulan keamanan:** Aman dilanjut untuk hackathon/testnet dengan 4 syarat — (1) scope key Emergency Withdraw sempit, (2) pakai "target" bukan "dijamin", (3) Council kasih max iterations, (4) semua gerbang fail-closed. Saat menyentuh mainnet/dana asli → butuh audit.

---

## Sumber

- [WCHL25 Winners — DoraHacks](https://dorahacks.io/hackathon/wchl25-regional-round/winner)
- [APAC Stellar Hackathon — Rise In](https://www.risein.com/programs/apac-stellar-hackathon)
- Project acuan: [BIT10](https://dorahacks.io/buidl/27340) · [RotateChain](https://dorahacks.io/buidl/30101) · [OHMS](https://dorahacks.io/buidl/27898) · [SplitSafe](https://dorahacks.io/buidl/29649) · [Fradium](https://dorahacks.io/buidl/28746) · [Plantify](https://dorahacks.io/buidl/28781) · [Prometheus](https://dorahacks.io/buidl/28691)

**Riset pendukung (kompas):** DeFi onboarding drop-off (ChainAware, Swapper); real yield vs ponzinomics (Cointelegraph, Eco); DeFi risk scoring (EEA Guidelines, Token Sniffer, ChainAware V3); perilaku retail (Traders Union, PwC 2026); DeFAI market (KuCoin, Coincub, The Block).

---

*Generated 27 Juni 2026 · direkonsiliasi 28 Juni 2026 (CCTP/Aave → Blend single-chain; status F1–F12 dari audit kode) — Vibing Farmer Master Strategy Document*
