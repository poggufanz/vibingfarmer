// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {YieldRouter} from "../src/YieldRouter.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockERC4626} from "./mocks/MockERC4626.sol";
import {MockReentrantERC4626} from "./mocks/MockReentrantERC4626.sol";

contract YieldRouterTest is Test {
    YieldRouter router;
    MockUSDC usdc;
    MockERC4626 vault;

    address owner = address(0xA11CE);
    address user = address(0xB0B);

    function setUp() public {
        usdc = new MockUSDC();
        router = new YieldRouter(owner, address(usdc));
        vault = new MockERC4626(usdc);

        usdc.mint(user, 1_000_000_000); // 1,000 USDC at 6dp

        vm.prank(owner);
        router.setPool(address(vault), true);
    }

    function test_constructor_revertsForZeroCanonicalAsset() public {
        bytes memory initCode = abi.encodePacked(type(YieldRouter).creationCode, abi.encode(owner, address(0)));
        address deployed;
        assembly {
            deployed := create(0, add(initCode, 0x20), mload(initCode))
        }

        assertEq(deployed, address(0), "zero canonical asset must reject construction");
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
        assertEq(usdc.allowance(address(router), address(vault)), 0, "pool allowance is cleared");
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

    function test_withdraw_revertsForZeroShares() public {
        vm.prank(user);
        vm.expectRevert(bytes("YieldRouter: shares are zero"));
        router.withdraw(address(vault), 0, 0);
    }

    function test_withdraw_revertsForDishonestRedeemReturn() public {
        MockReentrantERC4626 dishonestVault = new MockReentrantERC4626(usdc);

        vm.prank(owner);
        router.setPool(address(dishonestVault), true);

        uint256 amount = 1_000_000;
        vm.startPrank(user);
        usdc.approve(address(router), amount);
        uint256 shares = router.deposit(address(dishonestVault), amount, 1);
        dishonestVault.approve(address(router), shares);
        vm.stopPrank();

        dishonestVault.configureRedeem(0, 1);

        vm.prank(user);
        vm.expectRevert(bytes("YieldRouter: asset receipt mismatch"));
        router.withdraw(address(dishonestVault), shares, 1);

        assertEq(dishonestVault.balanceOf(user), shares, "failed redeem restores shares");
        assertEq(usdc.balanceOf(user), 1_000_000_000 - amount, "failed redeem is atomic");
    }

    function test_withdraw_revertsWhenPoolConsumesOnlyPartOfShares() public {
        MockReentrantERC4626 partialBurnVault = new MockReentrantERC4626(usdc);

        vm.prank(owner);
        router.setPool(address(partialBurnVault), true);

        uint256 amount = 1_000_000;
        vm.startPrank(user);
        usdc.approve(address(router), amount);
        uint256 shares = router.deposit(address(partialBurnVault), amount, 1);
        partialBurnVault.approve(address(router), shares);
        vm.stopPrank();

        partialBurnVault.configureRedeemBurn(1);

        vm.prank(user);
        vm.expectRevert(bytes("YieldRouter: share consumption mismatch"));
        router.withdraw(address(partialBurnVault), shares, 1);

        assertEq(partialBurnVault.balanceOf(user), shares, "partial share burn is atomic");
    }

    function test_setPool_onlyOwner() public {
        address attacker = address(0xBAD);
        address newPool = address(new MockERC4626(usdc));

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        router.setPool(newPool, true);

        assertFalse(router.allowedPool(newPool), "attacker could not whitelist a pool");

        vm.prank(owner);
        router.setPool(newPool, true);
        assertTrue(router.allowedPool(newPool), "owner can whitelist a pool");
    }

    function test_setPool_revertsForMismatchedAsset() public {
        MockUSDC otherAsset = new MockUSDC();
        MockERC4626 mismatchedVault = new MockERC4626(otherAsset);

        vm.prank(owner);
        vm.expectRevert(bytes("YieldRouter: wrong pool asset"));
        router.setPool(address(mismatchedVault), true);

        assertFalse(router.allowedPool(address(mismatchedVault)), "mismatched pool must stay disabled");
    }

    function test_setPool_revertsForNonContractPool() public {
        address eoaPool = address(0xCAFE);

        vm.prank(owner);
        vm.expectRevert(bytes("YieldRouter: pool has no code"));
        router.setPool(eoaPool, true);
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

    function test_deposit_revalidatesCanonicalAssetAfterAllowlisting() public {
        MockReentrantERC4626 mutableVault = new MockReentrantERC4626(usdc);

        vm.prank(owner);
        router.setPool(address(mutableVault), true);

        mutableVault.setReportedAsset(address(new MockUSDC()));

        uint256 amount = 1_000_000;
        vm.startPrank(user);
        usdc.approve(address(router), amount);
        vm.expectRevert(bytes("YieldRouter: wrong pool asset"));
        router.deposit(address(mutableVault), amount, 1);
        vm.stopPrank();
    }

    function test_disablingPool_blocksDepositsButKeepsWithdrawals() public {
        uint256 amount = 1_000_000;

        vm.startPrank(user);
        usdc.approve(address(router), amount * 2);
        uint256 shares = router.deposit(address(vault), amount, 1);
        vm.stopPrank();

        vm.prank(owner);
        router.setPool(address(vault), false);

        vm.startPrank(user);
        vm.expectRevert(bytes("YieldRouter: pool not allowed"));
        router.deposit(address(vault), amount, 1);

        vault.approve(address(router), shares);
        uint256 assets = router.withdraw(address(vault), shares, 1);
        vm.stopPrank();

        assertEq(assets, amount, "disabled pool remains available for exits");
        assertEq(usdc.balanceOf(user), 1_000_000_000, "exit returns the user's assets");
    }

    function test_deposit_revertsForZeroAmount() public {
        vm.prank(user);
        vm.expectRevert(bytes("YieldRouter: amount is zero"));
        router.deposit(address(vault), 0, 0);
    }

    function test_deposit_revertsBelowMinShares() public {
        MockReentrantERC4626 badVault = new MockReentrantERC4626(usdc);
        uint256 amount = 1_000_000; // 1 USDC at 6dp

        vm.prank(owner);
        router.setPool(address(badVault), true);

        vm.startPrank(user);
        usdc.approve(address(router), amount);
        vm.expectRevert(bytes("YieldRouter: slippage, shares < minShares"));
        router.deposit(address(badVault), amount, amount + 1);
        vm.stopPrank();
    }

    function test_deposit_revertsWhenPoolPullsOnlyPartOfAssets() public {
        MockReentrantERC4626 partialPullVault = new MockReentrantERC4626(usdc);
        partialPullVault.configureDeposit(1, 0);

        vm.prank(owner);
        router.setPool(address(partialPullVault), true);

        uint256 amount = 1_000_000;
        vm.startPrank(user);
        usdc.approve(address(router), amount);
        vm.expectRevert(bytes("YieldRouter: pool did not consume assets"));
        router.deposit(address(partialPullVault), amount, 1);
        vm.stopPrank();

        assertEq(usdc.balanceOf(user), 1_000_000_000, "failed deposit is atomic");
        assertEq(usdc.balanceOf(address(router)), 0, "failed deposit leaves no router dust");
    }

    function test_deposit_revertsForDishonestShareReturn() public {
        MockReentrantERC4626 dishonestVault = new MockReentrantERC4626(usdc);
        dishonestVault.configureDeposit(0, 1);

        vm.prank(owner);
        router.setPool(address(dishonestVault), true);

        uint256 amount = 1_000_000;
        vm.startPrank(user);
        usdc.approve(address(router), amount);
        vm.expectRevert(bytes("YieldRouter: share receipt mismatch"));
        router.deposit(address(dishonestVault), amount, 1);
        vm.stopPrank();

        assertEq(dishonestVault.balanceOf(user), 0, "dishonest deposit is atomic");
    }

    function test_noArbitraryCall_unknownSelectorReverts() public {
        (bool ok,) = address(router).call(abi.encodeWithSignature("sweep(address)", user));
        assertFalse(ok, "router must not expose a sweep/arbitrary-call surface");
    }

    function test_noArbitraryCall_rejectsPlainEther() public {
        vm.deal(user, 1 ether);
        vm.prank(user);
        (bool ok,) = address(router).call{value: 1 ether}("");
        assertFalse(ok, "router must not accept plain ETH (no receive/fallback)");
    }

    function test_noUnenforceablePerformanceFeeSurface() public {
        vm.startPrank(owner);
        (bool setFeeOk,) = address(router).call(abi.encodeWithSignature("setFee(uint16,address)", 1000, address(0xFEE)));
        (bool feeBpsOk,) = address(router).call(abi.encodeWithSignature("feeBps()"));
        (bool feeRecipientOk,) = address(router).call(abi.encodeWithSignature("feeRecipient()"));
        (bool principalOk,) =
            address(router).call(abi.encodeWithSignature("principalOf(address,address)", user, address(vault)));
        vm.stopPrank();

        assertFalse(setFeeOk, "router must not expose setFee");
        assertFalse(feeBpsOk, "router must not expose feeBps");
        assertFalse(feeRecipientOk, "router must not expose feeRecipient");
        assertFalse(principalOk, "router must not expose principal bookkeeping");
    }

    function test_withdraw_forwardsAllYieldWithoutPrincipalOrFeeBookkeeping() public {
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

        assertEq(usdc.balanceOf(user), 1_000_000_000 - amount + assets, "caller receives every redeemed asset");
        assertGt(assets, amount, "donated yield increases redeemed assets");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no USDC after withdrawal");
        assertEq(vault.balanceOf(address(router)), 0, "router holds no shares (zero-custody)");
    }
}
