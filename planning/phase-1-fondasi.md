# Phase 1 — Fondasi & Environment Setup

> **Fase:** 1 dari 5 | **Hari:** 1–3 (26–28 Mei 2026)
> **Gate:** Foundry build OK + MetaMask Flask running + EIP-7702 tx sukses di Sepolia
> **Status:** 🔴 Belum mulai

---

## Hari 1 — Environment + API Keys (26 Mei)

### A. Dev Tools

- [ ] **Foundry** — install jika belum ada
  ```bash
  curl -L https://foundry.paradigm.xyz | bash
  foundryup
  # Verify:
  forge --version
  cast --version
  ```

- [ ] **Node.js** — v18+ required (untuk 1Shot SDK + tooling)
  ```bash
  node --version   # harus ≥ 18
  ```

- [ ] **MetaMask Flask** — download dan install di browser khusus demo
  - URL: https://metamask.io/flask/
  - Versi minimum: **13.9.0** (auto-upgrade EOA saat request permissions)
  - ⚠️ Install di browser profile TERPISAH dari regular MetaMask
  - Buat wallet baru khusus demo → catat seed phrase di tempat aman
  - Switch network ke **Sepolia** di Flask

- [ ] **Sepolia ETH** — isi wallet demo + wallet 1Shot
  - Alchemy faucet: https://sepoliafaucet.com/
  - Infura faucet: https://www.infura.io/faucet/sepolia
  - Ambil minimal 0.2 ETH (0.1 untuk deploy, 0.1 untuk 1Shot wallet)

---

### B. API Keys

Ambil semua API key hari ini. Jangan tunggu sampai implementation.

- [ ] **Sepolia RPC** — daftar Alchemy (gratis)
  - URL: https://dashboard.alchemy.com/
  - Buat app baru → pilih Sepolia → copy HTTP URL
  - Format: `https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY`

- [ ] **1Shot API** — **tidak perlu API key**
  - Endpoint: `https://relayer.1shotapi.com/relayers` (pure JSON-RPC, no auth)
  - Baca OpenRPC spec di endpoint tersebut untuk konfirmasi method name + params
  - Tidak perlu daftar akun, tidak perlu funded wallet

- [ ] **Venice AI**
  - URL: https://venice.ai → Sign Up
  - Settings → API → Generate API Key
  - Test segera:
  ```bash
  curl https://api.venice.ai/api/v1/models?type=text \
    -H "Authorization: Bearer YOUR_VENICE_KEY" | head -50
  # Cek apakah llama-3.3-70b ada di list
  ```

- [ ] **Etherscan Sepolia API** (untuk verify contract nanti)
  - URL: https://sepolia.etherscan.io/ → My Account → API Keys

---

### C. Repo Setup

- [ ] Copy `.env.example` → `.env`, isi semua key yang sudah dapat

  ```bash
  cp .env.example .env   # atau buat manual kalau belum ada
  ```

  Isi `.env`:
  ```bash
  SEPOLIA_RPC=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
  PRIVATE_KEY=0x...              # private key wallet deployer (bukan demo wallet)
  ONESHOT_CLIENT_ID=...
  ONESHOT_CLIENT_SECRET=...
  VENICE_API_KEY=...
  ETHERSCAN_API_KEY=...
  # Ini diisi nanti setelah deploy:
  # VAULT_DEPOSITOR_ADDRESS=0x...
  # MOCK_VAULT_ADDRESS=0x...
  # ONESHOT_CONTRACT_METHOD_ID=...
  ```

- [ ] Buat `.env.example` dengan placeholder:

  ```bash
  SEPOLIA_RPC=https://eth-sepolia.g.alchemy.com/v2/YOUR_ALCHEMY_KEY
  PRIVATE_KEY=0x_your_deployer_private_key
  ONESHOT_CLIENT_ID=your_1shot_client_id
  ONESHOT_CLIENT_SECRET=your_1shot_client_secret
  VENICE_API_KEY=your_venice_api_key
  ETHERSCAN_API_KEY=your_etherscan_api_key
  VAULT_DEPOSITOR_ADDRESS=0x_fill_after_deploy
  MOCK_VAULT_ADDRESS=0x_fill_after_deploy
  ONESHOT_CONTRACT_METHOD_ID=fill_after_dashboard_setup
  ```

---

## Hari 2 — Foundry Init + Struktur Kontrak (27 Mei)

### A. Init Foundry Project

