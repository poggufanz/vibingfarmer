# Vibing Farmer — Spec-Grade Roadmap v2 (Base Sepolia)

> **Audiens dokumen ini: AI coding agent + developer (Faiq).**
> Setiap task berisi: Context, Spec (signature/storage/events/errors), Logic (urutan eksekusi eksplisit),
> Edge Cases, Acceptance Criteria (AC), Verification, dan **DO NOT** (anti-halusinasi).

---

## §0 — ATURAN ANTI-HALUSINASI UNTUK AI AGENT (BACA SEBELUM TASK APAPUN)

1. **JANGAN mengarang alamat kontrak.** Semua alamat eksternal (USDC, DelegationManager, vault, router) HARUS diambil dari sumber di §0.2 atau dari `deployments/base-sepolia.json` di repo. Kalau tidak ditemukan → STOP, tanya user. Jangan pakai alamat dari training data.
2. **JANGAN mengubah jalur otorisasi.** Fakta terverifikasi (audit Consensys Diligence atas `ERC20PeriodTransferEnforcer.sol`): enforcer `erc20-token-periodic` HANYA melepas calldata `IERC20.transfer(address,uint256)` — tepat 68 bytes, target eksekusi HARUS sama dengan token address di terms, selector HARUS `0xa9059cbb`. `approve()`, `deposit()`, atau fungsi lain TIDAK AKAN PERNAH lolos enforcer ini. Jangan menulis kode yang mencoba redeem 7715 untuk selain `transfer()`.
3. **JANGAN memindahkan validasi keamanan ke server/off-chain.** Semua batas (cap, vault target, expiry, slippage) sumber kebenarannya adalah storage on-chain.
4. **JANGAN memberi worker/session account custody dana user**, bahkan transien dalam satu tx, kecuali dinyatakan eksplisit di task.
5. **Versi & dependensi:** Solidity `^0.8.24`, Foundry, OpenZeppelin Contracts ≥5.x (`ReentrancyGuard`, `SafeERC20`, `Pausable`). Jangan pakai pattern OZ 4.x (`safeApprove` deprecated → pakai `forceApprove`).
6. Setiap nilai bertanda **[VERIFY]** wajib diverifikasi manual sebelum dipakai — jangan dianggap fakta.

### §0.1 Network Config (deployment target)

| Param | Nilai |
|---|---|
| Chain | Base Sepolia |
| Chain ID | `84532` |
| RPC env var | `BASE_SEPOLIA_RPC` |
| Explorer | `https://sepolia.basescan.org` (API key: `BASESCAN_API_KEY`) |
| Native token | ETH (testnet) |
| USDC testnet | **[VERIFY]** ambil dari Circle developer docs (developers.circle.com → USDC contract addresses → Base Sepolia). Jangan pakai mock ERC20 sendiri. |
| Bundler/Paymaster | Pimlico atau Alchemy, keduanya support Base Sepolia. Env: `BUNDLER_RPC`, `PAYMASTER_RPC` |

Chain lain yang dipakai HANYA untuk fork test (bukan deployment):
- `MAINNET_RPC` — Ethereum mainnet archive (Fase 3, data historis USDC depeg)
- `BASE_MAINNET_RPC` — Base mainnet archive (Fase 4, vault riil Morpho)

`foundry.toml`:
```toml
[rpc_endpoints]
base_sepolia = "${BASE_SEPOLIA_RPC}"
eth_mainnet  = "${MAINNET_RPC}"
base_mainnet = "${BASE_MAINNET_RPC}"

[etherscan]
base_sepolia = { key = "${BASESCAN_API_KEY}", chain = 84532 }
```

### §0.2 Sumber kebenaran eksternal

| Hal | Sumber |
|---|---|
| Alamat USDC Base Sepolia | Circle developer docs **[VERIFY]** |
| Deployment Delegation Framework per chain | package `@metamask/delegation-deployments` (monorepo MetaMask/smart-accounts-kit) **[VERIFY]** Base Sepolia ada atau tidak |
| Dukungan 7715 Snaps per chain | **[VERIFY — BLOCKER]** Per hacker guide MetaMask, Snaps untuk ERC-7715 (Permission Kernel + Gator Permissions) tercatat hanya jalan di Ethereum Sepolia. Test langsung `wallet_requestExecutionPermissions` di Base Sepolia. Hasil test menentukan §0.3. |
| 1Shot relayer chains | docs 1Shot **[VERIFY]** support Base Sepolia |
| Block number USDC depeg | Etherscan, cari block dengan timestamp 10–11 Mar 2023 **[VERIFY]** (~16.8jt adalah aproksimasi) |

