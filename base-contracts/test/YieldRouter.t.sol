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
    address feeRecipient = address(0xFEE);

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

    // --- Amendment A1: performance-fee switch (default-inert) ---

    function test_setFee_onlyOwnerAndBounds() public {
        // non-owner cannot set
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        router.setFee(1000, feeRecipient);

        // above the hard cap reverts
        vm.prank(owner);
        vm.expectRevert(bytes("YieldRouter: fee exceeds FEE_MAX_BPS"));
        router.setFee(2001, feeRecipient); // FEE_MAX_BPS is 2000

        // non-zero fee with no recipient reverts
        vm.prank(owner);
        vm.expectRevert(bytes("YieldRouter: fee needs a recipient"));
        router.setFee(1000, address(0));

        // owner sets a valid fee
        vm.prank(owner);
        router.setFee(1000, feeRecipient);
        assertEq(router.feeBps(), 1000, "feeBps set");
        assertEq(router.feeRecipient(), feeRecipient, "recipient set");

        // fee can be turned back off with a zero recipient
        vm.prank(owner);
        router.setFee(0, address(0));
        assertEq(router.feeBps(), 0, "fee turned off");
    }

    function test_withdraw_takesFeeOnYieldOnly() public {
        vm.prank(owner);
        router.setFee(1000, feeRecipient); // 10% on yield

        uint256 amount = 1_000_000; // 1 USDC principal at 6dp
        vm.startPrank(user);
        usdc.approve(address(router), amount);
        uint256 shares = router.deposit(address(vault), amount, 1);
        vm.stopPrank();

        // Simulate real yield: donate USDC to the vault, raising assets-per-share.
        usdc.mint(address(vault), 1_000_000); // +1 USDC of yield backing the same shares

        vm.startPrank(user);
        vault.approve(address(router), shares);
        uint256 assets = router.withdraw(address(vault), shares, 1);
        vm.stopPrank();

        uint256 expectedYield = assets - amount; // gross redeemed minus principal
        uint256 expectedFee = (expectedYield * 1000) / 10_000;

        assertGt(expectedFee, 0, "a fee was taken on the yield");
        assertEq(usdc.balanceOf(feeRecipient), expectedFee, "feeRecipient got exactly the yield fee");
        assertEq(
            usdc.balanceOf(user),
            1_000_000_000 - amount + (assets - expectedFee),
            "caller got principal + post-fee yield"
        );
        assertEq(router.principalOf(user, address(vault)), 0, "principal baseline reset, never skimmed");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no USDC after fee split (zero-custody)");
        assertEq(vault.balanceOf(address(router)), 0, "router holds no shares (zero-custody)");
    }

    function test_withdraw_noFeeWhenNoYield() public {
        vm.prank(owner);
        router.setFee(1000, feeRecipient); // fee on, but there will be no yield

        uint256 amount = 1_000_000;
        vm.startPrank(user);
        usdc.approve(address(router), amount);
        uint256 shares = router.deposit(address(vault), amount, 1);

        vault.approve(address(router), shares);
        uint256 assets = router.withdraw(address(vault), shares, 1);
        vm.stopPrank();

        assertEq(usdc.balanceOf(feeRecipient), 0, "no fee when there is no yield");
        assertEq(usdc.balanceOf(user), 1_000_000_000, "caller got full principal back, unskimmed");
        assertLe(assets, amount, "no yield: redeemed <= principal");
        assertEq(router.principalOf(user, address(vault)), 0, "principal fully withdrawn");
    }
}
