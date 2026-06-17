Ini hasil research aku dari setiap step, nah aku ingin juga semua step jangan langsung keliatan, tapi ganti gantian, sekalian update.

## Step 1 — Formalize State/Action/Reward

**Inspired by**: FinRL (AI4Finance Foundation)

### Narasi

FinRL mendefinisikan trading sebagai RL problem dengan tiga elemen: State (apa yang diamati), Action (apa yang bisa dilakukan), Reward (bagaimana mengukur sukses). Vibing Farmer butuh formalisasi yang sama supaya agent punya bahasa yang jelas — bukan sekadar "fetch data → tanya AI".

State harus mencakup semua yang dibutuhkan untuk membuat keputusan. Action harus terdefinisi jelas. Reward harus measurable dan tidak ambigu.

## Step 2 — Autonomous Monitor Loop

**Inspired by**: autoresearch (Andrej Karpathy) — prinsip "NEVER STOP"

### Narasi

autoresearch menjalankan loop tak terbatas: modifikasi kode → train → evaluasi → keep/discard → ulangi. Loop ini jalan semalam penuh tanpa intervensi manusia.

Di Vibing Farmer, loop-nya: fetch state → run gates → simulate → council → execute → sleep → ulangi. Yang penting: loop TIDAK boleh crash karena satu error. Setiap error dicatat dan loop lanjut ke cycle berikutnya — persis seperti autoresearch yang punya "crash recovery" di `program.md`.

## Step 3 — Parallel Data Fetch

**Inspired by**: EvoAgentX (DAG workflow — nodes run concurrently)

### Narasi

EvoAgentX menggunakan DAG (Directed Acyclic Graph) di mana nodes yang tidak saling bergantung berjalan secara paralel. Di Vibing Farmer, fetch pools, fetch gas price, fetch positions, dan fetch on-chain signals TIDAK saling bergantung — jadi bisa semua jalan serentak via `Promise.all`.

Kalau sequential: 4 × 500ms = 2 detik. Kalau parallel: max(500ms) = 500ms. Dengan DeFi timing yang penting, ini non-trivial.


## Step 4 — Fast-fail Gates

**Inspired by**: FinRL (Turbulence Index + risk constraints)

### Narasi

FinRL punya konsep Turbulence Index: kalau market chaos, hanya izinkan sell action. Selain itu, FinRL mendefinisikan constraint keras di environment — kalau state tertentu terdeteksi, agent otomatis di-restrict.

Di Vibing Farmer, gates ini adalah GARIS PERTAHANAN PERTAMA. Semuanya pure math — tidak ada AI call, tidak ada network request. Kalau gate gagal, loop langsung sleep tanpa membuang Venice AI credit.

Gates harus di-code sebagai pure functions: input → boolean. Mudah ditest, mudah di-debug.


## Step 5 — Simulation Engine

**Inspired by**: Konsep ZX (alternate timeline simulation) — lightweight DeFi adaptation

### Narasi

ZX original bayangkan ribuan agents berinteraksi selama jam/hari. Di Vibing Farmer, "simulation" bukan full agent-based — tapi tetap bisa menangkap spirit-nya: jalankan beberapa "alternate futures/timeline" dengan asumsi berbeda, lihat distribusi outcome, ambil expected value.

Yang bikin output ini powerful bukan jumlah scenarios-nya, tapi richness context yang dikirim ke setiap scenario — TVL trend, news sentiment, on-chain signals, historical APY.


## Step 6 — AI Council

**Inspired by**: TradingAgents (TauricResearch) — Bull/Bear researcher debate pattern

### Narasi

TradingAgents mensimulasikan firma trading nyata: ada fundamental analyst, sentiment analyst, technical analyst, risk manager, portfolio manager. Setiap agent punya role spesifik, dan mereka berkolaborasi — termasuk Bull/Bear researchers yang berdebat.

Di Vibing Farmer: tiga specialist agents jalan parallel, setiap satu punya system prompt dan data yang benar-benar berbeda. Yang bikin ini bukan sekedar "nanya hal yang sama 3 kali" adalah karena:
1. Setiap agent lihat dimensi berbeda
2. Setiap agent punya subset playbook yang relevan untuk role-nya
3. Output-nya compressed verdict, bukan free-text

Setiap verdict harus include `citedRules` — rules playbook mana yang dipakai untuk decide. Ini yang memungkinkan Reflector mengupdate counters-nya nanti.

## Step 7 — Consensus Gate + Decision Logging

**Inspired by**: EvoDS (ACC pattern — compressed verdicts → manager decision)

### Narasi

EvoDS menggunakan ACC (Adaptive Context Compression): sub-agents mengkompresi output mereka sebelum dikirim ke Manager Agent. Manager tidak menerima raw log panjang — hanya compressed verdict.

Di Vibing Farmer, consensus gate adalah "manager" yang menerima 3 compressed verdicts dan memutuskan. Logic-nya sederhana dan deterministic: butuh 2/3 majority DAN minimum confidence. Kalau salah satu tidak terpenuhi → HOLD.


