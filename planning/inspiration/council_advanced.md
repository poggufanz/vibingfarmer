# AI Council
### Narasi fitur: autonomous loop, debat multi-agen, dan gerbang izin manusia

---

## 1. Apa ini, dalam satu kalimat

AI Council adalah lapisan pengambilan keputusan yang memecah satu keputusan portofolio kompleks menjadi beberapa sudut pandang yang berdebat dari basis berbeda, berputar untuk menyusun argumen, lalu **berhenti** untuk meminta izin manusia sebelum tindakan apa pun dieksekusi.

Tiga komponen yang sebenarnya satu rantai:
- **Council** — beberapa agen yang menimbang keputusan dari sudut berbeda.
- **Autonomous loop** — siklus tempat agen-agen itu berdebat dan menyempitkan argumen.
- **Permission Layer** — gerbang tempat loop wajib berhenti dan menyerahkan keputusan ke manusia.

Memisahkan ketiganya akan menghilangkan inti "kenapa ini aman". Maka dijelaskan sebagai satu cerita.

---

## 2. Posisi dalam sistem (dari mana datang, ke mana pergi)

Council tidak berdiri sendiri. Ia adalah mata rantai tengah:

```
Simulasi (sebaran risiko VaR/CVaR)
        │  memberi BAHAN
        ▼
AI Council  ──loop reasoning──►  konsensus / no-consensus
        │  memberi PERTIMBANGAN
        ▼
Permission Layer (1 kalimat → manusia)
        │  memberi REM
        ▼
Eksekusi (testnet / simulasi)
```

- **Simulasi** memberi *bahan*: sebaran kemungkinan hasil, bukan satu angka pasti. (Detail simulasi ada di dokumen terpisah; di sini ia hanya input.)
- **Council** memberi *pertimbangan*: mengolah sebaran itu menjadi usulan tindakan yang sudah diadu dari beberapa sisi.
- **Permission** memberi *rem*: menerjemahkan hasil debat menjadi satu kalimat dan menunggu keputusan manusia.

---

## 3. Council: siapa agennya dan kenapa mereka tidak sekadar teater

Bahaya terbesar dari "debat multi-agen" adalah menjadi **teater**: kalau semua agen memakai base model yang sama (mis. Venice AI yang sama) dan hanya dibedakan oleh temperature atau persona, mereka tidak benar-benar independen. Itu satu model memakai topi berbeda, berpura-pura tidak setuju dengan dirinya sendiri. Debat semacam itu terlihat ramai tapi tidak menghasilkan keputusan yang lebih baik daripada satu prompt biasa.

Yang membuat debat ini bermakna bukan persona, tapi **basis kebenaran yang berbeda secara struktural** untuk tiap agen:

| Agen | Sudut pandang | Apa yang membatasinya (basis berbeda) |
|---|---|---|
| **Proposer** | Mencari peluang yield / arbitrase lintas batas | Temperature lebih tinggi; tugasnya memaksimalkan peluang |
| **Risk / Compliance** | Menolak yang melanggar batas | **Dibatasi RAG dokumen OJK/SEC** — tidak bisa mengarang, harus mengacu aturan nyata |
| **Validator** | Mengecek konsistensi | Membandingkan angka yang dipakai agen lain terhadap output simulasi |

Kunci kejujurannya ada di baris Risk: yang membuatnya benar-benar berbeda dari Proposer **bukan** temperature-nya, tapi fakta bahwa ia terikat pada dokumen aturan via RAG. Ia harus mengutip regulasi, bukan beropini. Itu memberi basis berbeda yang nyata, bukan kepura-puraan.

### Cara menjualnya dengan jujur

Jangan jual ini sebagai "banyak otak independen yang menghindari groupthink" — klaim itu tidak bisa dipertahankan kalau base model-nya sama. Jual sebagai: **satu keputusan dipecah menjadi sudut-sudut yang dipaksa berbeda dan dibatasi sumber berbeda, dengan validator yang mengaudit konsistensi.** Nilainya ada pada *struktur reasoning yang ter-audit*, bukan pada jumlah otak.

---

## 4. Autonomous loop: otonom di pikiran, bukan di tindakan

"Autonomous" menggoda untuk diartikan "AI yang jalan sendiri sampai memutuskan lalu eksekusi". Di konteks finansial yang menyentuh aset, loop tanpa rem bukan fitur — itu liabilitas. Referensinya BlackRock Aladdin: sistem ~$20 triliun itu **sengaja tidak otonom** di titik keputusan; ia berhenti dan menyerahkan ke manusia.

Maka loop ini otonom **hanya di bagian reasoning**, tidak di bagian action:
- Loop **boleh berputar bebas** saat menyusun argumen — konsekuensi salah di sini murah (paling banter debat ulang).
- Loop **wajib berhenti** sebelum menyentuh tindakan — di gerbang Permission.

### Tiga pintu keluar (atau loop jadi infinite loop yang membakar token)

Loop tanpa kondisi berhenti yang jelas akan berputar selamanya dan menghabiskan biaya. Maka harus ada tiga pintu keluar yang eksplisit:

