// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BaseExitSweeper} from "../../src/BaseExitSweeper.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MockERC4626} from "../mocks/MockERC4626.sol";
import {MockTokenMessengerV2} from "../mocks/MockTokenMessengerV2.sol";

contract BaseExitSweeperHandler is Test {
    BaseExitSweeper public immutable sweeper;
    MockUSDC public immutable usdc;
    MockTokenMessengerV2 public immutable messenger;
    MockERC4626 public immutable poolA;
    MockERC4626 public immutable poolB;
    MockERC4626 public immutable neverKnown;
    address public immutable protectedOwner;

    address[2] public actors = [address(0x1111), address(0x2222)];
    bool public invariantViolation;

    bytes32 private constant FORWARDER = bytes32(uint256(0xF0));
    string private constant VALID_G = "GAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCF6M";
    string private constant VALID_C = "CAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRDB3V";
    bytes32 private constant SWEPT_TOPIC = keccak256("Swept(address,uint256,uint256,uint256)");

    constructor(
        BaseExitSweeper sweeper_,
        MockUSDC usdc_,
        MockTokenMessengerV2 messenger_,
        MockERC4626 poolA_,
        MockERC4626 poolB_,
        MockERC4626 neverKnown_,
        address protectedOwner_
    ) {
        sweeper = sweeper_;
        usdc = usdc_;
        messenger = messenger_;
        poolA = poolA_;
        poolB = poolB_;
        neverKnown = neverKnown_;
        protectedOwner = protectedOwner_;
    }

    function sweep(
        uint256 actorSeed,
        uint128 amountASeed,
        uint128 amountBSeed,
        uint128 idleSeed,
        uint256 orderSeed,
        uint256 maxFee,
        bool contractHook
    ) external {
        address actor = actors[actorSeed % actors.length];
        uint256 amountA = bound(uint256(amountASeed), 1, 1_000_000_000);
        uint256 amountB = bound(uint256(amountBSeed), 1, 1_000_000_000);
        uint256 idle = bound(uint256(idleSeed), 1, 1_000_000_000);
        usdc.mint(actor, amountA + amountB + idle);
        _fund(actor, poolA, amountA);
        _fund(actor, poolB, amountB);
        vm.prank(actor);
        usdc.approve(address(sweeper), type(uint256).max);

        uint256[3] memory protectedBefore =
            [usdc.balanceOf(protectedOwner), poolA.balanceOf(protectedOwner), poolB.balanceOf(protectedOwner)];
        uint256 burnCountBefore = messenger.burnCount();
        uint256 variant = orderSeed % 4;
        (address[] memory pools, uint256[] memory floors, uint256 expectedSkipped) =
            _orderedPools(variant, amountA, amountB);
        bytes memory hook = _hook(contractHook);

        vm.recordLogs();
        vm.prank(actor);
        try sweeper.exitAllAndBurn(pools, floors, maxFee, block.timestamp, hook) returns (
            uint256 burned, uint256 exited, uint256 skipped
        ) {
            if (
                burned != amountA + amountB + idle || exited != 2 || skipped != expectedSkipped
                    || messenger.burnCount() != burnCountBefore + 1 || messenger.lastAmount() != burned
                    || messenger.lastDestinationDomain() != 27 || messenger.lastMintRecipient() != FORWARDER
                    || messenger.lastDestinationCaller() != FORWARDER || messenger.lastMinFinalityThreshold() != 1000
                    || messenger.lastMaxFee() != maxFee || keccak256(messenger.lastHookData()) != keccak256(hook)
                    || usdc.balanceOf(address(sweeper)) != 0
                    || usdc.allowance(address(sweeper), address(messenger)) != 0 || usdc.balanceOf(actor) != 0
                    || poolA.balanceOf(actor) != 0 || poolB.balanceOf(actor) != 0
            ) invariantViolation = true;
            _checkSweptEvent(actor, burned, exited, skipped);
        } catch {
            invariantViolation = true;
        }

        if (
            protectedBefore[0] != usdc.balanceOf(protectedOwner)
                || protectedBefore[1] != poolA.balanceOf(protectedOwner)
                || protectedBefore[2] != poolB.balanceOf(protectedOwner)
        ) invariantViolation = true;
    }

    function _fund(address actor, MockERC4626 pool, uint256 amount) private {
        vm.startPrank(actor);
        usdc.approve(address(pool), amount);
        pool.deposit(amount, actor);
        IERC20(address(pool)).approve(address(sweeper), type(uint256).max);
        vm.stopPrank();
    }

    function _orderedPools(uint256 variant, uint256 amountA, uint256 amountB)
        private
        view
        returns (address[] memory pools, uint256[] memory floors, uint256 expectedSkipped)
    {
        if (variant < 2) {
            pools = new address[](2);
            floors = new uint256[](2);
            if (variant == 0) {
                pools[0] = address(poolA);
                pools[1] = address(poolB);
                floors[0] = amountA;
                floors[1] = amountB;
            } else {
                pools[0] = address(poolB);
                pools[1] = address(poolA);
                floors[0] = amountB;
                floors[1] = amountA;
            }
            return (pools, floors, 0);
        }

        pools = new address[](3);
        floors = new uint256[](3);
        if (variant == 2) {
            pools[0] = address(neverKnown);
            pools[1] = address(poolA);
            pools[2] = address(poolB);
            floors[1] = amountA;
            floors[2] = amountB;
        } else {
            pools[0] = address(poolA);
            pools[1] = address(poolA);
            pools[2] = address(poolB);
            floors[0] = amountA;
            floors[2] = amountB;
        }
        return (pools, floors, 1);
    }

    function _hook(bool contractHook) private pure returns (bytes memory) {
        bytes memory key = bytes(contractHook ? VALID_C : VALID_G);
        return abi.encodePacked(bytes24(0), uint32(0), uint32(key.length), key);
    }

    function _checkSweptEvent(address actor, uint256 burned, uint256 exited, uint256 skipped) private {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 sweptEvents;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(sweeper) || logs[i].topics[0] != SWEPT_TOPIC) continue;
            sweptEvents++;
            address eventOwner = address(uint160(uint256(logs[i].topics[1])));
            (uint256 eventBurned, uint256 eventExited, uint256 eventSkipped) =
                abi.decode(logs[i].data, (uint256, uint256, uint256));
            if (eventOwner != actor || eventBurned != burned || eventExited != exited || eventSkipped != skipped) {
                invariantViolation = true;
            }
        }
        if (sweptEvents != 1) invariantViolation = true;
    }
}
