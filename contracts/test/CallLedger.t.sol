// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CallLedger, IAgentID} from "../src/CallLedger.sol";
import {
    MockAgentID,
    MockV2Factory,
    MockV3Factory,
    LyingPool,
    RevertingPool,
    ShortReturnPool,
    DirtyWordPool,
    GasBurnerPool,
    CostlyPool
} from "./mocks/Mocks.sol";

contract CallLedgerTest is Test {
    CallLedger ledger;
    MockAgentID aid;
    MockV2Factory v2f;
    MockV3Factory v3f;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address eve = makeAddr("eve"); // no Agent ID
    address token = makeAddr("token");
    address quote = makeAddr("quote");
    address other = makeAddr("other"); // token in no pool

    address v2pool; // canonical v2 pair token/quote
    address v3pool; // canonical v3 pool token/quote, fee 500

    bytes32 salt = keccak256("salt");
    uint32 constant H = 1 days;
    uint24 constant FEE = 500;

    function setUp() public {
        aid = new MockAgentID();
        aid.mint(alice, "alice");
        aid.mint(bob, "bob");
        v2f = new MockV2Factory();
        v3f = new MockV3Factory();
        v2pool = v2f.createPair(token, quote);
        v3pool = v3f.createPool(token, quote, FEE);
        ledger = new CallLedger(aid, address(v2f), address(v3f));
        vm.warp(1_800_000_000);
        vm.roll(1000);
    }

    function _commit(address who, address p, uint8 dir, uint32 h, bytes32 s)
        internal
        returns (uint256 id, bytes32 hash)
    {
        hash = ledger.computeHash(who, token, p, dir, h, s);
        vm.prank(who);
        id = ledger.commit(hash, h);
    }

    // ---------------- gate
    function test_NonHolderCannotCommit() public {
        bytes32 hash = ledger.computeHash(eve, token, v2pool, 1, H, salt);
        vm.prank(eve);
        vm.expectRevert(abi.encodeWithSelector(CallLedger.NotAgentHolder.selector, eve));
        ledger.commit(hash, H);
    }

    function test_NonHolderCannotCommitOpen() public {
        vm.prank(eve);
        vm.expectRevert(abi.encodeWithSelector(CallLedger.NotAgentHolder.selector, eve));
        ledger.commitOpen(token, v2pool, 1, H);
    }

    function test_ConstructorRejectsZero() public {
        vm.expectRevert(CallLedger.ZeroAddress.selector);
        new CallLedger(IAgentID(address(0)), address(v2f), address(v3f));
        vm.expectRevert(CallLedger.ZeroAddress.selector);
        new CallLedger(aid, address(0), address(v3f));
        vm.expectRevert(CallLedger.ZeroAddress.selector);
        new CallLedger(aid, address(v2f), address(0));
    }

    /// One address for both factories would make every v3 pool permanently unclassifiable.
    function test_ConstructorRejectsIdenticalFactories() public {
        vm.expectRevert(CallLedger.SameFactory.selector);
        new CallLedger(aid, address(v2f), address(v2f));
        new CallLedger(aid, address(v2f), address(v3f)); // distinct is fine
    }

    function test_HolderCommitStoresEverything() public {
        (uint256 id, bytes32 hash) = _commit(alice, v2pool, 1, H, salt);
        assertEq(id, 0);
        CallLedger.Call memory c = ledger.getCall(id);
        assertEq(c.agent, alice);
        assertEq(c.commitHash, hash);
        assertEq(c.commitBlock, 1000);
        assertEq(c.commitTime, 1_800_000_000);
        assertEq(c.expiryTime, 1_800_000_000 + H);
        assertEq(uint8(c.status), uint8(CallLedger.Status.Committed));
        assertEq(uint8(c.mode), uint8(CallLedger.Mode.Sealed));
        assertEq(c.poolKind, 0); // pool is still secret
        CallLedger.Agent memory a = ledger.getAgent(alice);
        assertEq(a.handle, "alice");
        assertEq(a.firstSeen, 1_800_000_000);
        assertEq(a.commits, 1);
        assertEq(a.openCalls, 0);
        assertEq(ledger.totalCalls(), 1);
    }

    function test_CommitEmits() public {
        bytes32 hash = ledger.computeHash(alice, token, v2pool, 1, H, salt);
        vm.expectEmit(true, true, false, true);
        emit CallLedger.Committed(0, alice, "alice", hash, H, 1_800_000_000, 1_800_000_000 + H);
        vm.prank(alice);
        ledger.commit(hash, H);
    }

    function test_HorizonBounds() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(CallLedger.BadHorizon.selector, uint32(1 hours - 1)));
        ledger.commit(keccak256("a"), 1 hours - 1);
        vm.expectRevert(abi.encodeWithSelector(CallLedger.BadHorizon.selector, uint32(30 days + 1)));
        ledger.commit(keccak256("b"), 30 days + 1);
        ledger.commit(keccak256("c"), 1 hours);
        ledger.commit(keccak256("d"), 30 days);
        vm.expectRevert(abi.encodeWithSelector(CallLedger.BadHorizon.selector, uint32(1 hours - 1)));
        ledger.commitOpen(token, v2pool, 1, 1 hours - 1);
        vm.expectRevert(abi.encodeWithSelector(CallLedger.BadHorizon.selector, uint32(30 days + 1)));
        ledger.commitOpen(token, v2pool, 1, 30 days + 1);
        vm.stopPrank();
    }

    function test_ZeroAndDuplicateHash() public {
        vm.startPrank(alice);
        vm.expectRevert(CallLedger.ZeroHash.selector);
        ledger.commit(bytes32(0), H);
        ledger.commit(keccak256("x"), H);
        vm.expectRevert(CallLedger.HashAlreadyUsed.selector);
        ledger.commit(keccak256("x"), H);
        vm.stopPrank();
    }

    // ---------------- sealed reveal, valid v2 / v3 pools
    function test_RevealHappyPathV2() public {
        (uint256 id,) = _commit(alice, v2pool, 2, H, salt);
        vm.warp(block.timestamp + H);
        vm.expectEmit(true, true, true, true);
        emit CallLedger.Revealed(id, alice, token, v2pool, ledger.POOL_V2(), 2, 1000, 1_800_000_000, 1_800_000_000 + H);
        vm.prank(alice);
        ledger.reveal(id, token, v2pool, 2, salt);
        CallLedger.Call memory c = ledger.getCall(id);
        assertEq(uint8(c.status), uint8(CallLedger.Status.Revealed));
        assertEq(c.token, token);
        assertEq(c.pool, v2pool);
        assertEq(c.poolKind, 1);
        assertEq(c.direction, 2);
        assertEq(c.revealTime, block.timestamp);
        assertEq(ledger.getAgent(alice).reveals, 1);
        assertFalse(ledger.isForfeited(id));
    }

    function test_RevealHappyPathV3() public {
        (uint256 id,) = _commit(alice, v3pool, 1, H, salt);
        vm.warp(block.timestamp + H);
        vm.prank(alice);
        ledger.reveal(id, token, v3pool, 1, salt);
        CallLedger.Call memory c = ledger.getCall(id);
        assertEq(c.poolKind, 2);
        assertEq(c.pool, v3pool);
    }

    /// Either side of the pair is an acceptable `token`.
    function test_RevealWithToken1() public {
        bytes32 hash = ledger.computeHash(alice, quote, v2pool, 1, H, salt);
        vm.prank(alice);
        uint256 id = ledger.commit(hash, H);
        vm.warp(block.timestamp + H);
        vm.prank(alice);
        ledger.reveal(id, quote, v2pool, 1, salt);
        assertEq(ledger.getCall(id).poolKind, 1);
    }

    // ---------------- pool sanity
    function _expectBadPoolReveal(address t, address p) internal {
        bytes32 s = keccak256(abi.encode(t, p));
        bytes32 hash = ledger.computeHash(alice, t, p, 1, H, s);
        vm.prank(alice);
        uint256 id = ledger.commit(hash, H);
        vm.warp(block.timestamp + H);
        vm.prank(alice);
        vm.expectRevert(CallLedger.BadPool.selector);
        ledger.reveal(id, t, p, 1, s);
        assertEq(ledger.poolKindOf(t, p), 0);
    }

    function test_BadPool_WrongFactory() public {
        address wrong = address(new LyingPool(makeAddr("notAFactory"), token, quote, FEE));
        _expectBadPoolReveal(token, wrong);
    }

    function test_BadPool_TokenNotInPool() public {
        _expectBadPoolReveal(other, v2pool);
        _expectBadPoolReveal(other, v3pool);
    }

    function test_BadPool_NonContract() public {
        _expectBadPoolReveal(token, makeAddr("just-an-eoa"));
    }

    /// The headline case: a pool that answers factory()/token0()/token1() exactly like a real one, but the
    /// factory does not map the pair back to it.
    function test_BadPool_ClaimsRightFactoryButNotCanonical() public {
        address fakeV2 = address(new LyingPool(address(v2f), token, quote, 0));
        _expectBadPoolReveal(token, fakeV2);
        assertEq(v2f.getPair(token, quote), v2pool); // factory still points at the real pair

        address fakeV3 = address(new LyingPool(address(v3f), token, quote, FEE));
        _expectBadPoolReveal(token, fakeV3);

        // ...and one on an unused token pair, where the factory maps nothing at all
        address fakeUnknown = address(new LyingPool(address(v2f), other, quote, 0));
        _expectBadPoolReveal(other, fakeUnknown);
    }

    /// A v3 pool whose fee is not the fee the factory registered it under.
    function test_BadPool_V3FeeMismatch() public {
        address liar = address(new LyingPool(address(v3f), token, quote, 3000));
        _expectBadPoolReveal(token, liar);
    }

    function test_BadPool_HostileReturnData() public {
        _expectBadPoolReveal(token, address(new RevertingPool()));
        _expectBadPoolReveal(token, address(new ShortReturnPool()));
        _expectBadPoolReveal(token, address(new DirtyWordPool()));
    }

    /// The probe gas cap keeps a griefing pool from eating the caller's whole gas limit.
    function test_BadPool_GasBurnerIsContained() public {
        address burner = address(new GasBurnerPool());
        uint256 before = gasleft();
        assertEq(ledger.poolKindOf(token, burner), 0);
        assertLt(before - gasleft(), 300_000);
    }

    /// `poolKindOf` must never silently answer 0 for a pool that really is canonical just because the caller
    /// was stingy with gas: under the 63/64 rule it either gets its full probe budget or reverts.
    /// Pre-fix, gas limits in the ~21k-25k band returned a confident, wrong 0.
    function test_ProbeNeverFalseNegativeUnderTightGas() public {
        address pool = address(new CostlyPool(address(v2f), token, quote));
        v2f.setPair(token, quote, pool); // the factory really does map the pair back to it: canonical
        assertEq(ledger.poolKindOf(token, pool), 1); // the truth, with plenty of gas

        bytes memory cd = abi.encodeCall(CallLedger.poolKindOf, (token, pool));
        uint256 answered;
        for (uint256 g = 5_000; g <= 400_000; g += 1_000) {
            (bool ok, bytes memory ret) = address(ledger).staticcall{gas: g}(cd);
            if (!ok) continue; // reverted (out of gas, or ProbeGasTooLow): acceptable, never a wrong answer
            assertEq(ret.length, 32);
            assertEq(abi.decode(ret, (uint256)), 1, "false negative: canonical pool reported as 0");
            answered++;
        }
        assertGt(answered, 0); // the scan really did reach the succeeding range
    }

    /// The explicit error when the caller cannot fund even the first probe.
    function test_ProbeGasTooLow() public view {
        bytes memory cd = abi.encodeCall(CallLedger.poolKindOf, (token, v2pool));
        (bool ok, bytes memory ret) = address(ledger).staticcall{gas: 40_000}(cd);
        assertFalse(ok);
        assertEq(bytes4(ret), CallLedger.ProbeGasTooLow.selector);
    }

    function test_PoolKindOfZeroAddresses() public view {
        assertEq(ledger.poolKindOf(address(0), v2pool), 0);
        assertEq(ledger.poolKindOf(token, address(0)), 0);
        assertEq(ledger.poolKindOf(token, v2pool), 1);
        assertEq(ledger.poolKindOf(token, v3pool), 2);
    }

    function test_CommitOpenBadPoolReverts() public {
        address liar = address(new LyingPool(address(v2f), token, quote, 0));
        vm.startPrank(alice);
        vm.expectRevert(CallLedger.BadPool.selector);
        ledger.commitOpen(token, liar, 1, H);
        vm.expectRevert(CallLedger.BadPool.selector);
        ledger.commitOpen(other, v2pool, 1, H);
        vm.expectRevert(CallLedger.BadPool.selector);
        ledger.commitOpen(token, address(0), 1, H);
        vm.stopPrank();
        assertEq(ledger.totalCalls(), 0);
    }

    // ---------------- open mode
    function test_OpenCallHappyPathAndEvents() public {
        vm.expectEmit(true, true, false, true);
        emit CallLedger.Committed(0, alice, "alice", bytes32(0), H, 1_800_000_000, 1_800_000_000 + H);
        vm.expectEmit(true, true, true, true);
        emit CallLedger.OpenCall(0, alice, token, "alice", v3pool, 2, 2, H, 1000, 1_800_000_000, 1_800_000_000 + H);
        vm.prank(alice);
        uint256 id = ledger.commitOpen(token, v3pool, 2, H);

        CallLedger.Call memory c = ledger.getCall(id);
        assertEq(c.agent, alice);
        assertEq(uint8(c.mode), uint8(CallLedger.Mode.Open));
        assertEq(uint8(c.status), uint8(CallLedger.Status.Revealed)); // published immediately
        assertEq(c.commitHash, bytes32(0));
        assertEq(c.token, token);
        assertEq(c.pool, v3pool);
        assertEq(c.poolKind, 2);
        assertEq(c.direction, 2);
        assertEq(c.horizon, H);
        assertEq(c.commitBlock, 1000);
        assertEq(c.commitTime, 1_800_000_000);
        assertEq(c.revealTime, 1_800_000_000);
        assertEq(c.expiryTime, 1_800_000_000 + H);

        CallLedger.Agent memory a = ledger.getAgent(alice);
        assertEq(a.commits, 1);
        assertEq(a.openCalls, 1);
        assertEq(a.reveals, 0); // open calls are not sealed reveals
        assertEq(ledger.callCountOf(alice), 1);
        assertEq(ledger.callsOf(alice, 0, 10)[0], id);
    }

    function test_OpenCallBadDirection() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CallLedger.BadDirection.selector, uint8(0)));
        ledger.commitOpen(token, v2pool, 0, H);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CallLedger.BadDirection.selector, uint8(3)));
        ledger.commitOpen(token, v2pool, 3, H);
    }

    function test_OpenCallCannotBeRevealedOrForfeited() public {
        vm.prank(alice);
        uint256 id = ledger.commitOpen(token, v2pool, 1, H);

        vm.warp(block.timestamp + H + 7 days + 1);
        assertFalse(ledger.isForfeited(id)); // never forfeits

        vm.prank(alice);
        vm.expectRevert(CallLedger.NotSealed.selector);
        ledger.reveal(id, token, v2pool, 1, salt);

        vm.prank(bob);
        vm.expectRevert(CallLedger.NotSealed.selector);
        ledger.markExpired(id);

        vm.warp(block.timestamp + 365 days);
        assertFalse(ledger.isForfeited(id));
        assertEq(uint8(ledger.getCall(id).status), uint8(CallLedger.Status.Revealed));
        assertEq(ledger.getAgent(alice).forfeits, 0);
    }

    function test_OpenCallsDoNotTouchHashUsed() public {
        vm.startPrank(alice);
        ledger.commitOpen(token, v2pool, 1, H);
        ledger.commitOpen(token, v2pool, 1, H); // identical open calls are fine
        vm.stopPrank();
        assertFalse(ledger.hashUsed(alice, bytes32(0)));
        assertEq(ledger.getAgent(alice).openCalls, 2);
    }

    function test_MixedModeStats() public {
        // 1 open, 1 sealed+revealed, 1 sealed+forfeited
        vm.prank(alice);
        ledger.commitOpen(token, v2pool, 1, H);
        (uint256 sealedId,) = _commit(alice, v2pool, 1, H, salt);
        (uint256 deadId,) = _commit(alice, v3pool, 2, H, keccak256("s2"));

        vm.warp(block.timestamp + H);
        vm.prank(alice);
        ledger.reveal(sealedId, token, v2pool, 1, salt);

        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(bob);
        ledger.markExpired(deadId);

        CallLedger.Agent memory a = ledger.getAgent(alice);
        assertEq(a.commits, 3);
        assertEq(a.openCalls, 1);
        assertEq(a.reveals, 1);
        assertEq(a.forfeits, 1);
        assertEq(ledger.callCountOf(alice), 3);
    }

    // ---------------- reveal rules
    function test_EarlyRevealReverts() public {
        (uint256 id,) = _commit(alice, v2pool, 1, H, salt);
        vm.warp(block.timestamp + H - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CallLedger.TooEarly.selector, uint64(1_800_000_000 + H)));
        ledger.reveal(id, token, v2pool, 1, salt);
    }

    function test_LateRevealReverts() public {
        (uint256 id,) = _commit(alice, v2pool, 1, H, salt);
        uint64 deadline = uint64(1_800_000_000 + H + 7 days);
        vm.warp(deadline); // last valid second
        assertFalse(ledger.isForfeited(id));
        assertEq(ledger.revealDeadline(id), deadline);
        vm.warp(deadline + 1);
        assertTrue(ledger.isForfeited(id));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CallLedger.RevealWindowClosed.selector, deadline));
        ledger.reveal(id, token, v2pool, 1, salt);
    }

    function test_RevealAtDeadlineWorks() public {
        (uint256 id,) = _commit(alice, v2pool, 1, H, salt);
        vm.warp(1_800_000_000 + H + 7 days);
        vm.prank(alice);
        ledger.reveal(id, token, v2pool, 1, salt);
    }

    function test_WrongHashReverts() public {
        (uint256 id,) = _commit(alice, v2pool, 1, H, salt);
        vm.warp(block.timestamp + H);
        vm.startPrank(alice);
        vm.expectRevert(CallLedger.HashMismatch.selector);
        ledger.reveal(id, token, v2pool, 2, salt); // flipped direction
        vm.expectRevert(CallLedger.HashMismatch.selector);
        ledger.reveal(id, token, v2pool, 1, keccak256("other"));
        vm.expectRevert(CallLedger.HashMismatch.selector);
        ledger.reveal(id, quote, v2pool, 1, salt); // other (valid) token of the same pool
        vm.expectRevert(CallLedger.HashMismatch.selector);
        ledger.reveal(id, token, v3pool, 1, salt); // other (valid) pool
        vm.expectRevert(abi.encodeWithSelector(CallLedger.BadDirection.selector, uint8(3)));
        ledger.reveal(id, token, v2pool, 3, salt);
        vm.stopPrank();
    }

    function test_OnlyCommitterCanReveal() public {
        (uint256 id,) = _commit(alice, v2pool, 1, H, salt);
        vm.warp(block.timestamp + H);
        vm.prank(bob);
        vm.expectRevert(CallLedger.NotCommitter.selector);
        ledger.reveal(id, token, v2pool, 1, salt);
    }

    function test_DoubleRevealReverts() public {
        (uint256 id,) = _commit(alice, v2pool, 1, H, salt);
        vm.warp(block.timestamp + H);
        vm.startPrank(alice);
        ledger.reveal(id, token, v2pool, 1, salt);
        vm.expectRevert(CallLedger.NotCommittedState.selector);
        ledger.reveal(id, token, v2pool, 1, salt);
        vm.stopPrank();
    }

    /// Bob copies Alice's hash (from mempool or chain). He can commit it, but can never reveal it,
    /// and it does not block Alice (hash uniqueness is per agent, so no front-run griefing).
    function test_CopyHashAttack() public {
        bytes32 h = ledger.computeHash(alice, token, v2pool, 1, H, salt);
        vm.prank(bob);
        uint256 stolen = ledger.commit(h, H); // bob front-runs with alice's hash
        vm.prank(alice);
        uint256 mine = ledger.commit(h, H); // alice is not blocked
        vm.warp(block.timestamp + H);
        vm.prank(bob);
        vm.expectRevert(CallLedger.HashMismatch.selector); // hash binds alice's address
        ledger.reveal(stolen, token, v2pool, 1, salt);
        vm.prank(bob);
        vm.expectRevert(CallLedger.NotCommitter.selector);
        ledger.reveal(mine, token, v2pool, 1, salt);
        vm.prank(alice);
        ledger.reveal(mine, token, v2pool, 1, salt);
        vm.warp(block.timestamp + 8 days);
        assertTrue(ledger.isForfeited(stolen)); // bob's copied call becomes a loss for bob
    }

    // ---------------- forfeit
    function test_Forfeit() public {
        (uint256 id,) = _commit(alice, v2pool, 1, H, salt);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CallLedger.StillRevealable.selector, uint64(1_800_000_000 + H + 7 days)));
        ledger.markExpired(id);

        vm.warp(1_800_000_000 + H + 7 days + 1);
        vm.prank(eve);
        vm.expectRevert(abi.encodeWithSelector(CallLedger.NotAgentHolder.selector, eve));
        ledger.markExpired(id);

        vm.expectEmit(true, true, true, true);
        emit CallLedger.Forfeited(id, alice, bob);
        vm.prank(bob);
        ledger.markExpired(id);
        assertTrue(ledger.isForfeited(id));
        assertEq(ledger.getAgent(alice).forfeits, 1);
        assertEq(uint8(ledger.getCall(id).status), uint8(CallLedger.Status.Forfeited));

        vm.prank(bob);
        vm.expectRevert(CallLedger.NotCommittedState.selector);
        ledger.markExpired(id);
    }

    function test_CannotForfeitRevealed() public {
        (uint256 id,) = _commit(alice, v2pool, 1, H, salt);
        vm.warp(block.timestamp + H);
        vm.prank(alice);
        ledger.reveal(id, token, v2pool, 1, salt);
        vm.warp(block.timestamp + 30 days);
        vm.prank(bob);
        vm.expectRevert(CallLedger.NotCommittedState.selector);
        ledger.markExpired(id);
        assertFalse(ledger.isForfeited(id));
    }

    function test_UnknownCall() public {
        vm.expectRevert(abi.encodeWithSelector(CallLedger.UnknownCall.selector, uint256(5)));
        ledger.getCall(5);
    }

    // ---------------- follow
    function test_FollowRules() public {
        vm.prank(eve);
        vm.expectRevert(abi.encodeWithSelector(CallLedger.NotAgentHolder.selector, eve));
        ledger.follow(alice);

        vm.startPrank(alice);
        vm.expectRevert(CallLedger.SelfFollow.selector);
        ledger.follow(alice);
        vm.expectRevert(abi.encodeWithSelector(CallLedger.NotAgentHolder.selector, eve));
        ledger.follow(eve);

        vm.expectEmit(true, true, false, false);
        emit CallLedger.Followed(alice, bob);
        ledger.follow(bob);
        assertTrue(ledger.isFollowing(alice, bob));
        assertEq(ledger.getAgent(bob).followers, 1);
        assertEq(ledger.getAgent(bob).handle, "bob"); // snapshot on being followed
        assertEq(ledger.getAgent(bob).firstSeen, 0); // but bob never interacted himself
        assertEq(ledger.getAgent(alice).following, 1);

        vm.expectRevert(CallLedger.AlreadyFollowing.selector);
        ledger.follow(bob);

        ledger.unfollow(bob);
        assertEq(ledger.getAgent(bob).followers, 0);
        assertEq(ledger.getAgent(alice).following, 0);
        vm.expectRevert(CallLedger.NotFollowing.selector);
        ledger.unfollow(bob);
        vm.stopPrank();
    }

    // ---------------- the gate must not strand an in-flight obligation
    /// An Agent ID that lapses, is burned, or whose registry stops answering mid-horizon must not turn an
    /// honest sealed call into a forfeit: `reveal` is authenticated by the commit itself, not by the gate.
    function test_RevealSurvivesLosingAgentId() public {
        (uint256 id,) = _commit(alice, v2pool, 1, H, salt);
        aid.mint(alice, ""); // Agent ID revoked / expired: balanceOf -> 0
        assertEq(aid.balanceOf(alice), 0);

        vm.warp(block.timestamp + H);
        vm.prank(alice);
        ledger.reveal(id, token, v2pool, 1, salt);
        assertEq(uint8(ledger.getCall(id).status), uint8(CallLedger.Status.Revealed));
        assertEq(ledger.getAgent(alice).reveals, 1);
        assertEq(ledger.getAgent(alice).handle, "alice"); // snapshot from the commit is untouched

        // ...but the gate still holds for making *new* calls
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CallLedger.NotAgentHolder.selector, alice));
        ledger.commit(keccak256("new"), H);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CallLedger.NotAgentHolder.selector, alice));
        ledger.commitOpen(token, v2pool, 1, H);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CallLedger.NotAgentHolder.selector, alice));
        ledger.follow(bob);
    }

    /// Ungating `reveal` must not weaken it: a non-holder who did not commit still gets nowhere.
    function test_UngatedRevealIsStillOnlyTheCommitter() public {
        (uint256 id,) = _commit(alice, v2pool, 1, H, salt);
        vm.warp(block.timestamp + H);
        vm.prank(eve); // never held an Agent ID, and knows the full preimage
        vm.expectRevert(CallLedger.NotCommitter.selector);
        ledger.reveal(id, token, v2pool, 1, salt);
    }

    /// Nobody should be stuck following forever because their own Agent ID lapsed.
    function test_UnfollowSurvivesLosingAgentId() public {
        vm.prank(alice);
        ledger.follow(bob);
        aid.mint(alice, "");
        vm.prank(alice);
        ledger.unfollow(bob);
        assertFalse(ledger.isFollowing(alice, bob));
        assertEq(ledger.getAgent(bob).followers, 0);
        assertEq(ledger.getAgent(alice).following, 0);
    }

    /// Ungating `unfollow` only ever removes the caller's own follow.
    function test_UngatedUnfollowTouchesNothingElse() public {
        vm.prank(alice);
        ledger.follow(bob);
        vm.prank(eve);
        vm.expectRevert(CallLedger.NotFollowing.selector);
        ledger.unfollow(bob);
        assertEq(ledger.getAgent(bob).followers, 1);
        assertTrue(ledger.isFollowing(alice, bob));
    }

    function test_HandleSnapshotIsSticky() public {
        _commit(alice, v2pool, 1, H, salt);
        aid.mint(alice, "renamed");
        _commit(alice, v2pool, 1, H, keccak256("2"));
        assertEq(ledger.getAgent(alice).handle, "alice");
    }

    // ---------------- pagination
    function test_Pagination() public {
        for (uint256 i; i < 7; ++i) {
            _commit(alice, v2pool, 1, H, bytes32(i + 100));
            _commit(bob, v2pool, 1, H, bytes32(i + 200));
        }
        assertEq(ledger.callCountOf(alice), 7);
        uint256[] memory p1 = ledger.callsOf(alice, 0, 3);
        assertEq(p1.length, 3);
        assertEq(p1[0], 0);
        assertEq(p1[1], 2);
        assertEq(p1[2], 4);
        uint256[] memory p3 = ledger.callsOf(alice, 6, 3);
        assertEq(p3.length, 1);
        assertEq(p3[0], 12);
        assertEq(ledger.callsOf(alice, 7, 3).length, 0);
        assertEq(ledger.callsOf(eve, 0, 10).length, 0);
        vm.expectRevert(CallLedger.PageTooLarge.selector);
        ledger.callsOf(alice, 0, 201);
    }

    // ---------------- fuzz
    function testFuzz_SealedRoundTrip(bool useV3, bool long, uint32 h, bytes32 s) public {
        address p = useV3 ? v3pool : v2pool;
        h = uint32(bound(h, 1 hours, 30 days));
        uint8 d = long ? 1 : 2;
        bytes32 hash = ledger.computeHash(alice, token, p, d, h, s);
        vm.prank(alice);
        uint256 id = ledger.commit(hash, h);
        vm.warp(block.timestamp + h);
        vm.prank(alice);
        ledger.reveal(id, token, p, d, s);
        CallLedger.Call memory c = ledger.getCall(id);
        assertEq(c.token, token);
        assertEq(c.poolKind, useV3 ? 2 : 1);
    }

    /// No arbitrary address passes the pool check.
    function testFuzz_ArbitraryPoolRejected(address t, address p) public view {
        vm.assume(p != v2pool && p != v3pool);
        assertEq(ledger.poolKindOf(t, p), 0);
    }
}
