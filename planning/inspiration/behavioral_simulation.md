# Behavioral Simulation
### Lapisan perilaku untuk memperkaya simulasi — mock agent (inti) + deep mode (opsional)

> Dokumen ini memperluas **dokumen Simulasi (Alternate Future)**. Di sana, Monte Carlo menghasilkan sebaran risiko dari parameter pasar. Dokumen ini menjelaskan bagaimana **perilaku manusia** (panik, herd, sentimen) dimasukkan ke dalam parameter itu agar sebarannya lebih realistis. Baca dokumen Simulasi dulu untuk konteks fan-out/fan-in dan Monte Carlo.

---

## 1. Masalah: Monte Carlo polos itu naif soal manusia

Monte Carlo standar menggiling skenario dengan asumsi harga bergerak acak sesuai distribusi tetap. Tapi pasar nyata tidak begitu: saat harga turun, orang **panik dan menjual bersamaan**, yang membuat penurunan makin dalam. Itu *herd behavior* — dan Monte Carlo polos tidak menangkapnya.

Lapisan ini menambahkan perilaku itu. Bukan dengan membuat ribuan agen LLM yang masing-masing "berpikir" (mahal & lambat), tapi dengan pendekatan bertingkat yang memakai alat termurah yang cukup untuk tiap kebutuhan.

---

## 2. Dua jenis kedalaman perilaku (menentukan alat mana yang dipakai)

| | **Agregat** | **Emergent / naratif** |
|---|---|---|
| Contoh | Pas panik, korelasi naik, volatilitas melonjak, herd selling | Rumor menyebar, klaster opini terbentuk sendiri dari interaksi |
| Sifat | Efek massa — bisa ditiru lewat aturan | Muncul sendiri — tak bisa ditebak dari aturan |
| Relevansi | Inti manajemen risiko portofolio | Lebih ke prediksi sentimen/opini publik |
| Alat | **Mock agent (murah)** | **MiroFish deep mode (mahal, sesekali)** |

Poin penting: untuk **manajemen risiko portofolio**, kebutuhan hampir selalu **agregat** — "seberapa dalam portofolio jatuh saat semua panik". Itu efek agregat, mock agent cukup. Kedalaman emergent baru relevan untuk skenario yang menyentuh sentimen sosial (mis. "bagaimana investor ritel Indonesia bereaksi ke berita Fed, dan apakah itu memicu herd selling").

---

## 3. Arsitektur: dua mesin + router

Sebuah router memilih mesin perilaku sesuai kebutuhan skenario. Keduanya memberi makan Monte Carlo yang sama.

```
        Skenario masuk → Router (butuh perilaku apa?)
               │
        agregat│                    │emergent
               ▼                    ▼
     MOCK AGENT (selalu jalan)   MIROFISH DEEP MODE (sesekali)
     matematika murni            ribuan agen LLM
     murah · andal               mahal · lambat
     99% keputusan lewat sini    tombol terpisah, BUKAN jalur kritis
               │                    │
               └────────┬───────────┘
                        ▼
                  Monte Carlo (parameter)
                        ▼
                  sebaran risiko (VaR/CVaR)
```

Aturan desain mutlak: **MiroFish tidak pernah di jalur kritis.** Jika ia lambat/mahal/gagal, sistem inti tetap jalan tanpanya. Itu yang membuat "garnish" benar-benar garnish, bukan bagian yang bisa menjatuhkan demo.

---

## 4. Mock agent — INTI (bangun ini dulu)

Pendekatan bertingkat, dari paling murah. Mulai dari Tingkat 1; naik hanya jika perlu.

### Tingkat 1 — Behavioral parameter (paling murah, mulai di sini)
Tanpa agen sama sekali. Tambahkan parameter ke Monte Carlo yang meniru *efek* perilaku. Contoh: "kalau drawdown lewat −10%, naikkan korelasi antar-aset" (meniru semua orang menjual bersamaan saat panik). Beberapa baris matematika tambahan di Python. Nol biaya LLM. **~80% nilai "dunia simulasi" didapat dari sini.**

### Tingkat 2 — Mock agent sederhana (kalau Tingkat 1 kurang kaya)
Buat beberapa *tipe* agen (bukan ribuan individu): mis. "panic seller", "value buyer", "momentum follower" — masing-masing aturan if-then sederhana. Saat simulasi jalan, tiap tipe bereaksi ke harga sesuai aturannya. Masih matematika murni, masih murah. (Rujukan: FCLAgent, arXiv:2510.12189 — keputusan beli/jual per situasi, tapi harga/volume tetap rule-based.)

### Tingkat 3 — LLM kalibrasi (sekali di awal, opsional)
Kalau tak mau mengarang aturan mock sendiri, pakai LLM **sekali** untuk mengusulkan pola perilaku realistis, lalu bekukan jadi aturan Tingkat 2. LLM tidak pernah jalan saat simulasi — hanya saat menyiapkan aturan. Sekali bayar, dipakai ribuan kali gratis. (Rujukan: paper stablecoin arXiv:2601.22168 — mock agent terkalibrasi ~1000x lebih murah dari agen LLM penuh.)