1. **Konvergen** — Proposer dan Risk mencapai kesepakatan. Loop selesai, lanjut ke Permission.
2. **Mentok** — sudah mencapai batas iterasi maksimum tanpa sepakat. Paksa berhenti, laporkan ke manusia sebagai "no consensus" (ini hasil yang sah, bukan kegagalan).
3. **Inkonsistensi fatal** — Validator menemukan angka yang tidak cocok dengan output simulasi. Stop, ada yang salah, jangan diteruskan.

Tetapkan **max iterations dari awal** — biasanya 2–3 putaran sudah cukup; jarang butuh lebih. Ini pelajaran konkret dari pengalaman orchestrator paralel sebelumnya: koordinasi agen tanpa batas yang tegas adalah tempat bug dan biaya bersembunyi.

---

## 5. Permission Layer: rem tindakan

Setelah loop berhenti (karena salah satu dari tiga pintu di atas), hasilnya tidak langsung dieksekusi. Ia masuk ke Permission Layer, yang tugasnya menerjemahkan seluruh debat rumit menjadi **satu kalimat polos** untuk manusia.

Contoh output: *"Risiko portofoliomu naik, tapi sebagian besar berasal dari pergerakan kurs, bukan asetmu — mau hedge?"* — bukan tabel VaR mentah, bukan transkrip debat.

Manusia memutuskan. Baru setelah itu eksekusi berjalan (di testnet/simulasi untuk tahap ini). Ini titik di mana sistem secara sengaja menyerahkan kendali — dan justru itu yang membuatnya bisa dipercaya, sama seperti Aladdin.

Catatan implementasi: pola "AI mengusulkan → manusia me-review → baru jalan" ini sudah pernah dibangun di proyek sebelumnya (review skill JSON + batched permission). Pola itu bisa dipakai ulang; yang berubah hanya isinya — dari "deposit vault" menjadi "rebalance berdasarkan hasil simulasi".

---

## 6. Kenapa ini bisa dibangun dengan stack yang ada

Seluruh Council hidup **off-chain** dan hanya butuh API teks biasa:
- Multi-agen via prompt/temperature/RAG berbeda — jalan di API tertutup mana pun (mis. Venice AI).
- RAG dokumen OJK/SEC — retrieval biasa, bukan modifikasi model.
- Loop + kondisi berhenti — logika orkestrasi biasa (cocok untuk backend orchestration).
- Permission gate — UI + state, pola yang sudah dikuasai.

Tidak ada bagian Council yang butuh akses internal model (hidden states) atau jaringan tertentu. Migrasi jaringan (mis. ke Stellar/Soroban) tidak menyentuh lapisan ini sama sekali — Council agnostik terhadap chain.

---

## 7. Landasan riset (untuk kredibilitas pitch)

- **TradingAgents** (arXiv:2412.20138) — kerangka multi-agen dengan peran spesialis (analis fundamental/sentimen/teknikal + tim manajemen risiko + peneliti Bull/Bear), menggabungkan output terstruktur dengan dialog natural untuk debat. Ini cetak biru paling dekat dengan struktur Council ini.
- **AlphaAgents** (BlackRock, arXiv:2508.11152) — multi-agen LLM untuk portofolio ekuitas, dari pemain RWA institusional nyata.
- **"Debate or Vote"** (NeurIPS 2025) — membahas kapan debat benar-benar mengungguli voting sederhana; bacaan untuk memvalidasi kapan debat layak dipakai dan kapan tidak.
- **BlackRock Aladdin** sebagai referensi dunia nyata — scenario analysis & dekomposisi risiko sebagai pilar; dan prinsip *tidak* memberi keputusan otonom (manusia bertanggung jawab penuh), yang menjadi dasar desain Permission Layer.

*Verifikasi nomor arXiv sebelum masuk ke dokumen kompetisi resmi.*

---

## 8. Batas jujur (apa yang sengaja TIDAK diklaim)

- **Bukan "menghindari groupthink lewat banyak otak independen"** — selama base model sama, klaim ini lemah. Yang diklaim: reasoning terstruktur & ter-audit.
- **Bukan eksekusi otonom yang memindahkan dana riil** berdasarkan skor AI. Manusia di titik keputusan; eksekusi di testnet/simulasi.
- **Bukan "akurasi 95%"** atau angka kepastian apa pun — itu warisan framing lama yang ditolak.
- **Tidak memakai latent vector / machine encode antar-agen** — itu butuh hidden states yang tak tersedia via API tertutup; dicatat sebagai future work, bukan komponen aktif. Penghematan token dicapai lewat output terstruktur padat (JSON), bukan komunikasi laten.

---

*Ringkasan satu kalimat:* **Council memecah keputusan jadi sudut-sudut yang dibatasi sumber berbeda, berdebat dalam loop yang otonom di reasoning tapi berhenti di tindakan, lalu menyerahkan satu kalimat ke manusia — reasoning yang ter-audit, bukan kotak hitam, dan bukan robot yang memindahkan uang sendiri.**