```bash
# Di root yield-vibing/
forge init --no-git   # --no-git karena repo sudah ada

# Rename default folders sesuai GETTING_STARTED.md
# Foundry default bikin src/ → rename ke contracts/
# Edit foundry.toml:
```

Buat `foundry.toml`:
```toml
[profile.default]
src = "contracts"
out = "out"
libs = ["lib"]
solc = "0.8.24"
optimizer = true
optimizer_runs = 200

[rpc_endpoints]
sepolia = "${SEPOLIA_RPC}"

[etherscan]
sepolia = { key = "${ETHERSCAN_API_KEY}" }
```

- [ ] Hapus file default Foundry (`contracts/Counter.sol`, `test/Counter.t.sol`, `script/Counter.s.sol`)
- [ ] Install OpenZeppelin:
  ```bash
  forge install OpenZeppelin/openzeppelin-contracts --no-commit
  ```
- [ ] Buat `remappings.txt`:
  ```
  @openzeppelin/=lib/openzeppelin-contracts/
  ```
- [ ] Verify build bersih:
  ```bash
  forge build   # harus clean, 0 contracts = OK
  ```

---

### B. Buat Skeleton Files

Buat file kosong dulu — isi nanti di Phase 2.

```bash
# Contracts
type nul > contracts\VaultDepositor.sol
type nul > contracts\MockVault.sol

# Tests
type nul > test\VaultDepositor.t.sol
type nul > test\MockVault.t.sol

# Deploy script
type nul > script\Deploy.s.sol

# Frontend
mkdir frontend
type nul > frontend\index.html
type nul > frontend\app.js
type nul > frontend\wallet.js
type nul > frontend\relay.js
type nul > frontend\venice.js
type nul > frontend\ui.js
type nul > frontend\style.css
```

Verify struktur:
```
yield-vibing/
├── contracts/
│   ├── VaultDepositor.sol   (empty)
│   └── MockVault.sol        (empty)
├── test/
│   ├── VaultDepositor.t.sol (empty)
│   └── MockVault.t.sol      (empty)
├── script/
│   └── Deploy.s.sol         (empty)
├── frontend/                (empty files)
├── design/                  (existing prototype)
├── lib/                     (OpenZeppelin)
├── foundry.toml
├── .env
└── .gitignore
```

---

### C. Cek Design Prototype

Run design prototype — baca visual reference sebelum mulai frontend.

```bash
npx serve design/
```

Buka: `http://localhost:3000/YIELD%20VIBING%20Prototype.html`

- [ ] Lihat semua 6 screen: Input → Recommend → Connect → Permission → Execute → Success
- [ ] Buka `DESIGN.md` — baca section 6 (Components) dan 9 (Per-Screen Signatures)
- [ ] Cek Tweaks panel (kanan bawah) — ganti palette, density, demo speed

---

## Hari 3 — Verifikasi EIP-7702 di Sepolia (28 Mei)

Ini **gate paling penting** sebelum nulis kontrak apapun.

### A. Test EIP-7702 Hello World

Buat file test sederhana (boleh di luar repo, di folder temp):

```javascript
// test-eip7702.mjs — run dengan: node test-eip7702.mjs
import { createPublicClient, createWalletClient, http } from 'https://esm.sh/viem'
import { privateKeyToAccount } from 'https://esm.sh/viem/accounts'
import { sepolia } from 'https://esm.sh/viem/chains'
```

Atau lebih mudah: buka browser, buka console di halaman kosong, paste:

```javascript
// Step 1: Check apakah MetaMask Flask aktif
console.log('MetaMask version:', window.ethereum?.version)

// Step 2: Request accounts
const accounts = await ethereum.request({ method: 'eth_requestAccounts' })
console.log('Account:', accounts[0])

// Step 3: Check network
const chainId = await ethereum.request({ method: 'eth_chainId' })
console.log('ChainId:', chainId)  // harus 0xaa36a7 (Sepolia)

// Step 4: Check apakah wallet sudah support wallet_getSupportedExecutionPermissions
try {
  const supported = await ethereum.request({
    method: 'wallet_getSupportedExecutionPermissions',
    params: []
  })
  console.log('ERC-7715 supported:', supported)
} catch (e) {
  console.error('ERC-7715 NOT supported:', e.message)
  // Jika error: pastikan MetaMask Flask 13.9+
}

// Step 5: Check EOA code (apakah sudah upgraded)
const code = await ethereum.request({
  method: 'eth_getCode',
  params: [accounts[0], 'latest']
})
console.log('EOA code:', code)
// '0x' = belum upgrade (normal EOA)
// '0xef0100...' = sudah upgrade ke smart account
```