### §0.3 Keputusan arsitektur otorisasi (isi setelah verifikasi)

- **Jika 7715 jalan di Base Sepolia:** Jalur A — 7715 `erc20-token-periodic` untuk leg `transfer(depositor, amount)`; sisanya via registry (Task 1.2).
- **Jika TIDAK:** Jalur B — full custom registry: user `approve(depositor)` sekali + `authorizeSessionKey` via EIP-5792 batch; depositor pakai `transferFrom` (Task 1.3 varian B).
- Dokumen ini menulis spec untuk KEDUA jalur di task terkait. Pilih satu, hapus yang lain dari implementasi.

---

## FASE 1 — FONDASI TRUST

### Task 1.1 — `fix(docs): koreksi klaim jalur otorisasi`
**Branch:** `fix/readme-authorization-path` · **File:** `README.md`, `docs/technical-blockchain-usage.md`

**Context:** README mengklaim worker mengeksekusi Swap→Approve→Deposit via permission ERC-7715. Mustahil (lihat §0 aturan 2).

**Langkah:**
1. Revisi "How it works" poin 4–5: tulis jalur sesuai keputusan §0.3.
2. Tambah sequence diagram (mermaid) untuk jalur terpilih di `technical-blockchain-usage.md`.
3. Tambah subbagian "Why not pure ERC-7715" berisi fakta enforcer (68 bytes / transfer-only / target=token) + link audit.

**AC:** `grep -ri "7715" docs/ README.md` → tidak ada klaim approve/deposit via 7715.
**DO NOT:** jangan hapus referensi 7715 seluruhnya — leg `transfer()` (Jalur A) tetap valid.

---

### Task 1.2 — `feat(contracts): AgentRegistry — scope on-chain`
**Branch:** `feat/onchain-agent-scope` · **File:** `contracts/AgentRegistry.sol` (baru)

**Context:** Satu-satunya sumber kebenaran batas agent. Semua fungsi eksekusi depositor bergantung pada kontrak ini.

**Spec — storage:**
```solidity
struct AgentScope {
    address owner;          // user pemberi izin (immutable setelah set)
    address vault;          // ERC-4626 target, hard-pinned, satu agent = satu vault
    address token;          // underlying asset vault
    uint96  capPerPeriod;   // batas kumulatif amount per period (token decimals)
    uint32  periodDuration; // detik, > 0
    uint96  spentInPeriod;
    uint40  periodStart;    // anchor fixed-window
    uint40  expiry;         // unix ts; HARUS <= block.timestamp + MAX_DURATION
    bool    revoked;
}
mapping(address agent => AgentScope) public scopes;
uint256 public constant MAX_DURATION = 30 days;
```

**Spec — fungsi & events:**
```solidity
event AgentAuthorized(address indexed owner, address indexed agent, address vault, address token, uint96 capPerPeriod, uint32 periodDuration, uint40 expiry);
event AgentRevoked(address indexed owner, address indexed agent);

error ScopeExists();
error InvalidScope();
error NotOwner();

function authorizeSessionKey(address agent, address vault, address token, uint96 capPerPeriod, uint32 periodDuration, uint40 expiry) external;
function revokeAgent(address agent) external;
function isActive(address agent) public view returns (bool);
```

**Logic `authorizeSessionKey` (urutan persis):**
1. `if (scopes[agent].owner != address(0)) revert ScopeExists();` — satu agent key = satu scope, selamanya. Re-scope = key baru. (Mencegah scope-swap attack pada key lama.)
2. `if (agent == address(0) || vault == address(0) || token == address(0)) revert InvalidScope();`
3. `if (capPerPeriod == 0 || periodDuration == 0) revert InvalidScope();`
4. `if (expiry <= block.timestamp || expiry > block.timestamp + MAX_DURATION) revert InvalidScope();`
5. `if (IERC4626(vault).asset() != token) revert InvalidScope();` — konsistensi vault↔token dicek on-chain, bukan dipercaya dari input.
6. Tulis scope: `owner = msg.sender`, `periodStart = uint40(block.timestamp)`, `spentInPeriod = 0`, `revoked = false`.
7. Emit `AgentAuthorized`.

