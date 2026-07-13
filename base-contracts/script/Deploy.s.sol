// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script, console} from "forge-std/Script.sol";
import {YieldRouter} from "../src/YieldRouter.sol";
import {IERC4626} from "../src/interfaces/IERC4626.sol";

/// @notice Alternative deploy path via `forge script --broadcast`. The path
/// this plan actually exercises is scripts/deploy.mjs (Task 1.6 Steps 6–7,
/// 11), which mirrors the proven spikes/smart-sessions/deploy-router.mjs
/// pattern and also writes deployments/base-sepolia.json. Both deploy the
/// same bytecode; use whichever fits your workflow.
///
/// Run: forge script script/Deploy.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL
///        --broadcast --private-key $BASE_DEPLOYER_PRIVKEY
contract Deploy is Script {
    function run() external returns (YieldRouter router) {
        address initialOwner = msg.sender;
        address poolToWhitelist = vm.envAddress("INITIAL_POOL_ADDRESS");
        address canonicalAsset = IERC4626(poolToWhitelist).asset();

        vm.startBroadcast();
        router = new YieldRouter(initialOwner, canonicalAsset);
        router.setPool(poolToWhitelist, true);
        vm.stopBroadcast();

        console.log("YieldRouter deployed at:", address(router));
        console.log("Whitelisted pool:", poolToWhitelist);
    }
}
