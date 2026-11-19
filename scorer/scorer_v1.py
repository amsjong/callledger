#!/usr/bin/env python3
"""CallLedger off-chain scorer v1 (stdlib only).

Implements the scoring spec in ../contracts/README.md. Everything here is a pure function of public
chain data, so two independent runs must agree.

Per call:

  price      median of K spot samples spread over a W-second window starting at the anchor block.
             p0 anchors at `commitBlock`; p1 anchors at the first block with ts >= `expiryTime`.
             Spot price of `token` in the pool's *other* token: v2 from getReserves, v3 from
             slot0.sqrtPriceX96, both decimal-adjusted. A median over a window costs an attacker
             ~K/2 sandwiches instead of one, which is the point (see spec rule 1).
  liquidity  pool USD liquidity must be >= $50,000 at the anchor block of BOTH ends, else VOID.
             USD value = 2x the other token's pool balance when that token is a stablecoin, or
             2x balance x BNB/USDT (from the canonical WBNB/USDT v2 pair at the same block) when it
             is WBNB. Any other quote token is unpriceable -> VOID.
  canonical  the pool is re-checked against the Pancake factory (getPair / getPool+fee) -> else VOID.
  score      clamp(signed return %, -R, +R) with R = 20. Forfeited sealed call = exactly -R.

Statuses: SCORED, PENDING (window not elapsed yet / still revealable), VOID (excluded from
averages), FORFEIT (counts as -R).

CLI:
  python3 -m scorer.scorer_v1 --token 0x.. --pool 0x.. --direction 1 --commit-block N --expiry-time TS
  python3 scorer/scorer_v1.py  ... (same)
"""

import argparse
import json
import os
import statistics
import sys
import tempfile
import time

if __package__ in (None, ""):  # allow `python3 scorer/scorer_v1.py`
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from scorer import abi
    from scorer.rpc import RPC, ARCHIVE_RPCS, first_block_at_or_after, log  # noqa: F401
else:
    from . import abi
    from .rpc import RPC, ARCHIVE_RPCS, first_block_at_or_after, log  # noqa: F401

# ------------------------------------------------------------------ chain constants (BSC mainnet)
V2_FACTORY = "0xca143ce32fe78f1f7019d7d551a6402fc5350c73"
V3_FACTORY = "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865"
WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"
USDT = "0x55d398326f99059ff775485246999027b3197955"
WBNB_USDT_V2 = "0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae"

STABLES = {
    USDT: "USDT",
    "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": "USDC",
    "0xe9e7cea3dedca5984780bafc599bd69add087d56": "BUSD",
    "0xc5f0f7b66764f6ec8c8dff7ba683102295e16409": "FDUSD",
}

POOL_KIND_NAME = {1: "v2", 2: "v3"}

# A token is free to return anything from decimals(). `10 ** decimals` is used to scale balances, so
# an absurd value is not a wrong price, it is an unbounded integer that hangs the whole run. Above
# this bound the token is declared unpriceable and every pool holding it voids.
MAX_DECIMALS = 36

# ------------------------------------------------------------------ scoring parameters (published)
DEFAULTS = {
    "samples": 7,            # K spot samples per window
    "windowSeconds": 1800,   # W: window length, starting at the anchor block
    "minLiquidityUsd": 50_000.0,
    "capPct": 20.0,          # R
    "revealWindowSeconds": 7 * 24 * 3600,  # must match CallLedger.REVEAL_WINDOW
}

# status values
SCORED, PENDING, VOID, FORFEIT = "SCORED", "PENDING", "VOID", "FORFEIT"


class Params:
    def __init__(self, **kw):
        for k, v in DEFAULTS.items():
            setattr(self, k, kw.get(k, v) if kw.get(k) is not None else v)

    def as_dict(self):
        return {k: getattr(self, k) for k in DEFAULTS}

    def cache_key(self):
        """Params fold into the cache key so changing a parameter invalidates cached results."""
        return "|".join(f"{k}={getattr(self, k)}" for k in sorted(DEFAULTS))


