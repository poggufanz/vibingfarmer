// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script} from "forge-std/Script.sol";
import {BaseExitSweeper} from "../src/BaseExitSweeper.sol";

/// @notice Legacy Forge broadcast entry point, retained only so old commands
/// fail closed. Hardened deployment is staged through the import-safe injected
/// client module in scripts/deploy-hardened.mjs; it never writes the canonical
/// deployment record or performs Safe acceptance.
contract DeploySweeper is Script {
    error DirectBroadcastDisabled();

    function run() external pure returns (BaseExitSweeper) {
        revert DirectBroadcastDisabled();
    }
}
