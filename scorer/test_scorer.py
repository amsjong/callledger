#!/usr/bin/env python3
"""Scorer self-tests against live BSC mainnet (read-only eth_call, no transactions).

Checks, in order:
  1. keccak256 vectors + the event topic0s the indexer derives from the contract source;
  2. the block/time search lands on the first block at or after a target timestamp;
  3. a 24h historical window on the WBNB/USDT **v2** pair scores SCORED with liquidity >> $50k;
  4. the same window on the WBNB/USDT **v3** 0.05% pool, and that the two agree to within ~1%;
  5. the liquidity floor voids a window when the floor is raised above the real TVL;
  6. a non-canonical "pool" (the WBNB token itself) is VOIDed;
  7. a forfeited sealed call scores exactly -cap, and a fresh sealed commit is PENDING.

Usage: python3 scorer/test_scorer.py [--rpc URL,URL]
"""

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scorer import abi, keccak                                      # noqa: E402
from scorer.rpc import RPC, ARCHIVE_RPCS, first_block_at_or_after   # noqa: E402
from scorer.scorer_v1 import (                                      # noqa: E402
    Chain, Params, MAX_DECIMALS, V2_FACTORY, WBNB, USDT, WBNB_USDT_V2,
    score_call, SCORED, PENDING, VOID, FORFEIT,
)

V3_WBNB_USDT_500 = "0x36696169c63e42cd08ce11f5deebbcebae652050"

PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  -- {detail}" if detail else ""))


class FakeRPC:
    """A pool of two fake tokens, so a weird ERC-20 can be exercised without finding one on chain."""

    def __init__(self, answers):
        self.answers = answers          # selector -> hex return ("0x" means "no code / empty")
        self.calls = 0

    def try_call(self, to, data, block="latest"):
        self.calls += 1
        return self.answers.get(data[:10], "0x")

    def block_number(self):
        return 1_000_000

    def ts(self, n):
        return 1_700_000_000


def _answers(decimals_word, symbol_ret, token_a, token_b, pool):
    def w(v):
        return "0x%064x" % v
    return {
        abi.selector("factory()"): w(int(V2_FACTORY[2:], 16)),
        abi.selector("token0()"): w(int(token_a[2:], 16)),
        abi.selector("token1()"): w(int(token_b[2:], 16)),
        abi.selector("getPair(address,address)"): w(int(pool[2:], 16)),
        abi.selector("decimals()"): decimals_word,
        abi.selector("symbol()"): symbol_ret,
    }


