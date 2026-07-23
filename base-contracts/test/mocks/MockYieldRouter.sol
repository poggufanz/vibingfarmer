// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @notice Minimal stand-in for the LIVE router's owner-revocable pool allowlist
/// (allowedPool). See IYieldRouter.sol for why this is allowedPool, not the
/// hardened source's permanent knownPool.
contract MockYieldRouter {
    mapping(address => bool) public allowedPool;

    function setAllowed(address pool, bool allowed) external {
        allowedPool[pool] = allowed;
    }
}
