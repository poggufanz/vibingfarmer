// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @notice YieldRouter's pool registry, read side only.
/// @dev `knownPool` is permanent: YieldRouter.setPool only ever sets it true,
/// deliberately, so disabling deposits cannot block exits. It is therefore an
/// allowlist that cannot be revoked, which is why BaseExitSweeper re-validates
/// each pool on every call instead of trusting membership alone.
interface IYieldRouter {
    function knownPool(address pool) external view returns (bool);
}
