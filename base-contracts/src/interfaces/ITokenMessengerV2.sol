// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @notice Circle CCTP v2 TokenMessengerV2, burn-with-hook only.
/// @dev The real function is declared `external notDenylistedCallers` with NO
/// return value — verified against circlefin/evm-cctp-contracts across its full
/// history. Five JS files in this repo declare `outputs: [{type:'uint64'}]`,
/// which is harmless under viem (outputs are unused when encoding a send) but
/// would make Solidity decode 32 bytes of returndata that does not exist.
/// Do not add a `returns` clause here.
interface ITokenMessengerV2 {
    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external;
}
