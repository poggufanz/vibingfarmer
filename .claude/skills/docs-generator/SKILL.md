---
name: docs-generator
description: Use when regenerating this project's docs/ set with complete Indonesian content, preserving existing structure and Skill Referensi, including optional blockchain coverage.
---

# Docs Generator

## Overview
Generate all docs listed in the manifest with full content, overwriting existing files. Keep Indonesian language and the existing document style. No placeholders.

## When to Use
- You must regenerate the full docs/ set for this project.
- You need consistent structure and Skill Referensi across all docs.
- The output must be complete and ready to use.

## Do Not Use
- For docs outside the manifest.
- For docs/spikes/** or docs/laporan_prediksi.md.

## Inputs
- Current plan and product scope (including whether a new web3 app is in scope).
- Existing docs content for structure and terminology.
- Skills available under .agents/skills.

## Output
- Overwrite all files in the manifest with complete content.

## Generation Rules
- Overwrite every file in the manifest.
- Use Indonesian language and match the existing structure in each file.
- Include a "Skill Referensi" line in every file.
- Do not add TODO/TBD or placeholder text.
- Keep mermaid diagrams when relevant.
- Do not create any docs outside the manifest.

## Blockchain Rule (Optional)
- Blockchain is optional by default.
- If the plan includes building a new web3 app:
  - Make docs/technical-blockchain-usage.md fully technical and detailed.
  - Add or reinforce blockchain integration where relevant in other docs.
- If the plan does not include a new web3 app:
  - Still generate docs/technical-blockchain-usage.md.
  - Mark it as optional and out of scope for the current plan.

## Manifest (Overwrite These Files)
- docs/business-impact-model.md
- docs/business-roadmap-backlog.md
- docs/product-demo-scenario.md
- docs/product-features-complete.md
- docs/product-user-stories.md
- docs/technical-api-events.md
- docs/technical-architecture.md
- docs/technical-blockchain-usage.md
- docs/technical-database.md
- docs/technical-security-privacy.md

## Skill Referensi Mapping (Use These)
- docs/business-impact-model.md: finance-expert + senior-data-scientist
- docs/business-roadmap-backlog.md: architecture-designer + finance-expert
- docs/product-demo-scenario.md: mobile-developer + blockchain-developer + cognitive-fluency-psychology
- docs/product-features-complete.md: mobile-developer + blockchain-developer
- docs/product-user-stories.md: cognitive-fluency-psychology
- docs/technical-api-events.md: api-integration-specialist
- docs/technical-architecture.md: architecture-designer
- docs/technical-blockchain-usage.md: blockchain-developer + web3-expert
- docs/technical-database.md: database-schema-designer
- docs/technical-security-privacy.md: security-review + data-privacy-compliance

## Per-File Blueprints (Kisi-kisi)
1) docs/business-impact-model.md
- Ringkasan dampak bisnis
- Problem dan market pain
- Model nilai dan manfaat
- Dampak untuk stakeholder utama
- KPI dan indikator dampak

2) docs/business-roadmap-backlog.md
- Ringkasan roadmap
- MoSCoW atau priority matrix
- Milestone per fase
- Backlog fitur utama
- Risiko dan mitigasi

3) docs/product-demo-scenario.md
- Tujuan demo
- Persona atau aktor demo
- Alur demo langkah demi langkah
- Checklist kesiapan demo
- Expected outcomes

4) docs/product-features-complete.md
- Ringkasan
- Daftar functional requirements (FR)
- Prioritas (MoSCoW)
- Platform considerations
- Integrasi dan dependensi
- Referensi

5) docs/product-user-stories.md
- Ringkasan persona
- User stories per fitur
- Acceptance criteria
- Non-functional notes

6) docs/technical-api-events.md
- Ringkasan event model
- Daftar event API
- Payload schema ringkas
- Alur publish dan subscribe
- Error handling dan retry

7) docs/technical-architecture.md
- Ringkasan arsitektur
- Prinsip desain
- Diagram arsitektur (teks atau mermaid)
- Data flow
- ADR ringkas
- NFR
- Failure modes

8) docs/technical-blockchain-usage.md
- Ringkasan peran blockchain
- Komponen on-chain dan off-chain
- Smart contract scope
- Audit trail dan verifikasi
- Risiko dan mitigasi

9) docs/technical-database.md
- Ringkasan data model
- Entitas atau collections inti
- Relasi utama
- Indexing dan query penting
- Retensi data dan keamanan

10) docs/technical-security-privacy.md
- Ringkasan keamanan dan privasi
- Data classification
- Threat model ringkas
- Kontrol keamanan (auth, encryption, logging)
- Compliance atau regulasi

## Quick Reference
| Action | Instruction |
| --- | --- |
| Regenerate all docs | Overwrite every file in the manifest. |
| Keep structure | Follow existing section order and language. |
| Add Skill Referensi | Use the mapping above for each file. |
| Blockchain not in scope | Still generate the blockchain doc and mark it optional. |
| Avoid placeholders | No TODO/TBD anywhere. |

## Example: docs/product-demo-scenario.md
```markdown
# Skenario Demo Produk BISA

> **Skill Referensi:** mobile-developer + blockchain-developer + cognitive-fluency-psychology
> **Versi:** 2.0 | **Tanggal:** 7 April 2026
> **Tujuan:** Menunjukkan alur end-to-end dari onboarding hingga presentasi kredensial

---

## 1. Tujuan Demo
Menjelaskan bagaimana pengguna UMKM mendaftar, menghubungkan data, menghasilkan skor kredit, dan menerbitkan kredensial digital untuk verifikasi bank.

## 2. Persona Demo
- UMKM owner: ingin skor kredit cepat tanpa mengungkap data mentah
- Admin BISA: memantau status proses dan audit trail

## 3. Alur Demo Langkah Demi Langkah
1. Buka aplikasi dan lakukan registrasi passkeys.
2. Pilih platform data (contoh: Tokopedia).
3. Berikan consent dan lakukan autentikasi di in-app browser.
4. Sistem menampilkan bukti zkTLS dan status data siap scoring.
5. Tekan "Hitung Skor", tunggu hingga skor muncul.
6. Lihat faktor penyusun skor.
7. Terbitkan Verifiable Credential (VC).
8. Presentasikan VC ke bank melalui QR code.

## 4. Checklist Kesiapan
- Demo data akun tersedia dan valid
- Jaringan stabil untuk proses zkTLS
- Credential issuer dan audit trail aktif
- UI demo mode aktif untuk menampilkan langkah

## 5. Expected Outcomes
- Skor kredit tampil dalam kurang dari 30 detik
- VC terbit dan dapat diverifikasi oleh bank
- Pengguna memahami nilai privacy-by-design
```

## Validation Checklist
- Semua file dalam manifest ditulis ulang.
- Setiap file memiliki "Skill Referensi".
- Bahasa Indonesia dan struktur konsisten.
- Tidak ada TODO atau placeholder.
- Aturan blockchain dipenuhi.

## Common Mistakes
- Menghasilkan dokumen di luar manifest.
- Menghapus "Skill Referensi" atau menggantinya dengan skill generik.
- Mengosongkan bagian penting dengan placeholder.
- Menghapus dokumen blockchain ketika web3 tidak in scope.

## Rationalizations to Avoid
| Excuse | Reality |
| --- | --- |
| "Pakai daftar docs umum saja." | Gunakan manifest khusus repo ini. |
| "Kalau bukan web3, doc blockchain di-skip." | Tetap buat dan tandai opsional. |
| "Skill referensi bisa diabaikan." | Wajib ada dan harus cocok dengan mapping. |

## Red Flags
- Ada file selain manifest yang ikut dihasilkan.
- docs/technical-blockchain-usage.md tidak dibuat.
- "Skill Referensi" hilang atau berubah.
- Ada TODO, TBD, atau placeholder.
