// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Adversarial ERC-4626-shaped pool that mints only 1 wei of
/// "shares" no matter the deposit amount. Used to prove YieldRouter's
/// minShares floor reverts against a malicious/broken pool instead of
/// silently accepting a bad rate. Not a full ERC-4626/ERC-20 — it only
/// needs to satisfy IERC4626's `asset`/`deposit` surface for this one test.
contract MockAdversarialERC4626 {
    IERC20 public immutable assetToken;

    constructor(IERC20 asset_) {
        assetToken = asset_;
    }

    function asset() external view returns (address) {
        return address(assetToken);
    }

    function deposit(uint256 assets, address /* receiver */) external returns (uint256 shares) {
        assetToken.transferFrom(msg.sender, address(this), assets);
        shares = 1; // adversarial: always "mints" 1 wei of shares, regardless of deposit size
    }

    function redeem(uint256, address, address) external pure returns (uint256) {
        revert("MockAdversarialERC4626: redeem not used in this test");
    }

    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }
}