# ------------------------------------------------------------------ token / pool metadata
class Chain:
    """Caching reader for token and pool metadata (immutable facts, so cached forever)."""

    def __init__(self, rpc, v2_factory=V2_FACTORY, v3_factory=V3_FACTORY):
        self.rpc = rpc
        self.v2_factory = v2_factory.lower()
        self.v3_factory = v3_factory.lower()
        self._tokens = {}
        self._pools = {}

    def token(self, addr):
        """Token metadata, best effort. Never raises: `symbol()` returning bytes32 or reverting and
        `decimals()` reverting are all normal on BSC. A token whose `decimals()` is out of range is
        flagged `unpriceable` instead, because scaling by `10 ** decimals` has to stay finite."""
        a = addr.lower()
        if a not in self._tokens:
            dec = self.rpc.try_call(a, abi.calldata("decimals()"))
            sym = self.rpc.try_call(a, abi.calldata("symbol()"))
            d = abi.word0(dec) if dec and len(abi.raw(dec)) >= 32 else None
            bad = d is not None and not 0 <= d <= MAX_DECIMALS
            self._tokens[a] = {
                "address": a,
                # decimals() reverting is common and 18 is the right assumption; decimals() lying is
                # not, so that case is recorded rather than papered over with a default.
                "decimals": 18 if (d is None or bad) else d,
                "decimalsRaw": d,
                "unpriceable": f"decimals() returned {d} (max {MAX_DECIMALS})" if bad else None,
                "symbol": abi.cap_text(abi.dec_string(sym) if sym else "") or a[:10],
            }
        return self._tokens[a]

    def pool(self, pool_addr, block="latest"):
        """Resolve + canonicality-check a pool. Returns a dict, or {"void": reason}.

        Keyed without the block because token0/token1/fee/factory can never change for a Pancake
        pool; the canonical factory lookup is done once at resolution time.
        """
        p = pool_addr.lower()
        if p in self._pools:
            return self._pools[p]
        r = self._resolve_pool(p, block)
        self._pools[p] = r
        return r

    def _resolve_pool(self, p, block):
        # Every read below goes through abi.word0: a probe against an address with no code answers
        # "0x", which is truthy but decodes to no words at all.
        fac = abi.word0(self.rpc.try_call(p, abi.calldata("factory()"), block))
        if fac is None:
            return {"void": "pool has no factory() view"}
        fac = abi.to_addr(fac)
        if fac == self.v2_factory:
            kind = 1
        elif fac == self.v3_factory:
            kind = 2
        else:
            return {"void": f"pool factory {fac} is not PancakeSwap v2/v3"}

        t0 = abi.word0(self.rpc.try_call(p, abi.calldata("token0()"), block))
        t1 = abi.word0(self.rpc.try_call(p, abi.calldata("token1()"), block))
        if t0 is None or t1 is None:
            return {"void": "pool has no token0()/token1()"}
        t0, t1 = abi.to_addr(t0), abi.to_addr(t1)

        fee = None
        if kind == 2:
            fee = abi.word0(self.rpc.try_call(p, abi.calldata("fee()"), block))
            if fee is None:
                return {"void": "v3 pool has no fee()"}
            canon = self.rpc.try_call(
                self.v3_factory, abi.calldata("getPool(address,address,uint24)", t0, t1, fee), block)
        else:
            canon = self.rpc.try_call(
                self.v2_factory, abi.calldata("getPair(address,address)", t0, t1), block)
        canon = abi.word0(canon)
        if canon is None:
            return {"void": "factory did not answer getPair/getPool"}
        if abi.to_addr(canon) != p:
            return {"void": "pool is not the canonical pool for its token pair (factory mismatch)"}

        meta0, meta1 = self.token(t0), self.token(t1)
        for t in (meta0, meta1):
            if t["unpriceable"]:
                return {"void": f"token {t['address']}: {t['unpriceable']}"}

        return {
            "address": p, "kind": kind, "kindName": POOL_KIND_NAME[kind], "factory": fac, "fee": fee,
            "token0": meta0, "token1": meta1,
        }

    # -------------------------------------------------------------- prices
    def spot(self, token, pool, block):
        """Spot price of `token` in units of the pool's other token, at `block`. None on failure."""
        t0, t1 = pool["token0"], pool["token1"]
        d0, d1 = t0["decimals"], t1["decimals"]
        if pool["kind"] == 1:
            data = self.rpc.try_call(pool["address"], abi.calldata("getReserves()"), block)
            if not data or len(abi.raw(data)) < 96:
                return None
            w = abi.words(data)
            r0, r1 = w[0], w[1]
            if r0 == 0 or r1 == 0:
                return None
            p0in1 = (r1 / 10 ** d1) / (r0 / 10 ** d0)
        else:
            data = self.rpc.try_call(pool["address"], abi.calldata("slot0()"), block)
            if not data or len(abi.raw(data)) < 32:
                return None
            sqrtp = abi.words(data)[0]
            if sqrtp == 0:
                return None
            p0in1 = (sqrtp / 2 ** 96) ** 2 * 10 ** (d0 - d1)
        if p0in1 <= 0:
            return None
        return p0in1 if token.lower() == t0["address"] else 1.0 / p0in1

    def bnb_usd(self, block):
        """BNB price in USDT from the canonical WBNB/USDT v2 pair at `block`. None on failure."""
        pool = self.pool(WBNB_USDT_V2, block)
        if "void" in pool:
            return None
        return self.spot(WBNB, pool, block)

    def other_token_balance(self, token, pool, block):
        """(other_token, human balance of the other token held by the pool) at `block`."""
        t0, t1 = pool["token0"], pool["token1"]
        other = t1 if token.lower() == t0["address"] else t0
        if pool["kind"] == 1:
            data = self.rpc.try_call(pool["address"], abi.calldata("getReserves()"), block)
            if not data or len(abi.raw(data)) < 96:
                return other, None
            w = abi.words(data)
            bal = w[1] if other is t1 else w[0]
        else:
            data = self.rpc.try_call(
                other["address"], abi.calldata("balanceOf(address)", pool["address"]), block)
            if not data or len(abi.raw(data)) < 32:
                return other, None
            bal = abi.words(data)[0]
        return other, bal / 10 ** other["decimals"]

    def liquidity_usd(self, token, pool, block):
        """(usd, reason). A pool is valued as 2x the quote side, which is exact for a balanced v2
        pair and the standard convention for v3 (where the token side's value is path-dependent).
        Returns (None, reason) when the quote token has no USD price we trust."""
        other, bal = self.other_token_balance(token, pool, block)
        if bal is None:
            return None, "could not read pool balance"
        addr = other["address"]
        if addr in STABLES:
            return 2.0 * bal, None
        if addr == WBNB:
            px = self.bnb_usd(block)
            if px is None:
                return None, "could not price BNB at that block"
            return 2.0 * bal * px, None
        return None, f"quote token {other['symbol']} ({addr}) has no USD price (not a stablecoin or WBNB)"


