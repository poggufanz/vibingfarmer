// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MockAToken} from "./MockAToken.sol";

contract MockMaliciousAavePool {
    using SafeERC20 for IERC20;

    IERC20 public immutable underlying;
    MockAToken public immutable aToken;

    address public callbackTarget;
    bytes public callbackData;
    bool public callbackOnSupply;
    bool public callbackOnWithdraw;
    bool public callbackSucceeded;
    bool private _insideCallback;

    uint256 public withdrawTransferShortfall;
    uint256 public withdrawReturnShortfall;

    constructor(IERC20 underlying_, MockAToken aToken_) {
        underlying = underlying_;
        aToken = aToken_;
    }

    function configureCallback(address target, bytes calldata data, bool onSupply, bool onWithdraw) external {
        callbackTarget = target;
        callbackData = data;
        callbackOnSupply = onSupply;
        callbackOnWithdraw = onWithdraw;
        callbackSucceeded = false;
    }

    function configureWithdraw(uint256 transferShortfall, uint256 returnShortfall) external {
        withdrawTransferShortfall = transferShortfall;
        withdrawReturnShortfall = returnShortfall;
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        require(asset == address(underlying), "MockAavePool: wrong asset");
        underlying.safeTransferFrom(msg.sender, address(this), amount);
        aToken.mint(onBehalfOf, amount);
        if (callbackOnSupply) _callback();
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        require(asset == address(underlying), "MockAavePool: wrong asset");
        if (callbackOnWithdraw) _callback();
        aToken.burn(msg.sender, amount);
        underlying.safeTransfer(to, amount - withdrawTransferShortfall);
        return amount - withdrawReturnShortfall;
    }

    function _callback() private {
        if (_insideCallback) return;
        _insideCallback = true;
        (callbackSucceeded,) = callbackTarget.call(callbackData);
        _insideCallback = false;
    }
}
