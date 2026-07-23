// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "./MockUSDC.sol";
import {MockTokenMessengerV2} from "./MockTokenMessengerV2.sol";
import {MockYieldRouter} from "./MockYieldRouter.sol";

contract MockTokenMessengerV2Test is Test {
    MockUSDC usdc;
    MockTokenMessengerV2 messenger;
    MockYieldRouter router;

    address burner = address(0xB0B);

    function setUp() public {
        usdc = new MockUSDC();
        messenger = new MockTokenMessengerV2();
        router = new MockYieldRouter();
        usdc.mint(burner, 1_000_000);
    }

    function test_burn_pullsTokensAndRecordsArgs() public {
        vm.startPrank(burner);
        usdc.approve(address(messenger), 1_000_000);
        messenger.depositForBurnWithHook(
            1_000_000, 27, bytes32(uint256(1)), address(usdc), bytes32(uint256(1)), 10_000, 1000, hex"beef"
        );
        vm.stopPrank();

        assertEq(usdc.balanceOf(burner), 0, "tokens must leave the burner");
        assertEq(usdc.balanceOf(address(messenger)), 1_000_000, "messenger must hold them");
        assertEq(messenger.lastAmount(), 1_000_000);
        assertEq(messenger.lastDestinationDomain(), 27);
        assertEq(messenger.lastMinFinalityThreshold(), 1000);
        assertEq(messenger.burnCount(), 1);
    }

    function test_burn_canBeMadeToRevert() public {
        messenger.setShouldRevert(true);
        vm.startPrank(burner);
        usdc.approve(address(messenger), 1_000_000);
        vm.expectRevert(bytes("messenger revert"));
        messenger.depositForBurnWithHook(
            1_000_000, 27, bytes32(uint256(1)), address(usdc), bytes32(uint256(1)), 10_000, 1000, hex"beef"
        );
        vm.stopPrank();
    }

    function test_router_allowedPoolDefaultsFalseAndIsSettable() public {
        assertFalse(router.allowedPool(address(0xDEAD)));
        router.setAllowed(address(0xDEAD), true);
        assertTrue(router.allowedPool(address(0xDEAD)));
    }
}
