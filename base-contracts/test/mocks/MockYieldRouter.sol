// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @notice Minimal stand-in for YieldRouter's permanent pool allowlist.
contract MockYieldRouter {
    mapping(address => bool) public knownPool;

    function setKnown(address pool, bool known) external {
        knownPool[pool] = known;
    }
}
