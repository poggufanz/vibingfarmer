// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @notice YieldRouter's pool registry, read side only.
/// @dev Pinned to the LIVE router (0xF80aa8F571E6d24Ea72F051Fc6F9A9C516727B6d,
/// deployed 2026-07-05), which exposes only `allowedPool` — an owner-revocable
/// deposit allowlist (selector 0xf50a9351, verified on-chain; pinned in
/// BaseExitSweeper.t.sol). The hardened YieldRouter.sol source also has a
/// second, permanent `knownPool` mapping for exit-eligibility that survives
/// deposits being disabled, but that hardened build was never deployed — do
/// not declare it here until it is. See BaseExitSweeper._eligible for the
/// ceiling this creates.
interface IYieldRouter {
    function allowedPool(address pool) external view returns (bool);
}
