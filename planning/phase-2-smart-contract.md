# Phase 2 — Smart Contracts

> **Fase:** 2 dari 5 | **Hari:** 4–8 (29 Mei – 2 Juni 2026)
> **Gate:** `forge test` semua pass + `forge coverage` ≥ 80% + deploy dry-run sukses
> **Status:** 🔴 Belum mulai

---

## Hari 4 — MockVault.sol (29 Mei)

### A. Tambah Remappings ke foundry.toml

Edit `foundry.toml`, tambah setelah `optimizer_runs = 200`:

```toml
remappings = [
    "@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/",
    "forge-std/=lib/forge-std/src/"
]
```

- [ ] Verify build setelah edit:
  ```bash
  wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && ~/.foundry/bin/forge build"
  # Expected: Compiler run successful, no warnings
  ```

---

### B. Implementasi MockVault.sol

Isi `contracts/MockVault.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockVault
/// @notice Mock vault untuk demo. Shares = assets 1:1. Tidak ada real ERC20 transfer.
contract MockVault {
    string public name;
    address public asset; // informational only

    mapping(address => uint256) private _shares;
    uint256 private _totalDeposited;

    event Deposit(
        address indexed caller,
        address indexed owner,
        uint256 assets,
        uint256 shares
    );

    constructor(string memory _name, address _asset) {
        name = _name;
        asset = _asset;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256) {
        require(assets > 0, "Zero assets");
        uint256 sharesAmount = assets;
        _shares[receiver] += sharesAmount;
        _totalDeposited += assets;
        emit Deposit(msg.sender, receiver, assets, sharesAmount);
        return sharesAmount;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _shares[account];
    }

    function totalAssets() external view returns (uint256) {
        return _totalDeposited;
    }
}
```

- [ ] Isi `test/MockVault.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockVault} from "../contracts/MockVault.sol";

contract MockVaultTest is Test {
    MockVault vaultA;
    MockVault vaultB;
    address user = address(0xBEEF);

    function setUp() public {
        vaultA = new MockVault("MockVault USDC-A", address(0x1111));
        vaultB = new MockVault("MockVault USDC-B", address(0x2222));
    }

    function test_name_set_correctly() public view {
        assertEq(vaultA.name(), "MockVault USDC-A");
        assertEq(vaultB.name(), "MockVault USDC-B");
    }

    function test_deposit_returns_shares_one_to_one() public {
        uint256 sharesReceived = vaultA.deposit(100e6, user);
        assertEq(sharesReceived, 100e6);
    }

    function test_deposit_updates_balance() public {
        vaultA.deposit(100e6, user);
        assertEq(vaultA.balanceOf(user), 100e6);
    }

    function test_deposit_updates_total_assets() public {
        vaultA.deposit(100e6, user);
        assertEq(vaultA.totalAssets(), 100e6);
    }

    function test_multiple_deposits_accumulate() public {
        vaultA.deposit(100e6, user);
        vaultA.deposit(50e6, user);
        assertEq(vaultA.balanceOf(user), 150e6);
        assertEq(vaultA.totalAssets(), 150e6);
    }

    function test_deposit_to_different_receivers() public {
        address user2 = address(0xDEAD);
        vaultA.deposit(100e6, user);
        vaultA.deposit(200e6, user2);
        assertEq(vaultA.balanceOf(user), 100e6);
        assertEq(vaultA.balanceOf(user2), 200e6);
    }

    function test_deposit_emits_event() public {
        vm.expectEmit(true, true, false, true);
        emit MockVault.Deposit(address(this), user, 50e6, 50e6);
        vaultA.deposit(50e6, user);
    }

    function test_deposit_reverts_on_zero_assets() public {
        vm.expectRevert("Zero assets");
        vaultA.deposit(0, user);
    }

    function test_vaults_are_independent() public {
        vaultA.deposit(100e6, user);
        vaultB.deposit(200e6, user);
        assertEq(vaultA.totalAssets(), 100e6);
        assertEq(vaultB.totalAssets(), 200e6);
    }
}
```

- [ ] Jalankan tests MockVault:
  ```bash
  wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && ~/.foundry/bin/forge test --match-contract MockVaultTest -vv"
  # Expected: 8 tests PASS
  ```

