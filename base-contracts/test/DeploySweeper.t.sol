// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {DeploySweeper} from "../script/DeploySweeper.s.sol";

contract DeploySweeperTest is Test {
    function test_directBroadcastEntryPointIsPermanentlyQuarantined() public {
        DeploySweeper script = new DeploySweeper();
        (bool ok, bytes memory result) = address(script).call(abi.encodeCall(script.run, ()));

        assertFalse(ok);
        assertGe(result.length, 4);
        assertEq(bytes4(result), bytes4(keccak256("DirectBroadcastDisabled()")));
    }
}
