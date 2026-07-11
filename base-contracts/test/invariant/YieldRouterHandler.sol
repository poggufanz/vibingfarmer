// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {YieldRouter} from "../../src/YieldRouter.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MockERC4626} from "../mocks/MockERC4626.sol";

/// @notice Bounded entry points for the YieldRouter invariant fuzzer. Every
/// call goes through the same whitelisted pool with one of three fixed
/// actors, mixing deposits and withdraws in random order and amounts. Guards
/// (the `if (... == 0) return;` lines) keep the fuzzer from wasting runs on
/// no-op calls instead of failing the whole run on an expected revert.
contract YieldRouterHandler is Test {
    YieldRouter public immutable router;
    MockUSDC public immutable usdc;
    MockERC4626 public immutable vault;

    address[3] public actors = [address(0x1111), address(0x2222), address(0x3333)];

    constructor(YieldRouter router_, MockUSDC usdc_, MockERC4626 vault_) {
        router = router_;
        usdc = usdc_;
        vault = vault_;
        for (uint256 i = 0; i < actors.length; i++) {
            usdc.mint(actors[i], 1_000_000_000_000); // 1,000,000 USDC at 6dp headroom
        }
    }

    function deposit(uint256 actorSeed, uint256 amountSeed) external {
        address actor = actors[actorSeed % actors.length];
        uint256 bal = usdc.balanceOf(actor);
        if (bal == 0) return;
        uint256 amount = bound(amountSeed, 1, bal);

        vm.prank(actor);
        usdc.approve(address(router), amount);
        vm.prank(actor);
        router.deposit(address(vault), amount, 0);
    }

    function withdraw(uint256 actorSeed, uint256 shareSeed) external {
        address actor = actors[actorSeed % actors.length];
        uint256 heldShares = vault.balanceOf(actor);
        if (heldShares == 0) return;
        uint256 shares = bound(shareSeed, 1, heldShares);

        vm.prank(actor);
        vault.approve(address(router), shares);
        vm.prank(actor);
        router.withdraw(address(vault), shares, 0);
    }
}
