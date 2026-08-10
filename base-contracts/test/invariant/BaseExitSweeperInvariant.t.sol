// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {BaseExitSweeper} from "../../src/BaseExitSweeper.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MockERC4626} from "../mocks/MockERC4626.sol";
import {MockTokenMessengerV2} from "../mocks/MockTokenMessengerV2.sol";
import {MockYieldRouter} from "../mocks/MockYieldRouter.sol";
import {BaseExitSweeperHandler} from "./BaseExitSweeperHandler.sol";

contract BaseExitSweeperInvariantTest is Test {
    BaseExitSweeper sweeper;
    MockUSDC usdc;
    MockTokenMessengerV2 messenger;
    MockYieldRouter router;
    MockERC4626 poolA;
    MockERC4626 poolB;
    MockERC4626 neverKnown;
    BaseExitSweeperHandler handler;

    address protectedOwner = address(0x9999);
    bytes32 constant FORWARDER = bytes32(uint256(0xF0));

    function setUp() public {
        usdc = new MockUSDC();
        messenger = new MockTokenMessengerV2();
        router = new MockYieldRouter();
        sweeper = new BaseExitSweeper(address(usdc), address(router), address(messenger), 27, FORWARDER, FORWARDER);
        poolA = new MockERC4626(usdc);
        poolB = new MockERC4626(usdc);
        neverKnown = new MockERC4626(usdc);
        router.setAllowed(address(poolA), true);
        router.setAllowed(address(poolB), true);

        usdc.mint(protectedOwner, 10_000_000);
        vm.startPrank(protectedOwner);
        usdc.approve(address(poolA), 5_000_000);
        poolA.deposit(5_000_000, protectedOwner);
        poolA.approve(address(sweeper), type(uint256).max);
        usdc.approve(address(sweeper), type(uint256).max);
        vm.stopPrank();

        handler = new BaseExitSweeperHandler(sweeper, usdc, messenger, poolA, poolB, neverKnown, protectedOwner);
        targetContract(address(handler));
    }

    function invariant_oneTruthfulBurnAndPinnedRoutePerSuccessfulAction() public view {
        assertFalse(handler.invariantViolation());
        assertEq(sweeper.stellarDomain(), 27);
        assertEq(sweeper.mintRecipient(), FORWARDER);
        assertEq(sweeper.destinationCaller(), FORWARDER);
        assertEq(sweeper.FINALITY_THRESHOLD(), 1000);
    }

    function invariant_zeroSweeperCustodyAndMessengerAllowance() public view {
        assertEq(usdc.balanceOf(address(sweeper)), 0);
        assertEq(usdc.allowance(address(sweeper), address(messenger)), 0);
    }

    function invariant_protectedOwnerIsNeverTouchedByAnotherCaller() public view {
        assertEq(usdc.balanceOf(protectedOwner), 5_000_000);
        assertEq(poolA.balanceOf(protectedOwner), 5_000_000);
        assertEq(poolB.balanceOf(protectedOwner), 0);
    }
}
