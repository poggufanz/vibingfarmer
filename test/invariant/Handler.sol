// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AgentRegistry} from "../../contracts/AgentRegistry.sol";
import {AgentVaultDepositor} from "../../contracts/AgentVaultDepositor.sol";

contract Handler is Test {
    AgentRegistry public reg;
    AgentVaultDepositor public dep;
    IERC20 public token;
    address public owner;
    address public worker;
    uint256 public workerPk;
    uint256 public nonce;

    // --- ghost accounting (the two headline invariants ride on these) ---
    uint256 public startTs; // for the period count in outflow bound
    uint256 public totalPulled; // sum of all successfully deposited amounts
    bool public revoked; // flipped permanently by revoke()
    uint256 public depositsAfterRevoke; // MUST stay 0

    constructor(AgentRegistry r, AgentVaultDepositor d, IERC20 t, address o, address w, uint256 wPk) {
        reg = r;
        dep = d;
        token = t;
        owner = o;
        worker = w;
        workerPk = wPk;
        startTs = block.timestamp;
    }

    function _sign(uint256 amount, uint256 minAmount, bytes32 execId) internal view returns (bytes memory) {
        bytes32 digest = dep.hashDeposit(amount, minAmount, 0, execId);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(workerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function deposit(uint96 amount, uint32 warp) external {
        amount = uint96(bound(amount, 0, 200e6)); // 200e6 > 100e6 cap ON PURPOSE: fuzzer must TRY to breach
        vm.warp(block.timestamp + bound(warp, 0, 3 days));
        if (amount == 0) return;
        // execId includes `worker` so the id stays unique if Handler grows multi-agent later
        bytes32 execId = keccak256(abi.encode(worker, nonce++));
        bytes memory sig = _sign(amount, 0, execId);
        try dep.executeAgentDeposit(amount, 0, 0, execId, sig) returns (uint256) {
            totalPulled += amount; // only counts on SUCCESS
            if (revoked) depositsAfterRevoke++; // any success here is a breach
        } catch {}
    }

    function revoke() external {
        vm.prank(owner);
        reg.revokeAgent(worker);
        revoked = true;
    }
}
