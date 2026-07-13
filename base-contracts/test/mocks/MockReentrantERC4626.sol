// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract MockReentrantERC4626 is ERC20 {
    using SafeERC20 for IERC20;

    IERC20 public immutable underlying;
    address public reportedAsset;

    address public callbackTarget;
    bytes public callbackData;
    bool public callbackOnDeposit;
    bool public callbackOnRedeem;
    bool public callbackSucceeded;
    bool private _insideCallback;

    uint256 public depositPullShortfall;
    uint256 public depositMintShortfall;
    uint256 public depositReturnBonus;
    uint256 public redeemTransferShortfall;
    uint256 public redeemReturnShortfall;
    uint256 public redeemBurnShortfall;

    constructor(IERC20 underlying_) ERC20("Adversarial Vault", "aVLT") {
        underlying = underlying_;
        reportedAsset = address(underlying_);
    }

    function asset() external view returns (address) {
        return reportedAsset;
    }

    function setReportedAsset(address asset_) external {
        reportedAsset = asset_;
    }

    function configureCallback(address target, bytes calldata data, bool onDeposit, bool onRedeem) external {
        callbackTarget = target;
        callbackData = data;
        callbackOnDeposit = onDeposit;
        callbackOnRedeem = onRedeem;
        callbackSucceeded = false;
    }

    function configureDeposit(uint256 pullShortfall, uint256 returnBonus) external {
        depositPullShortfall = pullShortfall;
        depositReturnBonus = returnBonus;
    }

    function configureDepositMintShortfall(uint256 mintShortfall) external {
        depositMintShortfall = mintShortfall;
    }

    function configureRedeem(uint256 transferShortfall, uint256 returnShortfall) external {
        redeemTransferShortfall = transferShortfall;
        redeemReturnShortfall = returnShortfall;
    }

    function configureRedeemBurn(uint256 burnShortfall) external {
        redeemBurnShortfall = burnShortfall;
    }

    function approveAsset(address spender, uint256 amount) external {
        underlying.forceApprove(spender, amount);
    }

    function seedShares(address receiver, uint256 shares) external {
        _mint(receiver, shares);
    }

    function approveSelfShares(address spender, uint256 shares) external {
        _approve(address(this), spender, shares);
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        uint256 pulled = assets - depositPullShortfall;
        underlying.safeTransferFrom(msg.sender, address(this), pulled);
        _mint(receiver, assets - depositMintShortfall);
        if (callbackOnDeposit) _callback();
        return assets - depositMintShortfall + depositReturnBonus;
    }

    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets) {
        if (msg.sender != owner) _spendAllowance(owner, msg.sender, shares);
        _burn(owner, shares - redeemBurnShortfall);

        uint256 transferred = shares - redeemTransferShortfall;
        underlying.safeTransfer(receiver, transferred);
        if (callbackOnRedeem) _callback();
        return transferred - redeemReturnShortfall;
    }

    function _callback() private {
        if (_insideCallback) return;
        _insideCallback = true;
        (callbackSucceeded,) = callbackTarget.call(callbackData);
        _insideCallback = false;
    }
}