**Logic `revokeAgent`:**
1. `if (scopes[agent].owner != msg.sender) revert NotOwner();`
2. `scopes[agent].revoked = true;` emit `AgentRevoked`.
3. TIDAK menghapus struct (audit trail) dan TIDAK boleh bergantung pada relayer — callable langsung dari EOA user.

**Logic `_rollPeriod` (internal, dipanggil depositor):**
```solidity
function _rollPeriod(AgentScope storage s) internal {
    uint256 elapsed = block.timestamp - s.periodStart;
    if (elapsed >= s.periodDuration) {
        s.periodStart += uint40((elapsed / s.periodDuration) * s.periodDuration);
        s.spentInPeriod = 0;
    }
}
```

**Edge cases (wajib di-test):**
- Burst boundary: fixed window mengizinkan total 2×cap dalam rentang < 2×duration di sekitar boundary. Ini ACCEPTED & terdokumentasi (sama dengan perilaku enforcer MetaMask). Max-loss formula: `capPerPeriod × ceil((expiry − now) / periodDuration)`.
- `authorizeSessionKey` untuk agent yang sudah revoked → tetap `ScopeExists` (key mati selamanya).
- Multi-period skip (tidak ada aktivitas 3 period) → `periodStart` melompat kelipatan duration, bukan reset ke `now`.

**AC:** semua validasi di atas punya unit test negatif (expect revert dengan error spesifik).
**Verification:** `forge test --match-contract AgentRegistryTest -vvv`
**DO NOT:** jangan tambah fungsi `updateScope`/`extendExpiry` — perpanjangan izin = otorisasi baru dengan key baru.

---

### Task 1.3 — `feat(contracts): executeAgentDeposit — SPEC LENGKAP`
**Branch:** `feat/execute-agent-deposit` · **File:** `contracts/AgentVaultDepositor.sol`

**Context:** Fungsi inti produk. Dipanggil worker agent. HARUS aman terhadap: compromised worker key, replay, fee-on-transfer token, reentrancy, dan parameter palsu dari server.

**Spec — kontrak:**
```solidity
contract AgentVaultDepositor is ReentrancyGuard, Pausable {
    AgentRegistry public immutable registry;
    mapping(address token => uint256) public reserves;   // token milik kontrak yang sudah teratribusi
    mapping(bytes32 => bool) public executed;             // idempotency

    event AgentDepositExecuted(
        address indexed agent, address indexed owner, address indexed vault,
        address token, uint256 assetsIn, uint256 sharesOut, bytes32 execId
    );
    error ScopeInactive();
    error TokenMismatch();
    error InsufficientReceived(uint256 received, uint256 minAmount);
    error CapExceeded(uint256 attempted, uint256 remaining);
    error AlreadyExecuted(bytes32 execId);
}
```

**Spec — signature (perhatikan: TIDAK ada parameter `onBehalfOf` dan TIDAK ada parameter `vault`):**
```solidity
function executeAgentDeposit(address token, uint256 minAmount, bytes32 execId)
    external nonReentrant whenNotPaused returns (uint256 shares);
```
Rasional: `vault` dan `beneficiary` DIDERIVASI dari scope on-chain. Kalau jadi parameter, compromised server bisa memalsukannya. Lebih sedikit parameter = lebih sedikit permukaan serangan.

**Logic (urutan PERSIS — jangan diubah urutannya):**
```
 1. AgentScope storage s = registry.scopeOf(msg.sender)
 2. if (s.revoked || block.timestamp >= s.expiry || s.owner == address(0)) revert ScopeInactive()
 3. if (token != s.token) revert TokenMismatch()
 4. if (executed[execId]) revert AlreadyExecuted(execId)
    executed[execId] = true                       // sebelum external call apapun
 5. uint256 received = IERC20(token).balanceOf(address(this)) - reserves[token]
 6. if (received == 0 || received < minAmount) revert InsufficientReceived(received, minAmount)
 7. registry.rollAndSpend(msg.sender, received)   // roll period + cek cap + tambah spent; revert CapExceeded jika lewat
 8. reserves[token] += received                   // CEI: state update SEBELUM interaksi vault
 9. IERC20(token).forceApprove(s.vault, received)
10. shares = IERC4626(s.vault).deposit(received, s.owner)   // shares LANGSUNG ke owner, bukan ke kontrak/agent
11. reserves[token] -= received                   // token sudah pindah ke vault
12. IERC20(token).forceApprove(s.vault, 0)        // bersihkan allowance sisa
13. emit AgentDepositExecuted(msg.sender, s.owner, s.vault, token, received, shares, execId)
```
Catatan langkah 7: `rollAndSpend` adalah fungsi di registry dengan access control `onlyDepositor` (alamat depositor di-set sekali oleh deployer registry). Jangan biarkan kontrak arbitrer memanggilnya.

