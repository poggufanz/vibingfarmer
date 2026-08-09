// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Records burn arguments and PULLS the tokens, like the real
/// TokenMessengerV2. The pull is essential: BaseExitSweeper's zero-residue
/// invariant only holds because the messenger takes the balance away.
contract MockTokenMessengerV2 {
    using SafeERC20 for IERC20;
    uint256 public lastAmount;
    uint32 public lastDestinationDomain;
    bytes32 public lastMintRecipient;
    address public lastBurnToken;
    bytes32 public lastDestinationCaller;
    uint256 public lastMaxFee;
    uint32 public lastMinFinalityThreshold;
    bytes public lastHookData;
    uint256 public burnCount;
    bool public shouldRevert;
    uint256 public pullShortfall;
    address public callbackTarget;
    bytes public callbackData;
    bool public callbackAttempted;
    bool public callbackSucceeded;
    bytes public callbackResult;

    event BurnObserved(uint256 amount);

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    function setPullShortfall(uint256 value) external {
        pullShortfall = value;
    }

    function setCallback(address target, bytes calldata data) external {
        callbackTarget = target;
        callbackData = data;
        callbackAttempted = false;
        callbackSucceeded = false;
        delete callbackResult;
    }

    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external {
        require(!shouldRevert, "messenger revert");
        if (callbackTarget != address(0)) {
            callbackAttempted = true;
            (callbackSucceeded, callbackResult) = callbackTarget.call(callbackData);
        }
        IERC20(burnToken).safeTransferFrom(msg.sender, address(this), amount - pullShortfall);
        emit BurnObserved(amount);
        lastAmount = amount;
        lastDestinationDomain = destinationDomain;
        lastMintRecipient = mintRecipient;
        lastBurnToken = burnToken;
        lastDestinationCaller = destinationCaller;
        lastMaxFee = maxFee;
        lastMinFinalityThreshold = minFinalityThreshold;
        lastHookData = hookData;
        burnCount++;
    }
}
