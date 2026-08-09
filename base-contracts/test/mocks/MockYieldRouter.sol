// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

contract MockYieldRouter {
    mapping(address => bool) public allowedPool;
    mapping(address => bool) public knownPool;

    function setAllowed(address pool, bool allowed) external {
        allowedPool[pool] = allowed;
        if (allowed) knownPool[pool] = true;
    }
}
