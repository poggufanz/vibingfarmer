// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @notice Hardened YieldRouter's permanent exit registry, read side only.
interface IYieldRouter {
    function knownPool(address pool) external view returns (bool);
}
