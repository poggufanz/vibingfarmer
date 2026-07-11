# Permission Layer
### Narasi komponen: gerbang izin manusia lintas-fitur (eks-"Caveman Translator")

---

## 1. Apa ini, dan kenapa komponen mandiri

Permission Layer adalah **satu gerbang** yang dilewati setiap tindakan berisiko sebelum dieksekusi. Ia menerjemahkan keputusan sistem yang rumit menjadi satu kalimat polos, lalu menunggu keputusan manusia.

Ia bukan bagian dari Council. Council hanya **salah satu** sumber yang memberinya keputusan untuk diloloskan. Karena ada jalur lain yang juga harus lewat gerbang ini (lihat Bagian 3), Permission Layer berdiri sebagai komponen keamanan tersendiri — bukan ekor dari satu fitur.

Nama lama "Caveman Translator" dibuang: lucu untuk brainstorm, tapi mengurangi kredibilitas di pitch serius. Fungsinya dipertahankan, namanya diprofesionalkan menjadi *Permission Layer* / *Plain-Language Action Gate*.

---

## 2. Dua tugas yang ia lakukan

1. **Menerjemahkan** — mengubah hasil rumit (debat Council, skor risiko, sebaran simulasi) menjadi **satu kalimat tanpa jargon** yang bisa dipahami manusia awam.
   - Bukan: tabel VaR mentah, transkrip debat, atau angka confidence.
   - Tapi: *"Risiko portofoliomu naik, tapi sebagian besar dari pergerakan kurs, bukan asetmu — mau hedge?"*
2. **Menahan** — tidak meneruskan tindakan apa pun sampai manusia memberi izin eksplisit. Ini titik di mana sistem secara sengaja menyerahkan kendali.

---

## 3. Kenapa lintas-fitur: siapa saja yang lewat gerbang ini

Permission Layer melayani lebih dari satu sumber. Inilah alasan ia komponen mandiri:

```
        Council (hasil debat)  ──┐
                                 │
        Eksekusi langsung     ──┼──►  PERMISSION LAYER  ──►  manusia  ──►  eksekusi
        (rebalance terpicu)      │      (1 kalimat)            (acc)        (testnet/sim)
                                 │
        Alert simulasi        ──┘
        (mis. tail risk lewat batas)
```

Apa pun sumbernya, **tidak ada yang menyentuh eksekusi tanpa lewat gerbang ini.** Itu yang membuatnya bernilai sebagai pola keamanan tunggal: satu tempat untuk mengaudit, satu tempat untuk memberi izin, satu tempat yang menjamin manusia selalu di tengah.

---

## 4. Peringatan keras soal "eksekusi langsung"

Istilah "eksekusi langsung" berbahaya di sistem finansial dan harus didefinisikan dengan tegas.

"Langsung" di sini berarti **"dipicu tanpa melalui Council"** — bukan **"dieksekusi tanpa manusia"**. Bedanya fundamental:

- ✅ Boleh: sebuah pemicu (mis. tail risk menembus batas) langsung mengusulkan tindakan tanpa harus menunggu debat Council penuh — lebih cepat. Tapi usulan itu **tetap berhenti di Permission Layer** dan menunggu acc manusia.
- ❌ Tidak boleh: AI memindahkan aset secara otonom berdasarkan skor kepercayaan, tanpa manusia. Ini melanggar prinsip inti proyek (rujukan Aladdin: sistem $20T sengaja *tidak* otonom di titik keputusan).

Dengan kata lain: Permission Layer justru ada untuk **memastikan "langsung" tidak pernah berarti "melewati manusia".** Ia adalah jaring yang membuat jalur cepat tetap aman. Jika suatu jalur bisa melewati gerbang ini, jalur itu salah desain.

