// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract MockMalformedReturnERC4626 is ERC20 {
    using SafeERC20 for IERC20;

    IERC20 public immutable underlying;
    uint256 public returnSize;

    constructor(IERC20 underlying_) ERC20("Malformed Vault", "mVLT") {
        underlying = underlying_;
    }

    function asset() external view returns (address) {
        return address(underlying);
    }

    function setReturnSize(uint256 size) external {
        returnSize = size;
    }

    function seedShares(address receiver, uint256 shares) external {
        _mint(receiver, shares);
    }

    function redeem(uint256 shares, address receiver, address owner) external returns (uint256) {
        if (msg.sender != owner) _spendAllowance(owner, msg.sender, shares);
        _burn(owner, shares);
        underlying.safeTransfer(receiver, shares);
        uint256 size = returnSize;
        assembly ("memory-safe") {
            mstore(0, shares)
            return(0, size)
        }
    }
}