def hostile_token_checks():
    tok = "0x1111111111111111111111111111111111111111"
    pool = "0x2222222222222222222222222222222222222222"
    call = {"callId": 1, "mode": 2, "status": 2, "token": tok, "pool": pool, "direction": 1,
            "commitBlock": 10, "commitTime": 1, "expiryTime": 2}

    # abi.word0 is what keeps an empty eth_call return (an address with no code answers "0x") from
    # raising IndexError deep inside a decode and taking the whole pass down.
    check("abi.word0 on an empty return is None, not an IndexError", abi.word0("0x") is None)
    check("abi.word0 reads the first word", abi.word0("0x" + "%064x" % 42) == 42)
    check("abi.cap_text caps length and strips NULs",
          abi.cap_text("a" * 500) == "a" * abi.MAX_TEXT and abi.cap_text("x\x00y") == "xy")

    # decimals() returning 2**255: `10 ** decimals` would hang the process, so the token is declared
    # unpriceable and every pool holding it voids.
    huge = Chain(FakeRPC(_answers("0x%064x" % (2 ** 255), "0x", tok, USDT, pool)))
    meta = huge.token(tok)
    check("absurd decimals() marks the token unpriceable", bool(meta["unpriceable"]), str(meta["unpriceable"])[:60])
    check("...and its decimals fall back to 18 rather than 2**255", meta["decimals"] == 18)
    r = score_call(huge, call, Params(), now=1_700_000_000, latest=1_000_000)
    check("a pool holding an absurd-decimals token is VOID",
          r["status"] == VOID and "decimals()" in (r["voidReason"] or ""), str(r["voidReason"])[:70])

    # decimals() exactly at the bound is accepted; one over is not.
    at = Chain(FakeRPC(_answers("0x%064x" % MAX_DECIMALS, "0x", tok, USDT, pool)))
    over = Chain(FakeRPC(_answers("0x%064x" % (MAX_DECIMALS + 1), "0x", tok, USDT, pool)))
    check(f"decimals() == {MAX_DECIMALS} is accepted", at.token(tok)["unpriceable"] is None)
    check(f"decimals() == {MAX_DECIMALS + 1} is rejected", over.token(tok)["unpriceable"] is not None)

    # symbol() variants: reverting, returning bytes32, and returning an unbounded string.
    reverting = Chain(FakeRPC(_answers("0x", "0x", tok, USDT, pool)))
    m = reverting.token(tok)
    check("decimals() reverting defaults to 18", m["decimals"] == 18 and m["decimalsRaw"] is None)
    check("symbol() reverting falls back to a short address stub", m["symbol"] == tok[:10])

    b32 = "0x" + b"WEIRD".hex() + "00" * 27
    m = Chain(FakeRPC(_answers("0x%064x" % 18, b32, tok, USDT, pool))).token(tok)
    check("symbol() returning bytes32 decodes", m["symbol"] == "WEIRD", m["symbol"])

    long_sym = "S" * 4000
    enc = ("0x" + "%064x" % 32 + "%064x" % len(long_sym)
           + long_sym.encode().hex() + "00" * ((32 - len(long_sym) % 32) % 32))
    m = Chain(FakeRPC(_answers("0x%064x" % 18, enc, tok, USDT, pool))).token(tok)
    check(f"a {len(long_sym)}-char symbol() is capped at {abi.MAX_TEXT}",
          len(m["symbol"]) == abi.MAX_TEXT, f"{len(m['symbol'])} chars")

    # a pool whose views answer nothing at all must void, not raise
    empty = Chain(FakeRPC({}))
    check("a pool with no factory() voids", "void" in empty.pool(pool))
    r = score_call(empty, call, Params(), now=1_700_000_000, latest=1_000_000)
    check("...and the call is VOID rather than an exception", r["status"] == VOID, str(r["voidReason"])[:60])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rpc", default=",".join(ARCHIVE_RPCS))
    a = ap.parse_args()

    print("== 1. keccak256 / event topic0s ==")
    check("keccak256('') vector",
          keccak.keccak_hex(b"") == "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")
    check("ERC-20 Transfer topic0",
          keccak.topic0("Transfer(address,address,uint256)")
          == "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef")
    check("getReserves() selector == 0x0902f1ac", keccak.selector("getReserves()") == "0x0902f1ac")
    check("slot0() selector == 0x3850c7bd", keccak.selector("slot0()") == "0x3850c7bd")
    check("balanceOf(address) selector == 0x70a08231",
          keccak.selector("balanceOf(address)") == "0x70a08231")
    check("getPair(address,address) selector == 0xe6a43905",
          keccak.selector("getPair(address,address)") == "0xe6a43905")

    rpc = RPC(a.rpc)
    chain = Chain(rpc)
    latest = rpc.block_number()
    now = rpc.ts(latest)
    print(f"\n== 2. chain / block search ==  (chainId {rpc.chain_id()}, latest {latest})")

    target = now - 2 * 86400
    b = first_block_at_or_after(rpc, target, latest - 600_000, latest)
    check("first_block_at_or_after lands at or after the target", b is not None and rpc.ts(b) >= target,
          f"block {b} ts {rpc.ts(b) if b else '-'}")
    check("...and its predecessor is strictly before it", b is not None and rpc.ts(b - 1) < target)
    check("a future timestamp returns None",
          first_block_at_or_after(rpc, now + 10_000, latest - 10, latest) is None)

    print("\n== 3. canonical pool resolution ==")
    p2 = chain.pool(WBNB_USDT_V2)
    check("WBNB/USDT v2 pair resolves as canonical v2", p2.get("kind") == 1, str(p2.get("void") or ""))
    p3 = chain.pool(V3_WBNB_USDT_500)
    check("WBNB/USDT v3 0.05% resolves as canonical v3",
          p3.get("kind") == 2 and p3.get("fee") == 500, str(p3.get("void") or p3.get("fee")))
    bad = chain.pool(WBNB)
    check("the WBNB token itself is not a pool", "void" in bad, str(bad.get("void"))[:70])

    # a 24h window ending ~2 days ago, i.e. commit ~3 days ago
    commit_ts = now - 3 * 86400
    commit_block = first_block_at_or_after(rpc, commit_ts, latest - 900_000, latest)
    horizon = 86400
    expiry = rpc.ts(commit_block) + horizon
    params = Params()
    base = {"callId": 1, "mode": 2, "status": 2, "direction": 1,
            "commitBlock": commit_block, "commitTime": rpc.ts(commit_block), "expiryTime": expiry}

    print(f"\n== 4. 24h window, WBNB long ==  (commitBlock {commit_block}, expiry {expiry})")
    for label, pool in (("v2 pair", WBNB_USDT_V2), ("v3 0.05% pool", V3_WBNB_USDT_500)):
        r = score_call(chain, dict(base, token=WBNB, pool=pool), params, now=now, latest=latest)
        print(f"  {label}: status={r['status']} p0={r['p0']} p1={r['p1']} "
              f"raw={r['rawReturnPct']}% capped={r['cappedScore']} "
              f"liq0=${(r['liquidityUsd0'] or 0):,.0f} liq1=${(r['liquidityUsd1'] or 0):,.0f} "
              f"void={r['voidReason']}")
        check(f"{label}: SCORED", r["status"] == SCORED, str(r["voidReason"] or ""))
        check(f"{label}: liquidity well above $50k",
              (r["liquidityUsd0"] or 0) > 1e6 and (r["liquidityUsd1"] or 0) > 1e6)
        check(f"{label}: p0 in a sane BNB/USDT range", r["p0"] and 100 < r["p0"] < 5000, str(r["p0"]))
        check(f"{label}: capped score within +/-{params.capPct}",
              r["cappedScore"] is not None and abs(r["cappedScore"]) <= params.capPct)
        check(f"{label}: {params.samples} samples requested, >1 distinct block used",
              len(r["detail"]["window0"]["blocks"]) > 1,
              str(r["detail"]["window0"]["blocks"]))
        globals()["_last_" + ("v2" if pool == WBNB_USDT_V2 else "v3")] = r

    rv2, rv3 = globals().get("_last_v2"), globals().get("_last_v3")
    if rv2 and rv3 and rv2["status"] == SCORED and rv3["status"] == SCORED:
        spread = abs(rv2["p0"] - rv3["p0"]) / rv2["p0"] * 100
        check("v2 and v3 agree on the BNB price to within 1%", spread < 1.0, f"{spread:.3f}% apart")
        dr = abs(rv2["rawReturnPct"] - rv3["rawReturnPct"])
        check("v2 and v3 agree on the 24h return to within 1pp", dr < 1.0, f"{dr:.3f}pp apart")

    print("\n== 5. short is the negated long ==")
    rs = score_call(chain, dict(base, token=WBNB, pool=WBNB_USDT_V2, direction=2),
                    params, now=now, latest=latest)
    check("SHORT scores the negated return",
          rs["status"] == SCORED and abs(rs["signedReturnPct"] + rv2["signedReturnPct"]) < 1e-6,
          f"{rs.get('signedReturnPct')} vs {rv2.get('signedReturnPct')}")

    print("\n== 6. liquidity floor ==")
    huge = Params(minLiquidityUsd=1e15)
    rl = score_call(chain, dict(base, token=WBNB, pool=WBNB_USDT_V2), huge, now=now, latest=latest)
    check("floor above the real TVL voids the call",
          rl["status"] == VOID and "floor" in (rl["voidReason"] or ""), str(rl["voidReason"])[:90])

    print("\n== 7. cap ==")
    tiny = Params(capPct=0.001)
    rc = score_call(chain, dict(base, token=WBNB, pool=WBNB_USDT_V2), tiny, now=now, latest=latest)
    check("score is clamped to the cap",
          rc["status"] == SCORED and abs(rc["cappedScore"]) <= 0.001, str(rc.get("cappedScore")))

    print("\n== 8. the other side of the same pair ==")
    # Scoring USDT instead of WBNB flips which side is the quote token: the price must invert, and
    # the liquidity must still be priceable (quote = WBNB, valued via this same pair).
    ru = score_call(chain, dict(base, token=USDT, pool=WBNB_USDT_V2), params, now=now, latest=latest)
    check("USDT side of the same pair also scores", ru["status"] == SCORED, str(ru["voidReason"] or ""))
    if ru["status"] == SCORED and rv2["status"] == SCORED:
        check("USDT price is the reciprocal of the WBNB price",
              abs(ru["p0"] * rv2["p0"] - 1.0) < 0.02, f"{ru['p0']} * {rv2['p0']}")

    print("\n== 9. sealed-call lifecycle ==")
    fresh = {"callId": 9, "mode": 1, "status": 1, "token": None, "pool": None, "direction": 0,
             "commitBlock": latest - 10, "commitTime": now - 60, "expiryTime": now + 3600}
    rf = score_call(chain, fresh, params, now=now, latest=latest)
    check("sealed call before expiry is PENDING", rf["status"] == PENDING, str(rf["detail"]))

    lapsed = dict(fresh, expiryTime=now - 8 * 86400, commitTime=now - 9 * 86400)
    rfo = score_call(chain, lapsed, params, now=now, latest=latest)
    check("sealed call past the reveal window is FORFEIT at -cap",
          rfo["status"] == FORFEIT and rfo["cappedScore"] == -params.capPct, str(rfo["cappedScore"]))

    marked = dict(fresh, status=3)
    rm = score_call(chain, marked, params, now=now, latest=latest)
    check("explicitly Forfeited call is FORFEIT at -cap",
          rm["status"] == FORFEIT and rm["cappedScore"] == -params.capPct)

    print("\n== 10. not-yet-elapsed expiry window is PENDING ==")
    recent = {"callId": 10, "mode": 2, "status": 2, "token": WBNB, "pool": WBNB_USDT_V2,
              "direction": 1, "commitBlock": latest - 100, "commitTime": now - 60,
              "expiryTime": now - 5}
    rp = score_call(chain, recent, params, now=now, latest=latest)
    check("expiry window that has not elapsed is PENDING", rp["status"] == PENDING, str(rp["detail"].get("reason")))

    print("\n== 11. hostile ERC-20s and empty returns (no network) ==")
    hostile_token_checks()

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed  ({rpc.calls} RPC calls)")
    if FAIL:
        print("FAILED: " + ", ".join(FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
