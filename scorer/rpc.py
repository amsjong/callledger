"""JSON-RPC client with a configurable URL list, retries, 429 backoff and failover (stdlib only).

Every public BSC endpoint rate-limits, drops requests under load, or (for the pruned ones) refuses
historical `eth_call`. So the client takes a *list*: it sticks to one URL while it answers, and on
error rotates to the next, retrying the whole list `attempts` times with exponential backoff. A
failure is only raised after every URL has been tried.

Block timestamps are cached (immutable once mined) because the window search reads a lot of them.
"""

import json
import random
import sys
import time
import urllib.error
import urllib.request

# Historical eth_call needs an archive node; the dataseed endpoints only keep recent state.
ARCHIVE_RPCS = [
    "https://bsc-mainnet.public.blastapi.io",
    "https://bsc-dataseed.bnbchain.org",
    "https://bsc-rpc.publicnode.com",
]
# Latest-state + eth_getLogs. dataseed first: fastest, but max ~1000-2000 block range per getLogs.
LATEST_RPCS = [
    "https://bsc-dataseed.bnbchain.org",
    "https://bsc-rpc.publicnode.com",
    "https://bsc-mainnet.public.blastapi.io",
]


class RpcError(RuntimeError):
    """A JSON-RPC level error (the node answered, with an error object)."""


class AllEndpointsFailed(RuntimeError):
    pass


def log(*a):
    print(*a, file=sys.stdout, flush=True)


class RPC:
    def __init__(self, urls, attempts=3, timeout=30, verbose=False):
        if isinstance(urls, str):
            urls = [u.strip() for u in urls.split(",") if u.strip()]
        if not urls:
            raise ValueError("RPC needs at least one url")
        self.urls = list(urls)
        self.attempts = attempts
        self.timeout = timeout
        self.verbose = verbose
        self.i = 0  # index of the URL currently in favour
        self.calls = 0
        self._ts_cache = {}
        self._id = 0

    # ---------------------------------------------------------------- transport
    def _post(self, url, payload):
        self._id += 1
        body = json.dumps(payload).encode()
        req = urllib.request.Request(
            url, body, {"Content-Type": "application/json", "User-Agent": "callledger-indexer/1"}
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            return json.load(r)

    def __call__(self, method, params):
        """One JSON-RPC call. Retries/failovers on transport errors and 429s.

        A JSON-RPC *error object* is endpoint-specific (e.g. "missing trie node" on a pruned node,
        or a getLogs range limit), so it also triggers failover — but the last one seen is what
        gets raised, so the caller sees a real message rather than a generic timeout.
        """
        last = None
        n = len(self.urls)
        for attempt in range(self.attempts):
            for k in range(n):
                url = self.urls[(self.i + k) % n]
                try:
                    self.calls += 1
                    res = self._post(url, {"jsonrpc": "2.0", "id": self._id + 1,
                                           "method": method, "params": params})
                except urllib.error.HTTPError as e:
                    last = RpcError(f"{url}: HTTP {e.code}")
                    if e.code in (429, 503, 502, 504):
                        time.sleep(min(8.0, (2 ** attempt) * 0.5) + random.random() * 0.3)
                    continue
                except Exception as e:  # URLError, timeout, bad JSON, ...
                    last = RpcError(f"{url}: {type(e).__name__}: {e}")
                    continue
                if isinstance(res, dict) and "error" in res and res["error"] is not None:
                    last = RpcError(f"{url}: {method}: {res['error']}")
                    if self.verbose:
                        log(f"  rpc error {last}")
                    continue
                self.i = (self.i + k) % n  # stick to the URL that worked
                return res.get("result")
            time.sleep(min(8.0, (2 ** attempt) * 0.5))
        raise AllEndpointsFailed(f"{method} failed on all {n} endpoint(s): {last}")

    # ---------------------------------------------------------------- helpers
    def call(self, to, data, block="latest"):
        tag = block if isinstance(block, str) else hex(int(block))
        return self("eth_call", [{"to": to, "data": data}, tag])

    def try_call(self, to, data, block="latest"):
        """eth_call that returns None instead of raising (for optional probes)."""
        try:
            return self.call(to, data, block)
        except Exception:
            return None

    def block_number(self):
        return int(self("eth_blockNumber", []), 16)

    def chain_id(self):
        return int(self("eth_chainId", []), 16)

    def block(self, number, full=False):
        tag = number if isinstance(number, str) else hex(int(number))
        return self("eth_getBlockByNumber", [tag, full])

    def ts(self, number):
        """Timestamp of a block, cached."""
        n = int(number)
        if n not in self._ts_cache:
            b = self.block(n)
            if b is None:
                raise RpcError(f"block {n} not found")
            self._ts_cache[n] = int(b["timestamp"], 16)
        return self._ts_cache[n]

    def logs(self, address, from_block, to_block, topics=None):
        f = {"address": address, "fromBlock": hex(int(from_block)), "toBlock": hex(int(to_block))}
        if topics:
            f["topics"] = topics
        return self("eth_getLogs", [f])


# ------------------------------------------------------------------ block/time search
# BSC targets ~0.75s blocks historically and ~0.45s since the Lorentz/Maxwell upgrades. Only used as
# a first guess for the interpolated search below, so being off by 2x only costs a few extra probes.
BLOCK_SECONDS = 0.45


def first_block_at_or_after(rpc, target_ts, lo_hint, latest=None):
    """Smallest block number with timestamp >= target_ts, searching upward from `lo_hint`.

    Returns None if the chain has not reached `target_ts` yet. Uses the estimated block time to jump
    close to the answer and then brackets + binary-searches, which keeps a search over ~100M blocks
    down to a handful of eth_getBlockByNumber calls instead of ~27.
    """
    lo = int(lo_hint)
    if latest is None:
        latest = rpc.block_number()
    if rpc.ts(latest) < target_ts:
        return None
    if rpc.ts(lo) >= target_ts:
        return lo

    # interpolate a guess, then expand geometrically until it brackets the target
    guess = lo + max(1, int((target_ts - rpc.ts(lo)) / BLOCK_SECONDS))
    guess = min(guess, latest)
    if rpc.ts(guess) >= target_ts:
        hi = guess
        step = max(1, (guess - lo) // 2)
        while True:  # walk back down to find a `lo` that is still below the target
            cand = max(lo, hi - step)
            if cand == lo or rpc.ts(cand) < target_ts:
                lo = cand
                break
            hi = cand
            step *= 2
    else:
        lo, hi = guess, min(latest, guess + 1)
        step = 1
        while rpc.ts(hi) < target_ts:
            lo = hi
            step *= 2
            hi = min(latest, hi + step)
            if hi == latest:
                break
    while lo < hi:
        mid = (lo + hi) // 2
        if rpc.ts(mid) >= target_ts:
            hi = mid
        else:
            lo = mid + 1
    return lo
