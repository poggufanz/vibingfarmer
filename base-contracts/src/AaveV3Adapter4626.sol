// base-contracts/src/AaveV3Adapter4626.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ERC4626, ERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IAaveV3Pool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

/// @title AaveV3Adapter4626
/// @notice Minimal ERC-4626 wrapper around one Aave v3 reserve so YieldRouter's
/// whitelisted-4626-pool interface reaches a REAL lending protocol (replaces the
/// MockERC4626 demo pools). Every deposited asset is supplied to Aave in the same
/// transaction; the adapter's aToken balance is the vault's totalAssets, so aToken
/// rebasing growth IS the share-price growth. No admin, no upgrade, no fees — same
/// trust surface as the mocks it replaces.
///
/// DEPLOYMENT NOTE (2026-07-09): NOT deployed on Base Sepolia — the Aave testnet
/// market lists a faucet USDC, not CCTP/Circle USDC (see relayer/scripts/check-aave-usdc.mjs),
/// so bridged USDC cannot be supplied there. This artifact is MAINNET-READY and proven
/// against real Aave via a Base-mainnet fork test (AaveV3Adapter.fork.t.sol). Base mainnet
/// targets: Pool 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5, USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,
/// aUSDC 0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB.
contract AaveV3Adapter4626 is ERC4626 {
    using SafeERC20 for IERC20;

    IAaveV3Pool public immutable aavePool;
    IERC20 public immutable aToken;

    constructor(IERC20 usdc, address pool_, address aToken_, string memory name_, string memory symbol_)
        ERC4626(usdc)
        ERC20(name_, symbol_)
    {
        aavePool = IAaveV3Pool(pool_);
        aToken = IERC20(aToken_);
        IERC20(usdc).forceApprove(pool_, type(uint256).max);
    }

    /// @dev aToken balance rebases upward as interest accrues — this is the
    /// entire yield accounting.
    function totalAssets() public view override returns (uint256) {
        return aToken.balanceOf(address(this));
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        super._deposit(caller, receiver, assets, shares); // pulls USDC in, mints shares
        aavePool.supply(asset(), assets, address(this), 0);
    }

    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
    {
        aavePool.withdraw(asset(), assets, address(this)); // USDC back to adapter first
        super._withdraw(caller, receiver, owner, assets, shares); // burns shares, pays receiver
    }
}
