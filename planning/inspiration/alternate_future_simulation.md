# Alternate Future Simulation
### Narasi fitur untuk Cognitive AI Layer for RWA

---

## 1. Masalah yang diselesaikan

Investor — baik ritel maupun institusi — terus-menerus dihadapkan pada pertanyaan yang sama: *"Kalau sesuatu yang buruk terjadi, portofolioku jadi gimana?"* Pertanyaan itu kelihatan sederhana, tapi sebagian besar alat yang ada menjawabnya dengan cara yang menyesatkan.

Kebanyakan alat menjawab dengan **satu angka pasti**: "Portofoliomu turun 12%." Angka itu terlihat tegas dan meyakinkan, tapi menyembunyikan hal yang paling penting — ketidakpastian. Orang tidak bangkrut karena rata-rata; mereka bangkrut karena skenario ekor, kejadian 5% terburuk yang mereka kira tidak akan datang. Satu angka menutupi ekor itu sepenuhnya.

Di sisi lain, alat stress-testing tradisional yang lebih jujur (berbasis Monte Carlo dan model ekonometrik) punya keterbatasan sendiri: mereka **buta narasi**. Mereka mengambil angka dari distribusi tetap, tapi tidak mengerti *makna* sebuah peristiwa. Mereka kesulitan merepresentasikan guncangan berfrekuensi rendah seperti pandemi, krisis rantai pasok, atau fragmentasi geopolitik yang berada di luar jendela data historis, dan desain skenarionya manual serta lambat beradaptasi terhadap informasi real-time.

Fitur ini berdiri di antara dua kelemahan itu: menjawab dengan **sebaran yang jujur**, tapi sebaran yang dibentuk oleh **pemahaman atas peristiwa nyata**.

---

## 2. Apa yang sebenarnya dihasilkan

Alih-alih satu angka, fitur ini menghasilkan **sebaran kemungkinan** dari ribuan skenario yang disimulasikan. Untuk satu pertanyaan ("kalau ada berita buruk soal suku bunga, apa yang terjadi?"), output-nya berbentuk:

- **Paling sering** — di mana mayoritas skenario mendarat (misal: turun 8–12%)
- **Skenario terbaik** — batas atas yang realistis
- **5% terburuk (tail risk)** — seberapa buruk kalau benar-benar apes (misal: turun lebih dari 25%)

Output kuantitatifnya menggunakan metrik risiko standar industri: **Value-at-Risk (VaR)** dan **Conditional VaR / Expected Shortfall (CVaR)**. Ini bukan metrik karangan; ini bahasa yang dipakai risk engine institusional dan regulator. Memakainya membuat sistem ini bisa dibandingkan secara langsung dengan standar yang sudah ada, bukan berdiri di atas klaim sendiri.

Prinsip yang dipegang: **sistem tidak pernah menjanjikan kepastian.** Justru kejujuran tentang ketidakpastian itulah yang menjadi nilai jualnya, karena itulah yang sebenarnya dipakai untuk mengambil keputusan.

---

## 3. Cara kerja: arsitektur fan-out / fan-in

Alur sistem mengikuti pola **fan-out → fan-in → simulasi → penjelasan**. Banyak sumber diperiksa berbarengan, dikerucutkan jadi satu set parameter, lalu digiling menjadi sebaran.

### Fan-out: banyak sumber diperiksa paralel

Empat jenis sinyal ditarik secara bersamaan, tapi **tidak semuanya lewat LLM** — dan ini pembeda penting dari sisi biaya:

| Sumber | Cara diambil | Biaya |
|---|---|---|
| News / sentimen | LLM (membaca, memahami narasi) | Makan token |
| Makro global (suku bunga, inflasi) | LLM | Makan token |
| Pasar crypto | API data → ambil angka | Murah |
| Pasar saham / kurs | API data → ambil angka | Murah |

News dan makro butuh LLM karena keduanya soal *memahami makna*. Pasar crypto dan saham hanya soal *menarik angka* (harga, volatilitas, korelasi) — itu tidak butuh LLM, cukup API data dan sedikit matematika. Membedakan keduanya adalah keputusan desain sadar, bukan kebetulan.

### Fan-in: semua sinyal jadi satu set parameter

Di titik kumpul, sinyal yang formatnya berbeda-beda dinormalisasi menjadi **satu objek parameter numerik**. LLM mengembalikan output terstruktur (JSON), lalu dipetakan ke parameter yang bisa dibaca mesin simulasi. Contoh bentuk akhir:

