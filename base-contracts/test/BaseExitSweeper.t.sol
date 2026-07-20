// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BaseExitSweeper} from "../src/BaseExitSweeper.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockERC4626} from "./mocks/MockERC4626.sol";
import {MockTokenMessengerV2} from "./mocks/MockTokenMessengerV2.sol";
import {MockYieldRouter} from "./mocks/MockYieldRouter.sol";

contract BaseExitSweeperTest is Test {
    BaseExitSweeper sweeper;
    MockUSDC usdc;
    MockYieldRouter router;
    MockTokenMessengerV2 messenger;
    MockERC4626 poolA;
    MockERC4626 poolB;

    address owner = address(0xB0B);

    bytes32 constant FORWARDER = bytes32(uint256(0xF0));
    uint32 constant STELLAR_DOMAIN = 27;
    uint32 constant FAST = 1000;
    string constant STRKEY = "GRECIPIENTOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO";

    function setUp() public {
        usdc = new MockUSDC();
        router = new MockYieldRouter();
        messenger = new MockTokenMessengerV2();
        sweeper = new BaseExitSweeper(address(usdc), address(router), address(messenger));

        poolA = new MockERC4626(usdc);
        poolB = new MockERC4626(usdc);
        router.setKnown(address(poolA), true);
        router.setKnown(address(poolB), true);

        usdc.mint(owner, 1_000_000_000); // 1,000 USDC at 6dp
    }

    function _hook() internal pure returns (bytes memory) {
        bytes memory s = bytes(STRKEY);
        return abi.encodePacked(bytes24(0), uint32(0), uint32(s.length), s);
    }

    /// Deposit `assets` from `owner` into `pool`, then approve the sweeper for max shares.
    function _fund(MockERC4626 pool, uint256 assets) internal {
        vm.startPrank(owner);
        usdc.approve(address(pool), assets);
        pool.deposit(assets, owner);
        IERC20(address(pool)).approve(address(sweeper), type(uint256).max);
        vm.stopPrank();
    }

    function _call(address[] memory pools, uint256[] memory floors)
        internal
        returns (uint256 burned, uint256 exited, uint256 skipped)
    {
        vm.prank(owner);
        return sweeper.exitAllAndBurn(
            pools, floors, FORWARDER, FORWARDER, STELLAR_DOMAIN, 1_000_000, FAST, _hook()
        );
    }

    function _one(address a) internal pure returns (address[] memory out) {
        out = new address[](1);
        out[0] = a;
    }

    function _one(uint256 a) internal pure returns (uint256[] memory out) {
        out = new uint256[](1);
        out[0] = a;
    }

    function test_singlePool_burnsFullRedeemedAmount() public {
        _fund(poolA, 100_000_000); // 100 USDC

        (uint256 burned, uint256 exited, uint256 skipped) =
            _call(_one(address(poolA)), _one(uint256(99_000_000)));

        assertEq(burned, 100_000_000, "must burn the FULL redeemed amount, not the floor");
        assertEq(exited, 1);
        assertEq(skipped, 0);
        assertEq(messenger.lastAmount(), 100_000_000);
        assertEq(usdc.balanceOf(address(sweeper)), 0, "zero residue");
    }

    function test_multiPool_burnsSumInOneCall() public {
        _fund(poolA, 100_000_000);
        _fund(poolB, 250_000_000);

        address[] memory pools = new address[](2);
        pools[0] = address(poolA);
        pools[1] = address(poolB);
        uint256[] memory floors = new uint256[](2);
        floors[0] = 99_000_000;
        floors[1] = 240_000_000;

        (uint256 burned, uint256 exited, uint256 skipped) = _call(pools, floors);

        assertEq(burned, 350_000_000);
        assertEq(exited, 2);
        assertEq(skipped, 0);
        assertEq(messenger.burnCount(), 1, "exactly ONE burn per transaction");
    }

    function test_idleUsdcIsSweptAlongsidePositions() public {
        _fund(poolA, 100_000_000);
        // 900 USDC left idle in the owner's account after the deposit above.
        vm.prank(owner);
        usdc.approve(address(sweeper), type(uint256).max);

        (uint256 burned,,) = _call(_one(address(poolA)), _one(uint256(0)));

        assertEq(burned, 1_000_000_000, "position plus idle");
        assertEq(usdc.balanceOf(owner), 0, "owner fully drained");
    }

    function test_idleOnly_noPositions_stillSucceeds() public {
        vm.prank(owner);
        usdc.approve(address(sweeper), type(uint256).max);

        address[] memory pools = new address[](0);
        uint256[] memory floors = new uint256[](0);
        (uint256 burned, uint256 exited, uint256 skipped) = _call(pools, floors);

        assertEq(burned, 1_000_000_000);
        assertEq(exited, 0);
        assertEq(skipped, 0);
    }

    function test_nothingAnywhere_reverts() public {
        address[] memory pools = new address[](0);
        uint256[] memory floors = new uint256[](0);
        vm.prank(owner);
        vm.expectRevert(BaseExitSweeper.NothingToExit.selector);
        sweeper.exitAllAndBurn(
            pools, floors, FORWARDER, FORWARDER, STELLAR_DOMAIN, 1_000_000, FAST, _hook()
        );
    }

    function test_burnArgumentsArePassedThroughVerbatim() public {
        _fund(poolA, 100_000_000);
        _call(_one(address(poolA)), _one(uint256(0)));

        assertEq(messenger.lastDestinationDomain(), STELLAR_DOMAIN);
        assertEq(messenger.lastMintRecipient(), FORWARDER);
        assertEq(messenger.lastDestinationCaller(), FORWARDER);
        assertEq(messenger.lastBurnToken(), address(usdc));
        assertEq(messenger.lastMaxFee(), 1_000_000);
        assertEq(messenger.lastMinFinalityThreshold(), FAST);
        assertEq(messenger.lastHookData(), _hook());
    }

    function test_emitsSweptWithCounts() public {
        _fund(poolA, 100_000_000);
        vm.expectEmit(true, false, false, true, address(sweeper));
        emit BaseExitSweeper.Swept(owner, 100_000_000, 1, 0);
        _call(_one(address(poolA)), _one(uint256(0)));
    }
}