- [ ] Commit:
  ```
  git add contracts/MockVault.sol test/MockVault.t.sol foundry.toml
  git commit -m "feat(contracts): MockVault.sol + full test suite"
  ```

---

## Hari 5 — AgentVaultDepositor.sol: Permission Management (30 Mei)

### A. Struct + Grant + Revoke

Isi `contracts/AgentVaultDepositor.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IVault {
    function deposit(uint256 assets, address receiver) external returns (uint256);
}

/// @title AgentVaultDepositor
/// @notice Per-agent scoped vault deposits. CEI pattern + ReentrancyGuard.
///         Tidak ada admin role. Permission per user per agentId.
contract AgentVaultDepositor is ReentrancyGuard {
    struct AgentPermission {
        address vault;
        uint256 maxAmount;
        uint256 usedAmount;
        uint256 expiresAt;
        bool active;
    }

    mapping(address => mapping(bytes32 => AgentPermission)) public agentPermissions;

    // Events
    event AgentStarted(bytes32 indexed agentId, address indexed user, address vault);
    event SwapExecuted(bytes32 indexed agentId, address indexed user, uint256 amountIn, uint256 amountOut);
    event ApproveExecuted(bytes32 indexed agentId, address indexed user, address vault, uint256 amount);
    event DepositExecuted(bytes32 indexed agentId, address indexed user, address vault, uint256 amount, uint256 sharesReceived);
    event AgentCompleted(bytes32 indexed agentId, address indexed user, address vault, uint256 sharesReceived);
    event AgentFailed(bytes32 indexed agentId, address indexed user, string reason);

    // Custom errors — lebih gas-efficient dari require string
    error PermissionNotActive();
    error PermissionExpired();
    error VaultMismatch();
    error AmountExceedsPermission();
    error InvalidVault();
    error InvalidAmount();
    error InvalidExpiry();

    /// @notice Grant permission ke agent untuk deposit ke vault tertentu.
    function grantAgentPermission(
        bytes32 agentId,
        address vault,
        uint256 maxAmount,
        uint256 expiresAt
    ) external {
        if (vault == address(0)) revert InvalidVault();
        if (maxAmount == 0) revert InvalidAmount();
        if (expiresAt <= block.timestamp) revert InvalidExpiry();

        agentPermissions[msg.sender][agentId] = AgentPermission({
            vault: vault,
            maxAmount: maxAmount,
            usedAmount: 0,
            expiresAt: expiresAt,
            active: true
        });
    }

    /// @notice Revoke permission agent secara immediate.
    function revokeAgentPermission(bytes32 agentId) external {
        agentPermissions[msg.sender][agentId].active = false;
    }
}
```

- [ ] Verify build:
  ```bash
  wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && ~/.foundry/bin/forge build"
  # Expected: Compiler run successful
  ```

- [ ] Commit:
  ```
  git add contracts/AgentVaultDepositor.sol
  git commit -m "feat(contracts): AgentVaultDepositor — permission struct, grant, revoke"
  ```

---

## Hari 6 — AgentVaultDepositor.sol: executeAgentDeposit (31 Mei)

### A. Tambah executeAgentDeposit

Tambahkan function berikut ke dalam contract (sebelum `}` penutup):

```solidity
    /// @notice Eksekusi full flow: Swap → Approve → Deposit untuk satu agent.
    ///         CEI: semua checks dulu → update state → baru external call.
    ///         nonReentrant mencegah reentrancy dari vault.deposit().
    function executeAgentDeposit(
        bytes32 agentId,
        address user,
        address vault,
        uint256 amount
    ) external nonReentrant {
        AgentPermission storage perm = agentPermissions[user][agentId];

        // CHECKS — revert langsung jika ada violation
        if (!perm.active) revert PermissionNotActive();
        if (block.timestamp >= perm.expiresAt) revert PermissionExpired();
        if (perm.vault != vault) revert VaultMismatch();
        if (perm.usedAmount + amount > perm.maxAmount) revert AmountExceedsPermission();

        // EFFECTS — update state sebelum external call
        perm.usedAmount += amount;

        // INTERACTIONS — emit events + call vault
        emit AgentStarted(agentId, user, vault);
        emit SwapExecuted(agentId, user, amount, amount);   // mock swap 1:1
        emit ApproveExecuted(agentId, user, vault, amount); // mock approve

        // Deposit ke vault — try/catch agar AgentFailed bisa di-emit
        try IVault(vault).deposit(amount, user) returns (uint256 sharesReceived) {
            emit DepositExecuted(agentId, user, vault, amount, sharesReceived);
            emit AgentCompleted(agentId, user, vault, sharesReceived);
        } catch {
            // Undo usedAmount — deposit gagal, kuota kembali
            perm.usedAmount -= amount;
            emit AgentFailed(agentId, user, "Vault deposit failed");
        }
    }
```

