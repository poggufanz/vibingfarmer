// base-contracts/test/AaveV3Adapter.t.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AaveV3Adapter4626} from "../src/AaveV3Adapter4626.sol";

contract TestUSDC is ERC20 {
    constructor() ERC20("USDC", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

/// Minimal Aave-v3-shaped pool: supply pulls asset + mints aToken 1:1; withdraw burns + returns.
/// simulateYield() mints extra aTokens to the adapter — models aToken rebasing growth.
contract MockAavePool is ERC20 {
    TestUSDC public immutable usdc;
    constructor(TestUSDC _usdc) ERC20("aUSDC", "aUSDC") { usdc = _usdc; }
    function decimals() public pure override returns (uint8) { return 6; }
    function supply(address, uint256 amount, address onBehalfOf, uint16) external {
        usdc.transferFrom(msg.sender, address(this), amount);
        _mint(onBehalfOf, amount);
    }
    function withdraw(address, uint256 amount, address to) external returns (uint256) {
        _burn(msg.sender, amount);
        usdc.transfer(to, amount);
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

    function test_asset_is_usdc() public view {
        assertEq(adapter.asset(), address(usdc));
    }

    function test_deposit_supplies_to_aave_and_mints_shares() public {
        vm.prank(user);
        uint256 shares = adapter.deposit(100e6, user);
        assertGt(shares, 0);
        assertEq(usdc.balanceOf(address(adapter)), 0);           // nothing idle in the adapter
        assertEq(pool.balanceOf(address(adapter)), 100e6);        // aTokens held by adapter
        assertEq(adapter.totalAssets(), 100e6);
    }

    function test_yield_grows_share_price_and_redeem_returns_more() public {
        vm.prank(user);
        uint256 shares = adapter.deposit(100e6, user);
        pool.simulateYield(address(adapter), 10e6);               // +10% yield
        vm.prank(user);
        uint256 assets = adapter.redeem(shares, user, user);
        assertGe(assets, 109_999_999);                            // ~110e6 minus 4626 rounding
    }

    function test_withdraw_pulls_from_aave() public {
        vm.prank(user);
        adapter.deposit(100e6, user);
        vm.prank(user);
        adapter.withdraw(40e6, user, user);
        assertEq(usdc.balanceOf(user), 940e6);
        assertEq(adapter.totalAssets(), 60e6);
    }
}