## Step 8 — Playbook Storage

**Inspired by**: ACE Stanford (Evolving Playbook — Generator/Reflector/Curator pattern, ICLR 2026)

### Narasi

ACE paper memperkenalkan konsep "playbook sebagai living document" — bukan static prompt, tapi collection of rules yang tumbuh, di-refine, dan di-prune berdasarkan empirical evidence.

Setiap rule punya:
- ID unik (`defi-001`)
- Category (`risk | gas | strategy`)
- Counters `helpful` dan `harmful` — diupdate setiap kali rule dipakai dan outcome diketahui
- Text — the actual rule

Rules dengan `harmful >> helpful` setelah minimum evaluations di-prune otomatis. Ini yang bikin playbook makin akurat seiring waktu tanpa human intervention.


## Step 9 — Execution Layer

**Inspired by**: MetaMask Smart Accounts Kit + 1Shot API

### Narasi

Yang membedakan "autonomous agent" dari "assistant yang butuh konfirmasi" adalah kemampuan execute tanpa human approval per-transaksi.

MetaMask Smart Accounts (ERC-4337) memungkinkan pre-authorized session keys: user sign SEKALI di awal untuk authorize agent execute dalam batas tertentu (max gas, whitelist protocol, max amount per tx). Setelah itu, agent bisa execute tanpa popup MetaMask.

1Shot API adalah middleware yang abstract complexity on-chain transaction — agent cukup bilang "move 100% dari pool A ke pool B" dan 1Shot handle routing, approval, execution.


## Step 10 — Outcome Tracker

**Inspired by**: autoresearch (results.tsv — track every experiment outcome) + FinRL (backtesting evaluation)

### Narasi

autoresearch mencatat setiap eksperimen di `results.tsv`: commit hash, val_bpb, status (keep/discard/crash). Agent tahu apa yang berhasil dan apa yang tidak karena ada historical record.

Di Vibing Farmer, outcome tracker adalah komponen TERPISAH yang jalan async — bukan di main loop. Dia evaluate keputusan yang sudah dibuat 7 hari lalu: apakah benar-benar profitable setelah gas dan IL?

Hasil evaluasi ini yang menjadi "ground truth" untuk ACE Reflector. Tanpa outcome tracker, Reflector buta — tidak tahu mana keputusan yang bagus dan mana yang buruk.

**Perbedaan kritis dari ACE original**: ACE evaluate secara immediate (tahu langsung benar/salah). DeFi evaluate secara delayed (butuh 7 hari untuk tahu yield actual). Ini kenapa outcome tracker jalan di cron job terpisah, bukan di dalam main loop.


## Step 11 — Reflector

**Inspired by**: ACE Stanford — Reflector Agent (tag rules helpful/harmful, extract insights)

### Narasi

ACE Reflector punya dua tugas: (1) tag setiap playbook rule yang dipakai sebagai helpful atau harmful berdasarkan outcome, (2) extract insight baru dari kegagalan.

Di Vibing Farmer, Reflector jalan async setelah Outcome Tracker selesai evaluasi. Dia menerima `decision` (dengan `citedRules`) dan `outcome` (wasProfit, netResultUSD).

Kalau profitable → semua cited rules dapat `helpful++`. Kalau loss → semua cited rules dapat `harmful++`. Plus Reflector mencoba extract rule baru dari kegagalan — apa yang harusnya diketahui agent sebelum keputusan itu dibuat?

**Key difference dari ACE original**: Di ACE, ground truth immediate (benar/salah langsung diketahui). Di Vibing Farmer, ground truth delayed 7 hari. Tapi mechanism-nya sama.


## Step 12 — Curator

**Inspired by**: ACE Stanford — Curator Agent (ADD new rules, prevent context collapse)

### Narasi

ACE Curator menambahkan rules secara incremental — tidak rewrite seluruh playbook (itu yang menyebabkan "context collapse" di pendekatan naif). Setiap ADD operation kecil dan targeted.

Sebelum ADD, Curator check duplikat menggunakan Jaccard similarity sederhana. Kalau rule yang sangat mirip sudah ada, increment counter-nya daripada tambah rule baru yang redundant.


## Step 13 — BulletpointAnalyzer (Simplified)

**Inspired by**: ACE Stanford — BulletpointAnalyzer (FAISS + sentence-transformers → simplified ke Jaccard + Venice AI)

### Narasi

ACE menggunakan FAISS + sentence-transformers untuk detect semantically similar rules, lalu merge mereka via LLM. Untuk Vibing Farmer, kita simplify: Jaccard similarity untuk detect candidates, Venice AI untuk merge.

Yang penting dari ACE pattern: saat merge, **sum the counters**. Rule A dengan `helpful=3` dan rule B dengan `helpful=2` yang di-merge jadi satu rule dengan `helpful=5`. Empirical evidence-nya dipertahankan, tidak hilang.
