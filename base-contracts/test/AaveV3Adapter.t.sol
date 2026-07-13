// base-contracts/test/AaveV3Adapter.t.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AaveV3Adapter4626} from "../src/AaveV3Adapter4626.sol";
import {MockAToken} from "./mocks/MockAToken.sol";
import {MockMaliciousAavePool} from "./mocks/MockMaliciousAavePool.sol";

contract TestUSDC is ERC20 {
    constructor() ERC20("USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

/// Minimal Aave-v3-shaped pool: supply pulls asset + mints aToken 1:1; withdraw burns + returns.
/// simulateYield() mints extra aTokens to the adapter — models aToken rebasing growth.
contract MockAavePool is ERC20 {
    using SafeERC20 for TestUSDC;

    TestUSDC public immutable usdc;

    constructor(TestUSDC _usdc) ERC20("aUSDC", "aUSDC") {
        usdc = _usdc;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function UNDERLYING_ASSET_ADDRESS() external view returns (address) {
        return address(usdc);
    }

    function supply(address, uint256 amount, address onBehalfOf, uint16) external {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        _mint(onBehalfOf, amount);
    }

    function withdraw(address, uint256 amount, address to) external returns (uint256) {
        _burn(msg.sender, amount);
        usdc.safeTransfer(to, amount);
        return amount;
    }

    function simulateYield(address to, uint256 amount) external {
        usdc.mint(address(this), amount);
        _mint(to, amount);
    }
}

contract AaveV3AdapterTest is Test {
    TestUSDC usdc;
    MockAavePool pool; // doubles as the aToken (it IS the aToken ERC20 here)
    AaveV3Adapter4626 adapter;
    address user = address(0xBEEF);

    function setUp() public {
        usdc = new TestUSDC();
        pool = new MockAavePool(usdc);
        adapter = new AaveV3Adapter4626(IERC20(address(usdc)), address(pool), address(pool), "VF Aave USDC", "vfaUSDC");
        usdc.mint(user, 1_000e6);
        vm.startPrank(user);
        usdc.approve(address(adapter), type(uint256).max);
        vm.stopPrank();
    }

    function test_constructor_revertsForZeroAavePool() public {
        MockAToken validAToken = new MockAToken(IERC20(address(usdc)));

        vm.expectRevert(bytes("AaveV3Adapter: pool is zero"));
        new AaveV3Adapter4626(IERC20(address(usdc)), address(0), address(validAToken), "VF Aave USDC", "vfaUSDC");
    }

    function test_constructor_revertsForNonContractAavePool() public {
        MockAToken validAToken = new MockAToken(IERC20(address(usdc)));

        vm.expectRevert(bytes("AaveV3Adapter: pool has no code"));
        new AaveV3Adapter4626(IERC20(address(usdc)), address(0xCAFE), address(validAToken), "VF Aave USDC", "vfaUSDC");
    }

    function test_constructor_revertsForZeroAToken() public {
        vm.expectRevert(bytes("AaveV3Adapter: aToken is zero"));
        new AaveV3Adapter4626(IERC20(address(usdc)), address(pool), address(0), "VF Aave USDC", "vfaUSDC");
    }

    function test_constructor_revertsForNonContractAToken() public {
        vm.expectRevert(bytes("AaveV3Adapter: aToken has no code"));
        new AaveV3Adapter4626(IERC20(address(usdc)), address(pool), address(0xBEEF), "VF Aave USDC", "vfaUSDC");
    }

    function test_constructor_revertsWhenATokenUnderlyingDiffersFromAsset() public {
        TestUSDC otherAsset = new TestUSDC();
        MockAToken mismatchedAToken = new MockAToken(IERC20(address(otherAsset)));

        vm.expectRevert(bytes("AaveV3Adapter: wrong aToken underlying"));
        new AaveV3Adapter4626(
            IERC20(address(usdc)), address(pool), address(mismatchedAToken), "VF Aave USDC", "vfaUSDC"
        );
    }

    function test_asset_is_usdc() public view {
        assertEq(adapter.asset(), address(usdc));
    }

    function test_totalAssets_includesIdleUnderlying() public {
        usdc.mint(address(adapter), 7e6);

        assertEq(adapter.totalAssets(), 7e6, "idle underlying remains part of vault NAV");
    }

    function test_deposit_revertsWhenPositiveAssetsMintZeroShares() public {
        uint256 donation = 1_000_000;
        usdc.mint(address(adapter), donation);
        uint256 userBalanceBefore = usdc.balanceOf(user);

        vm.prank(user);
        vm.expectRevert(bytes("AaveV3Adapter: shares are zero"));
        adapter.deposit(1, user);

        assertEq(usdc.balanceOf(user), userBalanceBefore, "zero-share deposit must roll back the user transfer");
        assertEq(adapter.totalSupply(), 0, "zero-share deposit creates no position");
        assertEq(adapter.totalAssets(), donation, "preexisting donation remains unchanged");
        assertEq(pool.balanceOf(address(adapter)), 0, "failed deposit mints no aTokens");
    }

    function test_deposit_revertsForZeroAssets() public {
        vm.prank(user);
        vm.expectRevert(bytes("AaveV3Adapter: assets are zero"));
        adapter.deposit(0, user);

        assertEq(adapter.totalSupply(), 0, "zero-asset deposit creates no shares");
        assertEq(adapter.totalAssets(), 0, "zero-asset deposit supplies nothing");
    }

    function test_redeem_usesIdleUnderlyingBeforeWithdrawingFromAave() public {
        vm.prank(user);
        uint256 shares = adapter.deposit(100e6, user);
        usdc.mint(address(adapter), 10e6);

        vm.prank(user);
        uint256 assets = adapter.redeem(shares, user, user);

        assertGt(assets, 100e6, "idle underlying is redeemable by shareholders");
        assertEq(usdc.balanceOf(address(adapter)), 0, "redeem consumes idle balance");
    }

    function test_deposit_blocksAaveSupplyCallbackReentry() public {
        (AaveV3Adapter4626 guardedAdapter, MockMaliciousAavePool maliciousPool,) = _deployMaliciousAdapter();
        uint256 amount = 100e6;

        usdc.mint(address(maliciousPool), 1);
        vm.prank(address(maliciousPool));
        usdc.approve(address(guardedAdapter), 1);
        maliciousPool.configureCallback(
            address(guardedAdapter),
            abi.encodeWithSignature("deposit(uint256,address)", 1, address(maliciousPool)),
            true,
            false
        );

        vm.prank(user);
        guardedAdapter.deposit(amount, user);

        assertFalse(maliciousPool.callbackSucceeded(), "Aave callback reentered deposit");
    }

    function test_mint_blocksAaveSupplyCallbackReentry() public {
        (AaveV3Adapter4626 guardedAdapter, MockMaliciousAavePool maliciousPool,) = _deployMaliciousAdapter();
        uint256 shares = 100e6;

        usdc.mint(address(maliciousPool), 1);
        vm.prank(address(maliciousPool));
        usdc.approve(address(guardedAdapter), 1);
        maliciousPool.configureCallback(
            address(guardedAdapter),
            abi.encodeWithSignature("mint(uint256,address)", 1, address(maliciousPool)),
            true,
            false
        );

        vm.prank(user);
        guardedAdapter.mint(shares, user);

        assertFalse(maliciousPool.callbackSucceeded(), "Aave callback reentered mint");
    }

    function test_deposit_blocksCrossFunctionWithdrawReentry() public {
        (AaveV3Adapter4626 guardedAdapter, MockMaliciousAavePool maliciousPool,) = _deployMaliciousAdapter();

        _seedPoolOwnedPosition(guardedAdapter, maliciousPool, 10e6);
        maliciousPool.configureCallback(
            address(guardedAdapter),
            abi.encodeWithSignature(
                "withdraw(uint256,address,address)", 1, address(maliciousPool), address(maliciousPool)
            ),
            true,
            false
        );

        vm.prank(user);
        guardedAdapter.deposit(100e6, user);

        assertFalse(maliciousPool.callbackSucceeded(), "deposit callback crossed into withdraw");
    }

    function test_mint_blocksCrossFunctionRedeemReentry() public {
        (AaveV3Adapter4626 guardedAdapter, MockMaliciousAavePool maliciousPool,) = _deployMaliciousAdapter();

        _seedPoolOwnedPosition(guardedAdapter, maliciousPool, 10e6);
        maliciousPool.configureCallback(
            address(guardedAdapter),
            abi.encodeWithSignature(
                "redeem(uint256,address,address)", 1, address(maliciousPool), address(maliciousPool)
            ),
            true,
            false
        );

        vm.prank(user);
        guardedAdapter.mint(100e6, user);

        assertFalse(maliciousPool.callbackSucceeded(), "mint callback crossed into redeem");
    }

    function test_withdraw_blocksAaveWithdrawCallbackReentry() public {
        (AaveV3Adapter4626 guardedAdapter, MockMaliciousAavePool maliciousPool,) = _deployMaliciousAdapter();

        _seedPoolOwnedPosition(guardedAdapter, maliciousPool, 10e6);
        vm.prank(user);
        guardedAdapter.deposit(100e6, user);

        maliciousPool.configureCallback(
            address(guardedAdapter),
            abi.encodeWithSignature(
                "withdraw(uint256,address,address)", 1, address(maliciousPool), address(maliciousPool)
            ),
            false,
            true
        );

        vm.prank(user);
        guardedAdapter.withdraw(50e6, user, user);

        assertFalse(maliciousPool.callbackSucceeded(), "Aave callback reentered withdraw");
    }

    function test_redeem_blocksAaveWithdrawCallbackReentry() public {
        (AaveV3Adapter4626 guardedAdapter, MockMaliciousAavePool maliciousPool,) = _deployMaliciousAdapter();

        _seedPoolOwnedPosition(guardedAdapter, maliciousPool, 10e6);
        vm.prank(user);
        uint256 shares = guardedAdapter.deposit(100e6, user);

        maliciousPool.configureCallback(
            address(guardedAdapter),
            abi.encodeWithSignature(
                "redeem(uint256,address,address)", 1, address(maliciousPool), address(maliciousPool)
            ),
            false,
            true
        );

        vm.prank(user);
        guardedAdapter.redeem(shares / 2, user, user);

        assertFalse(maliciousPool.callbackSucceeded(), "Aave callback reentered redeem");
    }

    function test_withdraw_blocksCrossFunctionDepositReentry() public {
        (AaveV3Adapter4626 guardedAdapter, MockMaliciousAavePool maliciousPool,) = _deployMaliciousAdapter();

        vm.prank(user);
        guardedAdapter.deposit(100e6, user);
        usdc.mint(address(maliciousPool), 1);
        vm.prank(address(maliciousPool));
        usdc.approve(address(guardedAdapter), 1);
        maliciousPool.configureCallback(
            address(guardedAdapter),
            abi.encodeWithSignature("deposit(uint256,address)", 1, address(maliciousPool)),
            false,
            true
        );

        vm.prank(user);
        guardedAdapter.withdraw(50e6, user, user);

        assertFalse(maliciousPool.callbackSucceeded(), "withdraw callback crossed into deposit");
    }

    function test_redeem_blocksCrossFunctionMintReentry() public {
        (AaveV3Adapter4626 guardedAdapter, MockMaliciousAavePool maliciousPool,) = _deployMaliciousAdapter();

        vm.prank(user);
        uint256 shares = guardedAdapter.deposit(100e6, user);
        usdc.mint(address(maliciousPool), 1);
        vm.prank(address(maliciousPool));
        usdc.approve(address(guardedAdapter), 1);
        maliciousPool.configureCallback(
            address(guardedAdapter),
            abi.encodeWithSignature("mint(uint256,address)", 1, address(maliciousPool)),
            false,
            true
        );

        vm.prank(user);
        guardedAdapter.redeem(shares / 2, user, user);

        assertFalse(maliciousPool.callbackSucceeded(), "redeem callback crossed into mint");
    }

    function test_withdraw_revertsForDishonestAaveReturn() public {
        (AaveV3Adapter4626 guardedAdapter, MockMaliciousAavePool maliciousPool,) = _deployMaliciousAdapter();

        vm.prank(user);
        guardedAdapter.deposit(100e6, user);
        maliciousPool.configureWithdraw(0, 1);

        uint256 sharesBefore = guardedAdapter.balanceOf(user);
        uint256 assetsBefore = usdc.balanceOf(user);
        vm.prank(user);
        vm.expectRevert(bytes("AaveV3Adapter: withdraw return mismatch"));
        guardedAdapter.withdraw(40e6, user, user);

        assertEq(guardedAdapter.balanceOf(user), sharesBefore, "failed withdrawal restores shares");
        assertEq(usdc.balanceOf(user), assetsBefore, "failed withdrawal pays no assets");
    }

    function test_withdraw_revertsWhenAaveTransfersOnlyPartOfAssets() public {
        (AaveV3Adapter4626 guardedAdapter, MockMaliciousAavePool maliciousPool,) = _deployMaliciousAdapter();

        vm.prank(user);
        guardedAdapter.deposit(100e6, user);
        usdc.mint(address(guardedAdapter), 1);
        maliciousPool.configureWithdraw(1, 0);

        uint256 sharesBefore = guardedAdapter.balanceOf(user);
        uint256 assetsBefore = usdc.balanceOf(user);
        vm.prank(user);
        vm.expectRevert(bytes("AaveV3Adapter: withdraw balance mismatch"));
        guardedAdapter.withdraw(40e6, user, user);

        assertEq(guardedAdapter.balanceOf(user), sharesBefore, "partial withdrawal restores shares");
        assertEq(usdc.balanceOf(user), assetsBefore, "partial withdrawal pays no assets");
    }

    function test_deposit_supplies_to_aave_and_mints_shares() public {
        vm.prank(user);
        uint256 shares = adapter.deposit(100e6, user);
        assertGt(shares, 0);
        assertEq(usdc.balanceOf(address(adapter)), 0); // nothing idle in the adapter
        assertEq(pool.balanceOf(address(adapter)), 100e6); // aTokens held by adapter
        assertEq(adapter.totalAssets(), 100e6);
    }

    function test_yield_grows_share_price_and_redeem_returns_more() public {
        vm.prank(user);
        uint256 shares = adapter.deposit(100e6, user);
        pool.simulateYield(address(adapter), 10e6); // +10% yield
        vm.prank(user);
        uint256 assets = adapter.redeem(shares, user, user);
        assertGe(assets, 109_999_999); // ~110e6 minus 4626 rounding
    }

    function test_withdraw_pulls_from_aave() public {
        vm.prank(user);
        adapter.deposit(100e6, user);
        vm.prank(user);
        adapter.withdraw(40e6, user, user);
        assertEq(usdc.balanceOf(user), 940e6);
        assertEq(adapter.totalAssets(), 60e6);
    }

    function _deployMaliciousAdapter()
        private
        returns (AaveV3Adapter4626 guardedAdapter, MockMaliciousAavePool maliciousPool, MockAToken maliciousAToken)
    {
        maliciousAToken = new MockAToken(IERC20(address(usdc)));
        maliciousPool = new MockMaliciousAavePool(IERC20(address(usdc)), maliciousAToken);
        guardedAdapter = new AaveV3Adapter4626(
            IERC20(address(usdc)), address(maliciousPool), address(maliciousAToken), "VF Aave USDC", "vfaUSDC"
        );
        vm.prank(user);
        usdc.approve(address(guardedAdapter), type(uint256).max);
    }

    function _seedPoolOwnedPosition(
        AaveV3Adapter4626 guardedAdapter,
        MockMaliciousAavePool maliciousPool,
        uint256 amount
    ) private {
        usdc.mint(address(maliciousPool), amount);
        vm.startPrank(address(maliciousPool));
        usdc.approve(address(guardedAdapter), amount);
        guardedAdapter.deposit(amount, address(maliciousPool));
        vm.stopPrank();
    }
}
