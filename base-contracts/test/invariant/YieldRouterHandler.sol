// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {YieldRouter} from "../../src/YieldRouter.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MockERC4626} from "../mocks/MockERC4626.sol";

/// @notice Stateful action surface for custody, registry, admin, actor-isolation,
/// and exact slippage-boundary invariants across two pools and three actors.
contract YieldRouterHandler is Test {
    YieldRouter public immutable router;
    MockUSDC public immutable usdc;
    MockERC4626 public immutable vault;
    MockERC4626 public immutable vaultB;
    address public immutable owner;

    address[3] public actors = [address(0x1111), address(0x2222), address(0x3333)];
    address public constant ATTACKER = address(0xBAD);

    bool public everKnownA;
    bool public everKnownB;
    bool public crossActorMutation;
    bool public unauthorizedAdminMutation;
    bool public slippageBoundaryViolation;
    bool public unexpectedActionFailure;

    constructor(YieldRouter router_, MockUSDC usdc_, MockERC4626 vault_, MockERC4626 vaultB_, address owner_) {
        router = router_;
        usdc = usdc_;
        vault = vault_;
        vaultB = vaultB_;
        owner = owner_;
        everKnownA = router_.knownPool(address(vault_));
        everKnownB = router_.knownPool(address(vaultB_));
        for (uint256 i; i < actors.length; i++) {
            usdc.mint(actors[i], 1_000_000_000_000);
        }
    }

    function togglePool(uint256 poolSeed, bool allowed) external {
        MockERC4626 selected = _vault(poolSeed);
        vm.prank(owner);
        router.setPool(address(selected), allowed);
        _observeKnown();
    }

    function attackerCannotToggle(uint256 poolSeed, bool allowed) external {
        MockERC4626 selected = _vault(poolSeed);
        bool beforeAllowed = router.allowedPool(address(selected));
        bool beforeKnown = router.knownPool(address(selected));
        vm.prank(ATTACKER);
        (bool ok,) = address(router).call(abi.encodeCall(router.setPool, (address(selected), allowed)));
        if (
            ok || router.allowedPool(address(selected)) != beforeAllowed
                || router.knownPool(address(selected)) != beforeKnown
        ) unauthorizedAdminMutation = true;
        _observeKnown();
    }

    function deposit(uint256 actorSeed, uint256 poolSeed, uint256 amountSeed) external {
        address actor = actors[actorSeed % actors.length];
        MockERC4626 selected = _vault(poolSeed);
        if (!router.allowedPool(address(selected))) return;
        uint256 bal = usdc.balanceOf(actor);
        if (bal == 0) return;
        uint256 amount = bound(amountSeed, 1, bal);
        uint256[9] memory beforeState = _actorState();

        vm.prank(actor);
        usdc.approve(address(router), amount);
        vm.prank(actor);
        (bool ok,) = address(router).call(abi.encodeCall(router.deposit, (address(selected), amount, amount)));
        if (!ok) unexpectedActionFailure = true;
        _checkOtherActors(actor, beforeState);
        _observeKnown();
    }

    function withdraw(uint256 actorSeed, uint256 poolSeed, uint256 shareSeed) external {
        address actor = actors[actorSeed % actors.length];
        MockERC4626 selected = _vault(poolSeed);
        uint256 heldShares = selected.balanceOf(actor);
        if (heldShares == 0) return;
        uint256 shares = bound(shareSeed, 1, heldShares);
        uint256[9] memory beforeState = _actorState();

        vm.prank(actor);
        selected.approve(address(router), shares);
        vm.prank(actor);
        (bool ok,) = address(router).call(abi.encodeCall(router.withdraw, (address(selected), shares, shares)));
        if (!ok) unexpectedActionFailure = true;
        _checkOtherActors(actor, beforeState);
        _observeKnown();
    }

    function probeDepositBoundary(uint256 actorSeed, uint256 poolSeed, uint256 amountSeed, bool plusOne) external {
        address actor = actors[actorSeed % actors.length];
        MockERC4626 selected = _vault(poolSeed);
        if (!router.allowedPool(address(selected))) return;
        uint256 bal = usdc.balanceOf(actor);
        if (bal == 0) return;
        uint256 amount = bound(amountSeed, 1, bal);
        uint256 assetsBefore = usdc.balanceOf(actor);
        uint256 sharesBefore = selected.balanceOf(actor);
        uint256[9] memory beforeState = _actorState();

        vm.prank(actor);
        usdc.approve(address(router), amount);
        vm.prank(actor);
        (bool ok,) = address(router)
            .call(abi.encodeCall(router.deposit, (address(selected), amount, amount + (plusOne ? 1 : 0))));
        if (ok == plusOne) slippageBoundaryViolation = true;
        if (plusOne && (usdc.balanceOf(actor) != assetsBefore || selected.balanceOf(actor) != sharesBefore)) {
            slippageBoundaryViolation = true;
        }
        _checkOtherActors(actor, beforeState);
        _observeKnown();
    }

    function probeWithdrawBoundary(uint256 actorSeed, uint256 poolSeed, uint256 shareSeed, bool plusOne) external {
        address actor = actors[actorSeed % actors.length];
        MockERC4626 selected = _vault(poolSeed);
        uint256 heldShares = selected.balanceOf(actor);
        if (heldShares == 0) return;
        uint256 shares = bound(shareSeed, 1, heldShares);
        uint256 assetsBefore = usdc.balanceOf(actor);
        uint256 sharesBefore = selected.balanceOf(actor);
        uint256[9] memory beforeState = _actorState();

        vm.prank(actor);
        selected.approve(address(router), shares);
        vm.prank(actor);
        (bool ok,) = address(router)
            .call(abi.encodeCall(router.withdraw, (address(selected), shares, shares + (plusOne ? 1 : 0))));
        if (ok == plusOne) slippageBoundaryViolation = true;
        if (plusOne && (usdc.balanceOf(actor) != assetsBefore || selected.balanceOf(actor) != sharesBefore)) {
            slippageBoundaryViolation = true;
        }
        _checkOtherActors(actor, beforeState);
        _observeKnown();
    }

    function _vault(uint256 seed) private view returns (MockERC4626) {
        return seed % 2 == 0 ? vault : vaultB;
    }

    function _observeKnown() private {
        if (router.knownPool(address(vault))) everKnownA = true;
        if (router.knownPool(address(vaultB))) everKnownB = true;
    }

    function _actorState() private view returns (uint256[9] memory state) {
        for (uint256 i; i < actors.length; i++) {
            state[i * 3] = usdc.balanceOf(actors[i]);
            state[i * 3 + 1] = vault.balanceOf(actors[i]);
            state[i * 3 + 2] = vaultB.balanceOf(actors[i]);
        }
    }

    function _checkOtherActors(address acting, uint256[9] memory beforeState) private {
        uint256[9] memory afterState = _actorState();
        for (uint256 i; i < actors.length; i++) {
            if (actors[i] == acting) continue;
            for (uint256 j; j < 3; j++) {
                if (beforeState[i * 3 + j] != afterState[i * 3 + j]) crossActorMutation = true;
            }
        }
    }
}
