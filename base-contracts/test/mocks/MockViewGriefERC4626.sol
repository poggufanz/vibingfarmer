// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

contract MockViewGriefERC4626 {
    address public immutable underlying;
    bool public failAsset;
    bool public failBalance;
    bool public failAllowance;
    bool public burnViewGas;

    constructor(address underlying_) {
        underlying = underlying_;
    }

    function configure(bool asset_, bool balance_, bool allowance_, bool gas_) external {
        failAsset = asset_;
        failBalance = balance_;
        failAllowance = allowance_;
        burnViewGas = gas_;
    }

    function asset() external view returns (address) {
        if (failAsset) revert("asset grief");
        return underlying;
    }

    function balanceOf(address) external view returns (uint256) {
        if (failBalance) revert("balance grief");
        if (burnViewGas) while (gasleft() > 500) {}
        return 1;
    }

    function allowance(address, address) external view returns (uint256) {
        if (failAllowance) revert("allowance grief");
        return 1;
    }

    function redeem(uint256, address, address) external pure returns (uint256) {
        revert("not reached");
    }
}
