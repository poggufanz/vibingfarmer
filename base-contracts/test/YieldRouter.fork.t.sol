// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {YieldRouter} from "../src/YieldRouter.sol";
import {MockERC4626} from "./mocks/MockERC4626.sol";

/// @notice Fork test against real Base Sepolia state. Uses the real,
/// Circle-confirmed Base Sepolia USDC (see spikes/cctp-corridor/addresses.md)
/// as the underlying asset — this is a real token on a real fork, not a
/// mock.
///
/// Pool target: see Task 1.6 Step 1's decision record. By default this test
/// self-deploys a MockERC4626 wrapping the real Base Sepolia USDC ON the
/// fork. SWAP-IN: set env var FORK_POOL_ADDRESS to a confirmed Morpho
/// MetaMorpho vault address and this test uses it automatically instead —
/// no code change required.
///
/// Requires network access to Base Sepolia. If the RPC is unreachable,
/// forge reports a setup failure (fork creation error), not a test failure.
contract YieldRouterForkTest is Test {
    // Circle-confirmed Base Sepolia USDC, 6dp — spikes/cctp-corridor/addresses.md.
    // EIP-55 checksummed literal (solc 0.8.23 rejects any address-shaped hex
    // literal, including all-lowercase, unless it carries the correct checksum).
    address constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    YieldRouter router;
    IERC20 usdc;
    address pool;
    bool usingRealPool;

    address owner = address(this);
    address user = address(0xB0B);

    function setUp() public {
        string memory rpc = vm.envOr("BASE_SEPOLIA_RPC_URL", string("https://sepolia.base.org"));
        vm.createSelectFork(rpc);

        usdc = IERC20(BASE_SEPOLIA_USDC);
        router = new YieldRouter(owner, BASE_SEPOLIA_USDC);

        address poolFromEnv = vm.envOr("FORK_POOL_ADDRESS", address(0));
        if (poolFromEnv != address(0)) {
            pool = poolFromEnv;
            usingRealPool = true;
        } else {
            pool = address(new MockERC4626(usdc));
            usingRealPool = false;
        }

        router.setPool(pool, true);
        deal(address(usdc), user, 10_000_000); // 10 USDC at 6dp — forge-std deal() locates the balance slot for us
    }

    function test_fork_deposit_intoRealBaseSepoliaUSDC() public {
        uint256 amount = 1_000_000; // 1 USDC at 6dp

        if (!usingRealPool) {
            console2.log("NOTE: running against a self-deployed MockERC4626, not a live Morpho vault.");
            console2.log("Set FORK_POOL_ADDRESS to a confirmed Base Sepolia vault to exercise a real venue.");
        }

        vm.startPrank(user);
        usdc.approve(address(router), amount);
        uint256 shares = router.deposit(pool, amount, 1);
        vm.stopPrank();

        assertGt(shares, 0, "shares minted against the fork pool");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no USDC on the fork (zero-custody)");
    }

    function test_fork_withdraw_unwindsToRealBaseSepoliaUSDC() public {
        uint256 amount = 1_000_000; // 1 USDC at 6dp

        vm.startPrank(user);
        usdc.approve(address(router), amount);
        uint256 shares = router.deposit(pool, amount, 1);

        IERC20(pool).approve(address(router), shares);
        uint256 assets = router.withdraw(pool, shares, 1);
        vm.stopPrank();

        assertGt(assets, 0, "assets redeemed from the fork pool");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no USDC on the fork (zero-custody)");
    }
}
