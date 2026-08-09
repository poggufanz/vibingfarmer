// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC4626} from "./interfaces/IERC4626.sol";
import {IYieldRouter} from "./interfaces/IYieldRouter.sol";
import {ITokenMessengerV2} from "./interfaces/ITokenMessengerV2.sol";
import {HookDataLib} from "./HookDataLib.sol";

/// @notice Stateless, caller-isolated full-balance exit into a constructor-pinned
/// Stellar CCTP route. Kernel/EntryPoint authorization is outside this contract;
/// this contract can only use shares and USDC approved by msg.sender.
contract BaseExitSweeper is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    IYieldRouter public immutable router;
    ITokenMessengerV2 public immutable tokenMessenger;
    uint32 public immutable stellarDomain;
    bytes32 public immutable mintRecipient;
    bytes32 public immutable destinationCaller;

    uint32 public constant FINALITY_THRESHOLD = 1000;
    uint256 public constant VIEW_GAS_CAP = 50_000;
    uint256 public constant REDEEM_GAS_CAP = 1_200_000;

    event Swept(address indexed owner, uint256 burned, uint256 exited, uint256 skipped);

    error ZeroAddress();
    error NoCode(address target);
    error InvalidStellarDomain(uint32 domain);
    error Expired(uint256 deadline, uint256 timestamp);
    error LengthMismatch();
    error NothingToExit();
    error Slippage(address pool, uint256 got, uint256 floor);
    error Residue(uint256 left);
    error AllowanceResidue(uint256 left);
    error OnlySelf();
    error RedeemFailed();

    constructor(
        address usdc_,
        address router_,
        address tokenMessenger_,
        uint32 stellarDomain_,
        bytes32 mintRecipient_,
        bytes32 destinationCaller_
    ) {
        if (
            usdc_ == address(0) || router_ == address(0) || tokenMessenger_ == address(0)
                || mintRecipient_ == bytes32(0) || destinationCaller_ == bytes32(0)
        ) revert ZeroAddress();
        if (usdc_.code.length == 0) revert NoCode(usdc_);
        if (router_.code.length == 0) revert NoCode(router_);
        if (tokenMessenger_.code.length == 0) revert NoCode(tokenMessenger_);
        if (stellarDomain_ != 27) revert InvalidStellarDomain(stellarDomain_);

        usdc = IERC20(usdc_);
        router = IYieldRouter(router_);
        tokenMessenger = ITokenMessengerV2(tokenMessenger_);
        stellarDomain = stellarDomain_;
        mintRecipient = mintRecipient_;
        destinationCaller = destinationCaller_;
    }

    function exitAllAndBurn(
        address[] calldata pools,
        uint256[] calldata minAssetsPerPool,
        uint256 maxFee,
        uint256 deadline,
        bytes calldata hookData
    ) external nonReentrant returns (uint256 burned, uint256 exited, uint256 skipped) {
        // The owner-selected deadline deliberately binds execution to timestamp, not block height.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > deadline) revert Expired(deadline, block.timestamp);
        if (pools.length != minAssetsPerPool.length) revert LengthMismatch();
        HookDataLib.validate(hookData);

        address owner = msg.sender;
        for (uint256 i = 0; i < pools.length; i++) {
            address pool = pools[i];
            if (!_eligible(pool)) {
                skipped++;
                continue;
            }

            (bool readable, uint256 shares) = _redeemableShares(pool, owner);
            if (!readable || shares == 0) {
                skipped++;
                continue;
            }

            uint256 balanceBefore = usdc.balanceOf(address(this));
            if (!_tryRedeem(pool, shares, owner)) {
                skipped++;
                continue;
            }

            uint256 balanceAfter = usdc.balanceOf(address(this));
            uint256 got = balanceAfter >= balanceBefore ? balanceAfter - balanceBefore : 0;
            if (got < minAssetsPerPool[i]) revert Slippage(pool, got, minAssetsPerPool[i]);
            exited++;
        }

        uint256 idle = usdc.balanceOf(owner);
        if (idle != 0) _tryTransferFrom(owner, idle);

        burned = usdc.balanceOf(address(this));
        if (burned == 0) revert NothingToExit();

        usdc.forceApprove(address(tokenMessenger), burned);
        tokenMessenger.depositForBurnWithHook(
            burned, stellarDomain, mintRecipient, address(usdc), destinationCaller, maxFee, FINALITY_THRESHOLD, hookData
        );
        usdc.forceApprove(address(tokenMessenger), 0);

        uint256 allowanceLeft = usdc.allowance(address(this), address(tokenMessenger));
        if (allowanceLeft != 0) revert AllowanceResidue(allowanceLeft);
        uint256 left = usdc.balanceOf(address(this));
        if (left != 0) revert Residue(left);

        emit Swept(owner, burned, exited, skipped);
    }

    /// @dev A self-call gives every pool redemption its own rollback boundary. The
    /// low-level pool call deliberately copies no returndata, so a malicious pool
    /// cannot force unbounded memory expansion. A malformed successful return
    /// reverts this frame, rolling back that pool's token/share movements while
    /// allowing the outer sweep to continue.
    function isolatedRedeem(address pool, uint256 shares, address owner) external {
        if (msg.sender != address(this)) revert OnlySelf();

        bytes memory data = abi.encodeCall(IERC4626.redeem, (shares, address(this), owner));
        bool ok;
        uint256 returnSize;
        assembly ("memory-safe") {
            ok := call(gas(), pool, 0, add(data, 0x20), mload(data), 0, 0)
            returnSize := returndatasize()
        }
        if (!ok || returnSize != 32) revert RedeemFailed();
    }

    function _eligible(address pool) private view returns (bool) {
        if (pool.code.length == 0) return false;
        (bool knownOk, uint256 known) =
            _staticUint(address(router), abi.encodeWithSelector(IYieldRouter.knownPool.selector, pool));
        if (!knownOk || known != 1) return false;
        (bool assetOk, uint256 assetWord) = _staticUint(pool, abi.encodeWithSelector(IERC4626.asset.selector));
        if (!assetOk || assetWord >> 160 != 0) return false;
        // Upper bits were checked above, so narrowing the ABI address word is safe.
        // forge-lint: disable-next-line(unsafe-typecast)
        return address(uint160(assetWord)) == address(usdc);
    }

    function _redeemableShares(address pool, address owner) private view returns (bool, uint256) {
        (bool balanceOk, uint256 balance) = _staticUint(pool, abi.encodeWithSelector(IERC20.balanceOf.selector, owner));
        if (!balanceOk) return (false, 0);
        (bool allowanceOk, uint256 allowance) =
            _staticUint(pool, abi.encodeWithSelector(IERC20.allowance.selector, owner, address(this)));
        if (!allowanceOk) return (false, 0);
        return (true, balance < allowance ? balance : allowance);
    }

    function _tryRedeem(address pool, uint256 shares, address owner) private returns (bool ok) {
        bytes memory data = abi.encodeCall(this.isolatedRedeem, (pool, shares, owner));
        address self = address(this);
        uint256 gasCap = REDEEM_GAS_CAP;
        assembly ("memory-safe") {
            ok := call(gasCap, self, 0, add(data, 0x20), mload(data), 0, 0)
        }
    }

    function _staticUint(address target, bytes memory data) private view returns (bool ok, uint256 value) {
        assembly ("memory-safe") {
            ok := staticcall(VIEW_GAS_CAP, target, add(data, 0x20), mload(data), 0, 0x20)
            if and(ok, eq(returndatasize(), 0x20)) { value := mload(0) }
            if iszero(eq(returndatasize(), 0x20)) { ok := 0 }
        }
    }

    function _tryTransferFrom(address owner, uint256 amount) private {
        (bool ok, bytes memory result) =
            address(usdc).call(abi.encodeCall(IERC20.transferFrom, (owner, address(this), amount)));
        if (!ok || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool))))) return;
    }
}