- [ ] Verify build:
  ```bash
  wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && ~/.foundry/bin/forge build"
  ```

- [ ] Commit:
  ```
  git add contracts/AgentVaultDepositor.sol
  git commit -m "feat(contracts): executeAgentDeposit — CEI + 6 events + try/catch vault"
  ```

---

## Hari 7 — Tests AgentVaultDepositor (1 Juni)

### A. Isi test/AgentVaultDepositor.t.sol

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentVaultDepositor} from "../contracts/AgentVaultDepositor.sol";
import {MockVault} from "../contracts/MockVault.sol";

contract AgentVaultDepositorTest is Test {
    AgentVaultDepositor depositor;
    MockVault vaultA;
    MockVault vaultB;

    address user = address(0xBEEF);
    bytes32 agentId1 = keccak256("agent-1");
    bytes32 agentId2 = keccak256("agent-2");
    uint256 maxAmount = 100e6;
    uint256 expiry;

    function setUp() public {
        depositor = new AgentVaultDepositor();
        vaultA = new MockVault("MockVault USDC-A", address(0));
        vaultB = new MockVault("MockVault USDC-B", address(0));
        expiry = block.timestamp + 1 days;
    }

    // ── Grant / Revoke ─────────────────────────────────────────────────────

    function test_grantAgentPermission_stores_permission() public {
        vm.prank(user);
        depositor.grantAgentPermission(agentId1, address(vaultA), maxAmount, expiry);

        (address vault, uint256 max, uint256 used, uint256 exp, bool active) =
            depositor.agentPermissions(user, agentId1);

        assertEq(vault, address(vaultA));
        assertEq(max, maxAmount);
        assertEq(used, 0);
        assertEq(exp, expiry);
        assertTrue(active);
    }

    function test_grant_reverts_zero_vault() public {
        vm.prank(user);
        vm.expectRevert(AgentVaultDepositor.InvalidVault.selector);
        depositor.grantAgentPermission(agentId1, address(0), maxAmount, expiry);
    }

    function test_grant_reverts_zero_amount() public {
        vm.prank(user);
        vm.expectRevert(AgentVaultDepositor.InvalidAmount.selector);
        depositor.grantAgentPermission(agentId1, address(vaultA), 0, expiry);
    }

    function test_grant_reverts_past_expiry() public {
        vm.prank(user);
        vm.expectRevert(AgentVaultDepositor.InvalidExpiry.selector);
        depositor.grantAgentPermission(agentId1, address(vaultA), maxAmount, block.timestamp);
    }

    function test_revoke_sets_inactive() public {
        vm.startPrank(user);
        depositor.grantAgentPermission(agentId1, address(vaultA), maxAmount, expiry);
        depositor.revokeAgentPermission(agentId1);
        vm.stopPrank();

        (,,,, bool active) = depositor.agentPermissions(user, agentId1);
        assertFalse(active);
    }

    // ── Success Path ────────────────────────────────────────────────────────

    function test_executeAgentDeposit_success() public {
        vm.prank(user);
        depositor.grantAgentPermission(agentId1, address(vaultA), maxAmount, expiry);

        depositor.executeAgentDeposit(agentId1, user, address(vaultA), 50e6);

        assertEq(vaultA.balanceOf(user), 50e6);
        (, , uint256 used,,) = depositor.agentPermissions(user, agentId1);
        assertEq(used, 50e6);
    }

    function test_executeAgentDeposit_emits_all_events() public {
        uint256 amount = 50e6;
        vm.prank(user);
        depositor.grantAgentPermission(agentId1, address(vaultA), maxAmount, expiry);

        vm.expectEmit(true, true, false, true);
        emit AgentVaultDepositor.AgentStarted(agentId1, user, address(vaultA));
        vm.expectEmit(true, true, false, true);
        emit AgentVaultDepositor.SwapExecuted(agentId1, user, amount, amount);
        vm.expectEmit(true, true, false, true);
        emit AgentVaultDepositor.ApproveExecuted(agentId1, user, address(vaultA), amount);
        vm.expectEmit(true, true, false, true);
        emit AgentVaultDepositor.DepositExecuted(agentId1, user, address(vaultA), amount, amount);
        vm.expectEmit(true, true, false, true);
        emit AgentVaultDepositor.AgentCompleted(agentId1, user, address(vaultA), amount);

        depositor.executeAgentDeposit(agentId1, user, address(vaultA), amount);
    }

    function test_cumulative_used_amount() public {
        vm.prank(user);
        depositor.grantAgentPermission(agentId1, address(vaultA), maxAmount, expiry);

        depositor.executeAgentDeposit(agentId1, user, address(vaultA), 30e6);
        depositor.executeAgentDeposit(agentId1, user, address(vaultA), 40e6);

        (, , uint256 used,,) = depositor.agentPermissions(user, agentId1);
        assertEq(used, 70e6);
    }

    // ── Parallel Agents ─────────────────────────────────────────────────────

    function test_parallel_agents_independent_vaults() public {
        vm.startPrank(user);
        depositor.grantAgentPermission(agentId1, address(vaultA), maxAmount, expiry);
        depositor.grantAgentPermission(agentId2, address(vaultB), maxAmount, expiry);
        vm.stopPrank();

        depositor.executeAgentDeposit(agentId1, user, address(vaultA), 60e6);
        depositor.executeAgentDeposit(agentId2, user, address(vaultB), 80e6);

        assertEq(vaultA.balanceOf(user), 60e6);
        assertEq(vaultB.balanceOf(user), 80e6);

        (, , uint256 used1,,) = depositor.agentPermissions(user, agentId1);
        (, , uint256 used2,,) = depositor.agentPermissions(user, agentId2);
        assertEq(used1, 60e6);
        assertEq(used2, 80e6);
    }

    // ── Fail Paths ──────────────────────────────────────────────────────────

    function test_revert_no_permission() public {
        vm.expectRevert(AgentVaultDepositor.PermissionNotActive.selector);
        depositor.executeAgentDeposit(agentId1, user, address(vaultA), 50e6);
    }

    function test_revert_after_revoke() public {
        vm.startPrank(user);
        depositor.grantAgentPermission(agentId1, address(vaultA), maxAmount, expiry);
        depositor.revokeAgentPermission(agentId1);
        vm.stopPrank();

        vm.expectRevert(AgentVaultDepositor.PermissionNotActive.selector);
        depositor.executeAgentDeposit(agentId1, user, address(vaultA), 50e6);
    }

    function test_revert_expired() public {
        vm.prank(user);
        depositor.grantAgentPermission(agentId1, address(vaultA), maxAmount, expiry);
        vm.warp(expiry + 1);

        vm.expectRevert(AgentVaultDepositor.PermissionExpired.selector);
        depositor.executeAgentDeposit(agentId1, user, address(vaultA), 50e6);
    }

    function test_revert_vault_mismatch() public {
        vm.prank(user);
        depositor.grantAgentPermission(agentId1, address(vaultA), maxAmount, expiry);

        vm.expectRevert(AgentVaultDepositor.VaultMismatch.selector);
        depositor.executeAgentDeposit(agentId1, user, address(vaultB), 50e6);
    }

    function test_revert_exceeds_max_amount() public {
        vm.prank(user);
        depositor.grantAgentPermission(agentId1, address(vaultA), maxAmount, expiry);

        vm.expectRevert(AgentVaultDepositor.AmountExceedsPermission.selector);
        depositor.executeAgentDeposit(agentId1, user, address(vaultA), 101e6);
    }

    function test_revert_cumulative_exceeds_max() public {
        vm.prank(user);
        depositor.grantAgentPermission(agentId1, address(vaultA), maxAmount, expiry);

        depositor.executeAgentDeposit(agentId1, user, address(vaultA), 60e6);

        vm.expectRevert(AgentVaultDepositor.AmountExceedsPermission.selector);
        depositor.executeAgentDeposit(agentId1, user, address(vaultA), 50e6);
    }

    function test_used_amount_unchanged_on_revert() public {
        vm.prank(user);
        depositor.grantAgentPermission(agentId1, address(vaultA), maxAmount, expiry);

        vm.expectRevert(AgentVaultDepositor.AmountExceedsPermission.selector);
        depositor.executeAgentDeposit(agentId1, user, address(vaultA), 200e6);

        (, , uint256 used,,) = depositor.agentPermissions(user, agentId1);
        assertEq(used, 0);
    }

    // ── Fuzz Tests ──────────────────────────────────────────────────────────

    function testFuzz_deposit_within_limit(uint256 amount) public {
        amount = bound(amount, 1, maxAmount);
        vm.prank(user);
        depositor.grantAgentPermission(agentId1, address(vaultA), maxAmount, expiry);

        depositor.executeAgentDeposit(agentId1, user, address(vaultA), amount);

        assertEq(vaultA.balanceOf(user), amount);
        (, , uint256 used,,) = depositor.agentPermissions(user, agentId1);
        assertEq(used, amount);
    }

    function testFuzz_deposit_over_limit_reverts(uint256 amount) public {
        amount = bound(amount, maxAmount + 1, maxAmount * 10);
        vm.prank(user);
        depositor.grantAgentPermission(agentId1, address(vaultA), maxAmount, expiry);

        vm.expectRevert(AgentVaultDepositor.AmountExceedsPermission.selector);
        depositor.executeAgentDeposit(agentId1, user, address(vaultA), amount);
    }

    function testFuzz_used_amount_never_exceeds_max(uint256 amount1, uint256 amount2) public {
        amount1 = bound(amount1, 1, maxAmount);
        amount2 = bound(amount2, 1, maxAmount);

        vm.prank(user);
        depositor.grantAgentPermission(agentId1, address(vaultA), maxAmount, expiry);

        depositor.executeAgentDeposit(agentId1, user, address(vaultA), amount1);
        (, , uint256 used,,) = depositor.agentPermissions(user, agentId1);
        uint256 remaining = maxAmount - used;

        if (amount2 <= remaining) {
            depositor.executeAgentDeposit(agentId1, user, address(vaultA), amount2);
            (, , uint256 usedAfter,,) = depositor.agentPermissions(user, agentId1);
            assertLe(usedAfter, maxAmount);
        } else {
            vm.expectRevert(AgentVaultDepositor.AmountExceedsPermission.selector);
            depositor.executeAgentDeposit(agentId1, user, address(vaultA), amount2);
        }
    }

    function testFuzz_different_agentIds_dont_interfere(bytes32 id1, bytes32 id2) public {
        vm.assume(id1 != id2);

        vm.startPrank(user);
        depositor.grantAgentPermission(id1, address(vaultA), maxAmount, expiry);
        depositor.grantAgentPermission(id2, address(vaultB), maxAmount, expiry);
        vm.stopPrank();

        depositor.executeAgentDeposit(id1, user, address(vaultA), 40e6);
        depositor.executeAgentDeposit(id2, user, address(vaultB), 60e6);

        (, , uint256 used1,,) = depositor.agentPermissions(user, id1);
        (, , uint256 used2,,) = depositor.agentPermissions(user, id2);
        assertEq(used1, 40e6);
        assertEq(used2, 60e6);
    }
}
```

- [ ] Jalankan semua tests:
  ```bash
  wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && ~/.foundry/bin/forge test -vv"
  # Expected: semua PASS (≥ 20 tests)
  ```

- [ ] Jalankan fuzz tests:
  ```bash
  wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && ~/.foundry/bin/forge test --match-test testFuzz -vv --fuzz-runs 500"
  # Expected: semua PASS
  ```

- [ ] Commit:
  ```
  git add test/AgentVaultDepositor.t.sol
  git commit -m "test(AgentVaultDepositor): full suite — success, parallel, fail paths, fuzz"
  ```

---

## Hari 8 — Deploy Script + Coverage Gate (2 Juni)

### A. Deploy.s.sol

Isi `script/Deploy.s.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {MockVault} from "../contracts/MockVault.sol";
import {AgentVaultDepositor} from "../contracts/AgentVaultDepositor.sol";

contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        MockVault vaultA = new MockVault("MockVault USDC-A", address(0));
        MockVault vaultB = new MockVault("MockVault USDC-B", address(0));
        AgentVaultDepositor depositor = new AgentVaultDepositor();

        vm.stopBroadcast();

        console.log("=== Vibing Farmer Deployment ===");
        console.log("VaultA:", address(vaultA));
        console.log("VaultB:", address(vaultB));
        console.log("AgentVaultDepositor:", address(depositor));
        console.log("Salin ke .env:");
        console.log("AGENT_VAULT_DEPOSITOR_ADDRESS=", address(depositor));
        console.log("MOCK_VAULT_A_ADDRESS=", address(vaultA));
        console.log("MOCK_VAULT_B_ADDRESS=", address(vaultB));
    }
}
```

- [ ] Dry-run deploy (tanpa broadcast):
  ```bash
  wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && ~/.foundry/bin/forge script script/Deploy.s.sol -vv"
  # Expected: simulasi OK, print 3 addresses
  ```

- [ ] Commit:
  ```
  git add script/Deploy.s.sol
  git commit -m "feat(script): Deploy.s.sol — 2x MockVault + AgentVaultDepositor"
  ```

---

### B. Coverage Gate

- [ ] Jalankan coverage:
  ```bash
  wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && ~/.foundry/bin/forge coverage"
  ```

  Expected:
  ```
  contracts/AgentVaultDepositor.sol  | ≥ 80% lines
  contracts/MockVault.sol            | ≥ 80% lines
  ```

  Jika ada baris yang uncovered → tambah test spesifik untuk baris tersebut.

---

### C. Security Checklist

Cek manual sebelum Phase 2 dinyatakan selesai:

- [ ] `executeAgentDeposit` punya modifier `nonReentrant`
- [ ] Semua 4 checks (`active`, `expired`, `vault`, `amount`) ada **sebelum** `perm.usedAmount += amount`
- [ ] Tidak ada `require(msg.sender == owner)` atau admin role apapun
- [ ] `grantAgentPermission` validate: `vault != 0`, `maxAmount > 0`, `expiresAt > block.timestamp`
- [ ] `revokeAgentPermission` set `active = false` — tidak delete (history terjaga)
- [ ] Pada vault failure: `usedAmount` di-rollback sebelum emit `AgentFailed`
- [ ] Tidak ada hardcoded address — semua parameter
- [ ] Mapping `agentPermissions` adalah `public` (frontend bisa baca)

---

## Gate Check — Phase 2 Complete?

```bash
wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && ~/.foundry/bin/forge test && ~/.foundry/bin/forge coverage"
```

- [ ] Semua tests PASS
- [ ] Coverage ≥ 80% di kedua contract
- [ ] `forge build` zero warnings
- [ ] Deploy dry-run sukses
- [ ] Security checklist semua ✅

- [ ] Final commit:
  ```
  git add -A
  git commit -m "chore(phase-2): complete — contracts + tests + deploy. Coverage ≥ 80%"
  ```

**Jika semua ✅ → lanjut ke `planning/phase-3-integration.md`**

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `forge: command not found` | Gunakan full path: `~/.foundry/bin/forge` |
| Import OZ gagal | Pastikan remappings sudah di `foundry.toml` + `forge install` sudah jalan |
| `forge coverage` crash | Tambah `--ir-minimum` flag: `forge coverage --ir-minimum` |
| Fuzz test flaky | Naikkan `--fuzz-runs 1000` untuk reproducibility |
| Deploy dry-run butuh `PRIVATE_KEY` | Tambah `--sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` (anvil default) |

---

_Dibuat: 2026-05-27 | Phase 2 dari 5_