**Expected results:**
- `chainId` = `0xaa36a7` ✅
- `wallet_getSupportedExecutionPermissions` = object dengan permission types ✅
- `EOA code` = `0x` (belum upgrade, normal) ✅

Jika `wallet_getSupportedExecutionPermissions` throw error → **Flask version salah, update dulu sebelum lanjut.**

---

### B. Test ERC-7715 Permission Grant

```javascript
// Paste di browser console (MetaMask Flask harus aktif)
const accounts = await ethereum.request({ method: 'eth_requestAccounts' })

// Dummy permission test — ganti address nanti dengan VaultDepositor yang sudah deploy
const DUMMY_SESSION_ACCOUNT = '0x0000000000000000000000000000000000000001'
const USDC_SEPOLIA = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'

try {
  const result = await ethereum.request({
    method: 'wallet_requestExecutionPermissions',
    params: [{
      chainId: '0xaa36a7',
      from: accounts[0],
      to: DUMMY_SESSION_ACCOUNT,
      permission: {
        type: 'erc20-token-periodic',
        isAdjustmentAllowed: false,
        data: {
          tokenAddress: USDC_SEPOLIA,
          periodAmount: '10000000',   // 10 USDC
          periodDuration: 86400,
          justification: 'Test permission for yield-vibing'
        }
      },
      rules: [{
        type: 'expiry',
        data: { timestamp: Math.floor(Date.now() / 1000) + 3600 }
      }]
    }]
  })
  
  console.log('Permission granted!')
  console.log('context:', result[0].context)
  console.log('delegationManager:', result[0].delegationManager)
  console.log('from (user smart account):', result[0].from)
  
  // Cek apakah EOA auto-upgraded
  const code = await ethereum.request({
    method: 'eth_getCode',
    params: [accounts[0], 'latest']
  })
  console.log('EOA code after upgrade:', code)
  // Seharusnya sekarang = 0xef0100... (sudah jadi smart account)
  
} catch (e) {
  console.error('FAILED:', e)
}
```

**Expected:** MetaMask Flask popup muncul dengan detail permission. User approve. Response berisi `context` + `delegationManager`. EOA code berubah jadi `0xef0100...`.

---

### C. Screenshot & Catat Hasil

Setelah semua test berhasil, catat di file ini:

**Hasil Verifikasi:**

| Check | Status | Notes |
|-------|--------|-------|
| MetaMask Flask version | [ ] | Version: ___ |
| Sepolia RPC working | [ ] | Block number: ___ |
| `wallet_getSupportedExecutionPermissions` | [ ] | Response: ___ |
| `wallet_requestExecutionPermissions` | [ ] | context prefix: ___ |
| EOA upgraded to smart account | [ ] | Code: 0xef0100___ |
| 1Shot API token working | [ ] | `expires_in`: ___ |
| Venice AI response working | [ ] | Model used: ___ |

---

## Gate Check — Phase 1 Complete?

Semua harus ✅ sebelum mulai Phase 2 (nulis kontrak).

- [ ] `forge build` clean
- [ ] MetaMask Flask 13.9+ installed, running on Sepolia
- [ ] `wallet_getSupportedExecutionPermissions` returns supported types
- [ ] `wallet_requestExecutionPermissions` shows MetaMask popup
- [ ] EOA code = `0xef0100...` setelah permission grant
- [ ] Sepolia ETH di deployer wallet ≥ 0.1 ETH
- [ ] Sepolia ETH di 1Shot wallet ≥ 0.05 ETH (diisi via 1Shot dashboard)
- [ ] All 4 API keys tested and working (SEPOLIA_RPC, ONESHOT, VENICE, ETHERSCAN)
- [ ] `.env` filled, `.env.example` committed

**Jika semua ✅ → lanjut ke `planning/phase-2-smart-contract.md`**

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `wallet_getSupportedExecutionPermissions` not found | Update Flask ke 13.9+ |
| Sepolia RPC 429 rate limit | Upgrade Alchemy free tier atau ganti ke Infura |
| `forge: command not found` | Run `source ~/.bashrc` atau restart terminal setelah `foundryup` |
| Flask popup tidak muncul | Test di Chrome bukan Firefox, disable other wallet extensions |
| Venice API 401 | Key belum aktif atau typo — cek di Venice dashboard |
| 1Shot token endpoint 400 | `client_id` vs `CLIENT_ID` — perhatikan key name dari dashboard |

---

_Dibuat: 2026-05-26 | Phase 1 dari 5_
