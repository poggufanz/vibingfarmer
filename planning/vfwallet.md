# VF Wallet (Passkey Smart Wallet) + VF API — Brainstorm Notes

> Catatan ide untuk dibawa brainstorming dengan agent code.
> Status: ide/eksplorasi. 
> Butuh Pembahasan Lebih Lanjut

---

## Inti ide (satu kalimat)

**"MetaMask, tapi passkey"** — wallet VF sendiri (akun user, kirim/terima, connect dApp, disesuaikan VF), tapi sign-nya pakai **passkey (Face ID/Touch ID via WebAuthn)**, bukan seed phrase. Di Stellar, passkey = smart contract account, jadi ini sebenarnya **lebih canggih dari MetaMask** (bisa spending limit, agent signer, policy di account level).

---

## Kenapa passkey, bukan seed-phrase wallet

- Wallet seed-phrase dari nol = harus generate/simpan/enkripsi key user → bagian PALING berbahaya (1 bug = dana hilang). Jangan vibe-code ini.
- **Passkey menghapus seluruh bagian itu.** Tidak ada seed yang di-generate/disimpan. Key ada di **secure enclave HP/laptop user** (hardware), lewat WebAuthn. VF tidak pernah menyentuh material kunci.
- Hasil: dapat semua manfaat "wallet sendiri" (non-custodial, kirim/terima, sign) TANPA menanggung risiko key management.

## Bonus: ini smart account, bukan EOA

Di Stellar, passkey wallet = `CustomAccountInterface` (contract account). Jadi bisa:
- Spending limit di account level
- **Agent signer** (ed25519 + policy) hidup di account yang sama → VF agent jalan dari wallet
- Eligibility policy (F8) bisa ditegakkan di account level
MetaMask (EOA biasa) tidak bisa ini.

---

## Gambaran arsitektur utuh

```
VF Wallet (Soroban smart account, passkey-signed)
├─ User sign pakai Face ID / Touch ID (bukan seed)     ← onboarding mulus (jawab 90% drop-off)
├─ Fungsi wallet normal: kirim/terima, connect dApp     ← "kayak MetaMask"
├─ Layer VF: eligibility (F8) + simulasi sebelum sign    ← "disesuaikan VF" (lensa Fradium: cek sebelum trx)
├─ Agent signer (ed25519 + policy)                       ← VF agent jalan dari wallet
└─ VF API = otak (app + extension pakai endpoint sama)   ← satu sumber, dua client
```

### Signer types (Passkey Kit)
- `SignerKey.Secp256r1(keyId)` → passkey (user, Face ID) → login + approve permission layer
- `SignerKey.Ed25519(publicKey)` → agent session key (VF SUDAH pakai ini)
- `SignerKey.Policy(contractAddress)` → policy signer → eligibility/scope sebagai aturan on-chain

### Pemetaan ke 3 pilar VF
- Human-in-the-loop → **passkey signer** (user tap untuk approve)
- Scoped agent autonomy → **ed25519 + policy signer**
- Eligibility gate (F8) → bisa jadi **policy** yang ditegakkan di account level

---

## VF API sendiri (otak untuk app + extension)

Masalah: VF mau jalan di **app** DAN **extension**. Jangan tulis logika 2x.
Solusi: **API VF = satu otak**, app + extension jadi client tipis.

```
        ┌─────────────┐
        │   VF API    │  ← eligibility gate (F8), AI strategy, vault facts,
        │  (1 sumber) │     monitor, Blend reads, build UNSIGNED tx
        └──────┬──────┘
        ┌──────┴──────┐
   ┌────▼───┐    ┌────▼─────┐
   │  App   │    │Extension │   ← client tipis, manggil endpoint sama
   └────┬───┘    └────┬─────┘
        │             │
   passkey sign   passkey sign   ← signing di sisi user, BUKAN di API
```

### GARIS KEAMANAN (jangan pernah diseberangi)
- ✅ API boleh: terima "vault X, amount Y" → balas "eligible, score 92, simulasi, **unsigned tx**".
- ✅ Signing terjadi di sisi user (passkey / wallet).
- ❌ API JANGAN: terima seed/secret key user, jangan sign atas nama user, jangan simpan kredensial.
- Selama API cuma menghasilkan **unsigned transaction + analisis**, VF tetap non-custodial.
- Catatan: pola ini = perluasan fee-bump relayer yang SUDAH jalan (server bantu gas, user yang sign).

### Composability story (untuk pitch)
Mirip "Fradium API Developer" — VF Analyzer/Gate sebagai API reusable. "VF bukan cuma app, tapi layanan yang bisa dipanggil dari mana saja."

---

## Positioning (kalau jadi dibangun)

> "Wallet DeFi yang kamu masuk pakai Face ID, yang menunjukkan apakah sebuah vault aman sebelum kamu menyetujui, dan menjalankan agent yield-mu — tanpa seed phrase, tanpa kehilangan kendali."

Tagline opsi: **"Set once with Face ID. Vibe forever."**

Menyatukan: onboarding (passkey) + proteksi (F8) + autonomy (agent). Tidak ada pemenang WCHL25 yang punya kombinasi ini.

---

## Yang harus diwaspadai (jujur)

1. **WebAuthn punya kurva belajar:** challenge binding ke transaksi, **recovery** (HP hilang gimana?), browser/device support. Passkey Kit bantu, tapi tetap butuh waktu paham.
2. **Bukan pengganti fokus inti.** Aturan yang sudah disepakati TETAP berlaku:
   - **Branch terpisah** (mis. `feat/passkey`) → error tidak menyentuh `iq`.
   - **Timebox keras** → tetapkan batas sebelum mulai; kalau lewat, buang branch, balik ke polish.
   - **Kerjakan HANYA setelah MVP inti + demo (F11) + pitch (F12) aman.**
3. Untuk submission, ini **stretch/roadmap**, bukan P0.

---

## Resource / referensi teknis

- Passkey Kit (TS SDK): github.com/kalepail/passkey-kit
- Smart Account Kit: github.com/kalepail/smart-account-kit
- Soroban passkey demo: github.com/kalepail/soroban-passkey
- Multisig smart wallet demo (superpeach): github.com/kalepail/superpeach
- Smart Wallets (Stellar Docs): developers.stellar.org/docs/build/apps/smart-wallets
- Passkey-Enabled Smart Wallet walkthrough — Cheesecake Labs
- CustomAccountInterface / __check_auth — Stellar authorization docs
- Passkey Kit pakai OpenZeppelin Relayer untuk submit passkey-signed tx (mirip fee-bump VF)

---

## Pertanyaan untuk brainstorm dengan agent code

1. Bentuk minimal demo: create account → Face ID login → kirim/terima → sign deposit VF. Berapa lama realistis?
2. Recovery flow: kalau device hilang, gimana user akses account? (multisig signer? backup passkey?)
3. Browser/device support: target apa dulu (Chrome desktop? mobile Safari?).
4. Integrasi ke agent account VF yang SUDAH ada: tambah passkey signer ke account existing, atau account baru?
5. VF API: endpoint minimal apa yang perlu (eligibility, vault facts, build-unsigned-tx, simulate)?
6. Timebox: berapa hari sebelum cut-loss kalau WebAuthn mentok?