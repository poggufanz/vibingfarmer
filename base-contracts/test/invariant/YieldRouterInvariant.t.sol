// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {YieldRouter} from "../../src/YieldRouter.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MockERC4626} from "../mocks/MockERC4626.sol";
import {YieldRouterHandler} from "./YieldRouterHandler.sol";

contract YieldRouterInvariantTest is Test {
    YieldRouter router;
    MockUSDC usdc;
    MockERC4626 vault;
    MockERC4626 vaultB;
    YieldRouterHandler handler;

    address owner = address(0xA11CE);

    function setUp() public {
        usdc = new MockUSDC();
        router = new YieldRouter(owner, address(usdc));
        vault = new MockERC4626(usdc);
        vaultB = new MockERC4626(usdc);

        vm.prank(owner);
        router.setPool(address(vault), true);

        handler = new YieldRouterHandler(router, usdc, vault, vaultB, owner);
        targetContract(address(handler));
    }

    /// @notice The router must never hold a USDC or share balance BETWEEN
    /// transactions — every deposit forwards shares to the caller and every
    /// withdraw forwards assets to the caller, atomically, in the same tx.
    /// This is the drain-proof invariant the ERC-7579 session policy relies
    /// on: even if a session key is compromised, there is never a balance
    /// sitting in the router for an out-of-policy call to steal.
    function invariant_routerHoldsNoTokens() public view {
        assertEq(usdc.balanceOf(address(router)), 0, "router must hold 0 USDC between txs");
        assertEq(vault.balanceOf(address(router)), 0, "router must hold 0 vault shares between txs");
        assertEq(vaultB.balanceOf(address(router)), 0, "router must hold 0 vaultB shares between txs");
        assertEq(usdc.allowance(address(router), address(vault)), 0, "router allowance to vault must be zero");
        assertEq(usdc.allowance(address(router), address(vaultB)), 0, "router allowance to vaultB must be zero");
    }

    function invariant_allowedAlwaysImpliesKnownAndKnownIsMonotonic() public view {
        if (router.allowedPool(address(vault))) assertTrue(router.knownPool(address(vault)));
        if (router.allowedPool(address(vaultB))) assertTrue(router.knownPool(address(vaultB)));
        if (handler.everKnownA()) assertTrue(router.knownPool(address(vault)), "known A cleared");
        if (handler.everKnownB()) assertTrue(router.knownPool(address(vaultB)), "known B cleared");
    }

    function invariant_adminAndActorsRemainIsolated() public view {
        assertFalse(handler.unauthorizedAdminMutation(), "attacker changed registry");
        assertFalse(handler.crossActorMutation(), "one actor changed another actor's balances");
        assertFalse(handler.unexpectedActionFailure(), "valid exact-boundary action unexpectedly failed");
    }

    function invariant_slippageBoundaryIsExactAndAtomic() public view {
        assertFalse(handler.slippageBoundaryViolation(), "exact/+1 slippage boundary violated");
    }
}