# ------------------------------------------------------------------ window sampling
def sample_blocks(rpc, anchor_block, params, latest=None):
    """K block numbers spanning [anchor_ts, anchor_ts + W]: the anchor plus K-1 interpolated points.

    Returns (blocks, elapsed) where `elapsed` is False if the chain has not reached the end of the
    window yet (-> PENDING). Duplicate blocks are collapsed, which happens when W/K is below the
    block time; that is fine, the median just has fewer distinct samples.
    """
    k = max(1, int(params.samples))
    w = int(params.windowSeconds)
    if latest is None:
        latest = rpc.block_number()
    t0 = rpc.ts(anchor_block)
    if rpc.ts(latest) < t0 + w:
        return [], False
    blocks = [int(anchor_block)]
    if k > 1 and w > 0:
        for i in range(1, k):
            target = t0 + (w * i) // (k - 1)
            b = first_block_at_or_after(rpc, target, blocks[-1], latest)
            if b is None:
                return [], False
            blocks.append(b)
    seen, uniq = set(), []
    for b in blocks:
        if b not in seen:
            seen.add(b)
            uniq.append(b)
    return uniq, True


def window_price(chain, token, pool, anchor_block, params, latest=None):
    """(median price, detail dict). price is None if the window has not elapsed or no sample read."""
    blocks, elapsed = sample_blocks(chain.rpc, anchor_block, params, latest)
    if not elapsed:
        return None, {"pending": True}
    samples = []
    for b in blocks:
        px = chain.spot(token, pool, b)
        if px is not None:
            samples.append((b, px))
    if not samples:
        return None, {"error": "no readable price sample in the window"}
    prices = [p for _, p in samples]
    return statistics.median(prices), {
        "anchorBlock": int(anchor_block),
        "anchorTime": chain.rpc.ts(anchor_block),
        "blocks": [b for b, _ in samples],
        "samples": len(samples),
        "min": min(prices), "max": max(prices),
    }


