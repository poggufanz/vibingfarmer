// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DepegConstants as D} from "./_constants.sol";

interface ISwapRouter {
    // SwapRouter02 struct — NO `deadline` field. Matches D.SWAP_ROUTER (0x68b3...Fc45).
    struct ExactInputSingleParams {
        address tokenIn; address tokenOut; uint24 fee; address recipient;
        uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata) external payable returns (uint256);
}

contract TimelineReplayForkTest is Test {
    uint256 constant AMOUNT_IN = 1_000_000e6; // 1,000,000 USDC

    function test_replaySweep_writesGroundTruthJson() public {
        uint32[5] memory delays = [uint32(2), 15, 50, 150, 600];
        string memory json = "replay";
        for (uint256 i; i < delays.length; ++i) {
            // Use the foundry.toml alias so the endpoint is single-sourced.
            vm.createSelectFork(vm.rpcUrl("eth_mainnet"), D.SIGNAL_BLOCK + delays[i]);
            uint256 out = _swap(D.USDC, D.WETH, D.FEE_500, AMOUNT_IN);
            assertGt(out, 0, "swap returned zero");
            string memory key = string.concat("delay_", vm.toString(delays[i]));
            vm.serializeUint(json, key, out);
        }
        // Provenance — the Assumptions panel (Task 4) needs these to be auditable.
        vm.serializeUint(json, "signalBlock", D.SIGNAL_BLOCK);
        vm.serializeUint(json, "chainId", 1);
        vm.serializeString(json, "depegDate", "2023-03-11");
        string memory finalOut = vm.serializeUint(json, "amountInUsdc", AMOUNT_IN);
        vm.writeJson(finalOut, "frontend/public/data/replay-usdc-depeg.json");
    }

    function _swap(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn) internal returns (uint256) {
        deal(tokenIn, address(this), amountIn); // USDC has a simple balance slot — deal works
        IERC20(tokenIn).approve(D.SWAP_ROUTER, amountIn);
        return ISwapRouter(D.SWAP_ROUTER).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn, tokenOut: tokenOut, fee: fee, recipient: address(this),
                amountIn: amountIn, amountOutMinimum: 0, sqrtPriceLimitX96: 0
            })
        );
    }
}
