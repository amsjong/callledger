#!/usr/bin/env python3
"""CallLedger off-chain scorer (v0 stub, stdlib only).

Scores one revealed / open call: price of `token` in `pool` (PancakeSwap v2 pair or v3 pool)
at the state after `commitBlock` vs at the first block whose timestamp >= `expiryTime`.
Return % = (p1/p0 - 1) * 100, sign flipped for SHORT (direction 2).

Needs an RPC that serves historical eth_call (archive). bsc-dataseed only keeps very recent state.
Usage:
  score.py --token 0x.. --pool 0x.. --direction 1 --commit-block N --expiry-time TS [--rpc URL]
  score.py --token 0x.. --pool 0x.. --direction 1 --commit-block N --horizon SECONDS   (expiry = block ts + horizon)
"""
import argparse, json, urllib.request

DEFAULT_RPC = "https://bsc-mainnet.public.blastapi.io"
V2_FACTORY = "0xca143ce32fe78f1f7019d7d551a6402fc5350c73"
V3_FACTORY = "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865"
SEL = {  # function selectors
    "factory": "0xc45a0155", "token0": "0x0dfe1681", "token1": "0xd21220a7",
    "getReserves": "0x0902f1ac", "slot0": "0x3850c7bd", "decimals": "0x313ce567",
}


class RPC:
    def __init__(self, url):
        self.url, self.i = url, 0

    def __call__(self, method, params):
        self.i += 1
        body = json.dumps({"jsonrpc": "2.0", "id": self.i, "method": method, "params": params}).encode()
        req = urllib.request.Request(self.url, body, {"Content-Type": "application/json", "User-Agent": "callledger-scorer"})
        r = json.load(urllib.request.urlopen(req, timeout=30))
        if "error" in r:
            raise RuntimeError(f"{method}: {r['error']}")
        return r["result"]

    def call(self, to, data, block):
        return self("eth_call", [{"to": to, "data": data}, hex(block)])

    def ts(self, block):
        return int(self("eth_getBlockByNumber", [hex(block), False])["timestamp"], 16)


def words(h):
    h = h[2:]
    return [int(h[i:i + 64], 16) for i in range(0, len(h), 64)]


def addr(h):
    return "0x" + h[-40:].lower()


def first_block_at_or_after(rpc, ts, lo):
    """Smallest block >= lo with timestamp >= ts (binary search). Returns None if not yet mined."""
    hi = int(rpc("eth_blockNumber", []), 16)
    if rpc.ts(hi) < ts:
        return None
    while lo < hi:
        mid = (lo + hi) // 2
        if rpc.ts(mid) >= ts:
            hi = mid
        else:
            lo = mid + 1
    return lo


def price(rpc, token, pool, block, meta):
    """Price of `token` denominated in the other pool token (human units)."""
    if meta["kind"] == "v2":
        r0, r1, _ = words(rpc.call(pool, SEL["getReserves"], block))[:3]
        a0, a1 = r0 / 10 ** meta["d0"], r1 / 10 ** meta["d1"]
        p0in1 = a1 / a0
    else:
        sqrtp = words(rpc.call(pool, SEL["slot0"], block))[0]
        p0in1 = (sqrtp / 2 ** 96) ** 2 * 10 ** (meta["d0"] - meta["d1"])
    return p0in1 if token == meta["t0"] else 1 / p0in1


def pool_meta(rpc, token, pool, block):
    f = addr(rpc.call(pool, SEL["factory"], block))
    kind = {V2_FACTORY: "v2", V3_FACTORY: "v3"}.get(f)
    if not kind:
        raise SystemExit(f"VOID: pool factory {f} is not PancakeSwap v2/v3")
    t0, t1 = addr(rpc.call(pool, SEL["token0"], block)), addr(rpc.call(pool, SEL["token1"], block))
    if token not in (t0, t1):
        raise SystemExit("VOID: token not in pool")
    d0 = words(rpc.call(t0, SEL["decimals"], block))[0]
    d1 = words(rpc.call(t1, SEL["decimals"], block))[0]
    # TODO(v1 scorer): minimum-liquidity rule (void if pool < $50k TVL at commitBlock) and canonical
    # factory.getPair/getPool check; the v2 contract already enforces canonical pools on-chain.
    return {"kind": kind, "t0": t0, "t1": t1, "d0": d0, "d1": d1}


def score(rpc, token, pool, direction, commit_block, expiry_time):
    token, pool = token.lower(), pool.lower()
    meta = pool_meta(rpc, token, pool, commit_block)
    end_block = first_block_at_or_after(rpc, expiry_time, commit_block)
    if end_block is None:
        return {"status": "PENDING", "expiryTime": expiry_time}
    p0, p1 = price(rpc, token, pool, commit_block, meta), price(rpc, token, pool, end_block, meta)
    ret = (p1 / p0 - 1) * 100
    signed = ret if direction == 1 else -ret
    return {
        "status": "SCORED", "poolKind": meta["kind"], "token": token, "pool": pool,
        "direction": "LONG" if direction == 1 else "SHORT",
        "commitBlock": commit_block, "commitTs": rpc.ts(commit_block),
        "endBlock": end_block, "endTs": rpc.ts(end_block), "expiryTime": expiry_time,
        "p0": p0, "p1": p1, "rawReturnPct": round(ret, 6), "scorePct": round(signed, 6),
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--rpc", default=DEFAULT_RPC)
    ap.add_argument("--token", required=True)
    ap.add_argument("--pool", required=True)
    ap.add_argument("--direction", type=int, choices=[1, 2], required=True)
    ap.add_argument("--commit-block", type=int, required=True)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--expiry-time", type=int)
    g.add_argument("--horizon", type=int)
    a = ap.parse_args()
    rpc = RPC(a.rpc)
    exp = a.expiry_time if a.expiry_time else rpc.ts(a.commit_block) + a.horizon
    print(json.dumps(score(rpc, a.token, a.pool, a.direction, a.commit_block, exp), indent=2))