**Cara dana sampai ke depositor (per §0.3):**
- **Jalur A (7715):** Call 1 userOp = redeem 7715 → `token.transfer(depositor, amount)` dari user account. Call 2 = `executeAgentDeposit`. Atomic dalam 1 userOp worker.
- **Jalur B (registry penuh):** user sudah `approve(depositor, cap_total)` saat onboarding. Tambahkan langkah 4b: `IERC20(token).safeTransferFrom(s.owner, address(this), amount)` dengan parameter `amount` eksplisit; langkah 5–6 tetap dipakai sebagai verifikasi balance-delta (lindungi dari fee-on-transfer).

**`execId` (kontrak agent off-chain):** `keccak256(abi.encode(owner, vault, planId, stepIndex))` — deterministik dari plan, BUKAN random. Retry relayer menghasilkan execId sama → revert `AlreadyExecuted` → tidak ada double deposit.

**Edge cases (wajib di-test):**
- Fee-on-transfer token → `received < amount` nominal; balance-delta menanganinya; `minAmount` jadi proteksi user.
- Donation attack: pihak ketiga transfer token ke depositor → `received` membesar → dikreditkan ke owner pemanggil berikutnya & MEMAKAN cap-nya. Dampak: griefing cap, bukan pencurian. Dokumentasikan; mitigasi opsional: cap `received` ke `amount` yang dideklarasikan (Jalur B).
- Vault `maxDeposit(owner)` < received → `deposit()` revert (perilaku 4626) → seluruh tx revert → dana kembali (Jalur A: revert userOp; tidak ada dana nyangkut).
- `deposit()` mengembalikan 0 shares (vault rusak/penuh) → tambah `if (shares == 0) revert`; jangan biarkan aset masuk tanpa shares.
- Reentrancy via token callback → tertutup `nonReentrant` + executed-flag di langkah 4.

**AC:**
- Worker key yang dicuri HANYA bisa: deposit token scope ke vault scope, dikreditkan ke owner scope, ≤ cap per period. Buktikan dengan test "malicious worker" yang mencoba semua kombinasi parameter.
- `assert(IERC20(token).balanceOf(workerAddress) == 0)` sepanjang flow.

**Verification:** `forge test --match-contract AgentVaultDepositorTest -vvv`
**DO NOT:** jangan tambahkan parameter `vault`/`recipient`/`onBehalfOf`; jangan pindahkan langkah 4 ke setelah external call; jangan pakai `safeApprove` (OZ 4.x, deprecated).

---

### Task 1.4 — `feat(contracts): revoke UX-grade`
Sudah ter-spec di Task 1.2 (`revokeAgent`). Tambahan:
1. `function revokeMany(address[] calldata agents) external` — loop revoke, validasi owner per item.
2. View helper untuk frontend: `function scopesOfOwner(address owner) external view returns (address[] memory agents)` — perlu `mapping(address owner => address[] agents)` yang di-push saat authorize.
**AC:** user revoke semua agent dalam 1 tx dari wallet sendiri saat server mati total.

### Task 1.5 — `fix(contracts): audit zero-custody`
**Langkah:** grep seluruh `agents/` + skill JSON generator: tidak boleh ada instruksi transfer token user ke alamat worker. Recipient yang sah HANYA `AgentVaultDepositor`. Tulis test integrasi yang assert balance worker = 0 di setiap step.