**Saran:** mulai Tingkat 1, naik ke Tingkat 2 kalau sempat, Tingkat 3 hanya kalau ingin. Karena lapisan ini di luar inti (Council + Monte Carlo), berhenti di tingkat yang tidak merusak fokus utama.

---

## 5. MiroFish deep mode — OPSIONAL (garnish, bukan main course)

> **Status: jalur opsional. BUKAN untuk versi pertama hackathon.** Bangun hanya jika inti (Council + Monte Carlo + mock agent + eksekusi Stellar) sudah solid dan masih ada waktu. Boleh disebut di pitch sebagai arsitektur/roadmap meski belum diimplementasi penuh.

### Apa itu MiroFish
Engine prediksi multi-agen open-source (powered by OASIS/CAMEL-AI) yang membangun "dunia paralel digital" berisi ribuan agen LLM dengan kepribadian & memori, lalu mengamati perilaku emergent. Viral Maret 2026 (#1 GitHub trending, inkubasi Shanda Group). Persis konsep "dunia simulasi penuh" — tapi sudah jadi, jadi bukan inovasi untuk dibangun ulang.

### Kenapa garnish, bukan inti
- **Mahal di runtime:** ribuan agen LLM + memori (butuh Zep Cloud key) = ribuan panggilan LLM per simulasi. Ini justru masalah token cost yang dihindari sejak awal proyek dengan memilih Monte Carlo. Menjadikannya inti = memutar balik ke masalah yang sudah dipecahkan.
- **Dependency berat:** Node.js + Python + LLM key + Zep = satu layanan eksternal lagi = satu titik gagal lagi saat demo.
- **Berbasis EVM-world tooling:** perlu dicek kecocokannya dengan stack Stellar sebelum integrasi serius.

### Desain garnish yang benar
- Alur normal (99%): Monte Carlo + mock agent. Jalan tiap keputusan, tiap demo.
- Deep mode (tombol terpisah, jarang): user memilih satu skenario penting → MiroFish jalan **sekali** → hasilnya (klaster opini, titik balik) di-feed sebagai **parameter tambahan** ke Monte Carlo. MiroFish tidak menggantikan Monte Carlo; ia memberinya makan, sesekali.

---

## 6. Positioning: kenapa ini justru lebih kuat dari MiroFish

MiroFish hanya punya **satu mode** (mahal, selalu agen penuh). Sistem ini punya **pilihan cerdas** antara murah-cepat (mock) dan dalam-mahal (deep), dipilih otomatis oleh router sesuai kebutuhan.

Itu *engineering judgment* yang bisa ditunjukkan ke juri: bukan "saya pakai MiroFish", tapi **"saya tahu kapan butuh kedalaman penuh dan kapan tidak, dan sistem memilih sendiri."** Lebih impresif daripada sekadar menempelkan tool viral.

Dan pembeda lebih besar dari MiroFish: MiroFish berhenti di **prediksi**. Sistem ini lanjut ke **keputusan (Council) → eksekusi aset nyata (Stellar) dengan gerbang manusia (Permission Layer)**. MiroFish meramal; sistem ini meramal lalu bertindak dengan izin. Itu kelas yang berbeda.

---

## 7. Urutan jujur untuk hackathon

1. **Inti dulu:** Council + Monte Carlo + mock agent Tingkat 1 + eksekusi Stellar testnet. Kalau hanya ini yang kelar, proyek sudah utuh & demo-able.
2. **Kalau ada waktu:** mock agent Tingkat 2.
3. **Bonus (jika inti solid & waktu sisa):** MiroFish deep mode sebagai satu contoh, atau cukup sebagai roadmap di pitch.

Pelajaran dari Vibing Farmer: plumbing yang makan waktu (dulu Vercel/Cloudflare) mencuri jatah yang seharusnya untuk logika inti. Integrasi MiroFish + Zep berpotensi jadi "plumbing" baru yang sama. Inti dulu solid, garnish belakangan.

---

## 8. Batas jujur

- **Mock agent meniru efek, bukan mereka-reka individu nyata** — Tingkat 1–2 adalah aproksimasi perilaku, bukan prediksi siapa pun.
- **MiroFish bukan inovasi proyek ini** — ia tool yang sudah ada; nilai proyek ada pada router cerdas + jembatan ke eksekusi, bukan pada simulasi agen itu sendiri.
- **Tidak ada klaim akurasi pasti** — lapisan perilaku memperkaya sebaran, tetap sebaran, bukan ramalan satu angka.

---

*Ringkasan satu kalimat:* **Perilaku manusia dimasukkan ke simulasi lewat dua mesin — mock agent murah untuk efek agregat (inti, selalu jalan) dan MiroFish untuk perilaku emergent (garnish opsional, sesekali) — dengan router yang memilih sesuai kebutuhan, dan MiroFish tidak pernah di jalur kritis.**