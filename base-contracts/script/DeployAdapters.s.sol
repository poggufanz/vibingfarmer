// base-contracts/script/DeployAdapters.s.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AaveV3Adapter4626} from "../src/AaveV3Adapter4626.sol";
import {YieldRouter} from "../src/YieldRouter.sol";

/// @notice MAINNET-FLIP tool. Deploys 3 AaveV3Adapter4626 wrapping one real Aave
/// v3 USDC market, whitelists them on the existing YieldRouter, and (optionally)
/// delists prior pools. Everything is env-driven so the same script serves the
/// Base-mainnet flip (Option 1, 2026-07-09) without a code edit.
///
/// NOT run on Base Sepolia — Aave's testnet market lists faucet USDC, not Circle
/// USDC (SP0 gate). Base mainnet defaults are baked in as env fallbacks.
///
/// Owner-only ops — run with the router owner's key. The deployer is 7702-delegated
/// (1 in-flight tx cap) — forge broadcast is serial by default (`--slow`), which is
/// exactly what we need.
///
/// Run (mainnet flip):
///   forge script script/DeployAdapters.s.sol --rpc-url $BASE_MAINNET_RPC_URL \
///     --broadcast --private-key $PRIVATE_KEY --slow
/// Optional env: MOCK_POOL_1/2/3 (addresses to delist), USDC, ROUTER,
///   AAVE_POOL_ADDRESS, AAVE_ATOKEN_ADDRESS.
contract DeployAdapters is Script {
    // Base MAINNET Aave v3 defaults (bgd-labs/aave-address-book · AaveV3Base.sol).
    address constant DEFAULT_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant DEFAULT_ROUTER = 0xF80aa8F571E6d24Ea72F051Fc6F9A9C516727B6d;
    address constant DEFAULT_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant DEFAULT_ATOKEN = 0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB;

    function run() external {
        address usdc = vm.envOr("USDC", DEFAULT_USDC);
        address router_ = vm.envOr("ROUTER", DEFAULT_ROUTER);
        address aavePool = vm.envOr("AAVE_POOL_ADDRESS", DEFAULT_POOL);
        address aToken = vm.envOr("AAVE_ATOKEN_ADDRESS", DEFAULT_ATOKEN);
        address mock1 = vm.envOr("MOCK_POOL_1", address(0));
        address mock2 = vm.envOr("MOCK_POOL_2", address(0));
        address mock3 = vm.envOr("MOCK_POOL_3", address(0));

        vm.startBroadcast();
        AaveV3Adapter4626 a1 = new AaveV3Adapter4626(IERC20(usdc), aavePool, aToken, "VF Aave USDC 1", "vfaUSDC1");
        AaveV3Adapter4626 a2 = new AaveV3Adapter4626(IERC20(usdc), aavePool, aToken, "VF Aave USDC 2", "vfaUSDC2");
        AaveV3Adapter4626 a3 = new AaveV3Adapter4626(IERC20(usdc), aavePool, aToken, "VF Aave USDC 3", "vfaUSDC3");
        YieldRouter router = YieldRouter(router_);
        router.setPool(address(a1), true);
        router.setPool(address(a2), true);
        router.setPool(address(a3), true);
        if (mock1 != address(0)) router.setPool(mock1, false);
        if (mock2 != address(0)) router.setPool(mock2, false);
        if (mock3 != address(0)) router.setPool(mock3, false);
        vm.stopBroadcast();

        console.log("adapter1:", address(a1));
        console.log("adapter2:", address(a2));
        console.log("adapter3:", address(a3));
    }
}