### Task 1.6 — `feat(contracts): slippage on-chain (untuk step swap)`
**Spec:** jika flow punya leg swap sebelum deposit, fungsi swap di depositor wajib `(uint256 minAmountOut, uint256 deadline)`; nilai berasal dari skill JSON yang direview user dan HARUS identik dengan yang dikirim on-chain (single serialization source). Opsional kuat: `uint16 maxSlippageBps` disimpan di `AgentScope` saat authorize.
**DO NOT:** jangan hitung minAmountOut di server saat eksekusi tanpa jejak ke nilai yang direview user.

---

## FASE 2 — OPS SECURITY

### Task 2.1 — idempotency: SUDAH masuk Task 1.3 (langkah 4 + kontrak execId). Sisa kerjaan: sisi agent — simpan execId sebelum submit, cek `executed(execId)` on-chain sebelum retry.

### Task 2.2 — `fix(security): key lifecycle worker`
1. Satu private key per worker, BUKAN master key. Generate saat plan dibuat; scope via Task 1.2.
2. Simpan encrypted-at-rest (libsodium sealed box), decrypt ke memory saat eksekusi, zeroize setelah.
3. Rotasi = `authorizeSessionKey(newKey, scope)` + `revokeAgent(oldKey)` (ingat: key lama mati permanen by design Task 1.2).
4. Tulis section "Key lifecycle" di `technical-security-privacy.md`; roadmap KMS untuk production.

### Task 2.3 — `feat: pause + circuit breaker`
**On-chain:** `Pausable` di depositor (sudah di spec 1.3), `pause()/unpause()` dengan `onlyGuardian` (untuk testnet: deployer EOA; produksi: multisig — tulis di docs).
**Off-chain (port Hermes):** gate sebelum submit — (a) gas snapshot diambil ≤ N detik sebelum submit, bukan saat planning; (b) anomaly: >X deposit/menit per owner → halt + alert; (c) log keputusan executed/skipped + alasan ke storage monitoring.
**DO NOT:** pause tidak boleh mengunci dana user di depositor — kombinasi balance-delta + atomic flow memastikan tidak ada dana idle; tulis invariant test untuk ini.

### Task 2.4 — `chore(docs): threat model`
Section wajib: (1) max-loss formula + contoh angka; (2) tabel "compromised server: bisa vs tidak bisa" pasca Fase 1; (3) trust 1Shot relayer — censorship/delay saat crash + fallback submit via RPC sendiri **[VERIFY support Base Sepolia]**; (4) output Venice AI = input untrusted → schema validation + cap on-chain; (5) hasil destructive test (Task 4.4).

---

## FASE 3 — HISTORICAL REPLAY (fork ETHEREUM MAINNET — bukan Base Sepolia, by design)

> Base mainnet launch Agu 2023; USDC depeg Mar 2023 → data event HANYA ada di Ethereum mainnet.
> Fork simulasi terpisah total dari chain deployment. Ini benar, bukan kompromi.

### Task 3.1 — `feat(simulation): TimelineReplay.t.sol`
**File:** `test/simulation/TimelineReplay.t.sol`
1. `[VERIFY]` block number signal: cari di Etherscan block pertama 10–11 Mar 2023 saat USDC < $0.985 di Chainlink/pool utama. Hardcode hasilnya + komentar sumber.
2. Loop `delays = [2, 15, 50, 150, 600]` block; tiap delay: `vm.createSelectFork(MAINNET_RPC, signalBlock + delay)` → swap RIIL `USDC→WETH` 1_000_000e6 via Uniswap V3 SwapRouter mainnet (alamat router & pool: dari docs Uniswap **[VERIFY]**, tulis sebagai konstanta berkomentar).
3. Serialize hasil → `vm.writeJson` → `frontend/public/data/replay-usdc-depeg.json` dengan metadata: block range, sumber, asumsi.
**AC:** tiap angka exit dapat di-cross-check manual ke harga historis pool.
**DO NOT:** jangan pakai rumus x*y=k manual — eksekusi swap via router di fork; EVM yang menghitung.

### Task 3.2 — Monte Carlo TS/Bun: input JSON 3.1; sample 1.000 path (delay manual ~ lognormal median 25 mnt p95 2 jam — TULIS asumsi di metadata; agentic 1–5 dtk + latency relayer); interpolasi antar ground-truth; k-means k=3 → 3 path representatif; output `replay-mc.json` berisi P5/P50/P95.

