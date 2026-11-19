// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {CallLedger, IAgentID, IPoolProbe, IV2Factory, IV3Factory} from "../src/CallLedger.sol";
import {LyingPool} from "./mocks/Mocks.sol";

/// Fork test against the REAL Agent ID registry and REAL PancakeSwap factories on BSC mainnet.
/// Run: BSC_RPC_URL=https://bsc-dataseed.bnbchain.org forge test --match-contract Fork -vv
contract CallLedgerForkTest is Test {
    IAgentID constant AGENT_ID = IAgentID(0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F);
    address constant V2_FACTORY = 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73;
    address constant V3_FACTORY = 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865;
    address constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address constant WBNB_USDT_V2 = 0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE; // PancakeSwap v2 pair
    address constant WBNB_USDT_V3_500 = 0x36696169C63e42cd08ce11f5deeBbCeBae652050; // PancakeSwap v3 pool, 0.05%

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
        ledger = new CallLedger(AGENT_ID, V2_FACTORY, V3_FACTORY);
    }

    function _ownerOfHandle(string memory h) internal view returns (address o) {
        (bool ok, bytes memory ret) = address(AGENT_ID).staticcall(abi.encodeWithSignature("ownerOfHandle(string)", h));
        require(ok, "ownerOfHandle failed");
        o = abi.decode(ret, (address));
    }

    /// The two addresses we hard-code really are the Pancake factories, and the two reference pools really
    /// are canonical under them.
    function test_Fork_FactoriesAndPoolsAreReal() public view {
        assertEq(IPoolProbe(WBNB_USDT_V2).factory(), V2_FACTORY);
        assertEq(IV2Factory(V2_FACTORY).getPair(WBNB, USDT), WBNB_USDT_V2);

        assertEq(IPoolProbe(WBNB_USDT_V3_500).factory(), V3_FACTORY);
        uint24 fee = IPoolProbe(WBNB_USDT_V3_500).fee();
        assertEq(fee, 500);
        assertEq(IV3Factory(V3_FACTORY).getPool(WBNB, USDT, fee), WBNB_USDT_V3_500);

        // and the ledger's own classifier agrees, for both tokens of each pool
        assertEq(ledger.poolKindOf(WBNB, WBNB_USDT_V2), 1);
        assertEq(ledger.poolKindOf(USDT, WBNB_USDT_V2), 1);
        assertEq(ledger.poolKindOf(WBNB, WBNB_USDT_V3_500), 2);
        assertEq(ledger.poolKindOf(USDT, WBNB_USDT_V3_500), 2);
        // a v3 pool is not a v2 pair and vice versa: the kinds are not interchangeable
        assertEq(ledger.poolKindOf(address(this), WBNB_USDT_V2), 0);
    }

    function test_Fork_RealHolderSealedCommitRevealOnV2Pool() public {
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
        CallLedger.Call memory c = ledger.getCall(id);
        assertEq(uint8(c.status), uint8(CallLedger.Status.Revealed));
        assertEq(uint8(c.mode), uint8(CallLedger.Mode.Sealed));
        assertEq(c.poolKind, 1);

        vm.prank(holder2);
        ledger.follow(holder);
        assertEq(ledger.getAgent(holder).followers, 1);
    }

    function test_Fork_RealHolderOpenCallOnV3Pool() public {
        vm.prank(holder2);
        uint256 id = ledger.commitOpen(USDT, WBNB_USDT_V3_500, 2, 4 hours);
        CallLedger.Call memory c = ledger.getCall(id);
        assertEq(c.agent, holder2);
        assertEq(uint8(c.mode), uint8(CallLedger.Mode.Open));
        assertEq(uint8(c.status), uint8(CallLedger.Status.Revealed));
        assertEq(c.token, USDT);
        assertEq(c.pool, WBNB_USDT_V3_500);
        assertEq(c.poolKind, 2);
        assertEq(c.direction, 2);
        assertEq(ledger.getAgent(holder2).openCalls, 1);
        assertEq(ledger.getAgent(holder2).handle, "agent");

        // open calls never forfeit, even long past the reveal window
        vm.warp(block.timestamp + 60 days);
        assertFalse(ledger.isForfeited(id));
        vm.prank(holder);
        vm.expectRevert(CallLedger.NotSealed.selector);
        ledger.markExpired(id);
    }

    /// A pool deployed here that answers factory() == the real v2 factory and token0() == WBNB is still
    /// rejected, because the real factory does not map WBNB/USDT back to it.
    function test_Fork_FakePoolRejected() public {
        address fake = address(new LyingPool(V2_FACTORY, WBNB, USDT, 0));
        assertEq(IPoolProbe(fake).factory(), V2_FACTORY);
        assertEq(IPoolProbe(fake).token0(), WBNB);
        assertEq(ledger.poolKindOf(WBNB, fake), 0);

        vm.prank(holder);
        vm.expectRevert(CallLedger.BadPool.selector);
        ledger.commitOpen(WBNB, fake, 1, 1 days);

        // and the sealed path rejects it at reveal, so the call can only ever forfeit
        bytes32 salt = keccak256("fake");
        bytes32 hash = ledger.computeHash(holder, WBNB, fake, 1, 1 days, salt);
        vm.prank(holder);
        uint256 id = ledger.commit(hash, 1 days);
        vm.warp(block.timestamp + 1 days);
        vm.prank(holder);
        vm.expectRevert(CallLedger.BadPool.selector);
        ledger.reveal(id, WBNB, fake, 1, salt);
        vm.warp(block.timestamp + 7 days + 1);
        assertTrue(ledger.isForfeited(id));

        // a v3 fake with the right factory and fee fails the same way
        address fake3 = address(new LyingPool(V3_FACTORY, WBNB, USDT, 500));
        assertEq(ledger.poolKindOf(WBNB, fake3), 0);
    }

    /// The 60k per-probe cap has to be comfortably enough for the *real* Pancake getters, because a
    /// canonical pool is always Pancake's own fixed bytecode and this contract is immutable. Measure it.
    function test_Fork_RealProbesAreFarInsideTheGasCap() public view {
        uint256 g0 = gasleft();
        assertEq(ledger.poolKindOf(WBNB, WBNB_USDT_V2), 1);
        uint256 usedV2 = g0 - gasleft();

        g0 = gasleft();
        assertEq(ledger.poolKindOf(USDT, WBNB_USDT_V3_500), 2);
        uint256 usedV3 = g0 - gasleft();

        console2.log("poolKindOf gas: v2", usedV2, "v3", usedV3);
        // v2 takes 4 probes, v3 takes 5; all of them together must stay well under a single probe's budget
        assertLt(usedV2, 60_000);
        assertLt(usedV3, 60_000);

        // and a caller who funds the probes gets the truth, not a gas-starved 0
        assertEq(ledger.poolKindOf{gas: 400_000}(WBNB, WBNB_USDT_V2), 1);
        assertEq(ledger.poolKindOf{gas: 400_000}(USDT, WBNB_USDT_V3_500), 2);
    }

    /// A real holder whose Agent ID stops answering mid-horizon must still be able to close out an honest
    /// sealed call instead of being recorded as a forfeiter.
    function test_Fork_RevealSurvivesAgentIdGoingAway() public {
        bytes32 salt = keccak256("lapsed");
        bytes32 hash = ledger.computeHash(holder, WBNB, WBNB_USDT_V2, 2, 1 days, salt);
        vm.prank(holder);
        uint256 id = ledger.commit(hash, 1 days);

        // the registry now reports the holder as holding nothing (expiry / burn / broken registry)
        vm.mockCall(address(AGENT_ID), abi.encodeCall(IAgentID.balanceOf, (holder)), abi.encode(uint256(0)));
        assertEq(AGENT_ID.balanceOf(holder), 0);

        vm.warp(block.timestamp + 1 days);
        vm.prank(holder);
        ledger.reveal(id, WBNB, WBNB_USDT_V2, 2, salt);
        assertEq(uint8(ledger.getCall(id).status), uint8(CallLedger.Status.Revealed));
        assertFalse(ledger.isForfeited(id));

        // new calls are still gated
        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(CallLedger.NotAgentHolder.selector, holder));
        ledger.commitOpen(WBNB, WBNB_USDT_V2, 1, 1 days);
    }

    function test_Fork_NonHolderReverts() public {
        address rando = makeAddr("rando-no-agent-id");
        assertEq(AGENT_ID.balanceOf(rando), 0);
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(CallLedger.NotAgentHolder.selector, rando));
        ledger.commit(keccak256("x"), 1 days);
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(CallLedger.NotAgentHolder.selector, rando));
        ledger.commitOpen(WBNB, WBNB_USDT_V2, 1, 1 days);
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(CallLedger.NotAgentHolder.selector, rando));
        ledger.follow(holder);
    }
}
