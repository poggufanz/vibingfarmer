// base-contracts/test/AaveV3Adapter.fork.t.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AaveV3Adapter4626} from "../src/AaveV3Adapter4626.sol";

/// @notice Fork test proving AaveV3Adapter4626 round-trips against REAL Aave v3.
///
/// Forks Base MAINNET (not Sepolia): the adapter's whole point is supplying
/// CCTP/Circle USDC to a real lending market, and Aave's Base SEPOLIA market lists
/// a faucet token instead of Circle USDC (see relayer/scripts/check-aave-usdc.mjs —
/// SP0 gate, 2026-07-09). On Base mainnet, Aave lists native Circle USDC, so a
/// mainnet fork is where "real Aave supply" is honestly provable. These are the
/// exact addresses the adapter is deployed against at the mainnet flip.
///
/// Mirrors YieldRouter.fork.t.sol's convention: defaults to a public RPC and always
/// runs; if the RPC is unreachable, forge reports a setup (fork-creation) failure,
/// not a test failure.
contract AaveV3AdapterForkTest is Test {
    // Aave v3 Base MAINNET (bgd-labs/aave-address-book · AaveV3Base.sol) — EIP-55 checksummed.
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; // native Circle USDC, 6dp
    address constant AAVE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant A_USDC = 0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB;

    AaveV3Adapter4626 adapter;
    address user = address(0xBEEF);

    function setUp() public {
        string memory rpc = vm.envOr("BASE_MAINNET_RPC_URL", string("https://mainnet.base.org"));
        vm.createSelectFork(rpc);
        adapter = new AaveV3Adapter4626(IERC20(USDC), AAVE_POOL, A_USDC, "VF Aave USDC", "vfaUSDC");
        deal(USDC, user, 100e6); // forge-std deal handles USDC's proxy storage on fork
        vm.prank(user);
        IERC20(USDC).approve(address(adapter), type(uint256).max);
    }

    function test_fork_deposit_and_withdraw_roundtrip() public {
        vm.startPrank(user);
        uint256 shares = adapter.deposit(50e6, user);
        assertGt(shares, 0, "shares minted");
        // Deposit really landed in Aave: the adapter now holds aUSDC, not idle USDC.
        assertEq(IERC20(USDC).balanceOf(address(adapter)), 0, "no idle USDC in adapter");
        assertGt(IERC20(A_USDC).balanceOf(address(adapter)), 0, "adapter holds aUSDC (real Aave supply)");
        assertGe(adapter.totalAssets(), 50e6 - 1, "totalAssets ~= supplied (aToken may round 1 wei)");

        uint256 assets = adapter.redeem(shares, user, user);
        assertGe(assets, 50e6 - 2, "round-trip within rounding tolerance");
        vm.stopPrank();

        console2.log("fork round-trip: supplied 50e6 USDC, redeemed", assets);
    }
}
