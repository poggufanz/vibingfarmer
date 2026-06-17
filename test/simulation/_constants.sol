// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// [VERIFY] First Ethereum mainnet block on 10-11 Mar 2023 where USDC < $0.985 on the
// main Uniswap V3 USDC/WETH pool. ~16,800,000 is an approximation — confirm on Etherscan
// (timestamp 2023-03-11) and the pool's slot0 price, then replace + cite the tx here.
library DepegConstants {
    uint256 internal constant SIGNAL_BLOCK = 16_800_000; // [VERIFY] replace with confirmed block
    // Uniswap V3 SwapRouter02 (mainnet) — note: SwapRouter02 has NO `deadline` in the
    // exactInputSingle struct (SwapRouter01 does). Task 2's interface matches this.
    address internal constant SWAP_ROUTER = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    uint24  internal constant FEE_500 = 500; // 0.05% USDC/WETH pool [VERIFY pool exists at this fee at SIGNAL_BLOCK]
}
