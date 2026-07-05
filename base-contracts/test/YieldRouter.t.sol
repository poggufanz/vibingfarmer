// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {YieldRouter} from "../src/YieldRouter.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockERC4626} from "./mocks/MockERC4626.sol";
import {MockAdversarialERC4626} from "./mocks/MockAdversarialERC4626.sol";

contract YieldRouterTest is Test {
    YieldRouter router;
    MockUSDC usdc;
    MockERC4626 vault;

    address owner = address(0xA11CE);
    address user = address(0xB0B);

    function setUp() public {
        router = new YieldRouter(owner);
        usdc = new MockUSDC();
        vault = new MockERC4626(usdc);

        usdc.mint(user, 1_000_000_000); // 1,000 USDC at 6dp

        vm.prank(owner);
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

    function test_setPool_onlyOwner() public {
        address attacker = address(0xBAD);
        address newPool = address(0xCAFE);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        router.setPool(newPool, true);

        assertFalse(router.allowedPool(newPool), "attacker could not whitelist a pool");

        vm.prank(owner);
        router.setPool(newPool, true);
        assertTrue(router.allowedPool(newPool), "owner can whitelist a pool");
    }

    function test_deposit_revertsForUnlistedPool() public {
        MockERC4626 unlistedVault = new MockERC4626(usdc);
        uint256 amount = 1_000_000;

        vm.startPrank(user);
        usdc.approve(address(router), amount);
        vm.expectRevert(bytes("YieldRouter: pool not allowed"));
        router.deposit(address(unlistedVault), amount, 1);
        vm.stopPrank();
    }

    function test_deposit_revertsBelowMinShares() public {
        MockAdversarialERC4626 badVault = new MockAdversarialERC4626(usdc);
        uint256 amount = 1_000_000; // 1 USDC at 6dp

        vm.prank(owner);
        router.setPool(address(badVault), true);

        vm.startPrank(user);
        usdc.approve(address(router), amount);
        vm.expectRevert(bytes("YieldRouter: slippage, shares < minShares"));
        router.deposit(address(badVault), amount, 2); // badVault always mints 1 wei — below the floor of 2
        vm.stopPrank();
    }

    function test_noArbitraryCall_unknownSelectorReverts() public {
        (bool ok, ) = address(router).call(abi.encodeWithSignature("sweep(address)", user));
        assertFalse(ok, "router must not expose a sweep/arbitrary-call surface");
    }

    function test_noArbitraryCall_rejectsPlainEther() public {
        vm.deal(user, 1 ether);
        vm.prank(user);
        (bool ok, ) = address(router).call{value: 1 ether}("");
        assertFalse(ok, "router must not accept plain ETH (no receive/fallback)");
    }
}
