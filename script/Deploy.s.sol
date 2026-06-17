// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {AgentRegistry} from "../contracts/AgentRegistry.sol";
import {AgentVaultDepositor} from "../contracts/AgentVaultDepositor.sol";
import {MockVault} from "../contracts/MockVault.sol";

contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        // USDC Base Sepolia: [VERIFY] from Circle developer docs before mainnet.
        // For the live demo we deploy a MockVault over the configured asset.
        address usdc = vm.envAddress("USDC_BASE_SEPOLIA");
        address guardian = vm.addr(pk); // testnet: deployer EOA. Production: multisig.

        vm.startBroadcast(pk);
        AgentRegistry reg = new AgentRegistry();
        AgentVaultDepositor dep = new AgentVaultDepositor(address(reg), guardian);
        reg.setDepositor(address(dep));
        MockVault vault = new MockVault("Vibing USDC Vault", usdc, 500);
        vm.stopBroadcast();

        string memory json = "deploy";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "agentRegistry", address(reg));
        vm.serializeAddress(json, "agentVaultDepositor", address(dep));
        vm.serializeAddress(json, "mockVault", address(vault));
        string memory out = vm.serializeAddress(json, "usdc", usdc);
        vm.writeJson(out, "deployments/base-sepolia.json");

        console2.log("AgentRegistry", address(reg));
        console2.log("AgentVaultDepositor", address(dep));
        console2.log("MockVault", address(vault));
    }
}
