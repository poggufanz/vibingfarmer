// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry} from "../contracts/AgentRegistry.sol";
import {AgentVaultDepositor} from "../contracts/AgentVaultDepositor.sol";
import {MockVault} from "../contracts/MockVault.sol";
import {MockERC20, FeeOnTransferERC20} from "./mocks/MockERC20.sol";

contract AgentVaultDepositorTest is Test {
    AgentRegistry reg;
    AgentVaultDepositor dep;
    MockERC20 token;
    MockVault vault;
    address owner = address(0xA11CE);
    uint256 workerPk = 0xA9E47; // worker has a private key — it SIGNS, never custodies
    address worker;             // = vm.addr(workerPk)
    address guardian = address(this);
    address relayer = address(0x5E1F); // arbitrary submitter (stands in for 1Shot)

    function setUp() public {
        worker = vm.addr(workerPk);
        reg = new AgentRegistry();
        dep = new AgentVaultDepositor(address(reg), guardian);
        reg.setDepositor(address(dep));
        token = new MockERC20("USD Coin", "USDC", 6);
        vault = new MockVault("Vault USDC", address(token), 500);

        token.mint(owner, 1_000e6);
        // NOTE: tests use max approval for brevity. The FRONTEND/demo must approve a
        // BOUNDED total cap (Phase 5) — do not copy type(uint256).max into production.
        vm.prank(owner);
        token.approve(address(dep), type(uint256).max);
        vm.prank(owner);
        reg.authorizeSessionKey(worker, address(vault), address(token), 100e6, 1 days, uint40(block.timestamp + 7 days));
    }

    function _execId(uint256 i) internal view returns (bytes32) {
        return keccak256(abi.encode(owner, address(vault), uint256(1), i));
    }

    /// Sign an AgentDeposit with `pk` over the depositor's EIP-712 digest. minShares=0 (opt out).
    function _sign(uint256 pk, uint256 amount, uint256 minAmount, bytes32 execId) internal view returns (bytes memory) {
        return _signMinShares(pk, amount, minAmount, 0, execId);
    }

    /// Sign an AgentDeposit including an explicit minShares floor.
    function _signMinShares(uint256 pk, uint256 amount, uint256 minAmount, uint256 minShares, bytes32 execId)
        internal view returns (bytes memory)
    {
        bytes32 digest = dep.hashDeposit(amount, minAmount, minShares, execId);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_deposit_movesRealTokens_sharesToOwner() public {
        bytes memory sig = _sign(workerPk, 50e6, 50e6, _execId(0));
        vm.prank(relayer); // ANY submitter works — auth is the signature, not msg.sender
        uint256 shares = dep.executeAgentDeposit(50e6, 50e6, 0, _execId(0), sig);
        assertGt(shares, 0);
        assertEq(vault.balanceOf(owner), shares);     // shares to OWNER, not worker
        assertEq(token.balanceOf(worker), 0);          // worker never custodies
        assertEq(token.balanceOf(relayer), 0);         // relayer never custodies
        assertEq(token.balanceOf(address(dep)), 0);    // no residue
        AgentRegistry.AgentScope memory s = reg.scopeOf(worker);
        assertEq(s.spentInPeriod, 50e6);
    }

    function test_replay_sameExecId_reverts() public {
        dep.executeAgentDeposit(50e6, 50e6, 0, _execId(0), _sign(workerPk, 50e6, 50e6, _execId(0)));
        // even a freshly re-signed message with the same execId is dead (replay guard)
        // sign BEFORE expectRevert: _sign() calls dep.hashDeposit() (a staticcall), which
        // would otherwise be consumed as "the next call" by the cheatcode.
        bytes memory sig = _sign(workerPk, 10e6, 10e6, _execId(0));
        vm.expectRevert(abi.encodeWithSelector(AgentVaultDepositor.AlreadyExecuted.selector, _execId(0)));
        dep.executeAgentDeposit(10e6, 10e6, 0, _execId(0), sig);
    }

    function test_capExceeded_reverts() public {
        dep.executeAgentDeposit(80e6, 80e6, 0, _execId(0), _sign(workerPk, 80e6, 80e6, _execId(0)));
        bytes memory sig = _sign(workerPk, 80e6, 80e6, _execId(1));
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.CapExceeded.selector, 80e6, 20e6));
        dep.executeAgentDeposit(80e6, 80e6, 0, _execId(1), sig);
    }

    function test_revokedAgent_cannotDeposit() public {
        bytes memory sig = _sign(workerPk, 10e6, 10e6, _execId(0));
        vm.prank(owner);
        reg.revokeAgent(worker);
        vm.expectRevert(AgentVaultDepositor.ScopeInactive.selector);
        dep.executeAgentDeposit(10e6, 10e6, 0, _execId(0), sig);
    }

    function test_expiredScope_cannotDeposit() public {
        bytes memory sig = _sign(workerPk, 10e6, 10e6, _execId(0));
        skip(8 days);
        vm.expectRevert(AgentVaultDepositor.ScopeInactive.selector);
        dep.executeAgentDeposit(10e6, 10e6, 0, _execId(0), sig);
    }

    function test_unscopedSigner_cannotDeposit() public {
        // a key with no registry scope: recovered signer has empty scope → ScopeInactive
        uint256 strangerPk = 0xBADBAD;
        bytes memory sig = _sign(strangerPk, 10e6, 10e6, _execId(0));
        vm.expectRevert(AgentVaultDepositor.ScopeInactive.selector);
        dep.executeAgentDeposit(10e6, 10e6, 0, _execId(0), sig);
    }

    function test_tamperedAmount_breaksSignature() public {
        // sign for 10e6 but submit 90e6 → recovered signer differs from worker → wrong/empty scope
        bytes memory sig = _sign(workerPk, 10e6, 10e6, _execId(0));
        vm.expectRevert(); // recovered address has no matching scope (ScopeInactive) or cap mismatch
        dep.executeAgentDeposit(90e6, 90e6, 0, _execId(0), sig);
    }

    function test_paused_blocksDeposit() public {
        bytes memory sig = _sign(workerPk, 10e6, 10e6, _execId(0));
        dep.pause(); // test contract is guardian
        vm.expectRevert(); // Pausable: EnforcedPause (before signature recovery)
        dep.executeAgentDeposit(10e6, 10e6, 0, _execId(0), sig);
    }

    function test_workerBalanceAlwaysZero() public {
        dep.executeAgentDeposit(50e6, 50e6, 0, _execId(0), _sign(workerPk, 50e6, 50e6, _execId(0)));
        assertEq(token.balanceOf(worker), 0);
    }

    // minShares hardening (M3): a deposit that mints fewer shares than the signed floor reverts,
    // protecting the owner against an adversarial/manipulatable vault returning dust shares.
    function test_minShares_belowFloor_reverts() public {
        // MockVault is ~1:1, so 50e6 assets ≈ 50e6 shares. Demand an impossible 100e6 floor.
        bytes memory sig = _signMinShares(workerPk, 50e6, 50e6, 100e6, _execId(0));
        vm.expectRevert(abi.encodeWithSelector(AgentVaultDepositor.InsufficientShares.selector, 50e6, 100e6));
        dep.executeAgentDeposit(50e6, 50e6, 100e6, _execId(0), sig);
    }

    function test_minShares_metFloor_succeeds() public {
        // A realistic floor at/below the minted amount must pass and credit the owner.
        bytes memory sig = _signMinShares(workerPk, 50e6, 50e6, 50e6, _execId(0));
        uint256 shares = dep.executeAgentDeposit(50e6, 50e6, 50e6, _execId(0), sig);
        assertGe(shares, 50e6);
        assertEq(vault.balanceOf(owner), shares);
    }

    // NOTE: ERC-4626 does not support fee-on-transfer assets end-to-end — the dep→vault
    // leg also loses the fee, so the mock vault is slightly under-collateralized here.
    // This test ONLY proves the depositor's balance-delta + minAmount guard; it is not a
    // claim that FoT tokens are supported as vault assets.
    function test_feeOnTransfer_minAmountProtectsUser() public {
        FeeOnTransferERC20 fee = new FeeOnTransferERC20("Fee USDC", "fUSDC", 6);
        MockVault feeVault = new MockVault("Vault fUSDC", address(fee), 500);
        uint256 w2Pk = 0xCAFE;
        address w2 = vm.addr(w2Pk);
        fee.mint(owner, 1_000e6);
        vm.prank(owner);
        fee.approve(address(dep), type(uint256).max);
        vm.prank(owner);
        reg.authorizeSessionKey(w2, address(feeVault), address(fee), 100e6, 1 days, uint40(block.timestamp + 1 days));

        // received = 50e6 - 1% = 49.5e6. minAmount 50e6 must revert.
        bytes memory sig1 = _sign(w2Pk, 50e6, 50e6, keccak256("fee"));
        vm.expectRevert(abi.encodeWithSelector(AgentVaultDepositor.InsufficientReceived.selector, 49.5e6, 50e6));
        dep.executeAgentDeposit(50e6, 50e6, 0, keccak256("fee"), sig1);

        // with realistic minAmount it succeeds and credits the true delta
        uint256 shares = dep.executeAgentDeposit(50e6, 49e6, 0, keccak256("fee2"), _sign(w2Pk, 50e6, 49e6, keccak256("fee2")));
        assertGt(shares, 0);
        AgentRegistry.AgentScope memory s = reg.scopeOf(w2);
        assertEq(s.spentInPeriod, 49.5e6);
    }

    // ─── depositHeld: fund from contract's OWN balance (ERC-7715 redeem pushed USDC in) ───

    /// Sign an AgentHeldDeposit (distinct typehash) over the depositor's EIP-712 digest.
    function _signHeld(uint256 pk, uint256 amount, uint256 minAmount, uint256 minShares, bytes32 execId)
        internal view returns (bytes memory)
    {
        bytes32 digest = dep.hashHeldDeposit(amount, minAmount, minShares, execId);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_depositHeld_depositsFromContractBalance() public {
        uint256 amount = 100e6;
        // simulate the ERC-7715 redeem: push USDC straight into the depositor
        token.mint(address(dep), amount);

        bytes32 execId = keccak256("held-1");
        bytes memory sig = _signHeld(workerPk, amount, amount, 0, execId);

        uint256 sharesBefore = vault.balanceOf(owner);
        vm.prank(relayer); // ANY submitter — auth is the worker signature, not msg.sender
        uint256 shares = dep.depositHeld(amount, amount, 0, execId, sig);

        assertGt(shares, 0);
        assertEq(vault.balanceOf(owner), sharesBefore + shares);
        assertEq(token.balanceOf(address(dep)), 0); // no permanent custody
        AgentRegistry.AgentScope memory s = reg.scopeOf(worker);
        assertEq(s.spentInPeriod, amount);
    }

    function test_depositHeld_revertsWhenUnderfunded() public {
        uint256 amount = 100e6;
        token.mint(address(dep), amount - 1); // 1 wei short
        bytes32 execId = keccak256("held-short");
        bytes memory sig = _signHeld(workerPk, amount, amount, 0, execId);
        vm.expectRevert();
        dep.depositHeld(amount, amount, 0, execId, sig);
    }

    function test_depositHeld_replayGuard() public {
        uint256 amount = 50e6;
        token.mint(address(dep), 2 * amount);
        bytes32 execId = keccak256("held-replay");
        bytes memory sig = _signHeld(workerPk, amount, amount, 0, execId);
        dep.depositHeld(amount, amount, 0, execId, sig);
        vm.expectRevert(abi.encodeWithSelector(AgentVaultDepositor.AlreadyExecuted.selector, execId));
        dep.depositHeld(amount, amount, 0, execId, sig);
    }

    function test_depositHeld_unscopedSigner_reverts() public {
        uint256 amount = 50e6;
        token.mint(address(dep), amount);
        bytes32 execId = keccak256("held-stranger");
        bytes memory sig = _signHeld(0xBADBAD, amount, amount, 0, execId);
        vm.expectRevert(AgentVaultDepositor.ScopeInactive.selector);
        dep.depositHeld(amount, amount, 0, execId, sig);
    }

    function test_sweepStranded_onlyGuardian() public {
        token.mint(address(dep), 10e6);
        vm.prank(address(0xBEEF));
        vm.expectRevert(AgentVaultDepositor.NotGuardian.selector);
        dep.sweepStranded(address(token), address(0xBEEF));
    }

    function test_sweepStranded_movesSurplusToGuardianTarget() public {
        token.mint(address(dep), 10e6);
        address sink = address(0x5151);
        dep.sweepStranded(address(token), sink); // test contract is guardian
        assertEq(token.balanceOf(sink), 10e6);
        assertEq(token.balanceOf(address(dep)), 0);
    }
}
