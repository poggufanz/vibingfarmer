# Skenario & Naskah Demo Presentasi: Vibing Farmer
**Tagline:** *"Set once. Vibe forever."*  
**Versi:** 2.0  
**Tanggal:** 13 Juni 2026  
**Bahasa:** Indonesia  

---

## 1. Persiapan Demo (Pre-Recording Checklist)

Sebelum merekam atau mempresentasikan, pastikan kondisi lingkungan pengujian adalah sebagai berikut:
1. **MetaMask Flask:** Terinstal di browser demo (bukan MetaMask biasa). Versi ≥ 13.9.0 untuk mendukung ERC-7715 secara penuh.
2. **Saldo Tes:** Akun Sepolia terhubung dan memiliki saldo tes minimal **100 USDC** dan sedikit **Sepolia ETH** untuk inisialisasi awal.
3. **Kontrak Pintar:** 
   - Kontrak [AgentRegistry.sol](file:///c:/SharredData/project/competition/vibing-farmer/contracts/AgentRegistry.sol) dan [AgentVaultDepositor.sol](file:///c:/SharredData/project/competition/vibing-farmer/contracts/AgentVaultDepositor.sol) sudah dideploy di Sepolia.
   - Alamat kontrak sudah tercantum di file konfigurasi [config.js](file:///c:/SharredData/project/competition/vibing-farmer/frontend/src/config.js).
4. **Kunci API Venice:** Konfigurasi `VENICE_API_KEY` aktif di `.env` (memakai model `llama-3.3-70b` untuk perumusan strategi pintar).
5. **Browser:** http://localhost:3000 sudah terbuka dan bersih dari state sesi lama (klik "Reset" jika diperlukan).

---

## 2. Struktur Visual & Komponen Codebase

Dalam demo ini, kita akan menyoroti bagaimana antarmuka (UI) berinteraksi langsung dengan kode logis aplikasi:
- **Upgrades EIP-7702:** Kode inisialisasi di [wallet.js](file:///c:/SharredData/project/competition/vibing-farmer/frontend/src/wallet.js) memicu upgrade EOA pengguna menjadi *Smart Account*.
- **Rekomendasi Venice AI:** Logika pemanggilan API Venice di [venice.js](file:///c:/SharredData/project/competition/vibing-farmer/frontend/src/venice.js) memicu pembuatan strategi deposit multi-vault.
- **Persetujuan Batasan Kriptografis (ERC-7715):** Kontrak [AgentRegistry.sol](file:///c:/SharredData/project/competition/vibing-farmer/contracts/AgentRegistry.sol) membatasi agen agar hanya bisa menyetor sesuai batas nominal, vault tertentu, dan batas waktu kedaluwarsa.
- **Eksekusi Swarm Tanpa Gas (1Shot Relayer):** Melalui [worker.js](file:///c:/SharredData/project/competition/vibing-farmer/frontend/src/worker.js) dan [relay.js](file:///c:/SharredData/project/competition/vibing-farmer/frontend/src/relay.js), agen menandatangani pesan EIP-712 yang kemudian disiarkan secara gasless oleh 1Shot Relayer ke fungsi `executeAgentDeposit` di [AgentVaultDepositor.sol](file:///c:/SharredData/project/competition/vibing-farmer/contracts/AgentVaultDepositor.sol).
- **Grafik Obsidian-Style (vis.js):** Perubahan status agen divisualisasikan secara real-time pada komponen grafis [AgentGraph` di `agents.jsx](file:///c:/SharredData/project/competition/vibing-farmer/frontend/src/agents.jsx).

---

## 3. Garis Besar Alur Demo (Timeline)

| Durasi | Scene | Fokus Tindakan | Visual Utama |
|---|---|---|---|
| **00:00 - 00:30** | **Scene 1: Pengenalan & Problem** | Masuk ke Landing Page, jelaskan frustrasi *yield farming* tradisional yang lambat dan mahal. | Hero section scroll-morph, logo Vibing Farmer. |
| **00:30 - 01:15** | **Scene 2: Koneksi Wallet (EIP-7702)** | Klik "Connect Wallet" -> Tampilkan upgrade EOA ke Smart Account via MetaMask Flask. | Popup MetaMask Flask, status "Smart Account Active" di Right Rail. |
| **01:15 - 02:15** | **Scene 3: Konsultasi AI (Venice AI)** | Input parameter: 100 USDC, Medium Risk, 2 Vaults. Klik "Generate Strategy". | Animasi thinking AI, panel simulasi Monte Carlo, Panel Deliberasi 3 Spesialis AI. |
| **02:15 - 03:00** | **Scene 4: Otorisasi Kriptografis (ERC-7715)** | Review skill JSON di UI, lalu klik "Approve". Tanda tangani batch permission di MetaMask Flask. | Panel Skill Editor, popup otorisasi MetaMask Flask. |
| **03:00 - 04:00** | **Scene 5: Eksekusi Swarm & vis.js Graph** | Klik "Launch Swarm". Lihat agen mengeksekusi swap -> approve -> deposit di graf secara real-time. | vis.js force-directed graph (Orchestrator -> Workers -> Steps -> Vaults). |
| **04:00 - 04:30** | **Scene 6: Memori Agen & Lesson Learned** | Klik node Worker yang selesai. Tunjukkan panel memori agen yang mencatat performa on-chain. | Panel detail memori (JSON log + lesson learned). |
| **04:30 - 05:00** | **Scene 7: Etherscan & Penutup** | Klik link Etherscan. Buktikan transaksi bebas gas yang dieksekusi oleh 1Shot Relayer. | Sepolia Etherscan, penutupan dengan tagline. |

## 4. Voiceover Script - English (with Pronunciation & Stressed Syllables)

Here is the complete word-for-word voiceover script for recording your demo video. The phonetic pronunciation guide is provided directly under each line, with **UPPERCASE** letters indicating where to place vocal stress/emphasis.

### Scene 1: Introduction & Problem

**"Hey everyone. Today I'm showing you Vibing Farmer..."**

> *[Hey EV-ri-wan. Tu-DEY aym SYO-wing yu VAY-bing FAR-mer...]*

**"...it's a tool that coordinates a swarm of AI agents to handle yield farming across multiple vaults in parallel, completely gas-free."**

> *[...its e tul det ko-OR-di-neyts e swarm of ey-ay EY-jents tu HEN-del YILD far-ming a-KROS MUL-ti-pel volts in PA-ra-lel, kom-PLIT-li gas-fri.]*

**"If you've ever tried farming in DeFi, you know how painful it is."**

> *[If yuv EV-er trayd FAR-ming in DI-fay, yu no haw PEYN-ful it is.]*

**"You want to split your funds into three different vaults, and you end up clicking through fifteen MetaMask popups..."**

> *[Yu wont tu split yor fands in-tu thri DI-frent volts, end yu end ap KLI-king thru FIF-tin me-ta-mask POP-aps...]*

**"...calculating gas costs in your head, and baby-sitting the transactions one by one. It's a mess."**

> *[...kal-kyu-LEY-ting gas kosts in yor hed, end BEY-bi-si-ting the tran-SAK-syens wan bay wan. Its e mes.]*

**"Vibing Farmer fixes this. The idea is simple: Set once. Vibe forever."**

> *[VAY-bing FAR-mer FIK-ses dis. The ay-DI-a is SIM-pel: Set wans. Vayb for-EV-er.]*

---

### Scene 2: Wallet Connection & EIP-7702

**"First, let's connect. I'll hit Connect Wallet."**

> *[Ferst, lets ko-NEKT. Ayl hit ko-NEKT WO-let.]*

**"We're using the new EIP-7702 standard here..."**

> *[Wir YU-zing the nyu i-ay-pi, se-ven-se-wen-o-tu STAN-dard hir...]*

**"...so my standard wallet gets upgraded to a Smart Account the moment I approve the connection in MetaMask Flask."**

> *[...so may STAN-dard WO-let gets ap-GREY-ded tu e Smart a-KAWNT the MO-ment ay a-PRUV the ko-NEK-syen in me-ta-mask flask.]*

**"Look at the right rail—there's the green Smart Account Active badge."**

> *[Luk et the rayt reyl—derz the grin Smart a-KAWNT AK-tiv bej.]*

**"This is huge because it lets us delegate transactions to our agents under strict rules, without ever giving up our main keys."**

> *[Dis is hyuj bi-KOS it lets as DE-le-geyt tran-SAK-syens tu awr EY-jents an-der strikt rulz, wi-THAWUT EV-er GI-ving ap awr meyn kiz.]*

---

### Scene 3: AI Consultation & Strategy Formulation

**"Now for the strategy. Let's put in 100 USDC, set the risk to Medium, and ask for 2 Vaults."**

> *[Naw for the STRA-te-ji. Lets put in wan-HAN-dred yu-es-di-si, set the risk tu MI-di-yum, end ask for tu volts.]*

**"When I click Generate Strategy, Venice JS talks directly to Venice AI running Llama 3.3 70b."**

> *[Hwen ay klik JE-ne-reyt STRA-te-ji, VE-nis jey-es toks di-REK-tli tu VE-nis ey-ay RA-ning LA-ma thri-poynt-thri se-ven-ti-bi.]*

**"Instead of just giving us a generic split, it actually explains the logic."**

> *[In-STED of jast GI-ving as e je-NE-rik split, it AK-cu-a-li eks-PLEYNS the LO-jik.]*

**"It suggests 60 USDC in MockVault A and 40 USDC in MockVault B."**

> *[It sa-JESTS SIKS-ti yu-es-di-si in mok-volt ey end FOR-ti yu-es-di-si in mok-volt bi.]*

**"You can see the AI Council here—three separate agents specializing in yield, risk, and market conditions debating the strategy."**

> *[Yu ken si the ey-ay KAWN-sil hir—thri SE-pa-reyt EY-jents SPE-sya-lay-zing in yild, risk, end MAR-ket kon-DI-syens di-BEY-ting the STRA-te-ji.]*

**"We even run a live Monte Carlo simulation showing bear, base, and bull projections so you know exactly what to expect."**

> *[Wi I-ven ran e layv MON-te KAR-lo si-myu-LEY-syen SYO-wing ber, beys, end bul pro-JEK-syens so yu no eg-ZAK-tli hwat tu eks-PEKT.]*

---

### Scene 4: Skill Review & ERC-7715 Permission Scoping

**"Before the agents touch any money, I can review their Skill Sets right here in the JSON editor."**

> *[Bi-FOR the EY-jents tac e-ni MA-ni, ay ken ri-VYU der skil sets rayt hir in the JEY-son E-di-tor.]*

**"If I don't like the slippage or limits, I can change them. I'm in control."**

> *[If ay dont layk the SLIP-ij or LI-mits, ay ken ceynj dem. Aym in kon-TROL.]*

**"Let's click Approve Skill Sets. MetaMask Flask pops up asking for ERC-7715 permissions."**

> *[Lets klik a-PRUV skil sets. me-ta-mask flask pops ap AS-king for i-ar-si, se-ven-se-wen-wan-fayv per-MI-syens.]*

**"This is the security layer."**

> *[Dis is the se-KYU-ri-ti LEY-er.]*

**"I'm authorizing the agents to handle my USDC under specific boundaries:"**

> *[Aym O-tho-ray-zing the EY-jents tu HEN-del may yu-es-di-si an-der spe-SI-fik BAWN-da-ris:]*

**"They can only touch the vaults I approved, they can't spend more than the cap, and the key expires in 24 hours."**

> *[Dey ken ON-li tac the volts ay a-PRUVD, dey kant spend mor den the kap, end the ki eks-PAYRS in twen-ti-for AW-erz.]*

**"The registry on-chain enforces these rules cryptographically."**

> *[The RE-jis-tri on-ceyn in-FOR-ses diz rulz krip-to-GRA-fi-kli.]*

---

### Scene 5: Swarm Execution & Fallback Jaringan

**"Now that the permissions are set, let's release the swarm. I'll click Launch Agent Swarm."**

> *[Naw det the per-MI-syens ar set, lets ri-LIS the swarm. Ayl klik lonc EY-jent swarm.]*

**"Check out this interactive network graph on the screen. The yellow node in the middle is the Orchestrator Agent, managing the execution."**

> *[Cek awt dis in-ter-AK-tiv NET-werk graf on the skrin. The YE-low nod in the MI-del is the OR-kes-trey-ter EY-jent, MA-na-jing the ek-se-KYU-syen.]*

*(Node Worker mulai berkedip kuning, masuk skenario Fallback)*

**"While we wait for the blockchain to confirm these transactions, let me explain what’s happening behind the scenes."**

> *[WA-yl wi weyt for the BLOK-ceyn tu kon-FIRM di-z tran-SAK-syens, let mi eks-PLEYN hwats HE-pe-ning bi-HAYND the sinz.]*

**"Notice how the worker nodes are blinking yellow. Right now, they aren't just waiting..."**

> *[NO-tis haw the WER-ker no-dz ar BLING-king YE-low. Rayt naw, dey arnt jast WEY-ting...]*

**"...they are actively crafting the EIP-712 signatures and passing them directly to the 1Shot Relayer."**

> *[...dey ar AK-tiv-li KRAF-ting the i-ay-pi, se-ven-wan-tu SIG-ne-cyers end PA-sing dem di-REK-tli tu the wan-syot RI-ley-er.]*

**"Because we are on Sepolia, block times can fluctuate. But here’s the actual beauty of this architecture:"**

> *[Bi-KOS wi ar on se-PO-li-a, blok tayms ken FLUK-cu-weyt. Bat hir-z the AK-cual BYU-ti of dis ar-ki-TEK-cyer:]*

**"As a user, I am entirely completely removed from this friction."**

> *[Es e YU-zer, aym in-TAYR-li kom-PLIT-li ri-MUVD from dis FRIK-syen.]*

**"I'm not sitting here clicking 'speed up transaction' in MetaMask. I'm not calculating gas spikes."**

> *[Aym not SI-ting hir KLI-king 'spid ap tran-SAK-syen' in me-ta-mask. Aym not kal-kyu-LEY-ting gas spayks.]*

**"The agent handles the asynchronous queueing, and if an RPC fails, the worker simply retries under the hood."**

> *[The EY-jent HEN-dels the ey-SING-kro-nes KYU-ing, end if en ar-pi-si feyls, the WER-ker SIM-pli ri-TRAYS an-der the hud.]*

*(Tunggu sampai node hijau)*

**"And there we go. The nodes are green. The swarm has successfully executed the entire pipeline."**

> *[End der wi go. The no-dz ar grin. The swarm hes sak-SES-fu-li EK-se-kyu-ted the in-TAYR PAYP-layn.]*

---

### Scene 6: Agent Memory & Traceability

**"Now, if I click on the Worker 1 node, I can see its memory log."**

> *[Naw, if ay klik on the WER-ker wan nod, ay ken si its ME-mo-ri log.]*

**"It shows the exact execution metrics, but what's cooler is the lesson learned at the bottom..."**

> *[It syos the eg-ZAK ek-se-KYU-syen ME-triks, bat hwats KU-ler is the LE-sen lernd et the BO-tom...]*

**"...like 'MockVault A accepted zero-point-five percent slippage reliably'."**

> *[...layk 'mok-volt ey ak-SEP-ted zi-ro-poynt-fayv per-SENT SLIP-ij ri-LAY-eb-li'.]*

**"The agent saves this feedback so Venice AI can read it in the next run to optimize the strategy. It gets smarter over time."**

> *[The EY-jent seyvs dis FID-bek so VE-nis ey-ay ken rid it in the nekst ran tu OP-ti-mays the STRA-te-ji. It gets SMAR-ter o-ver taym.]*

---

### Scene 7: Etherscan Verification & Outro

**"To wrap up, let's look at this transaction on Sepolia Etherscan."**

> *[Tu rap ap, lets luk et dis tran-SAK-syen on se-PO-li-a I-ther-skan.]*

**"If you look at the 'from' address, it's not my wallet—it's the 1Shot Relayer."**

> *[If yu luk et the 'from' a-DRES, its not may WO-let—its the wan-syot RI-ley-er.]*

**"The relayer paid the gas fee, meaning the user paid exactly zero."**

> *[The RI-ley-er peyd the gas fi, MI-ning the yu-zer peyd eg-ZAK-tli ZI-ro.]*

**"Yet, the shares were minted straight to my smart account."**

> *[Yet, the syers wer MIN-ted streyt tu may smart a-KAWNT.]*

**"100 USDC split across multiple vaults in under a minute, with one click, zero gas, and total control."**

> *[wan-HAN-dred yu-es-di-si split a-KROS MUL-ti-pel volts in AN-der e MI-nit, with wan klik, ZI-ro gas, end TO-tal kon-TROL.]*

**"Set once. Vibe forever. Thank you!"**

> *[Set wans. Vayb for-EV-er. Thengk yu!]*

---

## 5. Peta Alur Kode untuk Troubleshooting saat Demo

Jika juri atau penilai menanyakan detail codebase selama sesi tanya jawab (Q&A), Anda bisa merujuk ke bagian berkas berikut:

1. **Bagaimana Agen Membatasi Transaksi?**
   - Rujuk ke fungsi `executeAgentDeposit` pada baris 66-103 di [AgentVaultDepositor.sol](file:///c:/SharredData/project/competition/vibing-farmer/contracts/AgentVaultDepositor.sol). Tunjukkan pemeriksaan `ECDSA.recover` dan pembacaan scope dari `registry.scopeOf(agent)`.
2. **Di mana Status Kunci Agen Ephemeral Dikelola?**
   - Rujuk ke berkas [keyVault.js](file:///c:/SharredData/project/competition/vibing-farmer/frontend/src/strategy/keyVault.js) untuk fungsi enkripsi (`sealKey`, `openKey`) dan berkas [worker.js](file:///c:/SharredData/project/competition/vibing-farmer/frontend/src/worker.js) fungsi `setupKey()` baris 175-199.
3. **Bagaimana Penggabungan Batch Otorisasi Terjadi?**
   - Tunjukkan fungsi `dispatch()` baris 43-243 di [orchestrator.js](file:///c:/SharredData/project/competition/vibing-farmer/frontend/src/orchestrator.js), khususnya proses pembentukan array panggilan transaksi (`calls.push(buildAuthorizeSessionKeyCall(...))`) yang kemudian dikirim via `batchCalls` di baris 132.
