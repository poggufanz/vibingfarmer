# Walkthrough Phase 3 — Local Test - Updated.

_Tanpa Sepolia deploy dulu — test frontend flow + fallback_

---

## Persiapan (5 menit)

### 1. Install MetaMask Flask
- Download: https://metamask.io/flask/
- Install di Chrome/Brave sebagai extension
- Buat wallet baru atau import existing
- Switch network ke **Sepolia Testnet**
- Pastikan punya sedikit Sepolia ETH (faucet: https://sepoliafaucet.com/)

### 2. Jalankan frontend
```
npx serve C:\SharredData\project\competition\vibing-farmer\frontend
```
Buka: http://localhost:3000

---

## Test Flow (tanpa Sepolia deploy)

### Step 1 — Cek halaman load ✅ Fixed
- Buka http://localhost:3000
- Expected: dark layout 3-kolom persis prototype — sidebar 58px, main column, right rail 320px
- Brand "yield/vibing" di topbar kiri, badge "● sepolia", step rail horizontal
- Buka DevTools (F12) → Console
- Expected: `YIELD VIBING ready. Connect wallet to start.` — no errors

Feedback: Still good.
---

### Step 2 — Connect Wallet
- Klik **Connect Wallet**
- MetaMask Flask popup → pilih account → Connect
- Jika minta switch ke Sepolia → approve
- Expected:
  - Step dot "01 Connect" hijau ✅
  - Activity log: `Connected: 0x...`
  - Right rail Wallet panel: address + "eip-7702 ready"
  - Tombol **Generate Strategy** aktif

Feedback: Still good.
---

### Step 3 — Generate Strategy (fallback mode) ✅ Fixed
- Form isi:
  - Amount: `10`
  - Risk: klik **Medium** (button highlighted)
  - Number of Vaults: `2`
  - Venice API Key: **kosongkan dulu** (pakai fallback)
- Klik **Generate Strategy**
- Expected:
  - Step dot "02 Generate Strategy" hijau ✅
  - Card strategy menghilang → graph container muncul
  - Graph: 1 node Orchestrator (kuning) + 2 Worker nodes (abu) + 2 Vault nodes (ungu)
  - Activity log: `Strategy: Fallback: equal split across available vaults`
  - Activity log: `Vault 1: 5.00 USDC → 0x000000...`
  - Tombol **Approve & Execute** aktif

Feedback: Still good.
---

### Step 4 — Klik node di graph ✅ Fixed
- Klik node **Orchestrator** → right rail: total agents, completed, failed
- Klik node **Worker 1** → right rail:
  - Agent ID
  - Vault address
  - Skills: "Generated when agent dispatches" (placeholder — normal sebelum execute)
  - Memory: "No entries yet" (placeholder — normal sebelum execute)

Feedback: Still good.
---

### Step 5 — Approve & Execute ✅ Fixed
- Klik **Approve & Execute**
- Expected: **MetaMask Flask popup muncul** untuk ERC-7715 permission
  - Jenis permission: `erc20-token-periodic`
  - Token: USDC Sepolia (`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`)
  - Period amount: 10 USDC
  - Expiry: 24 jam
- **Approve** di MetaMask Flask
- Expected setelah approve:
  - Step "03 Grant Permission" hijau ✅
  - Activity log: `Permission granted. Dispatching agents...`
  - Worker nodes berubah **biru** (active)
  - Activity log: `agent-xxx... started → vault 0x000000...`
  - **1Shot relay akan gagal** karena contract address masih `0x000...`
  - Worker nodes berubah **merah** (failed)
  - Activity log: `Agent xxx... failed: ...`
- **Ini EXPECTED** — 1Shot error karena contract belum deploy ke Sepolia

> Fixes yang masuk untuk Step 5:
> 1. `walletClient.grantPermissions` → `window.ethereum.request({ method: 'wallet_requestExecutionPermissions' })`
> 2. Tambah `data.tokenAddress: USDC_SEPOLIA` (required field)

Feedback: Mantap, activity menyatakan berhasil semua dan juga hasil akhirnya: Done — 2 deposited, 0 failed.
---

### Step 6 — Verifikasi memory tersimpan
- Buka DevTools → Application → Local Storage → http://localhost:3000
- Cek key `yv_memory` → harus ada entries dengan step `deposit` status `failed`
- Klik node Worker di graph → right rail tampil memory entries dengan lesson

Feedback: Execelent. 
---

### Step 7 — Reset
- Klik **Reset**
- Graph clear, log clear, semua step pending lagi ✅
- Right rail Wallet: "not connected"

Feedback: Execelent. 
---

## Test Venice AI (opsional — jika punya API key)

1. Daftar/login di https://venice.ai/
2. Dapatkan API key dari dashboard
3. Masukkan di field **Venice API Key**
4. Klik **Generate Strategy**
5. Expected: strategy dari Venice AI (bukan fallback), rationale berbeda

Feedback: API KEY sudah ada di .env.
---

## Deploy ke Sepolia (full test — end-to-end)

### 1. Siapkan .env
```
SEPOLIA_RPC=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
PRIVATE_KEY=0x...
ETHERSCAN_API_KEY=...
```
> Alchemy free tier: https://alchemy.com

### 2. Deploy
```
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/vibing-farmer && source .env && ~/.foundry/bin/forge script script/Deploy.s.sol --rpc-url \$SEPOLIA_RPC --broadcast --verify"
``` 
Result: p0ggufanz@p0ggufanz:/mnt/c/SharredData/project/competition/vibing-farmer$ source .env && ~/.foundry/bin/forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC --broadcast --verify
[⠆] Compiling...
No files changed, compilation skipped
Script ran successfully.

== Logs ==
  === Vibing Farmer Deployment ===
  VaultA (MockVault USDC-A): 0x72bC6b01A60e22ab8b9D62E8237B37633C36aBa5
  VaultB (MockVault USDC-B): 0x2BF6aa67D7a372ad0f4F45Bf2223156DF12eF9DF
  AgentVaultDepositor:       0xc17883C82Cd3c4FfF24B6C07eAd07840e4fa2404
  ================================
  Copy these into .env:
  AGENT_VAULT_DEPOSITOR_ADDRESS= 0xc17883C82Cd3c4FfF24B6C07eAd07840e4fa2404
  MOCK_VAULT_A_ADDRESS= 0x72bC6b01A60e22ab8b9D62E8237B37633C36aBa5
  MOCK_VAULT_B_ADDRESS= 0x2BF6aa67D7a372ad0f4F45Bf2223156DF12eF9DF

## Setting up 1 EVM.

==========================

Chain 11155111

Estimated gas price: 14.203527934 gwei

Estimated total gas used for script: 1377900

Estimated amount required: 0.0195710411402586 ETH

==========================

##### sepolia
✅  [Success] Hash: 0x099d606457a5198dab5f410b76615c32e77e8141e01b45e79921b9f47b3a154f
Contract: MockVault
Contract Address: 0x2BF6aa67D7a372ad0f4F45Bf2223156DF12eF9DF
Block: 10939780
Paid: 0.002052936377696022 ETH (286041 gas * 7.177070342 gwei)


##### sepolia
✅  [Success] Hash: 0x237622d69e49b3908d4488efec063f423497d648eb66daa6ee912742b4d827df
Contract: MockVault
Contract Address: 0x72bC6b01A60e22ab8b9D62E8237B37633C36aBa5
Block: 10939780
Paid: 0.002052936377696022 ETH (286041 gas * 7.177070342 gwei)


##### sepolia
✅  [Success] Hash: 0x502f0882e1ac0f9d291282185f385cb1f2631130b315c1e59b13a7bc8ab53b89
Contract: AgentVaultDepositor
Contract Address: 0xc17883C82Cd3c4FfF24B6C07eAd07840e4fa2404
Block: 10939780
Paid: 0.003501276349781964 ETH (487842 gas * 7.177070342 gwei)

✅ Sequence #1 on sepolia | Total Paid: 0.007607149105174008 ETH (1059924 gas * avg 7.177070342 gwei)


==========================

ONCHAIN EXECUTION COMPLETE & SUCCESSFUL.
##
Start verification for (3) contracts
Start verifying contract `0x72bC6b01A60e22ab8b9D62E8237B37633C36aBa5` deployed on sepolia
EVM version: cancun
Compiler version: 0.8.24
Optimizations:    200
Constructor args: 0000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000104d6f636b5661756c7420555344432d4100000000000000000000000000000000
ETHERSCAN_API_KEY is set, defaulting to Etherscan verifier. Unset it or pass `--verifier sourcify` (or another provider) to override.

Submitting verification for [contracts/MockVault.sol:MockVault] 0x72bC6b01A60e22ab8b9D62E8237B37633C36aBa5.
Error: Encountered an error verifying this contract:
Response: `NOTOK`
Details:
                        `You are using a deprecated V1 endpoint, switch to Etherscan API V2 using https://docs.etherscan.io/v2-migration`

### 3. Update config.js
Salin 3 address dari output deploy ke `frontend/config.js`:
```js
export const AGENT_VAULT_DEPOSITOR_ADDRESS = '0xc17883C82Cd3c4FfF24B6C07eAd07840e4fa2404'
export const MOCK_VAULT_A_ADDRESS = '0x72bC6b01A60e22ab8b9D62E8237B37633C36aBa5'
export const MOCK_VAULT_B_ADDRESS = '0x2BF6aa67D7a372ad0f4F45Bf2223156DF12eF9DF'

Feedback: Done.
```


### 4. Restart serve + ulangi flow
```
npx serve C:\SharredData\project\competition\vibing-farmer\frontend
```
Kali ini 1Shot relay akan hit contract asli → full flow sukses, worker nodes hijau, shares tercatat.
Feedback: Done, sedikit pertanyaan apakah di cmd dari step 2 deploy ke sepolia harus jalan terus jangan sampai berhenti di `You are using a deprecated V1 endpoint, switch to Etherscan API V2 using https://docs.etherscan.io/v2-migration` atau harus jalan terus?.
---

## Checklist Walkthrough

- [x] Halaman load tanpa error di console
- [x] Layout 3-kolom persis prototype (sidebar 58px / main / right rail 320px)
- [x] Connect Wallet sukses (MetaMask Flask Sepolia)
- [x] Right rail Wallet panel update setelah connect
- [x] Graph muncul setelah Generate Strategy
- [x] **ERC-7715 permission popup muncul** dari MetaMask Flask ← kunci step 5
- [x] Worker nodes berubah warna saat execute (abu → biru → hijau/merah)
- [x] Memory entries tersimpan di localStorage setelah execute
- [x] Node click → right rail tampil detail agent / orchestrator
- [x] Reset bersih

---

## Troubleshooting Cepat

| Problem | Fix |
|---------|-----|
| Halaman blank / error di console | Pastikan `npx serve frontend/` dari root project |
| `vis is not defined` | Refresh — vis.js UMD harus load sebelum ESM modules |
| MetaMask popup tidak muncul | Pastikan pakai Flask bukan regular MetaMask |
| `Switch to Sepolia` error | Buka MetaMask → switch manual ke Sepolia |
| ERC-7715 popup tidak muncul | Flask versi harus ≥ 13.9.0 |
| `wallet_requestExecutionPermissions failed` | Pastikan account terhubung + on Sepolia |
| Graph tidak muncul setelah Generate | Buka console → cek error import vis.js atau config.js |
| 1Shot relay failed (0x000 address) | Expected — perlu Sepolia deploy dulu untuk end-to-end |
