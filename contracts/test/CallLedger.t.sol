// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CallLedger, IAgentID} from "../src/CallLedger.sol";

contract MockAgentID is IAgentID {
    mapping(address => string) public handles;

    function mint(address to, string calldata h) external {
        handles[to] = h;
    }

    function balanceOf(address o) external view returns (uint256) {
        return bytes(handles[o]).length > 0 ? 1 : 0;
    }

    function handleOf(address o) external view returns (string memory) {
        return handles[o];
    }
}

contract CallLedgerTest is Test {
    CallLedger ledger;
    MockAgentID aid;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address eve = makeAddr("eve"); // no Agent ID
    address token = makeAddr("token");
    address pool = makeAddr("pool");
    bytes32 salt = keccak256("salt");
    uint32 constant H = 1 days;

    function setUp() public {
        aid = new MockAgentID();
        aid.mint(alice, "alice");
        aid.mint(bob, "bob");
        ledger = new CallLedger(aid);
        vm.warp(1_800_000_000);
        vm.roll(1000);
    }

    function _commit(address who, uint8 dir, uint32 h, bytes32 s) internal returns (uint256 id, bytes32 hash) {
        hash = ledger.computeHash(who, token, pool, dir, h, s);
        vm.prank(who);
        id = ledger.commit(hash, h);
    }

    // ---------------- gate
    function test_NonHolderCannotCommit() public {
        bytes32 hash = ledger.computeHash(eve, token, pool, 1, H, salt);
        vm.prank(eve);
        vm.expectRevert(abi.encodeWithSelector(CallLedger.NotAgentHolder.selector, eve));
        ledger.commit(hash, H);
    }

    function test_HolderCommitStoresEverything() public {
        (uint256 id, bytes32 hash) = _commit(alice, 1, H, salt);
        assertEq(id, 0);
        CallLedger.Call memory c = ledger.getCall(id);
        assertEq(c.agent, alice);
        assertEq(c.commitHash, hash);
        assertEq(c.commitBlock, 1000);
        assertEq(c.commitTime, 1_800_000_000);
        assertEq(c.expiryTime, 1_800_000_000 + H);
        assertEq(uint8(c.status), uint8(CallLedger.Status.Committed));
        CallLedger.Agent memory a = ledger.getAgent(alice);
        assertEq(a.handle, "alice");
        assertEq(a.firstSeen, 1_800_000_000);
        assertEq(a.commits, 1);
        assertEq(ledger.totalCalls(), 1);
    }

    function test_CommitEmits() public {
        bytes32 hash = ledger.computeHash(alice, token, pool, 1, H, salt);
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

    // ---------------- reveal
    function test_RevealHappyPath() public {
        (uint256 id,) = _commit(alice, 2, H, salt);
        vm.warp(block.timestamp + H);
        vm.expectEmit(true, true, true, true);
        emit CallLedger.Revealed(id, alice, token, pool, 2, 1000, 1_800_000_000, 1_800_000_000 + H);
        vm.prank(alice);
        ledger.reveal(id, token, pool, 2, salt);
        CallLedger.Call memory c = ledger.getCall(id);
        assertEq(uint8(c.status), uint8(CallLedger.Status.Revealed));
        assertEq(c.token, token);
        assertEq(c.pool, pool);
        assertEq(c.direction, 2);
        assertEq(ledger.getAgent(alice).reveals, 1);
        assertFalse(ledger.isForfeited(id));
    }

    function test_EarlyRevealReverts() public {
        (uint256 id,) = _commit(alice, 1, H, salt);
        vm.warp(block.timestamp + H - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CallLedger.TooEarly.selector, uint64(1_800_000_000 + H)));
        ledger.reveal(id, token, pool, 1, salt);
    }

    function test_LateRevealReverts() public {
        (uint256 id,) = _commit(alice, 1, H, salt);
        uint64 deadline = uint64(1_800_000_000 + H + 7 days);
        vm.warp(deadline); // last valid second
        assertFalse(ledger.isForfeited(id));
        vm.warp(deadline + 1);
        assertTrue(ledger.isForfeited(id));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CallLedger.RevealWindowClosed.selector, deadline));
        ledger.reveal(id, token, pool, 1, salt);
    }

    function test_RevealAtDeadlineWorks() public {
        (uint256 id,) = _commit(alice, 1, H, salt);
        vm.warp(1_800_000_000 + H + 7 days);
        vm.prank(alice);
        ledger.reveal(id, token, pool, 1, salt);
    }

    function test_WrongHashReverts() public {
        (uint256 id,) = _commit(alice, 1, H, salt);
        vm.warp(block.timestamp + H);
        vm.startPrank(alice);
        vm.expectRevert(CallLedger.HashMismatch.selector);
        ledger.reveal(id, token, pool, 2, salt); // flipped direction
        vm.expectRevert(CallLedger.HashMismatch.selector);
        ledger.reveal(id, token, pool, 1, keccak256("other"));
        vm.expectRevert(CallLedger.HashMismatch.selector);
        ledger.reveal(id, makeAddr("t2"), pool, 1, salt);
        vm.expectRevert(abi.encodeWithSelector(CallLedger.BadDirection.selector, uint8(3)));
        ledger.reveal(id, token, pool, 3, salt);
        vm.stopPrank();
    }

    function test_OnlyCommitterCanReveal() public {
        (uint256 id,) = _commit(alice, 1, H, salt);
        vm.warp(block.timestamp + H);
        vm.prank(bob);
        vm.expectRevert(CallLedger.NotCommitter.selector);
        ledger.reveal(id, token, pool, 1, salt);
    }

    function test_DoubleRevealReverts() public {
        (uint256 id,) = _commit(alice, 1, H, salt);
        vm.warp(block.timestamp + H);
        vm.startPrank(alice);
        ledger.reveal(id, token, pool, 1, salt);
        vm.expectRevert(CallLedger.NotCommittedState.selector);
        ledger.reveal(id, token, pool, 1, salt);
        vm.stopPrank();
    }

    /// Bob copies Alice's hash right after seeing it in the mempool / chain.
    function test_CopyHashAttack() public {
        (, bytes32 aliceHash) = _commit(alice, 1, H, salt);
        // exact copy is rejected outright
        vm.prank(bob);
        vm.expectRevert(CallLedger.HashAlreadyUsed.selector);
        ledger.commit(aliceHash, H);

        // front-run variant: bob commits alice's hash first; alice's tx then fails, but bob can never reveal it
        bytes32 h2 = ledger.computeHash(alice, token, pool, 2, H, keccak256("s2"));
        vm.prank(bob);
        uint256 stolen = ledger.commit(h2, H);
        vm.warp(block.timestamp + H);
        vm.prank(bob);
        vm.expectRevert(CallLedger.HashMismatch.selector); // hash binds alice's address, not bob's
        ledger.reveal(stolen, token, pool, 2, keccak256("s2"));
    }

    // ---------------- forfeit
    function test_Forfeit() public {
        (uint256 id,) = _commit(alice, 1, H, salt);
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
        (uint256 id,) = _commit(alice, 1, H, salt);
        vm.warp(block.timestamp + H);
        vm.prank(alice);
        ledger.reveal(id, token, pool, 1, salt);
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

    function test_HandleSnapshotIsSticky() public {
        _commit(alice, 1, H, salt);
        aid.mint(alice, "renamed");
        _commit(alice, 1, H, keccak256("2"));
        assertEq(ledger.getAgent(alice).handle, "alice");
    }

    // ---------------- pagination
    function test_Pagination() public {
        for (uint256 i; i < 7; ++i) {
            _commit(alice, 1, H, bytes32(i + 100));
            _commit(bob, 1, H, bytes32(i + 200));
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
    function testFuzz_RevealRoundTrip(address t, address p, bool long, uint32 h, bytes32 s) public {
        vm.assume(t != address(0) && p != address(0));
        h = uint32(bound(h, 1 hours, 30 days));
        uint8 d = long ? 1 : 2;
        bytes32 hash = ledger.computeHash(alice, t, p, d, h, s);
        vm.prank(alice);
        uint256 id = ledger.commit(hash, h);
        vm.warp(block.timestamp + h);
        vm.prank(alice);
        ledger.reveal(id, t, p, d, s);
        assertEq(ledger.getCall(id).token, t);
    }
}
