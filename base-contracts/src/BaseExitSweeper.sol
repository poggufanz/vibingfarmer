// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC4626} from "./interfaces/IERC4626.sol";
import {IYieldRouter} from "./interfaces/IYieldRouter.sol";
import {ITokenMessengerV2} from "./interfaces/ITokenMessengerV2.sol";
import {HookDataLib} from "./HookDataLib.sol";

/// @title BaseExitSweeper
/// @notice One call exits every Base position the caller holds, sweeps their
/// idle USDC, and burns the exact total home to Stellar via CCTP v2. Amounts
/// are read at execution time because a userOp's calldata is fixed when the
/// passkey signs it, and CCTP provides no max sentinel.
///
/// Mirrors soroban/contracts/exit_router's sweep: read balances live, try each
/// position independently, report partial success honestly.
///
/// Holds no funds beyond one transaction — the same invariant YieldRouter
/// states for itself. There is deliberately NO admin surface and NO rescue
/// function: one instance serves every user, so an owner-gated sweep would let
/// the owner take funds in flight for someone else's transaction. The
/// zero-residue check below is therefore the only safety net, by design.
contract BaseExitSweeper is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    IYieldRouter public immutable router;
    ITokenMessengerV2 public immutable tokenMessenger;

    /// @notice Gas forwarded to each pool's redeem.
    /// @dev Mandatory, not tuning. Because maxRedeem does not report Aave-side
    /// pause state (AaveV3Adapter4626 does not override it; OZ's default just
    /// returns balanceOf), every iteration may legitimately attempt a call that
    /// is expected to fail. Solidity forwards 63/64 of remaining gas by default,
    /// so a pool that burns its stipend before reverting would starve the later
    /// iterations AND the closing checks — reverting the whole atomic exit,
    /// exactly what try/catch exists to prevent. The cap also bounds
    /// returndatacopy against an oversized return blob.
    uint256 public constant REDEEM_GAS_CAP = 400_000;

    event Swept(address indexed owner, uint256 burned, uint256 exited, uint256 skipped);

    error ZeroAddress();
    error LengthMismatch();
    error NothingToExit();
    error Slippage(address pool, uint256 got, uint256 floor);
    error Residue(uint256 left);

    constructor(address usdc_, address router_, address tokenMessenger_) {
        if (usdc_ == address(0) || router_ == address(0) || tokenMessenger_ == address(0)) {
            revert ZeroAddress();
        }
        usdc = IERC20(usdc_);
        router = IYieldRouter(router_);
        tokenMessenger = ITokenMessengerV2(tokenMessenger_);
    }

    /// @notice Exit every listed pool plus idle USDC, burn the total to Stellar.
    /// @dev `owner` is always msg.sender and is never a parameter. That is the
    /// entire access-control model: the contract can structurally only move the
    /// caller's own funds. It is also what defuses cross-pool reentrancy — a
    /// malicious pool re-entering from its own redeem callback arrives with
    /// msg.sender == pool, and allowance(pool, sweeper) is zero. nonReentrant is
    /// applied anyway as cheap defence in depth.
    function exitAllAndBurn(
        address[] calldata pools,
        uint256[] calldata minAssetsPerPool,
        bytes32 mintRecipient,
        bytes32 destinationCaller,
        uint32 destinationDomain,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external nonReentrant returns (uint256 burned, uint256 exited, uint256 skipped) {
        // Not merely for the revert (bare 0.8 indexing would revert anyway) but
        // to forbid any "defensive" padding that would silently zero the floor
        // for the tail pools.
        if (pools.length != minAssetsPerPool.length) revert LengthMismatch();

        HookDataLib.validate(hookData);

        address owner = msg.sender;

        for (uint256 i = 0; i < pools.length; i++) {
            address pool = pools[i];

            if (!_eligible(pool)) {
                skipped++;
                continue;
            }

            uint256 shares = _redeemableShares(pool, owner);
            if (shares == 0) {
                skipped++;
                continue;
            }

            uint256 balBefore = usdc.balanceOf(address(this));

            // A pool that reverts (paused, illiquid, hostile) moves nothing and
            // is skipped. Its RETURN VALUE is deliberately discarded — see below.
            try IERC4626(pool).redeem{gas: REDEEM_GAS_CAP}(shares, address(this), owner) returns (
                uint256
            ) {
                // measured below, never trusted from the pool
            } catch {
                skipped++;
                continue;
            }

            // Measured delta, exactly as YieldRouter.sol:80 does. A slippage floor
            // checked against a pool's self-reported number is a floor the pool
            // chose for itself.
            uint256 got = usdc.balanceOf(address(this)) - balBefore;
            if (got < minAssetsPerPool[i]) revert Slippage(pool, got, minAssetsPerPool[i]);
            exited++;
        }

        // Best effort. Assets have not moved if this fails, so it must not abort
        // an otherwise good exit. A zero-amount transferFrom is a valid no-op.
        uint256 idle = usdc.balanceOf(owner);
        if (idle > 0) {
            try IERC20(address(usdc)).transferFrom(owner, address(this), idle) returns (bool) {}
            catch {}
        }

        burned = usdc.balanceOf(address(this));
        if (burned == 0) revert NothingToExit();

        SafeERC20.forceApprove(usdc, address(tokenMessenger), burned);
        tokenMessenger.depositForBurnWithHook(
            burned,
            destinationDomain,
            mintRecipient,
            address(usdc),
            destinationCaller,
            maxFee,
            minFinalityThreshold,
            hookData
        );
        SafeERC20.forceApprove(usdc, address(tokenMessenger), 0);

        uint256 left = usdc.balanceOf(address(this));
        if (left != 0) revert Residue(left);

        emit Swept(owner, burned, exited, skipped);
    }

    /// @dev knownPool is a permanent, unrevocable allowlist, so membership alone
    /// is not enough — YieldRouter re-runs these same checks on every call for
    /// the same reason (a pool that decayed or was reconfigured after
    /// whitelisting is still knownPool forever).
    function _eligible(address pool) private view returns (bool) {
        if (!router.knownPool(pool)) return false;
        if (pool.code.length == 0) return false;
        try IERC4626(pool).asset() returns (address a) {
            return a == address(usdc);
        } catch {
            return false;
        }
    }

    function _redeemableShares(address pool, address owner) private view returns (uint256) {
        uint256 bal = IERC4626(pool).balanceOf(owner);
        uint256 allowed = IERC20(pool).allowance(owner, address(this));
        return bal < allowed ? bal : allowed;
    }
}