```json
{
  "volatility": 0.32,
  "correlation_asset_fx": 0.6,
  "shock_severity": 0.7,
  "drift": -0.02
}
```

Inilah satu-satunya "encoding" yang relevan dan benar-benar bisa dibangun: **transformasi sinyal heterogen menjadi parameter angka.** Tidak butuh akses ke internal model, jalan di API tertutup mana pun.

### Simulasi: Monte Carlo menggiling ribuan skenario

Yang menjalankan ribuan skenario **bukan LLM** — itu **Monte Carlo**, kode matematika deterministik (Python/NumPy). Inilah kunci dari kekhawatiran biaya dan latensi: 10.000 skenario dijalankan dalam hitungan milidetik dengan biaya token mendekati nol. LLM tidak pernah dipakai untuk *menghitung* skenario, hanya untuk menerjemahkan di kedua ujungnya.

### Penjelasan: LLM menerjemahkan hasil ke bahasa manusia

Di ujung akhir, LLM dipakai sekali lagi untuk menjelaskan sebaran itu dalam bahasa polos — bukan menampilkan tabel VaR mentah, tapi: *"Risikomu naik, dan sebagian besar berasal dari pergerakan kurs, bukan dari asetmu sendiri."*

---

## 4. Kenapa hemat token & cepat (jawaban langsung atas kekhawatiran inti)

Ketakutan awalnya masuk akal: kalau tiap skenario (berita buruk + panik + resesi) dijalankan sebagai satu panggilan LLM penuh, lalu dikali ribuan kombinasi, biayanya meledak.

Solusinya bukan "kompres jadi satu variabel pasti" — itu menghasilkan ramalan palsu. Solusinya adalah **menempatkan LLM hanya di pinggir**:

- LLM dipakai di **dua-tiga titik sempit**: membaca news, menerjemahkan narasi jadi parameter, dan menjelaskan hasil.
- **Inti perhitungan** (ribuan iterasi skenario) dijalankan oleh Monte Carlo — murni matematika, cepat, hampir gratis.

Pendekatan ini punya dukungan terukur dari riset. Studi yang membandingkan LLM stress-testing dengan Monte Carlo menemukan bahwa LLM agent jauh lebih mahal (puluhan detik per epoch vs milidetik untuk Monte Carlo), dan solusinya adalah memakai mock agent terkalibrasi yang mereplikasi perilaku LLM dengan biaya ~1000x lebih murah — menyimpan LLM hanya untuk penemuan skenario dan validasi. Itu persis pola yang dipakai di sini.

Catatan jujur: "penghematan token" yang sempat dibayangkan lewat *latent vector communication* antar-agen (machine encode) **tidak diperlukan dan tidak dipakai** — tujuannya (hemat biaya) sudah tercapai lewat arsitektur ini. Latent communication yang sebenarnya butuh akses hidden states model, yang tidak tersedia lewat API tertutup; ia dicatat sebagai inspirasi dan future work, bukan komponen aktif.

---

## 5. Kenapa LLM tetap dipakai (bukan Monte Carlo murni)

Kalau Monte Carlo yang menghitung, kenapa tidak buang LLM sama sekali? Karena Monte Carlo murni **buta narasi**. Ia tidak tahu "berita buruk" itu apa; ia hanya mengambil angka dari distribusi tetap. LLM memberi tiga hal yang tidak bisa diberikan Monte Carlo sendirian:

1. **Realisme perilaku** — LLM bereaksi berbeda terhadap "audit mengungkap kekurangan dana" vs "perbaikan bug kecil", menangkap dinamika yang digerakkan narasi.
2. **Kreativitas skenario** — LLM bisa menemukan kombinasi guncangan yang tidak terpikirkan dalam skenario yang ditulis manual.
3. **Interpretability** — jejak penalaran LLM menjadi log audit yang menjelaskan *kenapa* sebuah trajektori risiko terjadi.

Jadi pembagian tugasnya jelas: **LLM memberi makna, Monte Carlo memberi angka.**

---

## 6. Implementasi data: realistis & terjangkau

