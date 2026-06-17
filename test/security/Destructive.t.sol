// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry} from "../../contracts/AgentRegistry.sol";
import {AgentVaultDepositor} from "../../contracts/AgentVaultDepositor.sol";
import {MockVault} from "../../contracts/MockVault.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

contract DestructiveTest is Test {
    AgentRegistry reg;
    AgentVaultDepositor dep;
    MockERC20 token;
    MockVault vaultA;
    MockVault vaultB;
    address owner = address(0xA11CE);
    uint256 workerPk = 0xA9E47;
    uint256 strangerPk = 0xBAD1;
    address worker;
    address stranger;

    function setUp() public {
        worker = vm.addr(workerPk);
        stranger = vm.addr(strangerPk);
        reg = new AgentRegistry();
        dep = new AgentVaultDepositor(address(reg), address(this));
        reg.setDepositor(address(dep));
        token = new MockERC20("USD Coin", "USDC", 6);
        vaultA = new MockVault("Vault A", address(token), 500);
        vaultB = new MockVault("Vault B", address(token), 500);
        token.mint(owner, 1_000e6);
        vm.prank(owner);
        token.approve(address(dep), type(uint256).max);
        vm.prank(owner);
        reg.authorizeSessionKey(worker, address(vaultA), address(token), 100e6, 1 days, uint40(block.timestamp + 7 days));
    }

    function _sign(uint256 pk, uint256 amount, uint256 minAmount, bytes32 execId) internal view returns (bytes memory) {
        bytes32 digest = dep.hashDeposit(amount, minAmount, 0, execId);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // Attacker holds the worker key. Tries to drain to a different vault / over cap / after revoke.
    // The attacker cannot even pick a vault — vault is derived from scope (vaultA).
    // Shares always go to `owner`; attacker gains nothing. Submitted from `stranger` to
    // prove submitter != signer (the relayer model).
    function test_stolenWorkerKey_cannotRedirectVault() public {
        bytes memory sig = _sign(workerPk, 50e6, 50e6, keccak256("d1"));
        vm.prank(stranger);
        uint256 shares = dep.executeAgentDeposit(50e6, 50e6, 0, keccak256("d1"), sig);
        assertEq(vaultA.balanceOf(owner), shares);
        assertEq(vaultB.balanceOf(owner), 0);
        assertEq(vaultA.balanceOf(stranger), 0);
        assertEq(token.balanceOf(stranger), 0);
    }

    function test_stolenWorkerKey_cannotExceedCap() public {
        bytes memory sig1 = _sign(workerPk, 100e6, 100e6, keccak256("d2"));
        dep.executeAgentDeposit(100e6, 100e6, 0, keccak256("d2"), sig1);

        bytes memory sig2 = _sign(workerPk, 1e6, 1e6, keccak256("d3"));
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.CapExceeded.selector, 1e6, 0));
        dep.executeAgentDeposit(1e6, 1e6, 0, keccak256("d3"), sig2);
    }

    function test_midPlanRevoke_haltsImmediately() public {
        bytes memory sig1 = _sign(workerPk, 30e6, 30e6, keccak256("d4"));
        dep.executeAgentDeposit(30e6, 30e6, 0, keccak256("d4"), sig1);

        vm.prank(owner);
        reg.revokeAgent(worker); // user pulls the plug

        bytes memory sig2 = _sign(workerPk, 30e6, 30e6, keccak256("d5"));
        vm.expectRevert(AgentVaultDepositor.ScopeInactive.selector);
        dep.executeAgentDeposit(30e6, 30e6, 0, keccak256("d5"), sig2);
    }

    // A random attacker who does NOT hold the worker key has no scope at all.
    // (Distinct from the stolen-key cases above, where the attacker DOES sign as worker
    //  but is still boxed in by cap/vault/expiry.) Under the EIP-712 form this means the
    //  attacker signs with THEIR key -> recovered signer != worker -> ScopeInactive.
    function test_unauthorizedCaller_hasNoScope() public {
        bytes memory sig = _sign(strangerPk, 10e6, 10e6, keccak256("d6"));
        vm.expectRevert(AgentVaultDepositor.ScopeInactive.selector);
        dep.executeAgentDeposit(10e6, 10e6, 0, keccak256("d6"), sig);
    }
}
