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

    // A real 56-character Stellar G-address, matching the shape the JS validator accepts.
    string constant STRKEY = "GRECIPIENTOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO";

    function setUp() public {
        harness = new HookDataHarness();
    }

    /// Mirrors buildForwarderHookData in frontend/src/base/hookData.js.
    function _build(string memory strkey) internal pure returns (bytes memory) {
        bytes memory s = bytes(strkey);
        return abi.encodePacked(bytes24(0), uint32(0), uint32(s.length), s);
    }

    function test_validate_acceptsWellFormedHookData() public view {
        harness.validate(_build(STRKEY));
    }

    function test_validate_rejectsTooShort() public {
        bytes memory short = new bytes(31);
        vm.expectRevert(abi.encodeWithSelector(HookDataLib.HookDataTooShort.selector, uint256(31)));
        harness.validate(short);
    }

    function test_validate_rejectsNonZeroHeader() public {
        bytes memory s = bytes(STRKEY);
        bytes memory dirty = abi.encodePacked(
            bytes24(uint192(1)), uint32(0), uint32(s.length), s
        );
        vm.expectRevert(HookDataLib.HookDataDirtyHeader.selector);
        harness.validate(dirty);
    }

    function test_validate_rejectsNonZeroVersion() public {
        bytes memory s = bytes(STRKEY);
        bytes memory bad = abi.encodePacked(bytes24(0), uint32(1), uint32(s.length), s);
        vm.expectRevert(abi.encodeWithSelector(HookDataLib.HookDataBadVersion.selector, uint32(1)));
        harness.validate(bad);
    }

    function test_validate_rejectsLengthMismatch() public {
        bytes memory s = bytes(STRKEY);
        bytes memory bad = abi.encodePacked(bytes24(0), uint32(0), uint32(s.length + 1), s);
        vm.expectRevert(
            abi.encodeWithSelector(
                HookDataLib.HookDataLengthMismatch.selector, uint32(s.length + 1), uint256(s.length)
            )
        );
        harness.validate(bad);
    }

    function test_validate_rejectsShortStrkey() public {
        bytes memory bad = _build("GTOOSHORT");
        vm.expectRevert(HookDataLib.HookDataBadStrkey.selector);
        harness.validate(bad);
    }

    function test_validate_rejectsStrkeyOutsideBase32Alphabet() public {
        // 56 chars, but lowercase 'a' is outside [A-Z2-7].
        bytes memory bad = _build("aRECIPIENTOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO");
        vm.expectRevert(HookDataLib.HookDataBadStrkey.selector);
        harness.validate(bad);
    }
}