# ------------------------------------------------------------------ one call
def score_call(chain, call, params=None, now=None, latest=None):
    """Score one call.

    `call` keys: callId, mode (1 sealed / 2 open), status (1 Committed / 2 Revealed / 3 Forfeited),
    token, pool, direction (1 long / 2 short), commitBlock, commitTime, expiryTime.
    """
    params = params or Params()
    now = int(now if now is not None else time.time())
    out = {
        "callId": call.get("callId"),
        "status": PENDING,
        "p0": None, "p1": None,
        "rawReturnPct": None, "cappedScore": None,
        "liquidityUsd0": None, "liquidityUsd1": None,
        "voidReason": None,
        "detail": {},
    }
    mode, onchain_status = int(call.get("mode", 0)), int(call.get("status", 0))
    expiry = int(call.get("expiryTime", 0))
    deadline = expiry + int(params.revealWindowSeconds)

    # --- forfeits: explicit, or implicit once the reveal window has closed
    if onchain_status == 3 or (mode == 1 and onchain_status == 1 and now > deadline):
        out["status"] = FORFEIT
        out["cappedScore"] = -float(params.capPct)
        out["detail"]["reason"] = ("marked Forfeited on-chain" if onchain_status == 3
                                   else "sealed call unrevealed past the reveal window")
        return out
    # --- sealed and still hidden: nothing to score yet
    if mode == 1 and onchain_status == 1:
        out["detail"]["reason"] = ("awaiting horizon" if now < expiry else "in reveal window")
        out["detail"]["revealDeadline"] = deadline
        return out

    token, pool_addr = (call.get("token") or "").lower(), (call.get("pool") or "").lower()
    direction = int(call.get("direction") or 0)
    if not token or not pool_addr or direction not in (1, 2):
        out["status"] = VOID
        out["voidReason"] = "call has no published token/pool/direction"
        return out

    # --- the pool must still be the canonical Pancake pool for its pair
    pool = chain.pool(pool_addr)
    if "void" in pool:
        out["status"] = VOID
        out["voidReason"] = pool["void"]
        return out
    if token not in (pool["token0"]["address"], pool["token1"]["address"]):
        out["status"] = VOID
        out["voidReason"] = "token is not in the pool"
        return out
    out["detail"]["poolKind"] = pool["kindName"]

    if latest is None:
        latest = chain.rpc.block_number()

    # --- p1 anchor: first block at or after expiryTime. Not mined yet -> PENDING.
    b0 = int(call["commitBlock"])
    b1 = first_block_at_or_after(chain.rpc, expiry, b0, latest)
    if b1 is None:
        out["detail"]["reason"] = "horizon has not expired yet"
        return out

    # --- liquidity floor at BOTH anchors, before spending samples on prices
    liq0, why0 = chain.liquidity_usd(token, pool, b0)
    liq1, why1 = chain.liquidity_usd(token, pool, b1)
    out["liquidityUsd0"], out["liquidityUsd1"] = liq0, liq1
    floor = float(params.minLiquidityUsd)
    if liq0 is None or liq1 is None:
        out["status"] = VOID
        out["voidReason"] = why0 or why1 or "pool liquidity is unpriceable"
        return out
    if liq0 < floor or liq1 < floor:
        out["status"] = VOID
        out["voidReason"] = (f"pool liquidity below the ${floor:,.0f} floor "
                             f"(${liq0:,.0f} at commit, ${liq1:,.0f} at expiry)")
        return out

    # --- prices
    p0, d0 = window_price(chain, token, pool, b0, params, latest)
    p1, d1 = window_price(chain, token, pool, b1, params, latest)
    out["detail"]["window0"], out["detail"]["window1"] = d0, d1
    if p1 is None and d1.get("pending"):
        out["detail"]["reason"] = "the expiry observation window has not fully elapsed yet"
        return out
    if p0 is None or p1 is None:
        out["status"] = VOID
        out["voidReason"] = (d0.get("error") or d1.get("error") or "price unreadable")
        return out

    raw = (p1 / p0 - 1.0) * 100.0
    signed = raw if direction == 1 else -raw
    cap = float(params.capPct)
    out.update({
        "status": SCORED,
        "p0": p0, "p1": p1,
        "rawReturnPct": round(raw, 6),
        "signedReturnPct": round(signed, 6),
        "cappedScore": round(max(-cap, min(cap, signed)), 6),
        "endBlock": b1,
    })
    return out


