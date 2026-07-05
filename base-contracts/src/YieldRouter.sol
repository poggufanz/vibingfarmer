// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC4626} from "./interfaces/IERC4626.sol";

/// @title YieldRouter
/// @notice Deposits USDC into whitelisted ERC-4626 pools, minting shares
/// straight to the caller. Holds no funds beyond a single transaction.
contract YieldRouter {
    using SafeERC20 for IERC20;

    mapping(address => bool) public allowedPool;

    event Deposited(address indexed caller, address indexed pool, uint256 assets, uint256 shares);

    // NOTE: unrestricted for now — Task 1.4 adds Ownable + onlyOwner here.
    function setPool(address pool, bool allowed) external {
        allowedPool[pool] = allowed;
    }

    /// @notice Deposit `amount` of `pool`'s underlying asset, minting shares
    /// directly to `msg.sender`. `pool` must be whitelisted; `minShares` is
    /// the slippage floor.
    function deposit(address pool, uint256 amount, uint256 minShares) external returns (uint256 shares) {
        require(allowedPool[pool], "YieldRouter: pool not allowed");

        IERC20 asset = IERC20(IERC4626(pool).asset());
        asset.safeTransferFrom(msg.sender, address(this), amount);
        asset.forceApprove(pool, amount);

        shares = IERC4626(pool).deposit(amount, msg.sender);
        require(shares >= minShares, "YieldRouter: slippage, shares < minShares");

        emit Deposited(msg.sender, pool, amount, shares);
    }
}
