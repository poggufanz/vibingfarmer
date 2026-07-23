// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title HookDataLib
/// @notice On-chain port of `assertHookData` from frontend/src/base/hookData.js.
///
/// The JS validator is load-bearing: a wrong version byte reverts the Stellar
/// mint with Error(Contract,#7313) InvalidHookVersion AND strands the burned
/// USDC with no on-chain retry (SP0 lost 1 test USDC to exactly this).
/// That guarantee held only while every burn path ran through client-composed
/// calldata. BaseExitSweeper is a public contract anyone can call with
/// hand-built bytes, so the check is re-implemented here rather than inherited
/// from the client.
///
/// Layout: [24 zero bytes][uint32 version == 0 BE][uint32 strkey length BE][strkey UTF-8]
library HookDataLib {
    uint256 internal constant HEADER_LEN = 32;
    uint256 internal constant MIN_STRKEY_LEN = 56;

    error HookDataTooShort(uint256 length);
    error HookDataDirtyHeader();
    error HookDataBadVersion(uint32 version);
    error HookDataLengthMismatch(uint32 declared, uint256 actual);
    error HookDataBadStrkey();

    function validate(bytes calldata hookData) internal pure {
        if (hookData.length < HEADER_LEN) revert HookDataTooShort(hookData.length);

        if (bytes24(hookData[0:24]) != bytes24(0)) revert HookDataDirtyHeader();

        uint32 version = uint32(bytes4(hookData[24:28]));
        if (version != 0) revert HookDataBadVersion(version);

        uint32 declaredLen = uint32(bytes4(hookData[28:32]));
        uint256 actualLen = hookData.length - HEADER_LEN;
        if (declaredLen != actualLen) revert HookDataLengthMismatch(declaredLen, actualLen);

        if (actualLen < MIN_STRKEY_LEN) revert HookDataBadStrkey();

        // Base32 alphabet the JS regex /^[A-Z2-7]{2,}$/ accepts.
        for (uint256 i = HEADER_LEN; i < hookData.length; i++) {
            uint8 c = uint8(hookData[i]);
            bool upper = c >= 0x41 && c <= 0x5A; // A-Z
            bool digit = c >= 0x32 && c <= 0x37; // 2-7
            if (!upper && !digit) revert HookDataBadStrkey();
        }
    }
}
