// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script, console} from "forge-std/Script.sol";
import {BaseExitSweeper} from "../src/BaseExitSweeper.sol";

/// Run:
///   forge script script/DeploySweeper.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL \
///     --broadcast --private-key $BASE_DEPLOYER_PRIVKEY
///
/// The sweeper has no constructor owner and no admin surface, so there is
/// nothing to configure after deployment. Record the address in
/// deployments/base-sepolia.json and frontend/src/base/config.js.
contract DeploySweeper is Script {
    address constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address constant YIELD_ROUTER = 0xF80aa8F571E6d24Ea72F051Fc6F9A9C516727B6d;
    address constant TOKEN_MESSENGER_V2 = 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA;

    function run() external returns (BaseExitSweeper sweeper) {
        vm.startBroadcast();
        sweeper = new BaseExitSweeper(BASE_SEPOLIA_USDC, YIELD_ROUTER, TOKEN_MESSENGER_V2);
        vm.stopBroadcast();

        console.log("BaseExitSweeper deployed at:", address(sweeper));
        console.log("usdc:", BASE_SEPOLIA_USDC);
        console.log("router:", YIELD_ROUTER);
        console.log("tokenMessenger:", TOKEN_MESSENGER_V2);
    }
}