### Task 3.3 — Halaman replay: render JSON statis; chart 2 garis + band P5–P95; panel "Assumptions" WAJIB; label "Historical replay — bukan prediksi". Zero perhitungan & zero RPC di browser.

### Task 3.4 — Hapus konsep Aladdin/6-variabel dari docs; ganti scope Historical Replay.

### Task 3.5 (opsional) — varian Base-native: event pasca Agu-2023 (mis. crash 5 Agu 2024) fork `BASE_MAINNET_RPC`, pool Base.

---

## FASE 4 — REAL INTEGRATION (fork BASE MAINNET)

### Task 4.1 — `feat: vault riil via fork Base mainnet`
> Bukan Ethereum mainnet (rencana lama) dan bukan Base Sepolia (tidak ada protokol riil). Morpho punya deployment besar di Base mainnet — paling representatif untuk target produksimu.
1. Pilih 1 vault Morpho USDC di Base **[VERIFY alamat dari app/docs Morpho]**.
2. Fork test full flow: authorize → (transfer/transferFrom) → executeAgentDeposit → assert `vault.balanceOf(owner) > 0` dan `convertToAssets(shares)` masuk akal vs deposit.
3. Edge 4626: deposit pertama/inflation (cek vault punya virtual shares), rounding direction, `maxDeposit`.
4. MockVault tetap untuk Base Sepolia live demo — upgrade dengan fee kecil + rounding 4626 benar + `maxDeposit` supaya invariant test realistis.

### Task 4.2 — invariant test (Foundry): handler dengan `vm.warp` acak; invariants: `spentInPeriod ≤ capPerPeriod`; post-revoke/post-expiry execute selalu revert; total outflow user ≤ max-loss formula; `reserves[token] ≤ balanceOf(depositor)`. Target ≥10.000 runs.

### Task 4.3 — CI: job unit (`forge test`), job `slither` (continue-on-error dulu), job fork nightly (secrets `MAINNET_RPC`, `BASE_MAINNET_RPC`).

### Task 4.4 — `test(security): destructive scenarios di Base Sepolia` (BARU — keuntungan testnet)
Dengan deployment live testnet: (a) pakai worker key "dicuri" untuk mencoba drain → semua jalur harus mentok scope; (b) revoke saat agent mid-plan; (c) matikan relayer saat eksekusi → fallback path. Rekam hasil → masukkan Task 2.4. Ini materi demo: "server kami di-hack: tidak terjadi apa-apa."

---

## FASE 5 — REFACTOR & UX

- **5.1** pisahkan decision (pure, testable tanpa chain) vs execution di `agents/`.
- **5.2** single entry point: skill JSON generator hanya boleh men-target depositor; tidak ada call langsung worker→vault.
- **5.3** frontend: tombol Revoke (panggil `revokeAgent`/`revokeMany` langsung dari wallet user) + tampilan Max-at-Risk per agent (formula Task 1.2) + subscribe `AgentRevoked`.
- **5.4** permission summary human-readable: render dari OBJECT YANG SAMA yang di-serialize ke kontrak (single source) — nilai UI ≠ nilai on-chain adalah bug kelas keamanan.
- **5.5** migrasi Nuxt/Vue + viem/wagmi — TERAKHIR. Chain: `import { baseSepolia } from 'viem/chains'`. Smoke test pertama: `getSmartAccountsEnvironment(baseSepolia.id)` — kalau throw, framework belum ada di chain ini untuk versi toolkit → `overrideDeployedEnvironment` dengan alamat dari `delegation-deployments`, atau `deployDeleGatorEnvironment` **[VERIFY]**.

---

## URUTAN EKSEKUSI

```
§0.2/§0.3 verifikasi (7715 di Base Sepolia, USDC addr, 1Shot)   ← HARI INI, menentukan jalur
1.1 → 1.2 → 1.3 → 1.4 → 1.5 → 1.6
2.2 → 2.3 → 2.4
3.1 → 3.2 → 3.3 → 3.4
4.1 → 4.2 → 4.3 → 4.4
5.1 → 5.2 → 5.3 → 5.4 → 5.5
```

**Definition of Done global:** setiap parameter keamanan punya satu sumber kebenaran on-chain; setiap klaim docs/UI bisa dibuktikan dengan kode atau data; worst-case compromised server tertulis dalam angka dan TERBUKTI lewat destructive test 4.4.