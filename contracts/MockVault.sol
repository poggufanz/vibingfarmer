// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Real ERC-4626 mock vault for tests + Base Sepolia demo. Pulls assets on
///         deposit (transferFrom). Virtual shares (OZ default) blunt inflation attacks.
contract MockVault is ERC4626 {
    uint256 public immutable apyBps;

    constructor(string memory name_, address asset_, uint256 apyBps_)
        ERC20(name_, "vUSDC")
        ERC4626(IERC20(asset_))
    {
        apyBps = apyBps_;
    }
}
