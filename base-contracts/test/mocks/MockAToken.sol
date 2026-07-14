// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockAToken is ERC20 {
    IERC20 public immutable underlying;

    constructor(IERC20 underlying_) ERC20("Mock Aave Token", "maToken") {
        underlying = underlying_;
    }

    function UNDERLYING_ASSET_ADDRESS() external view returns (address) {
        return address(underlying);
    }

    function mint(address receiver, uint256 amount) external {
        _mint(receiver, amount);
    }

    function burn(address owner, uint256 amount) external {
        _burn(owner, amount);
    }
}
