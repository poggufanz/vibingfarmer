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
/// redeemed and forwarded to the caller on withdraw. This is the ONLY
/// contract an ERC-7579 session policy whitelists (see
/// docs/superpowers/specs/2026-07-04-approach-c-hybrid-cross-chain-design.md
/// §4): a compromised session key can call deposit/withdraw against a
/// whitelisted pool and nothing else, and never receives funds itself.
///
/// Amendment A1 (2026-07-05): an additive, default-inert performance-fee
/// switch. `feeBps` ships at 0 (exact passthrough). When the owner turns it
/// on, a fee is skimmed ONLY from the yield portion of a withdrawal (assets
/// above the caller's tracked principal), never from principal, and forwarded
/// to `feeRecipient` in the same transaction — zero-custody is preserved. The
/// canonical deposit/withdraw/setPool interface is unchanged.
contract YieldRouter is Ownable {
    using SafeERC20 for IERC20;

    /// @notice Hard ceiling on the performance fee — 20% (matches the highest
    /// market rate, Yearn v3's cap). setFee can never exceed this.
    uint16 public constant FEE_MAX_BPS = 2000;

    mapping(address => bool) public allowedPool;

    /// @notice Performance fee in basis points, charged on yield only. 0 = off.
    uint16 public feeBps;
    /// @notice Where performance fees are sent. Must be non-zero whenever feeBps > 0.
    address public feeRecipient;

    /// @notice Cumulative deposited baseline per caller per pool. Fees are only
    /// taken on withdrawn assets above this baseline. Tracks router flows only
    /// (a v1 limitation: shares moved into a pool position outside the router
    /// are invisible here).
    mapping(address caller => mapping(address pool => uint256)) public principalOf;

    event Deposited(address indexed caller, address indexed pool, uint256 assets, uint256 shares);
    event Withdrawn(address indexed caller, address indexed pool, uint256 shares, uint256 assets);
    event PoolAllowedSet(address indexed pool, bool allowed);
    event FeeSet(uint16 feeBps, address recipient);
    event FeeTaken(address indexed caller, address indexed pool, uint256 feeAssets);

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Deposit `amount` of `pool`'s underlying asset, minting shares
    /// directly to `msg.sender`. `pool` must be whitelisted; `minShares` is
    /// the slippage floor. No fee is charged on deposit.
    function deposit(address pool, uint256 amount, uint256 minShares) external returns (uint256 shares) {
        require(allowedPool[pool], "YieldRouter: pool not allowed");

        IERC20 asset = IERC20(IERC4626(pool).asset());
        asset.safeTransferFrom(msg.sender, address(this), amount);
        asset.forceApprove(pool, amount);

        shares = IERC4626(pool).deposit(amount, msg.sender);
        require(shares >= minShares, "YieldRouter: slippage, shares < minShares");

        principalOf[msg.sender][pool] += amount;

        emit Deposited(msg.sender, pool, amount, shares);
    }

    /// @notice Redeem `shares` of `pool` on behalf of `msg.sender`. Assets are
    /// redeemed to this router, an optional yield-only performance fee is
    /// skimmed (see Amendment A1), and the remainder is forwarded straight to
    /// `msg.sender` in the same transaction. Requires `msg.sender` to have
    /// approved this router for `shares` on `pool` beforehand (standard
    /// ERC-4626/ERC-20 allowance). `pool` must be whitelisted; `minAssets` is
    /// the slippage floor on what the caller RECEIVES (post-fee), so the
    /// guarantee stays honest.
    function withdraw(address pool, uint256 shares, uint256 minAssets) external returns (uint256 assets) {
        require(allowedPool[pool], "YieldRouter: pool not allowed");

        IERC20 asset = IERC20(IERC4626(pool).asset());
        assets = IERC4626(pool).redeem(shares, address(this), msg.sender);

        uint256 remaining = principalOf[msg.sender][pool];
        uint256 yieldPortion = assets > remaining ? assets - remaining : 0;
        // Principal consumed by this withdrawal = assets - yieldPortion, which
        // is <= remaining by construction, so this never underflows.
        principalOf[msg.sender][pool] = remaining - (assets - yieldPortion);

        uint256 fee = (yieldPortion * feeBps) / 10_000;
        if (fee > 0) {
            asset.safeTransfer(feeRecipient, fee);
            emit FeeTaken(msg.sender, pool, fee);
        }

        uint256 toCaller = assets - fee;
        asset.safeTransfer(msg.sender, toCaller);
        require(toCaller >= minAssets, "YieldRouter: slippage, assets < minAssets");

        emit Withdrawn(msg.sender, pool, shares, assets);
    }

    /// @notice Add or remove `pool` from the deposit/withdraw whitelist.
    /// Owner-only — this is the entire admin surface of the router, and the
    /// only way a new pool ever becomes reachable by a session key.
    function setPool(address pool, bool allowed) external onlyOwner {
        allowedPool[pool] = allowed;
        emit PoolAllowedSet(pool, allowed);
    }

    /// @notice Set the performance fee (bps, on yield only) and its recipient.
    /// Reverts above FEE_MAX_BPS, or if a non-zero fee has no recipient.
    function setFee(uint16 newFeeBps, address newRecipient) external onlyOwner {
        require(newFeeBps <= FEE_MAX_BPS, "YieldRouter: fee exceeds FEE_MAX_BPS");
        require(newFeeBps == 0 || newRecipient != address(0), "YieldRouter: fee needs a recipient");
        feeBps = newFeeBps;
        feeRecipient = newRecipient;
        emit FeeSet(newFeeBps, newRecipient);
    }
}
