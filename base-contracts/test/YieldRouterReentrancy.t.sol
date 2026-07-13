// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {YieldRouter} from "../src/YieldRouter.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockReentrantERC4626} from "./mocks/MockReentrantERC4626.sol";

contract YieldRouterReentrancyTest is Test {
    YieldRouter router;
    MockUSDC usdc;
    MockReentrantERC4626 vault;

    address owner = address(0xA11CE);
    address user = address(0xB0B);

    function setUp() public {
        usdc = new MockUSDC();
        router = new YieldRouter(owner, address(usdc));
        vault = new MockReentrantERC4626(usdc);

        vm.prank(owner);
        router.setPool(address(vault), true);
    }

    function test_deposit_blocksPoolCallbackReentry() public {
        uint256 amount = 10e6;
        usdc.mint(user, amount);
        usdc.mint(address(vault), 1);
        vault.approveAsset(address(router), 1);
        vault.configureCallback(
            address(router), abi.encodeCall(YieldRouter.deposit, (address(vault), 1, 0)), true, false
        );

        vm.startPrank(user);
        usdc.approve(address(router), amount);
        router.deposit(address(vault), amount, 1);
        vm.stopPrank();

        assertFalse(vault.callbackSucceeded(), "pool callback reentered deposit");
    }

    function test_withdraw_blocksPoolCallbackReentry() public {
        uint256 amount = 10e6;
        usdc.mint(user, amount);

        vm.startPrank(user);
        usdc.approve(address(router), amount);
        uint256 shares = router.deposit(address(vault), amount, 1);
        vm.stopPrank();

        usdc.mint(address(vault), 1);
        vault.seedShares(address(vault), 1);
        vault.approveSelfShares(address(router), 1);
        vault.configureCallback(
            address(router), abi.encodeCall(YieldRouter.withdraw, (address(vault), 1, 0)), false, true
        );

        vm.startPrank(user);
        vault.approve(address(router), shares);
        router.withdraw(address(vault), shares, 1);
        vm.stopPrank();

        assertFalse(vault.callbackSucceeded(), "pool callback reentered withdraw");
    }
}