### Pengecualian terukur (jika nanti diperlukan)
Kalau di masa depan ada tindakan yang benar-benar perlu otomatis penuh (mis. stop-loss darurat yang harus instan), itu harus:
- dibatasi pada tindakan **defensif** (mengurangi risiko, bukan menambah posisi),
- dengan batas yang sudah di-pre-approve manusia sebelumnya (bukan keputusan AI bebas),
- dan tetap tercatat di jejak audit.
Ini pengecualian sempit yang harus dirancang sadar, bukan default. Untuk hackathon: tidak perlu: semua lewat manusia.

---

## 5. Akar konkret: pola yang sudah pernah dibangun

Pola "AI mengusulkan → manusia me-review → baru jalan" bukan hal baru untuk proyek ini. Di Vibing Farmer sudah ada: pengguna meninjau skill JSON yang dibuat AI di editor interaktif, lalu mengotorisasi lewat batched permission, dengan tiap agen dibatasi ke budget-nya.

Itu **persis** Permission Layer dalam bentuk lain. Untuk proyek baru, polanya dipakai ulang; yang berubah hanya isi yang di-review — dari "deposit ke vault" menjadi "rebalance berdasarkan hasil simulasi/Council". Jadi komponen ini bukan dibangun dari nol; fondasinya sudah terbukti jalan.

Catatan migrasi (Stellar/Soroban): sebagian fungsi permission yang dulu butuh EIP-7702 + ERC-7715 di EVM kemungkinan jadi lebih sederhana, karena Soroban punya **account abstraction & otorisasi bawaan di level protokol**. Permission Layer sebagai logika tetap sama; mekanisme on-chain-nya bisa menyusut.

---

## 6. Posisi on-chain vs off-chain

- **Logika & terjemahan** (mengubah keputusan jadi 1 kalimat, menampilkan ke user, menunggu acc) → **off-chain**, di backend + frontend.
- **Pencatatan persetujuan** (bukti bahwa user Z meng-acc keputusan Y dari simulasi X) → boleh **on-chain** sebagai hash jejak audit, agar immutable.
- **Eksekusi setelah acc** → on-chain (Soroban, testnet untuk tahap ini).

Gerbangnya sendiri hidup off-chain; chain hanya menerima hasil akhir yang sudah disetujui dan menyimpan jejaknya.

---

## 7. Landasan riset (untuk kredibilitas pitch)

- **MAKA** (arXiv:2605.04003) — memisahkan intent routing, komputasi deterministik, dan verifikasi untuk menghasilkan rekomendasi sadar-risiko yang cocok untuk persetujuan manusia sebelum implementasi, sambil menjaga auditability & provenance. Ini kerangka paling dekat dengan Permission Layer.
- **BlackRock Aladdin** — prinsip bahwa sistem risiko institusional *tidak* memberi keputusan otonom; pengguna bertanggung jawab penuh. Dasar filosofis "manusia selalu di titik keputusan".

*Verifikasi nomor arXiv sebelum masuk ke dokumen kompetisi resmi.*

---

## 8. Batas jujur (apa yang sengaja TIDAK diklaim)

- **Bukan eksekusi otonom** — "eksekusi langsung" tidak pernah berarti melewati manusia (lihat Bagian 4).
- **Bukan penjamin keamanan mutlak** — gerbang ini mengurangi risiko keputusan buruk otomatis, tapi tidak menjamin keputusan manusia-nya benar. Ia memberi manusia informasi yang jelas, bukan menggantikan tanggung jawabnya.
- **Terjemahan 1 kalimat adalah penyederhanaan** — berguna untuk keputusan cepat, tapi detail lengkap (sebaran, debat) harus tetap bisa diakses kalau manusia mau menggali. Jangan sembunyikan kompleksitas, ringkas saja secara default.

---

*Ringkasan satu kalimat:* **Satu gerbang yang dilewati setiap tindakan berisiko dari sumber mana pun — menerjemahkan keputusan rumit jadi satu kalimat dan menahan eksekusi sampai manusia meng-acc, memastikan "jalur cepat" tidak pernah berarti "tanpa manusia".**