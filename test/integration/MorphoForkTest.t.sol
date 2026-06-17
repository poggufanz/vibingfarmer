// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {AgentRegistry} from "../../contracts/AgentRegistry.sol";
import {AgentVaultDepositor} from "../../contracts/AgentVaultDepositor.sol";

/// @notice Real-vault fork test against a Morpho MetaMorpho USDC vault on Base mainnet.
///         Requires BASE_MAINNET_RPC + the [VERIFY] addresses below — without them the
///         `require`s halt loudly (no silent pass). Suffix `Fork` excludes this from the
///         secret-less unit job (see .github/workflows/contracts.yml).
contract MorphoForkTest is Test {
    // [VERIFY] from Morpho app/docs — a real USDC MetaMorpho vault on BASE MAINNET.
    address constant MORPHO_USDC_VAULT = address(0); // [VERIFY] replace
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; // USDC Base mainnet

    AgentRegistry reg;
    AgentVaultDepositor dep;
    address owner = address(0xA11CE);
    uint256 workerPk = 0xA9E47; // worker has a private key — it SIGNS, never custodies
    address worker; // = vm.addr(workerPk)

    // [VERIFY] Base mainnet block — pin so the fork is deterministic (vault state frozen).
    // Unpinned = green today, red tomorrow when the vault fills/pauses. Also lighter on the RPC.
    uint256 constant FORK_BLOCK = 0; // [VERIFY] replace with a recent Base block (note the date)

    function setUp() public {
        if (FORK_BLOCK == 0) vm.createSelectFork(vm.envString("BASE_MAINNET_RPC"));
        else vm.createSelectFork(vm.envString("BASE_MAINNET_RPC"), FORK_BLOCK);
        require(MORPHO_USDC_VAULT != address(0), "set MORPHO_USDC_VAULT [VERIFY]");
        require(IERC4626(MORPHO_USDC_VAULT).asset() == USDC, "vault asset mismatch");

        worker = vm.addr(workerPk);
        reg = new AgentRegistry();
        dep = new AgentVaultDepositor(address(reg), address(this));
        reg.setDepositor(address(dep));
        deal(USDC, owner, 10_000e6);
        vm.prank(owner);
        IERC20(USDC).approve(address(dep), type(uint256).max);
        vm.prank(owner);
        reg.authorizeSessionKey(worker, MORPHO_USDC_VAULT, USDC, 5_000e6, 1 days, uint40(block.timestamp + 7 days));
    }

    /// Sign an AgentDeposit with `pk` over the depositor's EIP-712 digest.
    function _sign(uint256 pk, uint256 amount, uint256 minAmount, bytes32 execId) internal view returns (bytes memory) {
        bytes32 digest = dep.hashDeposit(amount, minAmount, 0, execId);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_realVault_depositCreditsOwnerShares() public {
        bytes memory sig = _sign(workerPk, 1_000e6, 990e6, keccak256("m1"));
        uint256 shares = dep.executeAgentDeposit(1_000e6, 990e6, 0, keccak256("m1"), sig);
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
            bytes memory sig = _sign(workerPk, 1_000e6, 990e6, keccak256("m2"));
            vm.expectRevert();
            dep.executeAgentDeposit(1_000e6, 990e6, 0, keccak256("m2"), sig);
        } else {
            // normal large vault: deposit succeeds and credits shares to owner
            bytes memory sig = _sign(workerPk, 1_000e6, 990e6, keccak256("m2b"));
            uint256 shares = dep.executeAgentDeposit(1_000e6, 990e6, 0, keccak256("m2b"), sig);
            assertGt(shares, 0);
            assertEq(IERC4626(MORPHO_USDC_VAULT).balanceOf(owner), shares);
        }
    }
}