Karena fitur ini adalah *simulasi skenario*, bukan trading bot frekuensi tinggi, ia **tidak butuh data real-time tick-by-tick.** Monte Carlo hanya butuh parameter (volatilitas, korelasi, harga terakhir) — yang cukup dipenuhi data yang bahkan delay 15 menit atau end-of-day. Ini membuat keterbatasan free tier API yang biasanya merepotkan menjadi tidak relevan.

Stack data yang realistis dan murah/gratis:

- **Crypto** — CoinGecko (free tier besar, tanpa kartu kredit) atau DIA (tanpa registrasi/key sama sekali)
- **Saham** — Alpha Vantage free tier (reliable, sudah cukup untuk parameter)
- **Kurs USD/IDR** — exchangerate.host (free tier generous)
- **News** — LLM + web search tool, hasilnya di-cache (tidak perlu API news terpisah)

### Prinsip demo: bangun empat jalur, tapi demo dari snapshot

Untuk pertunjukan langsung, jangan menggantungkan demo pada empat API live sekaligus — itu empat titik gagal, dan jalur news (web search live) yang paling lambat dan tak terduga. Pola yang aman: tarik data riil **sekali**, simpan sebagai snapshot, jalankan demo dari snapshot itu (tetap jujur: "data riil per tanggal X"), dan sediakan satu tombol "refresh live" sebagai bukti kapabilitas — ditekan hanya bila kondisi aman. Substansi tidak boleh dirusak oleh plumbing.

---

## 7. Momen demo (the wow)

Di layar: empat panel menyala berbarengan — news sedang dibaca, harga crypto masuk, saham masuk, makro masuk. Keempatnya mengalir menyatu ke tengah menjadi satu set parameter. Lalu *muncul* grafik sebaran: histogram kemungkinan hasil, dengan ekor terburuk ditandai jelas. Lalu satu kalimat penjelasan polos dari LLM.

Juri melihat **"banyak hal kompleks → satu jawaban jujur"** dalam sepuluh detik, tanpa perlu penjelasan panjang. Kekuatan visual justru pada kejujurannya: menampilkan mana yang AI dan mana yang matematika, bukan menyamarkan semuanya jadi "AI thinking".

---

## 8. Landasan riset (untuk kredibilitas pitch)

Fitur ini tidak dikarang; tiap komponen punya jejak di literatur peer-reviewed/preprint:

- **LLM + Monte Carlo untuk stress scenario** — pola standar; LLM menghasilkan skenario makro, dipetakan ke metrik tail-risk (VaR/CVaR), dan diverifikasi lewat plausibility check. Bisa dibangun hanya dengan API biasa (tanpa modifikasi bobot model).
- **Trade-off biaya LLM vs Monte Carlo** — riset mengukur LLM ~puluhan detik/epoch vs milidetik untuk Monte Carlo, dengan mock agent ~1000x lebih murah sebagai solusi.
- **Scenario generation sadar-distribusi** — pendekatan Variational Autoencoder untuk menghasilkan skenario Monte Carlo yang lebih kaya (dicatat sebagai future work; untuk hackathon, Monte Carlo standar sudah cukup).
- **BlackRock Aladdin** sebagai referensi dunia nyata — scenario analysis & stress testing adalah pilar inti sistem yang mengelola ~$20 triliun aset, yang juga melakukan dekomposisi risiko menjadi faktor-faktor.

---

## 9. Batas jujur (apa yang sengaja TIDAK diklaim)

- **Tidak ada "akurasi 95%"** atau angka akurasi pasti apa pun. Di domain finansial, mengklaim kepastian adalah red flag. Yang ditawarkan adalah sebaran yang jujur, bukan ramalan.
- **Tidak ada eksekusi otonom yang memindahkan dana riil** berdasarkan skor kepercayaan AI. Untuk hackathon: simulasi/testnet, dengan manusia di titik keputusan.
- **Latent vector / machine encode bukan komponen aktif** — hanya inspirasi & future work, karena butuh akses internal model yang tidak tersedia lewat API tertutup.
- **Dunia simulasi penuh (ribuan NPC agen)** bukan untuk versi pertama; Monte Carlo standar sudah cukup. Sandbox agen-penuh dicatat sebagai future work.

---

*Ringkasan satu kalimat:* **Fitur yang mengubah banyak sinyal kompleks (news, makro, crypto, saham) menjadi satu sebaran risiko yang jujur — memakai LLM untuk memberi makna di kedua ujung, dan Monte Carlo untuk menggiling ribuan skenario dengan cepat dan murah di tengah.**