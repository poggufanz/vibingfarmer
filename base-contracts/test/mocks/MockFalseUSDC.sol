// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {MockUSDC} from "./MockUSDC.sol";

contract MockFalseUSDC is MockUSDC {
    bool public returnFalse;
    address public falseFrom;
    address public falseTo;
    bool public falsePairEnabled;

    function setReturnFalse(bool value) external {
        returnFalse = value;
    }

    function setFalseTransferFromPair(address from, address to, bool enabled) external {
        falseFrom = from;
        falseTo = to;
        falsePairEnabled = enabled;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (returnFalse || (falsePairEnabled && from == falseFrom && to == falseTo)) return false;
        return super.transferFrom(from, to, value);
    }
}
