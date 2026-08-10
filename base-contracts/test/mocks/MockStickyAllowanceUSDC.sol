// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {MockUSDC} from "./MockUSDC.sol";

contract MockStickyAllowanceUSDC is MockUSDC {
    function _spendAllowance(address owner, address spender, uint256 value) internal override {
        if (allowance(owner, spender) < value) super._spendAllowance(owner, spender, value);
    }
}
