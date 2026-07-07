// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

/// @notice Honest 1:1 ERC-4626 mock vault (no adversarial behavior) — proves
/// YieldRouter's happy path. See MockAdversarialERC4626.sol (Task 1.5) for
/// the slippage-floor negative test.
contract MockERC4626 is ERC4626 {
    constructor(IERC20 asset_) ERC20("Mock Vault", "mVLT") ERC4626(asset_) {}
}
