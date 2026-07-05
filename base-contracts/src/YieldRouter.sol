// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC4626} from "./interfaces/IERC4626.sol";

/// @title YieldRouter
/// @notice Deposits USDC into whitelisted ERC-4626 pools and unwinds back to
/// the caller. Holds no funds beyond the lifetime of a single transaction —
/// shares are minted straight to the caller on deposit, and assets are
/// redeemed straight to the caller on withdraw. This is the ONLY contract an
/// ERC-7579 session policy whitelists (see
/// docs/superpowers/specs/2026-07-04-approach-c-hybrid-cross-chain-design.md
/// §4): a compromised session key can call deposit/withdraw against a
/// whitelisted pool and nothing else, and never receives funds itself.
contract YieldRouter is Ownable {
    using SafeERC20 for IERC20;

    mapping(address => bool) public allowedPool;

    event Deposited(address indexed caller, address indexed pool, uint256 assets, uint256 shares);
    event Withdrawn(address indexed caller, address indexed pool, uint256 shares, uint256 assets);
    event PoolAllowedSet(address indexed pool, bool allowed);

    constructor(address initialOwner) Ownable(initialOwner) {}

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

    /// @notice Redeem `shares` of `pool` on behalf of `msg.sender`, sending
    /// the underlying asset straight to `msg.sender`. Requires `msg.sender`
    /// to have approved this router for `shares` on `pool` beforehand
    /// (standard ERC-4626/ERC-20 allowance). `pool` must be whitelisted;
    /// `minAssets` is the slippage floor.
    function withdraw(address pool, uint256 shares, uint256 minAssets) external returns (uint256 assets) {
        require(allowedPool[pool], "YieldRouter: pool not allowed");

        assets = IERC4626(pool).redeem(shares, msg.sender, msg.sender);
        require(assets >= minAssets, "YieldRouter: slippage, assets < minAssets");

        emit Withdrawn(msg.sender, pool, shares, assets);
    }

    /// @notice Add or remove `pool` from the deposit/withdraw whitelist.
    /// Owner-only — this is the entire admin surface of the router, and the
    /// only way a new pool ever becomes reachable by a session key.
    function setPool(address pool, bool allowed) external onlyOwner {
        allowedPool[pool] = allowed;
        emit PoolAllowedSet(pool, allowed);
    }
}