# ------------------------------------------------------------------ cache
class Cache:
    """Disk cache of final results, so a call is scored once and never again.

    PENDING results are never cached (they change by definition) and the parameter set is folded
    into the key, so tightening the floor or the cap re-scores everything.
    """

    def __init__(self, path, params):
        self.path = path
        self.key = params.cache_key()
        self.data = {}
        self.hits = self.misses = 0
        if path and os.path.exists(path):
            try:
                with open(path) as f:
                    blob = json.load(f)
                if blob.get("paramsKey") == self.key:
                    self.data = blob.get("results", {})
            except Exception:
                self.data = {}

    def get(self, call_key):
        r = self.data.get(call_key)
        if r is None:
            self.misses += 1
            return None
        self.hits += 1
        return r

    def put(self, call_key, result):
        if result.get("status") in (SCORED, VOID, FORFEIT):
            self.data[call_key] = result

    def save(self):
        if not self.path:
            return
        d = os.path.dirname(os.path.abspath(self.path))
        os.makedirs(d, exist_ok=True)
        blob = {"paramsKey": self.key, "results": self.data}
        fd, tmp = tempfile.mkstemp(dir=d, prefix=".cache-", suffix=".json")
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(blob, f)
            os.replace(tmp, self.path)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise


def score_calls(chain, calls, params=None, cache=None, chain_id=56, contract="", now=None):
    """Score a list of calls, using/filling `cache`. Returns {callId: result}."""
    params = params or Params()
    latest = chain.rpc.block_number()
    now = int(now if now is not None else chain.rpc.ts(latest))
    results = {}
    for call in calls:
        cid = call.get("callId")
        ck = f"{chain_id}:{contract.lower()}:{cid}"
        hit = cache.get(ck) if cache else None
        if hit is not None:
            results[cid] = hit
            continue
        try:
            r = score_call(chain, call, params, now=now, latest=latest)
        except Exception as e:  # one bad pool must not sink the whole run
            r = {"callId": cid, "status": VOID, "voidReason": f"scorer error: {type(e).__name__}: {e}",
                 "p0": None, "p1": None, "rawReturnPct": None, "cappedScore": None,
                 "liquidityUsd0": None, "liquidityUsd1": None, "detail": {}}
        results[cid] = r
        if cache:
            cache.put(ck, r)
    if cache:
        cache.save()
    return results


# ------------------------------------------------------------------ CLI
def main(argv=None):
    ap = argparse.ArgumentParser(description="CallLedger scorer v1 (one call)")
    ap.add_argument("--rpc", default=",".join(ARCHIVE_RPCS),
                    help="comma-separated RPC URLs (archive needed for historical windows)")
    ap.add_argument("--token", required=True)
    ap.add_argument("--pool", required=True)
    ap.add_argument("--direction", type=int, choices=[1, 2], required=True)
    ap.add_argument("--commit-block", type=int, required=True)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--expiry-time", type=int)
    g.add_argument("--horizon", type=int)
    ap.add_argument("--samples", type=int, default=DEFAULTS["samples"])
    ap.add_argument("--window", type=int, default=DEFAULTS["windowSeconds"], dest="windowSeconds")
    ap.add_argument("--min-liquidity", type=float, default=DEFAULTS["minLiquidityUsd"],
                    dest="minLiquidityUsd")
    ap.add_argument("--cap", type=float, default=DEFAULTS["capPct"], dest="capPct")
    ap.add_argument("--mode", type=int, default=2, help="1=sealed, 2=open (default)")
    ap.add_argument("--status", type=int, default=2, help="1=Committed, 2=Revealed, 3=Forfeited")
    ap.add_argument("--verbose", action="store_true")
    a = ap.parse_args(argv)

    rpc = RPC(a.rpc, verbose=a.verbose)
    chain = Chain(rpc)
    expiry = a.expiry_time if a.expiry_time else rpc.ts(a.commit_block) + a.horizon
    params = Params(samples=a.samples, windowSeconds=a.windowSeconds,
                    minLiquidityUsd=a.minLiquidityUsd, capPct=a.capPct)
    call = {
        "callId": 0, "mode": a.mode, "status": a.status, "token": a.token, "pool": a.pool,
        "direction": a.direction, "commitBlock": a.commit_block,
        "commitTime": rpc.ts(a.commit_block), "expiryTime": expiry,
    }
    res = score_call(chain, call, params)
    res["params"] = params.as_dict()
    res["rpcCalls"] = rpc.calls
    print(json.dumps(res, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
