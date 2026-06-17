// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry} from "../contracts/AgentRegistry.sol";
import {AgentVaultDepositor} from "../contracts/AgentVaultDepositor.sol";
import {MockVault} from "../contracts/MockVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract PauseInvariantTest is Test {
    AgentRegistry reg; AgentVaultDepositor dep; MockERC20 token; MockVault vault;
    address owner = address(0xA11CE);
    uint256 workerPk = 0xB0B;
    address worker;

    function setUp() public {
        worker = vm.addr(workerPk);
        reg = new AgentRegistry();
        dep = new AgentVaultDepositor(address(reg), address(this));
        reg.setDepositor(address(dep));
        token = new MockERC20("USD Coin", "USDC", 6);
        vault = new MockVault("Vault USDC", address(token), 500);
        token.mint(owner, 1_000e6);
        vm.prank(owner); token.approve(address(dep), type(uint256).max);
        vm.prank(owner);
        reg.authorizeSessionKey(worker, address(vault), address(token), 100e6, 1 days, uint40(block.timestamp + 7 days));
    }

    // EIP-712 sign helper (mirrors ZeroCustodyTest / Phase 1 Task 3).
    function _sign(uint256 pk, uint256 amount, uint256 minAmount, bytes32 execId)
        internal view returns (bytes memory)
    {
        bytes32 digest = dep.hashDeposit(amount, minAmount, 0, execId);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_pausedBlocks_thenUnpauseWorks_noIdleFunds() public {
        bytes32 execId = keccak256("x");
        // Precompute sig: vm.expectRevert() only covers the immediately-following
        // call, and _sign() itself does a (non-reverting) staticcall to hashDeposit.
        bytes memory sig = _sign(workerPk, 50e6, 50e6, execId);

        dep.pause();
        vm.expectRevert(); // whenNotPaused reverts before signature recovery
        dep.executeAgentDeposit(50e6, 50e6, 0, execId, sig);
        // no funds moved while paused
        assertEq(token.balanceOf(address(dep)), 0);
        assertEq(dep.reserves(address(token)), 0);

        dep.unpause();
        // execId reuse after a reverted attempt is intentional: the revert rolled
        // back executed[execId]=true, proving a failed attempt does not burn the id.
        dep.executeAgentDeposit(50e6, 50e6, 0, execId, sig);
        assertEq(token.balanceOf(address(dep)), 0); // atomic: nothing idle after
        assertEq(dep.reserves(address(token)), 0);
        assertGt(vault.balanceOf(owner), 0);
    }
}
