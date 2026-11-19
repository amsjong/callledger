// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {CallLedger, IAgentID} from "../src/CallLedger.sol";

/// Fork test against the REAL Agent ID registry on BSC mainnet.
/// Run: BSC_RPC_URL=https://bsc-dataseed.bnbchain.org forge test --match-contract Fork -vv
contract CallLedgerForkTest is Test {
    IAgentID constant AGENT_ID = IAgentID(0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F);
    address constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address constant WBNB_USDT_V2 = 0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE; // PancakeSwap v2 pair

    CallLedger ledger;
    address holder;
    address holder2;

    function setUp() public {
        string memory rpc = vm.envOr("BSC_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        // resolve real holders from on-chain handles (no hard-coded assumptions about who holds what)
        holder = _ownerOfHandle("space");
        holder2 = _ownerOfHandle("agent");
        require(holder != address(0) && holder2 != address(0), "handles not registered");
        ledger = new CallLedger(AGENT_ID);
    }

    function _ownerOfHandle(string memory h) internal view returns (address o) {
        (bool ok, bytes memory ret) =
            address(AGENT_ID).staticcall(abi.encodeWithSignature("ownerOfHandle(string)", h));
        require(ok, "ownerOfHandle failed");
        o = abi.decode(ret, (address));
    }

    function test_Fork_RealHolderCommitRevealFollow() public {
        assertGt(AGENT_ID.balanceOf(holder), 0);
        console2.log("holder", holder, AGENT_ID.handleOf(holder));
        bytes32 salt = keccak256("fork-salt");
        bytes32 hash = ledger.computeHash(holder, WBNB, WBNB_USDT_V2, 1, 1 days, salt);
        vm.prank(holder);
        uint256 id = ledger.commit(hash, 1 days);
        assertEq(ledger.getAgent(holder).handle, "space");

        vm.warp(block.timestamp + 1 days);
        vm.roll(block.number + 1);
        vm.prank(holder);
        ledger.reveal(id, WBNB, WBNB_USDT_V2, 1, salt);
        assertEq(uint8(ledger.getCall(id).status), uint8(CallLedger.Status.Revealed));

        vm.prank(holder2);
        ledger.follow(holder);
        assertEq(ledger.getAgent(holder).followers, 1);
    }

    function test_Fork_NonHolderReverts() public {
        address rando = makeAddr("rando-no-agent-id");
        assertEq(AGENT_ID.balanceOf(rando), 0);
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(CallLedger.NotAgentHolder.selector, rando));
        ledger.commit(keccak256("x"), 1 days);
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(CallLedger.NotAgentHolder.selector, rando));
        ledger.follow(holder);
    }
}
