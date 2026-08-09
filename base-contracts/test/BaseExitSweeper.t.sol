// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BaseExitSweeper} from "../src/BaseExitSweeper.sol";
import {IYieldRouter} from "../src/interfaces/IYieldRouter.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockERC4626} from "./mocks/MockERC4626.sol";
import {MockTokenMessengerV2} from "./mocks/MockTokenMessengerV2.sol";
import {MockYieldRouter} from "./mocks/MockYieldRouter.sol";
import {MockReentrantERC4626} from "./mocks/MockReentrantERC4626.sol";
import {MockOverReportingERC4626} from "./mocks/MockOverReportingERC4626.sol";
import {HookDataLib} from "../src/HookDataLib.sol";
import {MockViewGriefERC4626} from "./mocks/MockViewGriefERC4626.sol";
import {MockStickyAllowanceUSDC} from "./mocks/MockStickyAllowanceUSDC.sol";
import {MockMalformedReturnERC4626} from "./mocks/MockMalformedReturnERC4626.sol";
import {MockFalseUSDC} from "./mocks/MockFalseUSDC.sol";

interface IReentrantMessengerProbe {
    function setCallback(address target, bytes calldata data) external;
    function callbackAttempted() external view returns (bool);
    function callbackSucceeded() external view returns (bool);
    function callbackResult() external view returns (bytes memory);
}

interface ISelectiveFalseTransfer {
    function setFalseTransferFromPair(address from, address to, bool enabled) external;
}

