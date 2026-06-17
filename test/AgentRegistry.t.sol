// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry} from "../contracts/AgentRegistry.sol";
import {MockVault} from "../contracts/MockVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract AgentRegistryTest is Test {
    AgentRegistry reg;
    MockERC20 token;
    MockVault vault;
    address owner = address(0xA11CE);
    address agent = address(0xBEEF);
    address depositor = address(0xD0);

    function setUp() public {
        reg = new AgentRegistry();
        reg.setDepositor(depositor);
        token = new MockERC20("USD Coin", "USDC", 6);
        vault = new MockVault("Vault USDC", address(token), 500);
    }

    function _authorize() internal {
        vm.prank(owner);
        reg.authorizeSessionKey(agent, address(vault), address(token), 100e6, 1 days, uint40(block.timestamp + 7 days));
    }

    function test_authorize_setsScopeAndIsActive() public {
        _authorize();
        AgentRegistry.AgentScope memory s = reg.scopeOf(agent);
        assertEq(s.owner, owner);
        assertEq(s.vault, address(vault));
        assertEq(s.token, address(token));
        assertEq(s.capPerPeriod, 100e6);
        assertTrue(reg.isActive(agent));
        address[] memory list = reg.scopesOfOwner(owner);
        assertEq(list.length, 1);
        assertEq(list[0], agent);
    }

    function test_authorize_revertsOnSecondScopeForSameAgent() public {
        _authorize();
        vm.prank(owner);
        vm.expectRevert(AgentRegistry.ScopeExists.selector);
        reg.authorizeSessionKey(agent, address(vault), address(token), 1e6, 1 days, uint40(block.timestamp + 1 days));
    }

    function test_authorize_revertsOnExpiryTooFar() public {
        vm.prank(owner);
        vm.expectRevert(AgentRegistry.InvalidScope.selector);
        reg.authorizeSessionKey(agent, address(vault), address(token), 1e6, 1 days, uint40(block.timestamp + 31 days));
    }

    function test_authorize_revertsOnVaultTokenMismatch() public {
        MockERC20 other = new MockERC20("Other", "OTH", 6);
        vm.prank(owner);
        vm.expectRevert(AgentRegistry.InvalidScope.selector);
        reg.authorizeSessionKey(agent, address(vault), address(other), 1e6, 1 days, uint40(block.timestamp + 1 days));
    }

    function test_revoke_onlyOwner_andKeyStaysDead() public {
        _authorize();
        vm.prank(address(0xDEAD));
        vm.expectRevert(AgentRegistry.NotOwner.selector);
        reg.revokeAgent(agent);
        vm.prank(owner);
        reg.revokeAgent(agent);
        assertFalse(reg.isActive(agent));
        // re-authorize same key still blocked (key dead forever)
        vm.prank(owner);
        vm.expectRevert(AgentRegistry.ScopeExists.selector);
        reg.authorizeSessionKey(agent, address(vault), address(token), 1e6, 1 days, uint40(block.timestamp + 1 days));
    }

    function test_rollAndSpend_onlyDepositor() public {
        _authorize();
        vm.expectRevert(AgentRegistry.NotDepositor.selector);
        reg.rollAndSpend(agent, 1e6);
    }

    function test_rollAndSpend_capAndMultiPeriodSkip() public {
        _authorize();
        vm.startPrank(depositor);
        reg.rollAndSpend(agent, 60e6);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.CapExceeded.selector, 50e6, 40e6));
        reg.rollAndSpend(agent, 50e6);
        // skip 3 periods with no activity → window jumps by multiples, not reset-to-now
        skip(3 days + 1);
        reg.rollAndSpend(agent, 100e6); // fresh full cap
        vm.stopPrank();
        AgentRegistry.AgentScope memory s = reg.scopeOf(agent);
        assertEq(s.spentInPeriod, 100e6);
    }
}
