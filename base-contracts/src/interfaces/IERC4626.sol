// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @notice Minimal ERC-4626 interface — only the functions YieldRouter calls.
/// Full spec: https://eips.ethereum.org/EIPS/eip-4626
interface IERC4626 {
    function asset() external view returns (address assetTokenAddress);
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
    function balanceOf(address account) external view returns (uint256);
}