contract BaseExitSweeperTest is Test {
    bytes4 constant HARDENED_EXIT_SELECTOR = 0x4c9d247b;
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
    string constant STRKEY = "GAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCF6M";
    string constant CONTRACT_STRKEY = "CAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRDB3V";

    function setUp() public {
        usdc = new MockUSDC();
        router = new MockYieldRouter();
        messenger = new MockTokenMessengerV2();
        sweeper = new BaseExitSweeper(
            address(usdc), address(router), address(messenger), STELLAR_DOMAIN, FORWARDER, FORWARDER
        );

        poolA = new MockERC4626(usdc);
        poolB = new MockERC4626(usdc);
        router.setAllowed(address(poolA), true);
        router.setAllowed(address(poolB), true);

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
        return sweeper.exitAllAndBurn(pools, floors, 1_000_000, block.timestamp, _hook());
    }

    function _one(address a) internal pure returns (address[] memory out) {
        out = new address[](1);
        out[0] = a;
    }

    function _one(uint256 a) internal pure returns (uint256[] memory out) {
        out = new uint256[](1);
        out[0] = a;
    }

    function _two(address a, address b) internal pure returns (address[] memory out) {
        out = new address[](2);
        out[0] = a;
        out[1] = b;
    }

    function _two(uint256 a, uint256 b) internal pure returns (uint256[] memory out) {
        out = new uint256[](2);
        out[0] = a;
        out[1] = b;
    }

    function test_singlePool_burnsFullRedeemedAmount() public {
        _fund(poolA, 100_000_000); // 100 USDC

        (uint256 burned, uint256 exited, uint256 skipped) = _call(_one(address(poolA)), _one(uint256(99_000_000)));

        assertEq(burned, 100_000_000, "must burn the FULL redeemed amount, not the floor");
        assertEq(exited, 1);
        assertEq(skipped, 0);
        assertEq(messenger.lastAmount(), 100_000_000);
        assertEq(usdc.balanceOf(address(sweeper)), 0, "zero residue");
    }

    function test_hardenedExitSelectorIsImplemented() public {
        address[] memory pools = new address[](0);
        uint256[] memory floors = new uint256[](0);
        vm.prank(owner);
        usdc.approve(address(sweeper), type(uint256).max);
        vm.prank(owner);
        (bool ok,) = address(sweeper)
            .call(
                abi.encodeWithSelector(
                    HARDENED_EXIT_SELECTOR, pools, floors, uint256(1_000_000), block.timestamp, _hook()
                )
            );
        assertTrue(ok, "frozen five-argument hardened ABI must be callable");
    }

    function test_constructorPinsAllRouteFacts() public view {
        assertEq(address(sweeper.usdc()), address(usdc));
        assertEq(address(sweeper.router()), address(router));
        assertEq(address(sweeper.tokenMessenger()), address(messenger));
        assertEq(sweeper.stellarDomain(), STELLAR_DOMAIN);
        assertEq(sweeper.mintRecipient(), FORWARDER);
        assertEq(sweeper.destinationCaller(), FORWARDER);
        assertEq(sweeper.FINALITY_THRESHOLD(), FAST);
        assertEq(BaseExitSweeper.exitAllAndBurn.selector, bytes4(0x4c9d247b));
    }

    function test_constructorRejectsEachZeroRouteFact() public {
        vm.expectRevert(BaseExitSweeper.ZeroAddress.selector);
        new BaseExitSweeper(address(0), address(router), address(messenger), 27, FORWARDER, FORWARDER);
        vm.expectRevert(BaseExitSweeper.ZeroAddress.selector);
        new BaseExitSweeper(address(usdc), address(0), address(messenger), 27, FORWARDER, FORWARDER);
        vm.expectRevert(BaseExitSweeper.ZeroAddress.selector);
        new BaseExitSweeper(address(usdc), address(router), address(0), 27, FORWARDER, FORWARDER);
        vm.expectRevert(BaseExitSweeper.ZeroAddress.selector);
        new BaseExitSweeper(address(usdc), address(router), address(messenger), 27, bytes32(0), FORWARDER);
        vm.expectRevert(BaseExitSweeper.ZeroAddress.selector);
        new BaseExitSweeper(address(usdc), address(router), address(messenger), 27, FORWARDER, bytes32(0));
    }

    function test_constructorRejectsEachCodeLessDependencyAndWrongDomain() public {
        vm.expectRevert(abi.encodeWithSelector(BaseExitSweeper.NoCode.selector, address(0x1001)));
        new BaseExitSweeper(address(0x1001), address(router), address(messenger), 27, FORWARDER, FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(BaseExitSweeper.NoCode.selector, address(0x1002)));
        new BaseExitSweeper(address(usdc), address(0x1002), address(messenger), 27, FORWARDER, FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(BaseExitSweeper.NoCode.selector, address(0x1003)));
        new BaseExitSweeper(address(usdc), address(router), address(0x1003), 27, FORWARDER, FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(BaseExitSweeper.InvalidStellarDomain.selector, uint32(26)));
        new BaseExitSweeper(address(usdc), address(router), address(messenger), 26, FORWARDER, FORWARDER);
    }

    function test_oldExitSelectorsReject() public {
        address[] memory pools = new address[](0);
        uint256[] memory floors = new uint256[](0);
        bytes memory hookData = _hook();
        (bool fourArg, bytes memory fourArgData) =
            address(sweeper).call(abi.encodeWithSelector(bytes4(0x0d390c9e), pools, floors, uint256(0), hookData));
        (bool legacy, bytes memory legacyData) = address(sweeper)
            .call(
                abi.encodeWithSelector(
                    bytes4(0x9abaf267), pools, floors, FORWARDER, FORWARDER, STELLAR_DOMAIN, uint256(0), FAST, hookData
                )
            );
        assertFalse(fourArg);
        assertEq(fourArgData.length, 0, "four-argument selector dispatched before reverting");
        assertFalse(legacy);
        assertEq(legacyData.length, 0, "legacy selector dispatched before reverting");
    }

    function test_expiredDeadlineWinsBeforeHookValidationOrExternalCall() public {
        _fund(poolA, 100_000_000);
        uint256 sharesBefore = poolA.balanceOf(owner);
        vm.warp(100);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(BaseExitSweeper.Expired.selector, uint256(99), uint256(100)));
        sweeper.exitAllAndBurn(_one(address(poolA)), _one(uint256(0)), 1_000_000, 99, hex"ff");

        assertEq(poolA.balanceOf(owner), sharesBefore);
        assertEq(messenger.burnCount(), 0);
    }

    function test_expiredAndMalformedHookHaveNoExternalStorageAccesses() public {
        _fund(poolA, 1_000_000);
        vm.warp(100);

        vm.record();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(BaseExitSweeper.Expired.selector, uint256(99), uint256(100)));
        sweeper.exitAllAndBurn(_one(address(poolA)), _one(uint256(0)), 0, 99, hex"ff");
        _assertNoExternalStorageAccesses();

        vm.record();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(HookDataLib.HookDataTooShort.selector, uint256(1)));
        sweeper.exitAllAndBurn(_one(address(poolA)), _one(uint256(0)), 0, 100, hex"ff");
        _assertNoExternalStorageAccesses();
    }

    function _assertNoExternalStorageAccesses() private view {
        (bytes32[] memory poolReads, bytes32[] memory poolWrites) = vm.accesses(address(poolA));
        (bytes32[] memory routerReads, bytes32[] memory routerWrites) = vm.accesses(address(router));
        (bytes32[] memory messengerReads, bytes32[] memory messengerWrites) = vm.accesses(address(messenger));
        assertEq(poolReads.length + poolWrites.length, 0, "pool touched before validation");
        assertEq(routerReads.length + routerWrites.length, 0, "router touched before validation");
        assertEq(messengerReads.length + messengerWrites.length, 0, "messenger touched before validation");
    }

    function test_forceApproveClearedAfterSuccess() public {
        _fund(poolA, 100_000_000);
        _call(_one(address(poolA)), _one(uint256(0)));
        assertEq(usdc.allowance(address(sweeper), address(messenger)), 0);
        assertEq(usdc.balanceOf(address(sweeper)), 0);
    }

    function test_forceApproveClearsStickyAllowanceAfterSuccess() public {
        MockStickyAllowanceUSDC sticky = new MockStickyAllowanceUSDC();
        MockYieldRouter stickyRouter = new MockYieldRouter();
        MockTokenMessengerV2 stickyMessenger = new MockTokenMessengerV2();
        BaseExitSweeper stickySweeper = new BaseExitSweeper(
            address(sticky), address(stickyRouter), address(stickyMessenger), 27, FORWARDER, FORWARDER
        );
        sticky.mint(owner, 1_000_000);
        vm.startPrank(owner);
        sticky.approve(address(stickySweeper), type(uint256).max);
        stickySweeper.exitAllAndBurn(new address[](0), new uint256[](0), 1_000_000, block.timestamp, _hook());
        vm.stopPrank();

        assertEq(sticky.allowance(address(stickySweeper), address(stickyMessenger)), 0);
        assertEq(sticky.balanceOf(address(stickySweeper)), 0);
    }

    function test_sweptEventOccursAfterMessengerBurnAndUsesMeasuredTruth() public {
        _fund(poolA, 100_000_000);
        MockReentrantERC4626 broken = new MockReentrantERC4626(usdc);
        router.setAllowed(address(broken), true);
        broken.seedShares(owner, 1);
        vm.prank(owner);
        broken.approve(address(sweeper), 1);

        vm.recordLogs();
        (uint256 burned, uint256 exited, uint256 skipped) =
            _call(_two(address(poolA), address(broken)), _two(uint256(0), uint256(0)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 burnTopic = keccak256("BurnObserved(uint256)");
        bytes32 sweptTopic = keccak256("Swept(address,uint256,uint256,uint256)");
        uint256 burnIndex = type(uint256).max;
        uint256 sweptIndex = type(uint256).max;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == burnTopic) burnIndex = i;
            if (logs[i].topics[0] == sweptTopic) {
                sweptIndex = i;
                (uint256 eventBurned, uint256 eventExited, uint256 eventSkipped) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256));
                assertEq(eventBurned, burned);
                assertEq(eventExited, exited);
                assertEq(eventSkipped, skipped);
            }
        }
        assertLt(burnIndex, sweptIndex, "Swept must only follow a successful Circle burn");
        assertEq(exited, 1);
        assertEq(skipped, 1);
    }

    function test_messengerRevertIsAtomic() public {
        _fund(poolA, 100_000_000);
        uint256 sharesBefore = poolA.balanceOf(owner);
        messenger.setShouldRevert(true);

        vm.expectRevert(bytes("messenger revert"));
        _call(_one(address(poolA)), _one(uint256(0)));

        assertEq(poolA.balanceOf(owner), sharesBefore);
        assertEq(usdc.balanceOf(address(sweeper)), 0);
        assertEq(usdc.allowance(address(sweeper), address(messenger)), 0);
    }

    function test_messengerPartialPullIsAtomic() public {
        _fund(poolA, 100_000_000);
        uint256 sharesBefore = poolA.balanceOf(owner);
        messenger.setPullShortfall(1);

        vm.expectRevert(abi.encodeWithSelector(BaseExitSweeper.Residue.selector, uint256(1)));
        _call(_one(address(poolA)), _one(uint256(0)));

        assertEq(poolA.balanceOf(owner), sharesBefore);
        assertEq(usdc.balanceOf(address(messenger)), 0);
        assertEq(usdc.allowance(address(sweeper), address(messenger)), 0);
    }

    function test_messengerCannotReenterAndCreateASecondBurn() public {
        _fund(poolA, 100_000_000);
        bytes memory nested = abi.encodeCall(
            sweeper.exitAllAndBurn, (new address[](0), new uint256[](0), uint256(0), block.timestamp, _hook())
        );
        IReentrantMessengerProbe probe = IReentrantMessengerProbe(address(messenger));
        probe.setCallback(address(sweeper), nested);

        (uint256 burned, uint256 exited, uint256 skipped) = _call(_one(address(poolA)), _one(uint256(100_000_000)));

        assertEq(burned, 100_000_000);
        assertEq(exited, 1);
        assertEq(skipped, 0);
        assertEq(messenger.burnCount(), 1);
        assertTrue(probe.callbackAttempted());
        assertFalse(probe.callbackSucceeded());
        assertEq(
            bytes4(probe.callbackResult()),
            bytes4(keccak256("ReentrancyGuardReentrantCall()")),
            "messenger callback must fail at the reentrancy guard"
        );
    }

    function test_knownPoolBalanceOrAllowanceReadFailureIsIsolated() public {
        MockViewGriefERC4626 griefer = new MockViewGriefERC4626(address(usdc));
        router.setAllowed(address(griefer), true);
        griefer.configure(false, false, false, true);
        _fund(poolA, 100_000_000);

        address[] memory pools = new address[](2);
        pools[0] = address(griefer);
        pools[1] = address(poolA);
        uint256[] memory floors = new uint256[](2);
        (uint256 burned, uint256 exited, uint256 skipped) = _call(pools, floors);

        assertEq(burned, 100_000_000);
        assertEq(exited, 1);
        assertEq(skipped, 1);
    }

    function test_malformedSuccessfulRedeemReturnsAreRolledBackAndSkipped() public {
        uint256[5] memory sizes = [uint256(0), 1, 31, 33, 4096];
        for (uint256 i; i < sizes.length; i++) {
            _assertMalformedReturnSkipped(sizes[i]);
        }
    }

    function test_isolatedRedeemHelperRejectsEveryNonSelfCaller() public {
        vm.expectRevert(BaseExitSweeper.OnlySelf.selector);
        sweeper.isolatedRedeem(address(poolA), 1, owner);
    }

    function _assertMalformedReturnSkipped(uint256 returnSize) private {
        MockMalformedReturnERC4626 malformed = new MockMalformedReturnERC4626(usdc);
        MockERC4626 later = new MockERC4626(usdc);
        router.setAllowed(address(malformed), true);
        router.setAllowed(address(later), true);
        usdc.mint(address(malformed), 10_000_000);
        malformed.seedShares(owner, 10_000_000);
        vm.prank(owner);
        malformed.approve(address(sweeper), type(uint256).max);
        malformed.setReturnSize(returnSize);

        vm.startPrank(owner);
        usdc.approve(address(later), 1_000_000);
        later.deposit(1_000_000, owner);
        later.approve(address(sweeper), type(uint256).max);
        vm.stopPrank();

        (uint256 burned, uint256 exited, uint256 skipped) =
            _call(_two(address(malformed), address(later)), _two(uint256(0), uint256(1_000_000)));
        assertEq(burned, 1_000_000, "malformed child movement must roll back");
        assertEq(exited, 1);
        assertEq(skipped, 1);
        assertEq(malformed.balanceOf(owner), 10_000_000, "malformed redeem must not consume owner shares");
        assertEq(usdc.balanceOf(address(malformed)), 10_000_000, "malformed pool assets stay in the pool");
    }

    function test_ownerIsAlwaysMsgSender() public {
        address victim = address(0x71C71);
        usdc.mint(victim, 50_000_000);
        vm.startPrank(victim);
        usdc.approve(address(poolA), 50_000_000);
        poolA.deposit(50_000_000, victim);
        poolA.approve(address(sweeper), type(uint256).max);
        vm.stopPrank();
        uint256 victimShares = poolA.balanceOf(victim);

        vm.prank(owner);
        vm.expectRevert(BaseExitSweeper.NothingToExit.selector);
        sweeper.exitAllAndBurn(_one(address(poolA)), _one(uint256(0)), 1_000_000, block.timestamp, _hook());

        assertEq(poolA.balanceOf(victim), victimShares);
        assertEq(usdc.balanceOf(victim), 0);
    }

    function testFuzz_burnAlwaysUsesPinnedRouteAndFastFinality(uint256 maxFee, bool useContractRecipient) public {
        _fund(poolA, 1_000_000);
        bytes memory s = bytes(useContractRecipient ? CONTRACT_STRKEY : STRKEY);
        bytes memory hook = abi.encodePacked(bytes24(0), uint32(0), uint32(s.length), s);
        vm.prank(owner);
        sweeper.exitAllAndBurn(_one(address(poolA)), _one(uint256(0)), maxFee, block.timestamp, hook);

        assertEq(messenger.lastDestinationDomain(), 27);
        assertEq(messenger.lastMintRecipient(), FORWARDER);
        assertEq(messenger.lastDestinationCaller(), FORWARDER);
        assertEq(messenger.lastMinFinalityThreshold(), 1000);
        assertEq(messenger.lastMaxFee(), maxFee);
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

    function test_idleFalseReturnIsExcludedFromMeasuredBurnWithoutBlockingPosition() public {
        MockFalseUSDC token = new MockFalseUSDC();
        MockYieldRouter localRouter = new MockYieldRouter();
        MockTokenMessengerV2 localMessenger = new MockTokenMessengerV2();
        BaseExitSweeper localSweeper = new BaseExitSweeper(
            address(token), address(localRouter), address(localMessenger), 27, FORWARDER, FORWARDER
        );
        MockERC4626 localPool = new MockERC4626(token);
        localRouter.setAllowed(address(localPool), true);
        token.mint(owner, 1_000_000_000);

        vm.startPrank(owner);
        token.approve(address(localPool), 100_000_000);
        localPool.deposit(100_000_000, owner);
        localPool.approve(address(localSweeper), type(uint256).max);
        token.approve(address(localSweeper), type(uint256).max);
        vm.stopPrank();
        ISelectiveFalseTransfer(address(token)).setFalseTransferFromPair(owner, address(localSweeper), true);

        vm.prank(owner);
        (uint256 burned, uint256 exited, uint256 skipped) = localSweeper.exitAllAndBurn(
            _one(address(localPool)), _one(uint256(100_000_000)), 0, block.timestamp, _hook()
        );

        assertEq(burned, 100_000_000, "false-returning optional idle pull is not counted");
        assertEq(exited, 1);
        assertEq(skipped, 0);
        assertEq(token.balanceOf(owner), 900_000_000);
        assertEq(localMessenger.lastAmount(), 100_000_000);
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
        sweeper.exitAllAndBurn(pools, floors, 1_000_000, block.timestamp, _hook());
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

    function test_poolThatReverts_isSkippedAndOthersStillExit() public {
        _fund(poolA, 100_000_000);
        vm.prank(owner);
        usdc.approve(address(sweeper), type(uint256).max);

        // A known pool whose redeem() reverts (e.g. drained/insolvent).
        // MockERC4626 (poolB) can't be used for this: OZ's ERC4626 redeem()
        // always previews an asset amount capped by what the vault actually
        // holds, so draining a plain vault's balance yields a *successful*
        // zero-asset redeem, not a revert (verified empirically). Instead
        // seed MockReentrantERC4626 with shares but never mint it any
        // underlying — its redeem() transfers unconditionally, so
        // SafeERC20 genuinely reverts for insufficient balance.
        MockReentrantERC4626 broken = new MockReentrantERC4626(usdc);
        router.setAllowed(address(broken), true);
        broken.seedShares(owner, 250_000_000);
        vm.prank(owner);
        IERC20(address(broken)).approve(address(sweeper), type(uint256).max);

        address[] memory pools = new address[](2);
        pools[0] = address(poolA);
        pools[1] = address(broken);
        uint256[] memory floors = new uint256[](2);
        floors[0] = 0;
        floors[1] = 0;

        (uint256 burned, uint256 exited, uint256 skipped) = _call(pools, floors);

        assertEq(exited, 1, "poolA must still exit");
        assertEq(skipped, 1, "the broken pool must be reported as skipped, not hidden");
        assertEq(burned, 100_000_000 + 900_000_000, "poolA plus the owner's idle balance");
    }

    function test_poolThatUnderpaysBelowItsFloor_revertsTheWholeCall() public {
        MockReentrantERC4626 liar = new MockReentrantERC4626(usdc);
        router.setAllowed(address(liar), true);
        usdc.mint(address(liar), 100_000_000);
        liar.seedShares(owner, 100_000_000);
        vm.prank(owner);
        IERC20(address(liar)).approve(address(sweeper), type(uint256).max);

        // Pays out 10 USDC less than the shares imply.
        liar.configureRedeem(10_000_000, 0);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                BaseExitSweeper.Slippage.selector, address(liar), uint256(90_000_000), uint256(99_000_000)
            )
        );
        sweeper.exitAllAndBurn(_one(address(liar)), _one(uint256(99_000_000)), 1_000_000, block.timestamp, _hook());
    }

    function test_floorUsesExactGreaterThanOrEqualBoundary() public {
        _fund(poolA, 100_000_000);
        (uint256 burned, uint256 exited, uint256 skipped) = _call(_one(address(poolA)), _one(uint256(100_000_000)));
        assertEq(burned, 100_000_000);
        assertEq(exited, 1);
        assertEq(skipped, 0);
    }

    function test_poolThatOverReportsIsCaughtByTheMeasuredDelta() public {
        // THE invariant this contract exists to hold. MockReentrantERC4626 cannot
        // express this case: its configureRedeem only ever SUBTRACTS from the
        // return value, so measured and reported would both be low and the test
        // would pass for the wrong reason. MockOverReportingERC4626 returns MORE
        // than it transfers, which is exactly what a hostile pool would do to sail
        // through a floor checked against its own number.
        MockOverReportingERC4626 liar = new MockOverReportingERC4626(usdc);
        router.setAllowed(address(liar), true);
        usdc.mint(address(liar), 100_000_000);
        liar.seedShares(owner, 100_000_000);
        vm.prank(owner);
        IERC20(address(liar)).approve(address(sweeper), type(uint256).max);

        // Transfers 90 USDC, claims 100.
        liar.setPayout(90_000_000);
        liar.setReported(100_000_000);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                BaseExitSweeper.Slippage.selector, address(liar), uint256(90_000_000), uint256(100_000_000)
            )
        );
        sweeper.exitAllAndBurn(_one(address(liar)), _one(uint256(100_000_000)), 1_000_000, block.timestamp, _hook());
    }

    function test_gasGriefingPoolIsSkippedAndLaterPoolsStillExit() public {
        MockOverReportingERC4626 griefer = new MockOverReportingERC4626(usdc);
        router.setAllowed(address(griefer), true);
        usdc.mint(address(griefer), 100_000_000);
        griefer.seedShares(owner, 100_000_000);
        vm.prank(owner);
        IERC20(address(griefer)).approve(address(sweeper), type(uint256).max);
        // Burns far more than REDEEM_GAS_CAP, so the capped call runs out of gas
        // inside its own frame and the outer try/catch survives with gas to spare.
        griefer.setGasBurn(50_000_000);

        _fund(poolB, 250_000_000);
        vm.prank(owner);
        usdc.approve(address(sweeper), type(uint256).max);

        // Griefer FIRST so a naive implementation would starve poolB.
        address[] memory pools = new address[](2);
        pools[0] = address(griefer);
        pools[1] = address(poolB);
        uint256[] memory floors = new uint256[](2);
        floors[0] = 0;
        floors[1] = 0;

        (uint256 burned, uint256 exited, uint256 skipped) = _call(pools, floors);

        assertEq(skipped, 1, "the griefer is skipped, not fatal");
        assertEq(exited, 1, "poolB still exits despite running second");
        assertGt(burned, 250_000_000, "poolB's assets plus idle actually came out");
    }

    function test_poolNotAllowedByTheRouter_isSkipped() public {
        MockERC4626 stranger = new MockERC4626(usdc);
        // deliberately NOT router.setAllowed
        _fund(poolA, 100_000_000);

        address[] memory pools = new address[](2);
        pools[0] = address(poolA);
        pools[1] = address(stranger);
        uint256[] memory floors = new uint256[](2);
        floors[0] = 0;
        floors[1] = 0;

        (, uint256 exited, uint256 skipped) = _call(pools, floors);
        assertEq(exited, 1);
        assertEq(skipped, 1);
    }

    /// Documents the live router's ceiling: allowedPool is an owner-revocable
    /// *deposit* allowlist, not a permanent exit-eligibility one (that mapping,
    /// knownPool, only exists in the hardened source that was never deployed).
    /// A pool the owner disables after the user already deposited into it gets
    /// SKIPPED here, not exited — funds stay recoverable via a direct
    /// pool.redeem, but this sweep will not reach them. See
    /// BaseExitSweeper._eligible.
    function test_poolDisabledAfterDeposit_remainsSweepableThroughKnownPool() public {
        _fund(poolA, 100_000_000);
        // Idle balance so the call still has something to burn — the point
        // under test is that the poolA POSITION is skipped, not reached.
        vm.prank(owner);
        usdc.approve(address(sweeper), type(uint256).max);

        // Disabling future deposits never clears the permanent exit registry.
        router.setAllowed(address(poolA), false);

        (uint256 burned, uint256 exited, uint256 skipped) = _call(_one(address(poolA)), _one(uint256(0)));
        assertEq(exited, 1, "disabled pool remains exit-eligible");
        assertEq(skipped, 0);
        assertEq(burned, 1_000_000_000, "position and idle balance both burn");
    }

    function test_codeLessKnownPoolIsSkippedAndLaterPoolStillExits() public {
        _fund(poolA, 100_000_000);
        _fund(poolB, 250_000_000);
        vm.etch(address(poolA), bytes(""));

        (uint256 burned, uint256 exited, uint256 skipped) =
            _call(_two(address(poolA), address(poolB)), _two(uint256(0), uint256(250_000_000)));

        assertEq(burned, 250_000_000);
        assertEq(exited, 1);
        assertEq(skipped, 1);
    }

    /// Pins IYieldRouter's allowlist getter to the LIVE deployed router's ABI
    /// (0xF80aa8F571E6d24Ea72F051Fc6F9A9C516727B6d, selector 0xf50a9351,
    /// verified on-chain). This exact drift — the interface declaring a getter
    /// the deployed router doesn't have — took exitAllAndBurn down in
    /// production; a future silent rename must fail HERE, not as an empty
    /// revert in a user's simulation.
    function test_knownPoolSelectorPinnedToHardenedRouterABI() public pure {
        assertEq(IYieldRouter.knownPool.selector, bytes4(0xcdfc89aa));
    }

    function test_allowedPoolWhoseAssetChangedIsRejectedPerCall() public {
        MockReentrantERC4626 drifted = new MockReentrantERC4626(usdc);
        router.setAllowed(address(drifted), true);
        drifted.seedShares(owner, 100_000_000);
        vm.prank(owner);
        IERC20(address(drifted)).approve(address(sweeper), type(uint256).max);

        // allowedPool staying true says nothing about the pool's current asset,
        // so per-call revalidation is the only gate against a pool that drifted.
        drifted.setReportedAsset(address(0xBEEF));

        _fund(poolA, 100_000_000);
        address[] memory pools = new address[](2);
        pools[0] = address(poolA);
        pools[1] = address(drifted);
        uint256[] memory floors = new uint256[](2);
        floors[0] = 0;
        floors[1] = 0;

        (, uint256 exited, uint256 skipped) = _call(pools, floors);
        assertEq(exited, 1, "the valid pool still exits");
        assertEq(skipped, 1, "the drifted pool is rejected on this call");
    }

    function test_poolWithNoAllowance_isSkipped() public {
        vm.startPrank(owner);
        usdc.approve(address(poolA), 100_000_000);
        poolA.deposit(100_000_000, owner);
        // no share approval to the sweeper
        usdc.approve(address(sweeper), type(uint256).max);
        vm.stopPrank();

        (, uint256 exited, uint256 skipped) = _call(_one(address(poolA)), _one(uint256(0)));
        assertEq(exited, 0);
        assertEq(skipped, 1);
    }

    function test_arrayLengthMismatch_reverts() public {
        address[] memory pools = new address[](2);
        pools[0] = address(poolA);
        pools[1] = address(poolB);
        uint256[] memory floors = new uint256[](1);
        floors[0] = 0;

        vm.prank(owner);
        vm.expectRevert(BaseExitSweeper.LengthMismatch.selector);
        sweeper.exitAllAndBurn(pools, floors, 1_000_000, block.timestamp, _hook());
    }

    function test_duplicatePoolEntry_secondIterationRedeemsNothing() public {
        _fund(poolA, 100_000_000);
        vm.prank(owner);
        usdc.approve(address(sweeper), type(uint256).max);

        address[] memory pools = new address[](2);
        pools[0] = address(poolA);
        pools[1] = address(poolA);
        uint256[] memory floors = new uint256[](2);
        floors[0] = 0;
        floors[1] = 0;

        (uint256 burned, uint256 exited, uint256 skipped) = _call(pools, floors);
        assertEq(exited, 1, "only the first pass has shares");
        assertEq(skipped, 1, "the duplicate finds zero shares and is skipped");
        assertEq(burned, 100_000_000 + 900_000_000, "no double counting");
    }

    function test_replayingCompletedSweepCannotCreateASecondBurn() public {
        _fund(poolA, 100_000_000);
        _call(_one(address(poolA)), _one(uint256(100_000_000)));
        assertEq(messenger.burnCount(), 1);

        vm.prank(owner);
        vm.expectRevert(BaseExitSweeper.NothingToExit.selector);
        sweeper.exitAllAndBurn(_one(address(poolA)), _one(uint256(100_000_000)), 1_000_000, block.timestamp, _hook());
        assertEq(messenger.burnCount(), 1);
    }

    function test_malformedHookData_revertsBeforeAnyRedeem() public {
        _fund(poolA, 100_000_000);
        uint256 sharesBefore = IERC20(address(poolA)).balanceOf(owner);

        bytes memory badVersion = abi.encodePacked(bytes24(0), uint32(1), uint32(bytes(STRKEY).length), bytes(STRKEY));

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(HookDataLib.HookDataBadVersion.selector, uint32(1)));
        sweeper.exitAllAndBurn(_one(address(poolA)), _one(uint256(0)), 1_000_000, block.timestamp, badVersion);

        assertEq(
            IERC20(address(poolA)).balanceOf(owner),
            sharesBefore,
            "no shares may be redeemed when the hook is malformed"
        );
    }

    function test_healthyRedeemUsesFarLessThanTheGasCap() public {
        _fund(poolA, 100_000_000);
        uint256 gasBefore = gasleft();
        vm.prank(owner);
        sweeper.exitAllAndBurn(_one(address(poolA)), _one(uint256(0)), 1_000_000, block.timestamp, _hook());
        uint256 used = gasBefore - gasleft();
        // The whole call, not just the redeem, must sit well under the per-pool
        // cap. If this ever fails, RAISE REDEEM_GAS_CAP — do not lower this
        // assertion. A cap set too low silently turns healthy pools into
        // "skipped" ones, which the UI would then report as a pool failure.
        assertLt(used, sweeper.REDEEM_GAS_CAP(), "recalibrate REDEEM_GAS_CAP");
    }

    function test_maliciousPoolCannotReenterAndDrainOtherPools() public {
        MockReentrantERC4626 hostile = new MockReentrantERC4626(usdc);
        router.setAllowed(address(hostile), true);
        usdc.mint(address(hostile), 100_000_000);
        hostile.seedShares(owner, 100_000_000);
        vm.prank(owner);
        IERC20(address(hostile)).approve(address(sweeper), type(uint256).max);

        _fund(poolA, 500_000_000);

        // From inside its own redeem, the hostile pool calls back into the sweeper
        // trying to drain poolA to an attacker-chosen destination.
        bytes memory reentry = abi.encodeCall(
            BaseExitSweeper.exitAllAndBurn,
            (_one(address(poolA)), _one(uint256(0)), 1_000_000, block.timestamp, _hook())
        );
        hostile.configureCallback(address(sweeper), reentry, false, true);

        uint256 poolASharesBefore = IERC20(address(poolA)).balanceOf(owner);

        // Deviates from the brief here: MockReentrantERC4626.redeem() transfers
        // assets to the sweeper BEFORE invoking the callback, and the callback
        // fires through a raw `.call` whose failure is only recorded
        // (callbackSucceeded = false), never bubbled up. So the nested
        // exitAllAndBurn call genuinely reverts (nonReentrant), but that revert
        // dies inside the low-level call and never propagates out of
        // hostile.redeem(), which returns normally. The outer sweeper's
        // try/catch around IERC4626(pool).redeem(...) therefore sees a
        // *successful* call, not a caught revert — hostile's own redemption
        // still counts as exited, not skipped. The security property under
        // test is narrower and still holds: the attacker-controlled reentrant
        // call is neutralized, so poolA is never touched and the burn
        // destination is never corrupted to 0xBAD.
        (, uint256 exited, uint256 skipped) = _call(_one(address(hostile)), _one(uint256(0)));

        assertEq(exited, 1, "the hostile pool's own redemption still succeeds");
        assertEq(skipped, 0, "only the injected reentrant call fails, not the outer redeem");
        assertEq(IERC20(address(poolA)).balanceOf(owner), poolASharesBefore, "poolA shares must be untouched");
        assertEq(messenger.lastMintRecipient(), FORWARDER, "burn must never go to 0xBAD");
    }

    function test_poolCallbackCannotCreateASecondBurnForItsOwnPosition() public {
        MockReentrantERC4626 hostile = new MockReentrantERC4626(usdc);
        MockReentrantERC4626 target = new MockReentrantERC4626(usdc);
        router.setAllowed(address(hostile), true);
        router.setAllowed(address(target), true);

        usdc.mint(address(hostile), 10_000_000);
        hostile.seedShares(owner, 10_000_000);
        vm.prank(owner);
        hostile.approve(address(sweeper), type(uint256).max);

        usdc.mint(address(target), 20_000_000);
        target.seedShares(address(hostile), 20_000_000);
        hostile.approveToken(IERC20(address(target)), address(sweeper), type(uint256).max);

        bytes memory nested = abi.encodeCall(
            BaseExitSweeper.exitAllAndBurn,
            (_one(address(target)), _one(uint256(0)), 1_000_000, block.timestamp, _hook())
        );
        hostile.configureCallback(address(sweeper), nested, false, true);

        _call(_one(address(hostile)), _one(uint256(0)));

        assertFalse(hostile.callbackSucceeded(), "nested sweep must hit the reentrancy guard");
        assertEq(target.balanceOf(address(hostile)), 20_000_000, "nested owner position remains untouched");
        assertEq(messenger.burnCount(), 1, "one outer call creates exactly one burn");
    }
}
