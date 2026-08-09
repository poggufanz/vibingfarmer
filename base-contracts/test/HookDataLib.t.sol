// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {HookDataLib} from "../src/HookDataLib.sol";

/// External wrapper so `vm.expectRevert` can target a call boundary — an
/// internal library call would inline and revert inside the test frame.
contract HookDataHarness {
    function validate(bytes calldata hookData) external pure {
        HookDataLib.validate(hookData);
    }
}

contract HookDataLibTest is Test {
    HookDataHarness harness;

    string constant VALID_G = "GAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCF6M";
    string constant VALID_C = "CAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRDB3V";
    string constant STALE_PAYLOAD = "GAIRCEIRCEIRCEIRCEIRCEIRAEIRCEIRCEIRCEIRCEIRCEIRCEIRCF6M";
    string constant MUTATED_CHECKSUM = "GAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCFWM";
    string constant SWAPPED_CHECKSUM = "GAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRDTAX";
    string constant VALID_UNSUPPORTED_T = "TAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRDYM5";

    function setUp() public {
        harness = new HookDataHarness();
    }

    /// Mirrors buildForwarderHookData in frontend/src/base/hookData.js.
    function _build(string memory strkey) internal pure returns (bytes memory) {
        bytes memory s = bytes(strkey);
        return abi.encodePacked(bytes24(0), uint32(0), uint32(s.length), s);
    }

    function test_acceptsExactSdkGeneratedGAndC() public view {
        harness.validate(_build(VALID_G));
        harness.validate(_build(VALID_C));
    }

    function test_rejectsMutatedPayloadWithStaleChecksum() public {
        vm.expectRevert(HookDataLib.HookDataBadStrkey.selector);
        harness.validate(_build(STALE_PAYLOAD));
    }

    function test_rejectsMutatedChecksum() public {
        vm.expectRevert(HookDataLib.HookDataBadStrkey.selector);
        harness.validate(_build(MUTATED_CHECKSUM));
    }

    function test_rejectsBigEndianChecksumOrder() public {
        vm.expectRevert(HookDataLib.HookDataBadStrkey.selector);
        harness.validate(_build(SWAPPED_CHECKSUM));
    }

    function test_rejectsUnsupportedVersionWithValidChecksum() public {
        vm.expectRevert(HookDataLib.HookDataBadStrkey.selector);
        harness.validate(_build(VALID_UNSUPPORTED_T));
    }

    function test_validate_rejectsTooShort() public {
        bytes memory short = new bytes(31);
        vm.expectRevert(abi.encodeWithSelector(HookDataLib.HookDataTooShort.selector, uint256(31)));
        harness.validate(short);
    }

    function test_validate_rejectsNonZeroHeader() public {
        bytes memory s = bytes(VALID_G);
        bytes memory dirty = abi.encodePacked(bytes24(uint192(1)), uint32(0), uint32(s.length), s);
        vm.expectRevert(HookDataLib.HookDataDirtyHeader.selector);
        harness.validate(dirty);
    }

    function test_validate_rejectsNonZeroVersion() public {
        bytes memory s = bytes(VALID_G);
        bytes memory bad = abi.encodePacked(bytes24(0), uint32(1), uint32(s.length), s);
        vm.expectRevert(abi.encodeWithSelector(HookDataLib.HookDataBadVersion.selector, uint32(1)));
        harness.validate(bad);
    }

    function test_validate_rejectsLengthMismatch() public {
        bytes memory s = bytes(VALID_G);
        bytes memory bad = abi.encodePacked(bytes24(0), uint32(0), uint32(s.length + 1), s);
        vm.expectRevert(
            abi.encodeWithSelector(HookDataLib.HookDataLengthMismatch.selector, uint32(s.length + 1), uint256(s.length))
        );
        harness.validate(bad);
    }

    function test_validate_rejectsShortStrkey() public {
        bytes memory bad = _build("GTOOSHORT");
        vm.expectRevert(HookDataLib.HookDataBadStrkey.selector);
        harness.validate(bad);
    }

    function test_rejectsLength55And57() public {
        bytes memory valid = bytes(VALID_G);
        bytes memory shortKey = new bytes(55);
        for (uint256 i; i < shortKey.length; i++) {
            shortKey[i] = valid[i];
        }
        vm.expectRevert(HookDataLib.HookDataBadStrkey.selector);
        harness.validate(_build(string(shortKey)));

        bytes memory longKey = abi.encodePacked(valid, bytes1("A"));
        vm.expectRevert(HookDataLib.HookDataBadStrkey.selector);
        harness.validate(_build(string(longKey)));
    }

    function test_rejectsInvalidBase32SymbolsLowercaseAndNonAscii() public {
        bytes memory invalid = hex"303138393d61ff"; // 0, 1, 8, 9, =, lowercase, non-ASCII
        for (uint256 i; i < invalid.length; i++) {
            bytes memory candidate = bytes(VALID_G);
            candidate[10] = invalid[i];
            vm.expectRevert(HookDataLib.HookDataBadStrkey.selector);
            harness.validate(_build(string(candidate)));
        }
    }

    function test_decodesExactly35Bytes() public pure {
        assertTrue(_oracle(bytes(VALID_G)));
        assertTrue(_oracle(bytes(VALID_C)));
        assertEq(bytes(VALID_G).length * 5, 35 * 8, "56 Base32 symbols must decode to exactly 35 bytes");
    }

    function test_validate_rejectsStrkeyOutsideBase32Alphabet() public {
        // 56 chars, but lowercase 'a' is outside [A-Z2-7].
        bytes memory bad = _build("aRECIPIENTOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO");
        vm.expectRevert(HookDataLib.HookDataBadStrkey.selector);
        harness.validate(bad);
    }

    function testFuzz_knownValidGAndCMutationsMatchIndependentOracle(
        bool useContract,
        uint8 versionSeed,
        uint8 payloadIndexSeed,
        uint8 payloadValueSeed,
        uint8 invalidIndexSeed,
        uint8 invalidValueSeed,
        uint8 checksumIndexSeed,
        uint8 checksumValueSeed
    ) public view {
        bytes memory valid = _knownVector(useContract);
        assertTrue(_oracle(valid), "fixture must be accepted by the independent oracle");
        _assertProductionMatchesOracle(valid);

        bytes memory versionMutation = _knownVector(useContract);
        versionMutation[0] = _differentBase32Symbol(versionMutation[0], versionSeed);
        assertFalse(_oracle(versionMutation), "changed version symbol must invalidate the vector");
        _assertProductionMatchesOracle(versionMutation);

        bytes memory payloadMutation = _knownVector(useContract);
        uint256 payloadIndex = 2 + uint256(payloadIndexSeed) % 50; // symbols wholly inside the 32-byte payload
        payloadMutation[payloadIndex] = _differentBase32Symbol(payloadMutation[payloadIndex], payloadValueSeed);
        assertFalse(_oracle(payloadMutation), "changed payload with stale checksum must be rejected");
        _assertProductionMatchesOracle(payloadMutation);

        bytes memory alphabetMutation = _knownVector(useContract);
        bytes memory invalidAlphabet = hex"303138393d61ff"; // 0, 1, 8, 9, =, lowercase, non-ASCII
        alphabetMutation[uint256(invalidIndexSeed) % alphabetMutation.length] =
            invalidAlphabet[uint256(invalidValueSeed) % invalidAlphabet.length];
        assertFalse(_oracle(alphabetMutation), "non-Base32 symbol must be rejected");
        _assertProductionMatchesOracle(alphabetMutation);

        bytes memory checksumMutation = _knownVector(useContract);
        uint256 checksumIndex = 53 + uint256(checksumIndexSeed) % 3; // symbols wholly inside the CRC16 bytes
        checksumMutation[checksumIndex] = _differentBase32Symbol(checksumMutation[checksumIndex], checksumValueSeed);
        assertFalse(_oracle(checksumMutation), "changed checksum symbol must be rejected");
        _assertProductionMatchesOracle(checksumMutation);
    }

    function _knownVector(bool useContract) private pure returns (bytes memory) {
        return bytes(useContract ? VALID_C : VALID_G);
    }

    function _differentBase32Symbol(bytes1 current, uint8 seed) private pure returns (bytes1) {
        bytes memory alphabet = bytes("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567");
        uint256 index = uint256(seed) % alphabet.length;
        if (alphabet[index] == current) index = (index + 1) % alphabet.length;
        return alphabet[index];
    }

    function _assertProductionMatchesOracle(bytes memory candidate) private view {
        bool expected = _oracle(candidate);
        bytes memory envelope = abi.encodePacked(bytes24(0), uint32(0), uint32(candidate.length), candidate);
        (bool accepted,) = address(harness).staticcall(abi.encodeCall(harness.validate, (envelope)));
        assertEq(accepted, expected, "production and independent StrKey oracle disagree");
    }

    function _oracle(bytes memory encoded) private pure returns (bool) {
        if (encoded.length != 56) return false;
        bytes memory decoded = new bytes(35);
        uint256 acc;
        uint256 bits;
        uint256 out;
        for (uint256 i; i < encoded.length; i++) {
            uint8 c = uint8(encoded[i]);
            uint8 v;
            if (c >= 65 && c <= 90) v = c - 65;
            else if (c >= 50 && c <= 55) v = c - 50 + 26;
            else return false;
            acc = (acc << 5) | v;
            bits += 5;
            if (bits >= 8) {
                bits -= 8;
                // forge-lint: disable-next-line(unsafe-typecast)
                decoded[out++] = bytes1(uint8(acc >> bits));
                acc &= (uint256(1) << bits) - 1;
            }
        }
        if (out != 35 || bits != 0 || (decoded[0] != 0x30 && decoded[0] != 0x10)) return false;
        uint16 crc;
        for (uint256 i; i < 33; i++) {
            crc ^= uint16(uint8(decoded[i])) << 8;
            for (uint256 j; j < 8; j++) {
                crc = (crc & 0x8000) != 0 ? (crc << 1) ^ 0x1021 : crc << 1;
            }
        }
        // forge-lint: disable-next-line(unsafe-typecast)
        uint8 low = uint8(crc);
        // forge-lint: disable-next-line(unsafe-typecast)
        uint8 high = uint8(crc >> 8);
        return uint8(decoded[33]) == low && uint8(decoded[34]) == high;
    }
}
