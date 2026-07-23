// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A pool that LIES UPWARD: it transfers `payout` but returns `reported`,
/// which may be larger. MockReentrantERC4626 cannot do this — its shortfalls only
/// subtract — so this mock is what proves BaseExitSweeper checks the measured
/// balance delta rather than the pool's own number.
///
/// It can also burn arbitrary gas inside redeem, to prove REDEEM_GAS_CAP keeps a
/// griefing pool from starving the pools that come after it.
contract MockOverReportingERC4626 is ERC20 {
    IERC20 public immutable underlying;
    uint256 public payout;
    uint256 public reported;
    uint256 public gasBurn;

    constructor(IERC20 underlying_) ERC20("Over Reporting Vault", "oVLT") {
        underlying = underlying_;
    }

    function asset() external view returns (address) {
        return address(underlying);
    }

    function seedShares(address receiver, uint256 shares) external {
        _mint(receiver, shares);
    }

    function setPayout(uint256 v) external {
        payout = v;
    }

    function setReported(uint256 v) external {
        reported = v;
    }

    function setGasBurn(uint256 v) external {
        gasBurn = v;
    }

    function deposit(uint256, address) external pure returns (uint256) {
        revert("deposit not supported");
    }

    function redeem(uint256 shares, address receiver, address owner) external returns (uint256) {
        if (msg.sender != owner) _spendAllowance(owner, msg.sender, shares);

        // Griefing mode: consume gas until the capped frame dies.
        uint256 target = gasBurn;
        if (target > 0) {
            uint256 spent = 0;
            uint256 sink = 0;
            while (spent < target) {
                sink = uint256(keccak256(abi.encode(sink)));
                spent += 200;
            }
        }

        _burn(owner, shares);
        underlying.transfer(receiver, payout);
        return reported; // deliberately NOT `payout`
    }
}
