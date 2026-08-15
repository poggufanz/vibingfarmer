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
    uint256 internal constant STRKEY_LEN = 56;

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

        if (actualLen != STRKEY_LEN) revert HookDataBadStrkey();

        bytes memory decoded = new bytes(35);
        uint256 accumulator;
        uint256 bits;
        uint256 out;
        for (uint256 i = HEADER_LEN; i < hookData.length; i++) {
            uint8 c = uint8(hookData[i]);
            uint8 value;
            if (c >= 0x41 && c <= 0x5A) {
                value = c - 0x41;
            } else if (c >= 0x32 && c <= 0x37) {
                value = c - 0x32 + 26;
            } else {
                revert HookDataBadStrkey();
            }
            accumulator = (accumulator << 5) | value;
            bits += 5;
            if (bits >= 8) {
                bits -= 8;
                // The accumulator is masked to fewer than eight residual bits after each emitted byte.
                // forge-lint: disable-next-line(unsafe-typecast)
                decoded[out++] = bytes1(uint8(accumulator >> bits));
                accumulator &= (uint256(1) << bits) - 1;
            }
        }
        if (out != 35 || bits != 0) revert HookDataBadStrkey();

        uint8 versionByte = uint8(decoded[0]);
        if (versionByte != 0x30 && versionByte != 0x10) revert HookDataBadStrkey();

        uint16 crc;
        for (uint256 i = 0; i < 33; i++) {
            crc ^= uint16(uint8(decoded[i])) << 8;
            for (uint256 bit = 0; bit < 8; bit++) {
                crc = (crc & 0x8000) != 0 ? (crc << 1) ^ 0x1021 : crc << 1;
            }
        }
        // These casts intentionally select the low/high CRC16 bytes for Stellar's little-endian checksum.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint8 crcLow = uint8(crc);
        // forge-lint: disable-next-line(unsafe-typecast)
        uint8 crcHigh = uint8(crc >> 8);
        if (uint8(decoded[33]) != crcLow || uint8(decoded[34]) != crcHigh) {
            revert HookDataBadStrkey();
        }
    }
}
