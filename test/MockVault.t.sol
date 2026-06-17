// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockVault} from "../contracts/MockVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice ERC-4626 compliance checks for the real-custody MockVault (Phase 1).
contract MockVaultTest is Test {
    MockERC20 token;
    MockVault vaultA;
    MockVault vaultB;
    address user = address(0xBEEF);

    function setUp() public {
        token = new MockERC20("USD Coin", "USDC", 6);
        vaultA = new MockVault("Vault USDC-A", address(token), 480); // 4.8% APY
        vaultB = new MockVault("Vault USDC-B", address(token), 610); // 6.1% APY

        token.mint(user, 1_000e6);
        vm.prank(user);
        token.approve(address(vaultA), type(uint256).max);
        vm.prank(user);
        token.approve(address(vaultB), type(uint256).max);
    }

    function test_name_and_symbol() public view {
        assertEq(vaultA.name(), "Vault USDC-A");
        assertEq(vaultA.symbol(), "vUSDC");
    }

    function test_asset_set_correctly() public view {
        assertEq(vaultA.asset(), address(token));
    }

    function test_apy_set_correctly() public view {
        assertEq(vaultA.apyBps(), 480);
        assertEq(vaultB.apyBps(), 610);
    }

    function test_deposit_pulls_real_tokens_and_mints_shares() public {
        vm.prank(user);
        uint256 shares = vaultA.deposit(100e6, user);

        assertEq(shares, 100e6); // empty vault: 1:1
        assertEq(vaultA.balanceOf(user), shares);
        assertEq(vaultA.totalAssets(), 100e6);
        assertEq(token.balanceOf(address(vaultA)), 100e6);
        assertEq(token.balanceOf(user), 900e6);
    }

    function test_multiple_deposits_accumulate() public {
        vm.startPrank(user);
        vaultA.deposit(100e6, user);
        vaultA.deposit(50e6, user);
        vm.stopPrank();

        assertEq(vaultA.balanceOf(user), 150e6);
        assertEq(vaultA.totalAssets(), 150e6);
    }

    function test_deposit_to_different_receiver() public {
        address receiver = address(0xDEAD);
        vm.prank(user);
        vaultA.deposit(100e6, receiver);

        assertEq(vaultA.balanceOf(receiver), 100e6);
        assertEq(vaultA.balanceOf(user), 0);
        assertEq(token.balanceOf(user), 900e6); // user paid
    }

    function test_vaults_are_independent() public {
        vm.startPrank(user);
        vaultA.deposit(100e6, user);
        vaultB.deposit(200e6, user);
        vm.stopPrank();

        assertEq(vaultA.totalAssets(), 100e6);
        assertEq(vaultB.totalAssets(), 200e6);
    }

    function test_withdraw_burns_shares_and_returns_tokens() public {
        vm.startPrank(user);
        vaultA.deposit(100e6, user);
        vaultA.withdraw(40e6, user, user);
        vm.stopPrank();

        assertEq(vaultA.balanceOf(user), 60e6);
        assertEq(vaultA.totalAssets(), 60e6);
        assertEq(token.balanceOf(user), 940e6);
    }

    function test_redeem_full_balance() public {
        vm.startPrank(user);
        uint256 shares = vaultA.deposit(100e6, user);
        vaultA.redeem(shares, user, user);
        vm.stopPrank();

        assertEq(vaultA.balanceOf(user), 0);
        assertEq(vaultA.totalAssets(), 0);
        assertEq(token.balanceOf(user), 1_000e6);
    }

    function test_withdraw_reverts_insufficient_shares() public {
        vm.startPrank(user);
        vaultA.deposit(10e6, user);
        vm.expectRevert();
        vaultA.withdraw(20e6, user, user);
        vm.stopPrank();
    }
}
