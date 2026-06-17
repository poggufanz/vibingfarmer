// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry} from "../contracts/AgentRegistry.sol";
import {AgentVaultDepositor} from "../contracts/AgentVaultDepositor.sol";
import {MockVault} from "../contracts/MockVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract ZeroCustodyTest is Test {
    AgentRegistry reg; AgentVaultDepositor dep; MockERC20 token; MockVault vault;
    address owner = address(0xA11CE);
    uint256 workerPk = 0xBEEF; address worker;

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

    function _sign(uint256 pk, uint256 amount, uint256 minAmount, bytes32 execId) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, dep.hashDeposit(amount, minAmount, 0, execId));
        return abi.encodePacked(r, s, v);
    }

    function _signHeld(uint256 pk, uint256 amount, uint256 minAmount, bytes32 execId) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, dep.hashHeldDeposit(amount, minAmount, 0, execId));
        return abi.encodePacked(r, s, v);
    }

    function test_workerAndDepositorHoldNothingAfterFlow() public {
        dep.executeAgentDeposit(50e6, 50e6, 0, keccak256("a"), _sign(workerPk, 50e6, 50e6, keccak256("a")));
        assertEq(token.balanceOf(worker), 0);
        assertEq(token.balanceOf(address(dep)), 0);
        assertEq(dep.reserves(address(token)), 0);
        assertEq(vault.balanceOf(worker), 0);
        assertGt(vault.balanceOf(owner), 0);
    }

    // ERC-7715 redeem pushes USDC into the depositor (transient custody). depositHeld must
    // leave NO permanent custody: balance back to its reserve floor (0 at rest), shares to owner.
    function test_depositHeld_leavesNoPermanentCustody() public {
        token.mint(address(dep), 50e6); // simulate the redeem transfer landing
        dep.depositHeld(50e6, 50e6, 0, keccak256("h"), _signHeld(workerPk, 50e6, 50e6, keccak256("h")));
        assertEq(token.balanceOf(address(dep)), 0);          // no permanent custody
        assertEq(dep.reserves(address(token)), 0);           // reserve nets to zero at rest
        assertEq(token.balanceOf(worker), 0);
        assertGt(vault.balanceOf(owner), 0);
    }

    // If a redeem lands but its depositHeld never does, the guardian sweep restores zero custody —
    // transient custody can never become permanent.
    function test_strandedRedeem_sweptToZero() public {
        token.mint(address(dep), 50e6); // redeem landed, deposit never came
        assertEq(token.balanceOf(address(dep)), 50e6);
        dep.sweepStranded(address(token), owner); // test contract is guardian
        assertEq(token.balanceOf(address(dep)), 0);
        assertEq(dep.reserves(address(token)), 0);
    }
}
