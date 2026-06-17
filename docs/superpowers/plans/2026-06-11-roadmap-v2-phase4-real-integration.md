# Roadmap v2 — Phase 4: Real Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Prove the Phase 1 contracts work against a real ERC-4626 vault (Morpho on forked Base mainnet), hold under stateful fuzzing (invariants), pass destructive "stolen key" drills on live Base Sepolia, and run in CI.

**Architecture:** A Base-mainnet fork test runs the full authorize→approve→executeAgentDeposit flow against a real Morpho USDC vault and checks 4626 edge behavior. A Foundry invariant handler warps time and hammers deposits to assert the safety invariants hold for ≥10k runs. A destructive test suite (run against the live testnet deployment) confirms a compromised worker cannot escape scope. CI wires unit + slither + nightly fork jobs.

**Tech Stack:** Foundry fork + invariant tests (WSL), Morpho Base mainnet vault, GitHub Actions, Slither.

**Depends on:** Phase 1 (registry + depositor + MockVault). Needs `BASE_MAINNET_RPC` (archive).

> Forks **Base mainnet** (real Morpho), not Ethereum mainnet (that's Phase 3) and not Base Sepolia (no real protocols there).

> **⚠️ SIGNATURE SYNC (read before coding any test here):** Phase 1 made `executeAgentDeposit` EIP-712 signed — the real signature is `executeAgentDeposit(uint256 amount, uint256 minAmount, bytes32 execId, bytes sig)` and authorization is the **recovered signer**, not `msg.sender`. The test snippets below still show the pre-revision `vm.prank(worker); dep.executeAgentDeposit(amount, minAmount, execId)` form for brevity. When implementing, in EVERY test here:
> 1. Give the worker a private key: `uint256 workerPk = 0x...; address worker = vm.addr(workerPk);`
> 2. Add the `_sign` helper from Phase 1 Task 3 (`dep.hashDeposit` + `vm.sign` + `abi.encodePacked(r,s,v)`).
> 3. Replace each call with `dep.executeAgentDeposit(amount, minAmount, execId, _sign(workerPk, amount, minAmount, execId))` and drop the `vm.prank(worker)` (submitter is arbitrary).
> 4. The invariant `Handler.deposit` must sign with the worker key too; `Handler` needs `workerPk` passed in its constructor. The "stolen key" destructive test = attacker holds `workerPk` and signs — still bounded by scope.

---

## File Structure

- Modify: `foundry.toml` — add `base_mainnet` rpc endpoint.
- Create: `test/integration/MorphoForkTest.t.sol` — real vault flow + 4626 edges.
- Create: `test/invariant/DepositorInvariant.t.sol` + `test/invariant/Handler.sol` — stateful fuzz.
- Create: `test/security/Destructive.t.sol` — stolen-key / mid-plan-revoke / relayer-down drills.
- Create: `.github/workflows/contracts.yml` — unit + slither + nightly fork.

---

## Task 1: Morpho real-vault fork test

**Files:**
- Modify: `foundry.toml`
- Create: `test/integration/MorphoForkTest.t.sol`

- [ ] **Step 1: Add the Base mainnet fork endpoint**

In `foundry.toml` under `[rpc_endpoints]` add:

```toml
base_mainnet = "${BASE_MAINNET_RPC}"
```

- [ ] **Step 2: Write the fork test against a real Morpho USDC vault**

```solidity
// test/integration/MorphoForkTest.t.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {AgentRegistry} from "../../contracts/AgentRegistry.sol";
import {AgentVaultDepositor} from "../../contracts/AgentVaultDepositor.sol";

contract MorphoForkTest is Test {
    // [VERIFY] from Morpho app/docs — a real USDC MetaMorpho vault on BASE MAINNET.
    address constant MORPHO_USDC_VAULT = 0x0000000000000000000000000000000000000000; // [VERIFY] replace
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;               // USDC Base mainnet [VERIFY]

    AgentRegistry reg; AgentVaultDepositor dep;
    address owner = address(0xA11CE); address worker = address(0xBEEF);

    // [VERIFY] Base mainnet block — pin so the fork is deterministic (vault state frozen).
    // Unpinned = green today, red tomorrow when the vault fills/pauses. Also lighter on the RPC.
    uint256 constant FORK_BLOCK = 0; // [VERIFY] replace with a recent Base block (note the date)

    function setUp() public {
        if (FORK_BLOCK == 0) vm.createSelectFork(vm.envString("BASE_MAINNET_RPC"));
        else vm.createSelectFork(vm.envString("BASE_MAINNET_RPC"), FORK_BLOCK);
        require(MORPHO_USDC_VAULT != address(0), "set MORPHO_USDC_VAULT [VERIFY]");
        require(IERC4626(MORPHO_USDC_VAULT).asset() == USDC, "vault asset mismatch");
        reg = new AgentRegistry();
        dep = new AgentVaultDepositor(address(reg), address(this));
        reg.setDepositor(address(dep));
        deal(USDC, owner, 10_000e6);
        vm.prank(owner); IERC20(USDC).approve(address(dep), type(uint256).max);
        vm.prank(owner);
        reg.authorizeSessionKey(worker, MORPHO_USDC_VAULT, USDC, 5_000e6, 1 days, uint40(block.timestamp + 7 days));
    }

    function test_realVault_depositCreditsOwnerShares() public {
        vm.prank(worker);
        uint256 shares = dep.executeAgentDeposit(1_000e6, 990e6, keccak256("m1"));
        assertGt(shares, 0);
        assertEq(IERC4626(MORPHO_USDC_VAULT).balanceOf(owner), shares);
        uint256 assets = IERC4626(MORPHO_USDC_VAULT).convertToAssets(shares);
        assertApproxEqRel(assets, 1_000e6, 0.02e18); // within 2% of deposit
        assertEq(IERC20(USDC).balanceOf(worker), 0);
    }

    // Two explicit branches so the test can NEVER pass hollow (all-body-skipped).
    function test_realVault_maxDepositRespected() public {
        uint256 maxDep = IERC4626(MORPHO_USDC_VAULT).maxDeposit(owner);
        if (maxDep < 1_000e6) {
            // cap-constrained vault: a deposit over the 4626 cap must revert
            vm.prank(worker);
            vm.expectRevert();
            dep.executeAgentDeposit(1_000e6, 990e6, keccak256("m2"));
        } else {
            // normal large vault: deposit succeeds and credits shares to owner
            vm.prank(worker);
            uint256 shares = dep.executeAgentDeposit(1_000e6, 990e6, keccak256("m2b"));
            assertGt(shares, 0);
            assertEq(IERC4626(MORPHO_USDC_VAULT).balanceOf(owner), shares);
        }
    }
}
```

- [ ] **Step 3: Run the fork test (skips cleanly if env/addresses unset)**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && forge test --match-contract MorphoForkTest -vvv"`
Expected: PASS once `BASE_MAINNET_RPC` + the `[VERIFY]` Morpho vault address are set. If the vault address is still zero, the `require` halts with a clear message — fill it from Morpho docs, do not guess.

- [ ] **Step 4: Commit**

```bash
git add foundry.toml test/integration/MorphoForkTest.t.sol
git commit -m "test(integration): Morpho real-vault fork flow + 4626 edges"
```

---

## Task 2: Stateful invariant suite

**Files:**
- Create: `test/invariant/Handler.sol`
- Create: `test/invariant/DepositorInvariant.t.sol`

- [ ] **Step 1: Write the handler that warps time and deposits randomly**

```solidity
// test/invariant/Handler.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AgentRegistry} from "../../contracts/AgentRegistry.sol";
import {AgentVaultDepositor} from "../../contracts/AgentVaultDepositor.sol";

contract Handler is Test {
    AgentRegistry public reg; AgentVaultDepositor public dep;
    IERC20 public token; address public owner; address public worker;
    uint256 public nonce;

    // --- ghost accounting (the two headline invariants ride on these) ---
    uint256 public startTs;             // for the period count in outflow bound
    uint256 public totalPulled;         // sum of all successfully deposited amounts
    bool public revoked;                // flipped permanently by revoke()
    uint256 public depositsAfterRevoke; // MUST stay 0

    constructor(AgentRegistry r, AgentVaultDepositor d, IERC20 t, address o, address w) {
        reg = r; dep = d; token = t; owner = o; worker = w;
        startTs = block.timestamp;
    }

    function deposit(uint96 amount, uint32 warp) external {
        amount = uint96(bound(amount, 0, 200e6)); // 200e6 > 100e6 cap ON PURPOSE: fuzzer must TRY to breach
        vm.warp(block.timestamp + bound(warp, 0, 3 days));
        if (amount == 0) return;
        // execId includes `worker` so the id stays unique if Handler grows multi-agent later
        bytes32 execId = keccak256(abi.encode(worker, nonce++));
        vm.prank(worker);
        try dep.executeAgentDeposit(amount, 0, execId) returns (uint256) {
            totalPulled += amount;                 // only counts on SUCCESS
            if (revoked) depositsAfterRevoke++;     // any success here is a breach
        } catch {}
    }

    function revoke() external { vm.prank(owner); reg.revokeAgent(worker); revoked = true; }
}
```

- [ ] **Step 2: Write the invariant test**

```solidity
// test/invariant/DepositorInvariant.t.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry} from "../../contracts/AgentRegistry.sol";
import {AgentVaultDepositor} from "../../contracts/AgentVaultDepositor.sol";
import {MockVault} from "../../contracts/MockVault.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {Handler} from "./Handler.sol";

contract DepositorInvariantTest is Test {
    AgentRegistry reg; AgentVaultDepositor dep; MockERC20 token; MockVault vault; Handler handler;
    address owner = address(0xA11CE); address worker = address(0xBEEF);

    function setUp() public {
        reg = new AgentRegistry();
        dep = new AgentVaultDepositor(address(reg), address(this));
        reg.setDepositor(address(dep));
        token = new MockERC20("USD Coin", "USDC", 6);
        vault = new MockVault("Vault USDC", address(token), 500);
        token.mint(owner, 1_000_000e6);
        vm.prank(owner); token.approve(address(dep), type(uint256).max);
        vm.prank(owner);
        reg.authorizeSessionKey(worker, address(vault), address(token), 100e6, 1 days, uint40(block.timestamp + 30 days));
        handler = new Handler(reg, dep, token, owner, worker);
        targetContract(address(handler));
    }

    // --- weak/structural invariants (true almost by construction, keep as cheap sanity) ---
    function invariant_spentNeverExceedsCap() public view {
        AgentRegistry.AgentScope memory s = reg.scopeOf(worker);
        assertLe(s.spentInPeriod, s.capPerPeriod);
    }

    function invariant_reservesNeverExceedBalance() public view {
        assertLe(dep.reserves(address(token)), token.balanceOf(address(dep)));
    }

    // --- headline invariant 1: total outflow <= the bounded-loss formula (cap * periods elapsed) ---
    // This is the actual proof of the threat-model "bounded loss" claim. PERIOD = 1 days (matches
    // the `period` passed to authorizeSessionKey in setUp). +1 covers the current, partially-elapsed period.
    function invariant_outflowBounded() public view {
        uint256 periodsElapsed = (block.timestamp - handler.startTs()) / 1 days + 1;
        assertLe(handler.totalPulled(), uint256(100e6) * periodsElapsed);
    }

    // --- headline invariant 2: after revoke, ZERO deposits ever succeed ---
    function invariant_noDepositsAfterRevoke() public view {
        assertEq(handler.depositsAfterRevoke(), 0);
    }
}
```

- [ ] **Step 3: Configure ≥10k runs and run**

Add to `foundry.toml`:

```toml
[invariant]
runs = 256
depth = 50
fail_on_revert = false
```

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && forge test --match-contract DepositorInvariantTest -vvv"`
Expected: PASS (256×50 ≈ 12.8k calls). Tune `runs`/`depth` upward if time allows.

- [ ] **Step 4: Commit**

```bash
git add test/invariant/ foundry.toml
git commit -m "test(invariant): cap + reserves invariants under stateful fuzz"
```

---

## Task 3: Destructive scenarios (live Base Sepolia advantage)

**Files:**
- Create: `test/security/Destructive.t.sol`

- [ ] **Step 1: Write the stolen-key / revoke / expiry drill as a local test (mirrors the live drill)**

```solidity
// test/security/Destructive.t.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry} from "../../contracts/AgentRegistry.sol";
import {AgentVaultDepositor} from "../../contracts/AgentVaultDepositor.sol";
import {MockVault} from "../../contracts/MockVault.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

contract DestructiveTest is Test {
    AgentRegistry reg; AgentVaultDepositor dep; MockERC20 token; MockVault vaultA; MockVault vaultB;
    address owner = address(0xA11CE); address worker = address(0xBEEF); address attacker = address(0xBAD);

    function setUp() public {
        reg = new AgentRegistry();
        dep = new AgentVaultDepositor(address(reg), address(this));
        reg.setDepositor(address(dep));
        token = new MockERC20("USD Coin", "USDC", 6);
        vaultA = new MockVault("Vault A", address(token), 500);
        vaultB = new MockVault("Vault B", address(token), 500);
        token.mint(owner, 1_000e6);
        vm.prank(owner); token.approve(address(dep), type(uint256).max);
        vm.prank(owner);
        reg.authorizeSessionKey(worker, address(vaultA), address(token), 100e6, 1 days, uint40(block.timestamp + 7 days));
    }

    // Attacker holds the worker key. Tries to drain to a different vault / over cap / after revoke.
    function test_stolenWorkerKey_cannotRedirectVault() public {
        // The attacker cannot even pick a vault — vault is derived from scope (vaultA).
        // Shares always go to `owner`; attacker gains nothing.
        vm.prank(worker);
        uint256 shares = dep.executeAgentDeposit(50e6, 50e6, keccak256("d1"));
        assertEq(vaultA.balanceOf(owner), shares);
        assertEq(vaultB.balanceOf(owner), 0);
        assertEq(vaultA.balanceOf(attacker), 0);
        assertEq(token.balanceOf(attacker), 0);
    }

    function test_stolenWorkerKey_cannotExceedCap() public {
        vm.startPrank(worker);
        dep.executeAgentDeposit(100e6, 100e6, keccak256("d2"));
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.CapExceeded.selector, 1e6, 0));
        dep.executeAgentDeposit(1e6, 1e6, keccak256("d3"));
        vm.stopPrank();
    }

    function test_midPlanRevoke_haltsImmediately() public {
        vm.prank(worker);
        dep.executeAgentDeposit(30e6, 30e6, keccak256("d4"));
        vm.prank(owner); reg.revokeAgent(worker); // user pulls the plug
        vm.prank(worker);
        vm.expectRevert(AgentVaultDepositor.ScopeInactive.selector);
        dep.executeAgentDeposit(30e6, 30e6, keccak256("d5"));
    }

    // A random attacker who does NOT hold the worker key has no scope at all.
    // (Distinct from the stolen-key cases above, where the attacker DOES sign as worker
    //  but is still boxed in by cap/vault/expiry.) Under the EIP-712 form this means the
    //  attacker signs with THEIR key -> recovered signer != worker -> ScopeInactive.
    function test_unauthorizedCaller_hasNoScope() public {
        vm.prank(attacker);
        vm.expectRevert(AgentVaultDepositor.ScopeInactive.selector);
        dep.executeAgentDeposit(10e6, 10e6, keccak256("d6"));
    }
}
```

- [ ] **Step 2: Run**

Run: `wsl -e bash -c "cd /mnt/c/SharredData/project/competition/yield-vibing && forge test --match-contract DestructiveTest -vvv"`
Expected: PASS — every escape attempt mentions scope.

- [ ] **Step 3: Run the drills against the LIVE Base Sepolia deployment, record results into the threat model**

After Phase 1 Task 6 has deployed (addresses in `deployments/base-sepolia.json`), run each drill against the live depositor and capture the revert reasons. Paste the outcomes into `docs/technical-threat-model.md` §5. This is the demo line: "our server got hacked — nothing happened."

> **Submission shape (Blocker 1 is SETTLED — EIP-712 relayer, see ledger / Phase 1).** Authorization is the
> recovered EIP-712 signer, NOT `msg.sender`. So a live drill is: sign the deposit with the stolen worker key,
> then submit the `(amount, minAmount, execId, sig)` tx from ANY funded account (or the relayer path). Do **not**
> model this as a naked `cast send` from the worker EOA — that conflates signer with submitter and would
> mis-test the real auth path.

Drills to record:
1. **Stolen worker key, wrong vault** — there is no vault parameter; shares still land with `owner`. Attacker gains nothing.
2. **Stolen worker key, over cap** — second deposit reverts `CapExceeded(attempted, remaining)`.
3. **Mid-plan revoke** — `revokeAgent`, then next signed deposit reverts `ScopeInactive`.
4. **Relayer down (the promised availability drill)** — kill the primary 1Shot relay path, then re-submit the
   *same signed* `(amount, minAmount, execId, sig)` via a fallback RPC. Assert it still lands exactly once
   (the `execId` idempotency guard makes the resubmit safe — a replay is a no-op, not a double deposit).
   Record: primary-down behavior, fallback success, and that no double-spend occurred.

- [ ] **Step 4: Commit**

```bash
git add test/security/Destructive.t.sol docs/technical-threat-model.md
git commit -m "test(security): destructive stolen-key/revoke drills + live results"
```

---

## Task 4: CI workflow

**Files:**
- Create: `slither.config.json`
- Create: `.github/workflows/contracts.yml`

- [ ] **Step 0: Write `slither.config.json` so real findings don't drown in OZ/test noise**

```json
{
  "filter_paths": "lib/|test/",
  "exclude_informational": false,
  "exclude_low": false
}
```

Without this, Slither floods on OpenZeppelin imports and test files. Soft-fail stays for now;
promote `continue-on-error: false` (hard gate) after Phase 5 once the baseline is clean.

- [ ] **Step 1: Write the workflow (unit always; slither soft; fork nightly)**

> **Fork-exclusion is by CONTRACT NAME, not path glob.** Foundry path matching does **not** reliably
> support brace expansion `{a,b}` across versions, so `--no-match-path 'test/{integration,simulation}/**'`
> can silently fail to exclude → the secret-less `unit` job runs a fork test → `envString` reverts → CI
> permanently red. Instead, every fork/RPC-dependent test contract MUST carry the `Fork` suffix
> (`MorphoForkTest`, and rename Phase 3's replay contract to `TimelineReplayForkTest`). Then
> `--no-match-contract Fork` / `--match-contract Fork` is deterministic on every forge version.
>
> **⚠️ `schedule:` only fires from the DEFAULT branch.** GitHub runs cron workflows from `main` only —
> while this work lives on `iq`, the nightly fork job will NOT run until merged to `main`. Documented in
> the workflow comment so it isn't mistaken for a broken pipeline.

```yaml
# .github/workflows/contracts.yml
name: contracts
on:
  push: { branches: [main, iq] }
  pull_request:
  # NOTE: scheduled runs fire ONLY from the default branch (main). On `iq` the
  # fork-nightly job will not trigger until this is merged to main.
  schedule: [{ cron: '0 3 * * *' }] # nightly fork tests

jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { submodules: recursive }
      - uses: foundry-rs/foundry-toolchain@v1
      # Exclude every fork/RPC test by CONTRACT-NAME suffix `Fork` (brace globs are unreliable).
      - run: forge test --no-match-contract Fork -vv

  slither:
    runs-on: ubuntu-latest
    continue-on-error: true   # soft-fail for now; promote to hard gate after Phase 5
    steps:
      - uses: actions/checkout@v4
        with: { submodules: recursive }
      - uses: crytic/slither-action@v0
        with: { target: 'contracts/' }
        # config: slither.config.json filters lib/ + test/ noise (see Task 4 Step 0)

  fork-nightly:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { submodules: recursive }
      - uses: foundry-rs/foundry-toolchain@v1
      - run: forge test --match-contract Fork -vv
        env:
          MAINNET_RPC: ${{ secrets.MAINNET_RPC }}
          BASE_MAINNET_RPC: ${{ secrets.BASE_MAINNET_RPC }}
```

- [ ] **Step 2: Validate the workflow YAML**

Run: `rtk npx --yes @action-validator/cli .github/workflows/contracts.yml` **[VERIFY `@action-validator/cli` resolves via npx in this env]**. If npx can't fetch it, fall back to pasting the file into GitHub's web workflow editor — its inline linter is sufficient. Expected: valid.

- [ ] **Step 3: Commit**

```bash
git add slither.config.json .github/workflows/contracts.yml
git commit -m "ci: unit + slither(soft) + nightly fork test jobs"
```

---

## Self-Review checklist

- [ ] 4.1→Task1, 4.2→Task2, 4.3→Task4, 4.4→Task3.
- [ ] **All 4 roadmap-4.2 invariants present:** `spentNeverExceedsCap`, `reservesNeverExceedBalance` (structural), **plus the two headline proofs** `outflowBounded` (total outflow ≤ cap×periods — the bounded-loss claim) and `noDepositsAfterRevoke` (revoke = hard stop). Ghost accounting (`totalPulled`, `startTs`, `revoked`, `depositsAfterRevoke`) lives in the Handler.
- [ ] `[VERIFY]` items (Morpho vault, USDC Base mainnet, fork block) guarded by `require`/explicit branch so a wrong/zero value halts loudly instead of passing silently.
- [ ] `test_realVault_maxDepositRespected` has BOTH branches (cap-low → revert, normal → success+shares) — cannot pass hollow.
- [ ] Type consistency: `executeAgentDeposit(amount,minAmount,execId[,sig])`, `scopeOf`, `reserves`, `CapExceeded(attempted,remaining)`, `ScopeInactive` identical to Phase 1.
- [ ] **Blocker 1 = SETTLED (EIP-712 relayer).** Auth is recovered signer, not `msg.sender`. Live drill submits signed payload from any account; the SIGNATURE SYNC note governs every test snippet here.
- [ ] CI excludes fork tests by **contract-name suffix `Fork`** (`--no-match-contract Fork`), not brace glob; `slither.config.json` filters `lib/|test/`; scheduled job's default-branch-only limitation noted in the workflow.
- [ ] Destructive suite covers: stolen-key wrong-vault, stolen-key over-cap, mid-plan revoke, **unauthorized-caller no-scope**, and the **relayer-down availability drill** (fallback RPC + execId idempotency, no double-spend).
