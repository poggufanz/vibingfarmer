// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry} from "../../contracts/AgentRegistry.sol";
import {AgentVaultDepositor} from "../../contracts/AgentVaultDepositor.sol";
import {MockVault} from "../../contracts/MockVault.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {Handler} from "./Handler.sol";

contract DepositorInvariantTest is Test {
    AgentRegistry reg;
    AgentVaultDepositor dep;
    MockERC20 token;
    MockVault vault;
    Handler handler;
    address owner = address(0xA11CE);
    uint256 workerPk = 0xA9E47;
    address worker;

    function setUp() public {
        worker = vm.addr(workerPk);
        reg = new AgentRegistry();
        dep = new AgentVaultDepositor(address(reg), address(this));
        reg.setDepositor(address(dep));
        token = new MockERC20("USD Coin", "USDC", 6);
        vault = new MockVault("Vault USDC", address(token), 500);
        token.mint(owner, 1_000_000e6);
        vm.prank(owner);
        token.approve(address(dep), type(uint256).max);
        vm.prank(owner);
        reg.authorizeSessionKey(worker, address(vault), address(token), 100e6, 1 days, uint40(block.timestamp + 30 days));
        handler = new Handler(reg, dep, token, owner, worker, workerPk);
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
