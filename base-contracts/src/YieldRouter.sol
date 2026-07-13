// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC4626} from "./interfaces/IERC4626.sol";

/// @title YieldRouter
/// @notice Deposits USDC into whitelisted ERC-4626 pools and unwinds back to
/// the caller. Holds no funds beyond the lifetime of a single transaction —
/// shares are minted straight to the caller on deposit, and assets are
/// redeemed and forwarded to the caller on withdraw. This is the ONLY
/// contract an ERC-7579 session policy whitelists (see
/// docs/superpowers/specs/2026-07-04-approach-c-hybrid-cross-chain-design.md
/// §4): a compromised session key can call deposit/withdraw against a
/// whitelisted pool and nothing else, and never receives funds itself.
contract YieldRouter is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable canonicalAsset;

    mapping(address => bool) public allowedPool;
    mapping(address => bool) public knownPool;

    event Deposited(address indexed caller, address indexed pool, uint256 assets, uint256 shares);
    event Withdrawn(address indexed caller, address indexed pool, uint256 shares, uint256 assets);
    event PoolAllowedSet(address indexed pool, bool allowed);

    constructor(address initialOwner, address canonicalAsset_) Ownable(initialOwner) {
        require(canonicalAsset_ != address(0), "YieldRouter: asset is zero");
        canonicalAsset = canonicalAsset_;
    }

    /// @notice Deposit `amount` of `pool`'s underlying asset, minting shares
    /// directly to `msg.sender`. `pool` must be whitelisted; `minShares` is
    /// the slippage floor. No fee is charged on deposit.
    function deposit(address pool, uint256 amount, uint256 minShares) external nonReentrant returns (uint256 shares) {
        require(allowedPool[pool], "YieldRouter: pool not allowed");
        require(amount > 0, "YieldRouter: amount is zero");
        _validatePool(pool);

        IERC20 asset = IERC20(canonicalAsset);
        uint256 assetBalanceBefore = asset.balanceOf(address(this));
        uint256 shareBalanceBefore = IERC4626(pool).balanceOf(msg.sender);
        asset.safeTransferFrom(msg.sender, address(this), amount);
        require(asset.balanceOf(address(this)) == assetBalanceBefore + amount, "YieldRouter: asset transfer mismatch");
        asset.forceApprove(pool, amount);

        shares = IERC4626(pool).deposit(amount, msg.sender);
        asset.forceApprove(pool, 0);
        require(asset.balanceOf(address(this)) == assetBalanceBefore, "YieldRouter: pool did not consume assets");
        uint256 shareBalanceAfter = IERC4626(pool).balanceOf(msg.sender);
        require(
            shareBalanceAfter >= shareBalanceBefore && shareBalanceAfter - shareBalanceBefore == shares,
            "YieldRouter: share receipt mismatch"
        );
        require(shares >= minShares, "YieldRouter: slippage, shares < minShares");

        emit Deposited(msg.sender, pool, amount, shares);
    }

    /// @notice Redeem `shares` of `pool` on behalf of `msg.sender`. Assets are
    /// redeemed to this router and forwarded in full to `msg.sender` in the
    /// same transaction. Requires `msg.sender` to have approved this router
    /// for `shares` on `pool` beforehand (standard ERC-4626/ERC-20 allowance).
    /// Pools remain available for exits after deposits are disabled.
    function withdraw(address pool, uint256 shares, uint256 minAssets) external nonReentrant returns (uint256 assets) {
        require(knownPool[pool], "YieldRouter: pool not known");
        require(shares > 0, "YieldRouter: shares are zero");
        _validatePool(pool);

        IERC20 asset = IERC20(canonicalAsset);
        uint256 assetBalanceBefore = asset.balanceOf(address(this));
        uint256 shareBalanceBefore = IERC4626(pool).balanceOf(msg.sender);
        assets = IERC4626(pool).redeem(shares, address(this), msg.sender);
        require(asset.balanceOf(address(this)) == assetBalanceBefore + assets, "YieldRouter: asset receipt mismatch");
        uint256 shareBalanceAfter = IERC4626(pool).balanceOf(msg.sender);
        require(
            shareBalanceBefore >= shareBalanceAfter && shareBalanceBefore - shareBalanceAfter == shares,
            "YieldRouter: share consumption mismatch"
        );

        require(assets >= minAssets, "YieldRouter: slippage, assets < minAssets");
        asset.safeTransfer(msg.sender, assets);
        require(asset.balanceOf(address(this)) == assetBalanceBefore, "YieldRouter: asset forwarding mismatch");

        emit Withdrawn(msg.sender, pool, shares, assets);
    }

    /// @notice Enable or disable new deposits into `pool`.
    /// Owner-only — this is the entire admin surface of the router, and the
    /// only way a new pool ever becomes reachable by a session key. Once
    /// enabled, a pool remains known so disabling deposits cannot block exits.
    function setPool(address pool, bool allowed) external onlyOwner {
        if (allowed) {
            _validatePool(pool);
            knownPool[pool] = true;
        }
        allowedPool[pool] = allowed;
        emit PoolAllowedSet(pool, allowed);
    }

    function _validatePool(address pool) private view {
        require(pool.code.length > 0, "YieldRouter: pool has no code");
        require(IERC4626(pool).asset() == canonicalAsset, "YieldRouter: wrong pool asset");
    }
}
