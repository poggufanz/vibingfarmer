# Machine Encode
### Dokumen future work / arah riset — BUKAN dokumen fitur

> **Status: TIDAK diimplementasi di versi sekarang.**
> Dokumen ini mencatat sebuah arah riset, bukan fitur yang bisa diklaim. Jangan masukkan "machine encode" ke daftar fitur proposal atau pitch sebagai komponen aktif. Yang boleh diklaim sekarang ada di Bagian 5.

---

## 1. Kenapa dokumen ini ada

"Machine encode" terus muncul kembali sepanjang perancangan proyek — ide bahwa agen AI bisa berkomunikasi memakai representasi mesin yang padat agar hemat token dan cepat. Dokumen ini ada untuk **menutup** pertanyaan itu sekali, dengan jujur: apa yang sebenarnya dimaksud, mana yang nyata, mana yang tidak bisa dibangun sekarang, dan apa syarat agar suatu hari bisa.

Tanpa catatan ini, ide ini akan terus kembali dan menggoda untuk dimasukkan ke pitch padahal statusnya tidak berubah.

---

## 2. Dua hal berbeda yang sama-sama disebut "machine encode"

Ini sumber kebingungan utama. Dua hal ini **terjadi di tempat berbeda, untuk tujuan berbeda, dan hanya satu yang benar-benar "machine encode".** Mereka kebetulan diberi nama sama.

| | **Encode A — Latent vector sejati** | **Encode B — Kamus sandi / JSON padat** |
|---|---|---|
| Apa yang dikirim | Angka mentah dari jeroan model (hidden states / KV cache) | Teks — hanya teks yang dipersingkat |
| Ruang | Latent space (bukan token) | Tetap token space |
| Tujuan | Hemat token + kecepatan transfer memori | Hemat token (lebih sedikit) |
| Butuh apa | Akses internal model → **local / self-hosted** | Tidak butuh apa-apa khusus |
| Status | **Tidak bisa via API tertutup** | Bisa sekarang — tapi ini cuma prompt engineering biasa |
| Apakah "machine encode" sejati? | Ya | Tidak — ini teks ringkas berlabel keren |

Poin paling penting: **Encode B bukan versi murah dari Encode A.** Mereka teknologi terpisah yang kebetulan dinamai sama. Tidak ada "jembatan" atau "migrasi" dari B ke A — pindah dari satu ke lainnya bukan upgrade, melainkan ganti sistem total.

---

## 3. Encode A — Latent vector sejati (butuh local model)

### Konsepnya
Alih-alih agen menghasilkan teks kata-per-kata lalu agen lain membacanya kembali, agen langsung mengambil **matriks angka dari lapisan terdalamnya** (hidden states) dan menembakkannya via memori server ke agen lain. Tidak ada teks di tengah. Kecepatannya setingkat transfer memori (milidetik), dan biaya token-nya mendekati nol karena tidak melewati penghitungan token API komersial.

### Kenapa tidak bisa sekarang
Penyedia API tertutup (OpenAI, Anthropic, Venice AI) **menyembunyikan hidden states** demi keamanan dan privasi model mereka. API hanya memberi: teks masuk → teks keluar. Tidak ada cara menarik vektor laten lewat API komersial. Ini bukan soal keterampilan — pintunya dikunci dari sisi penyedia.

### Syarat agar bisa
Memakai model open-weight yang **di-host sendiri** (mis. Llama / Mistral via vLLM atau Hugging Face di server sendiri). Dengan kendali penuh atas kode internal model, hidden states bisa diakses langsung. Ini butuh kapasitas infrastruktur (GPU, ops) dan keahlian infra yang tidak ringan.

### Landasan riset (nyata, bukan karangan)
- **Interlat** (arXiv:2511.09149) — memakai continuous last hidden states LLM sebagai representasi "pikiran" untuk komunikasi langsung antar-agen, dengan kompresi tambahan.
- **LatentMAS** (arXiv:2511.20639) — melaporkan pengurangan token output ~70–84% dan inferensi ~4x lebih cepat dibanding sistem berbasis teks.

Catatan jujur soal sejarah perancangan ini: skeptisisme awal bahwa "machine encode" itu istilah karangan ternyata **keliru** — ini subbidang riset aktif. Angka penghematan ~85% yang sempat diragukan justru berada di dalam rentang yang sudah diukur peneliti. Yang tetap benar: metode ini butuh akses hidden states, sehingga di luar jangkauan stack API tertutup.

---

## 4. Encode B — Kamus sandi / JSON padat (bisa sekarang, tapi bukan inovasi)

