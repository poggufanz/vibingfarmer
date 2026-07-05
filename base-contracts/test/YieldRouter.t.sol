// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {YieldRouter} from "../src/YieldRouter.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockERC4626} from "./mocks/MockERC4626.sol";

contract YieldRouterTest is Test {
    YieldRouter router;
    MockUSDC usdc;
    MockERC4626 vault;

    address user = address(0xB0B);

    function setUp() public {
        router = new YieldRouter();
        usdc = new MockUSDC();
        vault = new MockERC4626(usdc);

        usdc.mint(user, 1_000_000_000); // 1,000 USDC at 6dp

        router.setPool(address(vault), true);
    }

    function test_deposit_intoWhitelistedPool_mintsSharesToCaller() public {
        uint256 amount = 1_000_000; // 1 USDC at 6dp

        vm.startPrank(user);
        usdc.approve(address(router), amount);
        uint256 shares = router.deposit(address(vault), amount, 1);
        vm.stopPrank();

        assertGt(shares, 0, "shares were minted");
        assertEq(vault.balanceOf(user), shares, "caller holds all minted shares");
        assertEq(vault.balanceOf(address(router)), 0, "router holds no shares (zero-custody)");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no USDC (zero-custody)");
        assertEq(usdc.balanceOf(user), 1_000_000_000 - amount, "USDC left the caller");
    }

    function test_withdraw_redeemsSharesToUSDC() public {
        uint256 amount = 1_000_000; // 1 USDC at 6dp

        vm.startPrank(user);
        usdc.approve(address(router), amount);
        uint256 shares = router.deposit(address(vault), amount, 1);

        vault.approve(address(router), shares);
        uint256 assets = router.withdraw(address(vault), shares, 1);
        vm.stopPrank();

        assertGt(assets, 0, "assets were redeemed");
        assertEq(usdc.balanceOf(user), 1_000_000_000, "caller got the USDC back");
        assertEq(vault.balanceOf(user), 0, "caller's shares were burned");
        assertEq(vault.balanceOf(address(router)), 0, "router holds no shares (zero-custody)");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no USDC (zero-custody)");
    }
}