### Konsepnya
Memaksa agen berkomunikasi memakai format singkat buatan sendiri ketimbang kalimat panjang. Contoh:

- Normal (~35 token):
  *"Berdasarkan pergeseran kurva yield obligasi AS tenor 10 tahun yang naik 50 basis poin, portofolio reksa dana pendapatan tetap kita mengalami peningkatan risiko penurunan aset sebesar 4%."*
- Padat (~8–10 token):
  `[US10Y:+50BP][RWA:FIXED_INCOME][RISK:+4%][ACTION:REBALANCE]`
  atau lebih baik sebagai JSON: `{"signal":"US10Y","bp":50,"risk_delta":0.04,"action":"rebalance"}`

Karena agen lain sudah membaca dokumentasi "kamus" yang sama via system prompt, keduanya bisa bertukar argumen dalam struktur padat ini. Penghematan ~70% token realistis.

### Kenapa ini BUKAN machine encode
Ini tetap **teks-ke-teks**, tetap token space. Tidak ada yang istimewa secara teknis — ini **prompt engineering biasa** ("suruh AI menjawab ringkas dalam format ini"). Memberinya nama "Protokol Kompresi Kamus Sandi" tidak mengubah faktanya. Ini sesuatu yang sudah dilakukan rutin tanpa dianggap inovasi.

### Kenapa tetap berguna
Justru di sinilah letak nilainya yang sebenarnya: format padat terstruktur ini **persis** yang dibutuhkan untuk memberi makan mesin simulasi (Monte Carlo). Output LLM dalam JSON padat → dipetakan ke parameter numerik. Jadi terima **mekanismenya** (output padat terstruktur), tolak **framing-nya** (ini bukan machine encode, bukan batu loncatan ke latent vector, bukan jalan ke "akurasi 95%").

---

## 5. Apa yang boleh diklaim sekarang vs apa yang tidak

### Boleh diklaim (jujur, bisa dibangun)
- Agen berkomunikasi memakai **output JSON terstruktur yang padat** untuk efisiensi token — ini Encode B, disebut apa adanya: *structured state passing / context compression*, bukan "machine encode".
- Penghematan token nyata, tapi dari prompt engineering biasa, bukan dari teknologi laten.

### TIDAK boleh diklaim (belum ada / menyesatkan)
- "Agen berkomunikasi via vektor laten / bahasa mesin" sebagai fitur aktif → **tidak**, butuh local model yang belum dipakai.
- "Hemat 85% token lewat machine encode" sebagai fitur sekarang → **tidak**, itu angka untuk Encode A yang belum diimplementasi.
- "Migrasi dari kamus sandi ke latent vector" sebagai roadmap mulus → **tidak**, keduanya sistem terpisah, bukan tangga.
- Angka **"akurasi 95%"** dalam bentuk apa pun → **tidak**, ini warisan framing lama yang ditolak di seluruh proyek.

---

## 6. Kalau suatu hari pindah ke local model

Jika proyek bermigrasi ke model open-weight yang di-host sendiri (mis. demi memotong biaya token operasional sepenuhnya, atau demi kontrol penuh), maka Encode A menjadi mungkin. Urutan yang masuk akal:

1. **Sekarang** — pakai Encode B (JSON padat) di atas API tertutup. Fokus membuktikan logika sistem (Council, simulasi) bekerja. Biaya token diterima sebagai ongkos kenyamanan.
2. **Nanti (jika perlu)** — pindah inti reasoning ke local model open-weight. Baru di sini Encode A (latent communication) bisa dieksplorasi sebagai optimasi biaya/kecepatan.

Penting: langkah 2 **bukan** "menyalakan fitur yang sudah dirancang" — ini proyek riset/infra tersendiri dengan kebutuhan GPU, ops, dan keahlian yang berbeda. Perlakukan sebagai milestone besar terpisah, bukan toggle.

Yang juga penting untuk diingat: tujuan asli machine encode (hemat token) **sudah tercapai lewat jalan lain** — arsitektur fan-in/Monte Carlo membuat LLM hanya dipakai di sedikit titik, sisanya matematika murah. Jadi Encode A bukan kebutuhan mendesak; ia jalur terkunci menuju tujuan yang sudah diraih lewat pintu terbuka. Itu sebabnya ia future work, bukan prioritas.

---

*Ringkasan satu kalimat:* **Machine encode sejati (latent vector) itu nyata dan ada risetnya, tapi butuh local model dan tidak bisa via API tertutup; yang bisa dipakai sekarang hanyalah JSON padat — yang berguna untuk memberi makan simulasi, tapi tidak boleh dijual sebagai "machine encode" karena ia hanya prompt engineering biasa.**