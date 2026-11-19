#!/usr/bin/env python3
"""CallLedger indexer (stdlib only).

Walks `eth_getLogs` over the CallLedger contract from its deploy block, decodes every event by a
topic0 derived from the event signature in the contract source, cross-checks the live views
(`totalCalls` / `getCall` / `getAgent`), runs the v1 scorer, and writes the static JSON the web app
reads. Incremental: decoded events are kept in a state file and only new blocks are fetched, with a
reorg safety margin re-scanned every run.

  python3 indexer/index.py --once
  python3 indexer/index.py --once --rpc http://127.0.0.1:8545 --out /tmp/data --chain-id 31337
  python3 indexer/index.py --interval 300          # loop forever (or use cron with --once)

Writes, atomically (temp file + rename), into --out (default web/site/data):
  meta.json                     lastIndexedBlock, updatedAt, contract, chainId, scoring params
  leaderboard.json              one row per agent
  calls.json                    the latest 200 calls
  agents/<lowercase addr>.json  profile + full call history

A lock file makes overlapping runs exit instead of racing on the output.
"""

import argparse
import datetime
import json
import os
import re
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scorer import abi                                                  # noqa: E402
from scorer.keccak import topic0                                        # noqa: E402
from scorer.rpc import RPC, ARCHIVE_RPCS, LATEST_RPCS, log              # noqa: E402
from scorer import scorer_v1 as sc                                      # noqa: E402

VERSION = "1.0.0"

# ------------------------------------------------------------------ defaults (BSC mainnet)
CONTRACT = "0x286eba3895fdcb3534e2f7c28a36d622650a2528"
AGENT_ID = "0x60b9262456de011f7d15a54cdd8c48baaa8b022f"
DEPLOY_BLOCK = 134548883
CHAIN_ID = 56

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
DEFAULT_OUT = os.path.join(REPO, "web", "site", "data")
DEFAULT_STATE = os.path.join(HERE, "state.json")

REVEAL_WINDOW = 7 * 24 * 3600  # CallLedger.REVEAL_WINDOW

# Output files are named after an address, so the name is checked against this and never merely
# assumed to be hex -- a path separator in a file name would write outside the data directory.
ADDR_RE = re.compile(r"^0x[0-9a-f]{40}$")
# One agent's history cannot be allowed to grow its JSON file without bound.
MAX_AGENT_CALLS = 2000

# ------------------------------------------------------------------ event signatures
# Copied verbatim from contracts/src/CallLedger.sol; topic0 is derived, never hard-coded, so a
# signature drift shows up as "no events" rather than as silently mis-decoded data.
SIGS = {
    "AgentSeen": "AgentSeen(address,string)",
    "Committed": "Committed(uint256,address,string,bytes32,uint32,uint64,uint64)",
    "OpenCall": "OpenCall(uint256,address,address,string,address,uint8,uint8,uint32,uint64,uint64,uint64)",
    "Revealed": "Revealed(uint256,address,address,address,uint8,uint8,uint64,uint64,uint64)",
    "Forfeited": "Forfeited(uint256,address,address)",
    "Followed": "Followed(address,address)",
    "Unfollowed": "Unfollowed(address,address)",
}
TOPIC0 = {topic0(sig): name for name, sig in SIGS.items()}

MODE_NAME = {0: "None", 1: "Sealed", 2: "Open"}
STATUS_NAME = {0: "None", 1: "Committed", 2: "Revealed", 3: "Forfeited"}
DIR_NAME = {0: "", 1: "LONG", 2: "SHORT"}
POOLKIND_NAME = {0: "", 1: "v2", 2: "v3"}


# ------------------------------------------------------------------ small utilities
def iso(ts=None):
    t = datetime.datetime.fromtimestamp(ts if ts is not None else time.time(), datetime.timezone.utc)
    return t.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def write_json_atomic(path, obj):
    d = os.path.dirname(os.path.abspath(path))
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(obj, f, separators=(",", ":"), sort_keys=False)
            f.flush()
            os.fsync(f.fileno())
        # mkstemp creates 0600; these files are served by a web server, so make them world-readable
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


class Lock:
    """Exclusive, crash-tolerant lock file. A lock whose pid is gone is taken over."""

    def __init__(self, path):
        self.path = path
        self.fd = None

    def __enter__(self):
        os.makedirs(os.path.dirname(os.path.abspath(self.path)), exist_ok=True)
        for attempt in range(2):
            try:
                self.fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
                os.write(self.fd, f"{os.getpid()} {iso()}\n".encode())
                return self
            except FileExistsError:
                if attempt == 0 and self._stale():
                    log(f"removing stale lock {self.path}")
                    try:
                        os.unlink(self.path)
                    except FileNotFoundError:
                        pass
                    continue
                log(f"another indexer run holds {self.path}; exiting")
                raise SystemExit(0)

    def _stale(self):
        try:
            with open(self.path) as f:
                pid = int(f.read().split()[0])
        except Exception:
            return True
        if pid == os.getpid():
            return True
        try:
            os.kill(pid, 0)
            return False  # alive
        except ProcessLookupError:
            return True
        except PermissionError:
            return False

    def __exit__(self, *a):
        if self.fd is not None:
            os.close(self.fd)
        try:
            os.unlink(self.path)
        except FileNotFoundError:
            pass
        return False


# ------------------------------------------------------------------ event decoding
def _dyn_string(data_words, raw_bytes, head_index):
    """Read the dynamic `string` whose offset sits at head word `head_index` of an event's data.

    Length-capped: a handle is chain-supplied text with no on-chain bound, and it is copied into
    every call row and agent file.
    """
    try:
        off = data_words[head_index]
        n = int.from_bytes(raw_bytes[off:off + 32], "big")
        return abi.cap_text(raw_bytes[off + 32:off + 32 + n].decode("utf-8", "replace"))
    except Exception:
        return ""


def decode_log(entry):
    """One raw log -> a decoded dict, or None if topic0 is not one of ours."""
    topics = entry.get("topics") or []
    if not topics:
        return None
    name = TOPIC0.get(topics[0].lower())
    if name is None:
        return None
    raw = abi.raw(entry.get("data") or "0x")
    w = [int.from_bytes(raw[i:i + 32], "big") for i in range(0, len(raw) - len(raw) % 32, 32)]
    e = {
        "event": name,
        "blockNumber": int(entry["blockNumber"], 16),
        "logIndex": int(entry["logIndex"], 16),
        "txHash": entry["transactionHash"],
    }
    t = [int(x, 16) for x in topics]

    if name == "AgentSeen":
        e["agent"] = abi.to_addr(t[1])
        e["handle"] = _dyn_string(w, raw, 0)
    elif name == "Committed":
        e["callId"] = t[1]
        e["agent"] = abi.to_addr(t[2])
        e["handle"] = _dyn_string(w, raw, 0)
        e["commitHash"] = abi.to_bytes32(w[1])
        e["horizon"] = w[2]
        e["commitTime"] = w[3]
        e["expiryTime"] = w[4]
    elif name == "OpenCall":
        e["callId"] = t[1]
        e["agent"] = abi.to_addr(t[2])
        e["token"] = abi.to_addr(t[3])
        e["handle"] = _dyn_string(w, raw, 0)
        e["pool"] = abi.to_addr(w[1])
        e["poolKind"] = w[2]
        e["direction"] = w[3]
        e["horizon"] = w[4]
        e["commitBlock"] = w[5]
        e["commitTime"] = w[6]
        e["expiryTime"] = w[7]
    elif name == "Revealed":
        e["callId"] = t[1]
        e["agent"] = abi.to_addr(t[2])
        e["token"] = abi.to_addr(t[3])
        e["pool"] = abi.to_addr(w[0])
        e["poolKind"] = w[1]
        e["direction"] = w[2]
        e["commitBlock"] = w[3]
        e["commitTime"] = w[4]
        e["expiryTime"] = w[5]
    elif name == "Forfeited":
        e["callId"] = t[1]
        e["agent"] = abi.to_addr(t[2])
        e["markedBy"] = abi.to_addr(t[3])
    elif name in ("Followed", "Unfollowed"):
        e["follower"] = abi.to_addr(t[1])
        e["agent"] = abi.to_addr(t[2])
    return e


# ------------------------------------------------------------------ log fetching
def fetch_logs(rpc, contract, from_block, to_block, chunk):
    """Chunked eth_getLogs. Halves the chunk on a range/size complaint and retries that chunk."""
    out = []
    start = from_block
    size = chunk
    while start <= to_block:
        end = min(to_block, start + size - 1)
        try:
            raw = rpc.logs(contract, start, end)
        except Exception as e:
            if size > 50:
                size = max(50, size // 4)
                log(f"  getLogs {start}-{end} failed ({type(e).__name__}); retrying with chunk {size}")
                continue
            raise
        out.extend(raw)
        log(f"  getLogs {start}-{end}: {len(raw)} log(s)")
        start = end + 1
        if size < chunk:
            size = min(chunk, size * 2)
    return out


# ------------------------------------------------------------------ state
def load_state(path, chain_id, contract, deploy_block):
    st = {"version": VERSION, "chainId": chain_id, "contract": contract,
          "lastBlock": deploy_block - 1, "events": [], "tokens": {}, "blockTimes": {}}
    if not os.path.exists(path):
        return st
    try:
        with open(path) as f:
            old = json.load(f)
    except Exception as e:
        log(f"state file unreadable ({e}); starting from the deploy block")
        return st
    # A different chain or contract must never be merged into the same state.
    if old.get("chainId") != chain_id or (old.get("contract") or "").lower() != contract:
        log("state file is for a different chain/contract; starting from the deploy block")
        return st
    st.update({k: old.get(k, st[k]) for k in ("lastBlock", "events", "tokens", "blockTimes")})
    # Valid JSON is not a valid state: a truncated or hand-edited file would otherwise blow up
    # deep inside build_calls, after the run has already spent its RPC budget.
    if not isinstance(st["lastBlock"], int) or not isinstance(st["events"], list) \
            or not isinstance(st["tokens"], dict) or not isinstance(st["blockTimes"], dict):
        log("state file has the wrong shape; starting from the deploy block")
        return {**st, "lastBlock": deploy_block - 1, "events": [], "tokens": {}, "blockTimes": {}}
    good = [e for e in st["events"] if _valid_event(e)]
    if len(good) != len(st["events"]):
        log(f"state file: dropped {len(st['events']) - len(good)} malformed event(s)")
        st["events"] = good
    return st


def _valid_event(e):
    return (isinstance(e, dict) and e.get("event") in SIGS
            and isinstance(e.get("blockNumber"), int) and isinstance(e.get("logIndex"), int))


def save_state(path, st):
    write_json_atomic(path, st)


# ------------------------------------------------------------------ building the model
def build_calls(events, now):
    """Fold the event log into one record per callId (spec: derive from logs, not from getAgent)."""
    calls = {}
    for e in sorted(events, key=lambda x: (x["blockNumber"], x["logIndex"])):
        n = e["event"]
        if n == "Committed":
            cid = e["callId"]
            is_open = int(e["commitHash"], 16) == 0
            calls[cid] = {
                "callId": cid,
                "agent": e["agent"],
                "handleSnapshot": e["handle"],
                "mode": 2 if is_open else 1,
                "status": 2 if is_open else 1,
                "commitHash": None if is_open else e["commitHash"],
                "horizon": e["horizon"],
                "commitBlock": e["blockNumber"],
                "commitTime": e["commitTime"],
                "expiryTime": e["expiryTime"],
                "revealTime": e["commitTime"] if is_open else None,
                "token": None, "pool": None, "poolKind": 0, "direction": 0,
                "commitTx": e["txHash"],
                "commitLogIndex": e["logIndex"],
                "revealTx": None,
            }
        elif n in ("OpenCall", "Revealed"):
            c = calls.get(e["callId"])
            if c is None:
                continue  # a Committed log we have not seen (should not happen; never guess)
            c.update({"token": e["token"], "pool": e["pool"], "poolKind": e["poolKind"],
                      "direction": e["direction"], "commitBlock": e["commitBlock"],
                      "expiryTime": e["expiryTime"], "status": 2})
            if n == "Revealed":
                c["revealTx"] = e["txHash"]
                c["revealBlock"] = e["blockNumber"]
        elif n == "Forfeited":
            c = calls.get(e["callId"])
            if c is not None:
                c["status"] = 3
                c["forfeitTx"] = e["txHash"]
    # spec rule 8: identical open calls in the same block credit the earliest; the rest are copies
    seen = {}
    for cid in sorted(calls):
        c = calls[cid]
        if c["mode"] != 2 or not c["token"]:
            continue
        key = (c["commitBlock"], c["token"], c["pool"], c["direction"], c["horizon"])
        first = seen.get(key)
        if first is None:
            seen[key] = cid
        else:
            c["copyOf"] = first
    return calls


def decode_agent(hexstr):
    """Decode `getAgent(address) -> Agent`.

    The struct has a dynamic member (`string handle`) so the whole tuple is returned dynamically:
    word 0 is the offset to the tuple, then the tuple head -- offset(handle), firstSeen, commits,
    reveals, forfeits, openCalls, followers, following -- then the handle bytes.
    """
    if not hexstr:
        return None
    raw = abi.raw(hexstr)
    if len(raw) < 32 * 10:
        return None
    base = int.from_bytes(raw[0:32], "big")
    if base + 32 * 8 > len(raw):
        return None
    head = [int.from_bytes(raw[base + 32 * i:base + 32 * (i + 1)], "big") for i in range(8)]
    handle = ""
    try:
        off = base + head[0]
        n = int.from_bytes(raw[off:off + 32], "big")
        handle = abi.cap_text(raw[off + 32:off + 32 + n].decode("utf-8", "replace"))
    except Exception:
        pass
    return {"handle": handle, "firstSeen": head[1], "commits": head[2], "reveals": head[3],
            "forfeits": head[4], "openCalls": head[5], "followers": head[6], "following": head[7]}


def effective_status(c, now):
    """On-chain Status, with an unmarked expired sealed call reported as forfeited (isForfeited)."""
    if c["status"] == 3:
        return 3
    if c["mode"] == 1 and c["status"] == 1 and now > c["expiryTime"] + REVEAL_WINDOW:
        return 3
    return c["status"]


# ------------------------------------------------------------------ main pass
def run_once(args):
    contract = args.contract.lower()
    rpc = RPC(args.rpc, verbose=args.verbose)
    score_rpc = rpc if args.score_rpc == args.rpc else RPC(args.score_rpc, verbose=args.verbose)
    chain = sc.Chain(score_rpc, args.v2_factory, args.v3_factory)
    params = sc.Params(samples=args.samples, windowSeconds=args.window,
                       minLiquidityUsd=args.min_liquidity, capPct=args.cap)

    t_start = time.time()
    on_chain_id = rpc.chain_id()
    if on_chain_id != args.chain_id:
        raise SystemExit(f"RPC reports chainId {on_chain_id}, expected {args.chain_id} "
                         f"(pass --chain-id to index a fork)")
    head = rpc.block_number()
    safe_head = max(args.deploy_block - 1, head - args.reorg_margin)
    log(f"chainId {on_chain_id} head {head} safe head {safe_head} (reorg margin {args.reorg_margin})")

    st = load_state(args.state, args.chain_id, contract, args.deploy_block)
    # re-scan the margin: drop anything we recorded inside it, then re-fetch
    from_block = max(args.deploy_block, min(st["lastBlock"] + 1, safe_head + 1))
    rescan_from = max(args.deploy_block, safe_head + 1 - args.reorg_margin)
    from_block = min(from_block, rescan_from)
    before = len(st["events"])
    st["events"] = [e for e in st["events"] if e["blockNumber"] < from_block]
    if before != len(st["events"]):
        log(f"dropped {before - len(st['events'])} event(s) at/after block {from_block} for re-scan")

    if from_block <= safe_head:
        log(f"fetching logs {from_block}..{safe_head}")
        raw = fetch_logs(rpc, contract, from_block, safe_head, args.chunk)
        decoded, unknown, broken = [], 0, 0
        for entry in raw:
            # One log the node returns in an unexpected shape must not abort a whole pass.
            try:
                d = decode_log(entry)
            except Exception as e:
                broken += 1
                log(f"  skipping an undecodable log: {type(e).__name__}: {e}")
                continue
            if d is None:
                unknown += 1
            else:
                decoded.append(d)
        log(f"decoded {len(decoded)} event(s)"
            + (f", {unknown} with an unknown topic0" if unknown else "")
            + (f", {broken} undecodable" if broken else ""))
        st["events"].extend(decoded)
        st["lastBlock"] = safe_head
    else:
        log(f"nothing new to fetch (lastBlock {st['lastBlock']})")
        st["lastBlock"] = max(st["lastBlock"], safe_head)

    st["events"].sort(key=lambda e: (e["blockNumber"], e["logIndex"]))
    now = rpc.ts(head)

    # ------------------------------------------------------------ live views (cross-check)
    total_calls = abi.word0(rpc.try_call(contract, abi.calldata("totalCalls()")))
    n_committed = sum(1 for e in st["events"] if e["event"] == "Committed")
    if total_calls is not None and total_calls != n_committed:
        log(f"NOTE: totalCalls()={total_calls} but {n_committed} Committed event(s) indexed "
            f"(expected only if the contract is ahead of the reorg-safe head)")

    calls = build_calls(st["events"], now)

    # getCall for every call still in a non-final on-chain state: catches a reveal or an explicit
    # markExpired whose log we might have missed, and is the authoritative status.
    for cid, c in sorted(calls.items()):
        if c["status"] != 1:
            continue
        data = rpc.try_call(contract, abi.calldata("getCall(uint256)", cid))
        w = abi.words(data) if data else []
        if len(w) < 13:
            # The authoritative read failed. The event log alone stops at the reorg-safe head, so a
            # reveal in the last few blocks is invisible here -- and a forfeit, once scored, is
            # cached forever. Flag the call so scoring defers instead of locking in -cap.
            c["unverified"] = True
            continue
        # getCall returns a fully static `Call` struct: one word per field, encoded in place, in
        # declaration order -- agent, commitBlock, horizon, status, mode, direction, poolKind,
        # commitTime, expiryTime, revealTime, commitHash, token, pool.
        status, mode = w[3], w[4]
        if status != c["status"]:
            log(f"  call {cid}: getCall says status {STATUS_NAME.get(status, status)}; log said "
                f"{STATUS_NAME.get(c['status'])} -- trusting the chain")
            c["status"] = status
            c["mode"] = mode
            c["direction"] = w[5]
            c["poolKind"] = w[6]
            c["revealTime"] = w[9] or None
            if len(w) >= 13:
                c["token"] = abi.to_addr(w[11]) if w[11] else None
                c["pool"] = abi.to_addr(w[12]) if w[12] else None

    # ------------------------------------------------------------ token symbols (cached on disk)
    tokens = st["tokens"]
    for c in calls.values():
        a = c.get("token")
        if not a or a in tokens:
            continue
        # A hostile ERC-20 is a normal thing to find in a call: symbol() can return bytes32 or
        # revert, decimals() can revert or lie. None of it may stop the pass.
        try:
            meta = chain.token(a)
        except Exception as e:
            log(f"  token {a}: metadata unreadable ({type(e).__name__}: {e})")
            tokens[a] = {"symbol": "", "decimals": None}
            continue
        tokens[a] = {"symbol": meta["symbol"], "decimals": meta["decimals"]}
        log(f"  token {a}: {meta['symbol']!r} ({meta['decimals']} dec)"
            + (f" UNPRICEABLE: {meta['unpriceable']}" if meta["unpriceable"] else ""))

    # ------------------------------------------------------------ scoring
    cache = sc.Cache(args.score_cache, params)
    scoreable, deferred = [], []
    for c in calls.values():
        # A sealed call that looks lapsed but whose getCall() probe failed is not scored this pass:
        # the scorer would return FORFEIT (-cap) and the cache would keep it forever.
        if c.get("unverified") and c["mode"] == 1 and now > c["expiryTime"] + REVEAL_WINDOW:
            deferred.append(c["callId"])
            continue
        scoreable.append(
            {"callId": c["callId"], "mode": c["mode"], "status": c["status"], "token": c["token"],
             "pool": c["pool"], "direction": c["direction"], "commitBlock": c["commitBlock"],
             "commitTime": c["commitTime"], "expiryTime": c["expiryTime"]})
    if deferred:
        log(f"deferring {len(deferred)} lapsed sealed call(s) with no authoritative getCall(): "
            f"{deferred[:10]}")
    if args.no_score:
        scores = {c["callId"]: {"status": sc.PENDING, "p0": None, "p1": None, "rawReturnPct": None,
                                "cappedScore": None, "liquidityUsd0": None, "liquidityUsd1": None,
                                "voidReason": None, "detail": {"reason": "scoring disabled"}}
                  for c in scoreable}
    else:
        scores = sc.score_calls(chain, scoreable, params, cache,
                                chain_id=args.chain_id, contract=contract, now=now)
        log(f"scored {len(scores)} call(s) (cache: {cache.hits} hit, {cache.misses} miss)")
    for cid in deferred:
        scores[cid] = {"status": sc.PENDING, "p0": None, "p1": None, "rawReturnPct": None,
                       "cappedScore": None, "liquidityUsd0": None, "liquidityUsd1": None,
                       "voidReason": None,
                       "detail": {"reason": "awaiting an authoritative getCall() read"}}

    # ------------------------------------------------------------ agents
    agents = {}

    def touch(addr):
        if addr not in agents:
            agents[addr] = {
                "address": addr, "handleSnapshot": "", "firstSeen": None,
                "calls": 0, "sealedCalls": 0, "openCalls": 0, "reveals": 0,
                "sealedPastExpiry": 0, "forfeits": 0, "explicitForfeits": 0,
                "scoredCalls": 0, "voidCalls": 0, "pendingCalls": 0, "copyCalls": 0,
                "scoreSum": 0.0, "scoreN": 0,
                "followers": 0, "following": 0, "callIds": [],
            }
        return agents[addr]

    for e in st["events"]:
        if e["event"] == "AgentSeen":
            a = touch(e["agent"])
            a["handleSnapshot"] = e["handle"]
            if a["firstSeen"] is None:
                a["firstSeen"] = blocktime(rpc, st, e["blockNumber"])
        elif e["event"] in ("Followed", "Unfollowed"):
            touch(e["follower"])
            touch(e["agent"])

    for cid in sorted(calls):
        c = calls[cid]
        a = touch(c["agent"])
        if not a["handleSnapshot"]:
            a["handleSnapshot"] = c["handleSnapshot"]
        a["callIds"].append(cid)
        a["calls"] += 1
        eff = effective_status(c, now)
        if c["mode"] == 2:
            a["openCalls"] += 1
        else:
            a["sealedCalls"] += 1
            if now > c["expiryTime"]:
                a["sealedPastExpiry"] += 1
            if c["status"] == 2:
                a["reveals"] += 1
            if eff == 3:
                a["forfeits"] += 1
                if c["status"] == 3:
                    a["explicitForfeits"] += 1
        s = scores.get(cid, {})
        if c.get("copyOf") is not None:
            a["copyCalls"] += 1
            continue  # copies are recorded but never scored (spec rule 8)
        if s.get("status") == sc.SCORED:
            a["scoredCalls"] += 1
        elif s.get("status") == sc.VOID:
            a["voidCalls"] += 1
        elif s.get("status") == sc.PENDING:
            a["pendingCalls"] += 1
        if s.get("cappedScore") is not None and s.get("status") in (sc.SCORED, sc.FORFEIT):
            a["scoreSum"] += float(s["cappedScore"])
            a["scoreN"] += 1

    # live registry handle + live follower counters
    for addr, a in agents.items():
        g = rpc.try_call(contract, abi.calldata("getAgent(address)", addr))
        ag = decode_agent(g)
        if ag:
            a["followers"], a["following"] = ag["followers"], ag["following"]
            if a["firstSeen"] is None and ag["firstSeen"]:
                a["firstSeen"] = ag["firstSeen"]
            if not a["handleSnapshot"]:
                a["handleSnapshot"] = ag["handle"]
        h = rpc.try_call(args.agent_id, abi.calldata("handleOf(address)", addr))
        live = abi.cap_text(abi.dec_string(h)) if h else ""
        a["handle"] = live or a["handleSnapshot"] or ""
        a["handleIsLive"] = bool(live)
        bal = rpc.try_call(args.agent_id, abi.calldata("balanceOf(address)", addr))
        a["hasAgentId"] = (abi.word0(bal) or 0) > 0

    # ------------------------------------------------------------ output
    os.makedirs(os.path.join(args.out, "agents"), exist_ok=True)
    scoring = dict(params.as_dict())
    scoring["note"] = ("price = median of N spot samples over windowSeconds from the anchor block; "
                       "liquidity floor applies at both anchors; score = clamp(signed return %, -cap, +cap); "
                       "forfeited sealed call = -cap")

    meta = {
        "lastIndexedBlock": st["lastBlock"],
        "headBlock": head,
        "updatedAt": iso(),
        "chainTimeAt": iso(now),
        "contract": contract,
        "agentIdRegistry": args.agent_id,
        "chainId": args.chain_id,
        "deployBlock": args.deploy_block,
        "indexerVersion": VERSION,
        "totalCalls": total_calls if total_calls is not None else len(calls),
        "indexedCalls": len(calls),
        "agents": len(agents),
        "scoring": scoring,
        "reorgMargin": args.reorg_margin,
        "events": {name: sum(1 for e in st["events"] if e["event"] == name) for name in SIGS},
    }

    rows = []
    for addr, a in agents.items():
        rows.append({
            "address": addr,
            "handle": a["handle"],
            "handleIsLive": a["handleIsLive"],
            "hasAgentId": a["hasAgentId"],
            "calls": a["calls"],
            "sealedCalls": a["sealedCalls"],
            "openCalls": a["openCalls"],
            "reveals": a["reveals"],
            "revealRate": (round(a["reveals"] / a["sealedPastExpiry"], 6)
                           if a["sealedPastExpiry"] else None),
            "sealedPastExpiry": a["sealedPastExpiry"],
            "forfeits": a["forfeits"],
            "explicitForfeits": a["explicitForfeits"],
            "scoredCalls": a["scoredCalls"],
            "pendingCalls": a["pendingCalls"],
            "voidCalls": a["voidCalls"],
            "copyCalls": a["copyCalls"],
            "avgCappedScore": (round(a["scoreSum"] / a["scoreN"], 4) if a["scoreN"] else None),
            "ratedCalls": a["scoreN"],
            "followers": a["followers"],
            "following": a["following"],
            "firstSeen": a["firstSeen"],
        })
    rows.sort(key=lambda r: (r["avgCappedScore"] is None, -(r["avgCappedScore"] or 0), -r["calls"]))

    def call_row(c):
        s = scores.get(c["callId"], {})
        tok = tokens.get(c["token"] or "", {})
        eff = effective_status(c, now)
        return {
            "callId": c["callId"],
            "agent": c["agent"],
            "handleSnapshot": c["handleSnapshot"],
            "mode": MODE_NAME.get(c["mode"], "?"),
            "onChainStatus": STATUS_NAME.get(c["status"], "?"),
            "effectiveStatus": STATUS_NAME.get(eff, "?"),
            "token": c["token"],
            "tokenSymbol": tok.get("symbol") or "",
            "tokenDecimals": tok.get("decimals"),
            "pool": c["pool"],
            "poolKind": POOLKIND_NAME.get(c["poolKind"], ""),
            "direction": DIR_NAME.get(c["direction"], ""),
            "horizon": c["horizon"],
            "commitBlock": c["commitBlock"],
            "commitTime": c["commitTime"],
            "expiryTime": c["expiryTime"],
            "revealTime": c["revealTime"],
            "revealDeadline": c["expiryTime"] + REVEAL_WINDOW if c["mode"] == 1 else None,
            "commitTx": c["commitTx"],
            "revealTx": c["revealTx"],
            "copyOf": c.get("copyOf"),
            "score": {
                "status": s.get("status"),
                "p0": s.get("p0"), "p1": s.get("p1"),
                "rawReturnPct": s.get("rawReturnPct"),
                "cappedScore": s.get("cappedScore"),
                "liquidityUsd0": s.get("liquidityUsd0"),
                "liquidityUsd1": s.get("liquidityUsd1"),
                "voidReason": s.get("voidReason"),
                "reason": (s.get("detail") or {}).get("reason"),
            },
        }

    all_rows = [call_row(calls[cid]) for cid in sorted(calls)]
    by_agent = {}
    for r in all_rows:
        by_agent.setdefault(r["agent"], []).append(r)

    # meta.json is written LAST, on purpose: it is what the site reports as "last updated" and what
    # the next run reads as a freshness marker, so it must never advertise data that a failed write
    # further down this list left stale.
    index_row = {r["address"]: r for r in rows}
    for addr, profile in index_row.items():
        if not ADDR_RE.match(addr):
            log(f"refusing to write an agent file for a malformed address {addr!r}")
            continue
        agent_calls = list(reversed(by_agent.get(addr, [])))
        write_json_atomic(os.path.join(args.out, "agents", f"{addr}.json"),
                          {"updatedAt": meta["updatedAt"], "chainId": args.chain_id,
                           "contract": contract, "profile": profile,
                           "callsTruncated": len(agent_calls) > MAX_AGENT_CALLS,
                           "calls": agent_calls[:MAX_AGENT_CALLS]})
    write_json_atomic(os.path.join(args.out, "leaderboard.json"),
                      {"updatedAt": meta["updatedAt"], "lastIndexedBlock": st["lastBlock"],
                       "chainId": args.chain_id, "contract": contract, "agents": rows})
    write_json_atomic(os.path.join(args.out, "calls.json"),
                      {"updatedAt": meta["updatedAt"], "chainId": args.chain_id,
                       "contract": contract, "count": len(all_rows),
                       "calls": list(reversed(all_rows))[:200]})
    write_json_atomic(os.path.join(args.out, "meta.json"), meta)

    st["tokens"] = tokens
    save_state(args.state, st)
    log(f"wrote {args.out}: {len(rows)} agent(s), {len(all_rows)} call(s); "
        f"{rpc.calls + (0 if score_rpc is rpc else score_rpc.calls)} RPC calls, "
        f"{time.time() - t_start:.1f}s")
    return meta


def blocktime(rpc, st, number):
    """Block timestamp, cached across runs in the state file (block times are immutable)."""
    key = str(number)
    bt = st.setdefault("blockTimes", {})
    if key not in bt:
        bt[key] = rpc.ts(number)
    return bt[key]


# ------------------------------------------------------------------ CLI
def main(argv=None):
    ap = argparse.ArgumentParser(description="CallLedger indexer")
    ap.add_argument("--rpc", default=",".join(LATEST_RPCS), help="comma-separated RPC URLs for logs/head")
    ap.add_argument("--score-rpc", default=None,
                    help="RPC URLs for the scorer (needs historical eth_call); "
                         "defaults to an archive list, or to --rpc when --rpc is given")
    ap.add_argument("--contract", default=CONTRACT)
    ap.add_argument("--agent-id", default=AGENT_ID)
    ap.add_argument("--v2-factory", default=sc.V2_FACTORY)
    ap.add_argument("--v3-factory", default=sc.V3_FACTORY)
    ap.add_argument("--deploy-block", type=int, default=DEPLOY_BLOCK)
    ap.add_argument("--chain-id", type=int, default=CHAIN_ID)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--state", default=None, help=f"state file (default {DEFAULT_STATE}, or <out>/../.state.json)")
    ap.add_argument("--score-cache", default=None, help="scorer result cache (default next to --state)")
    ap.add_argument("--lock", default=None, help="lock file (default next to --state)")
    ap.add_argument("--chunk", type=int, default=1000, help="eth_getLogs block range per request")
    ap.add_argument("--reorg-margin", type=int, default=50, help="blocks behind head to stop at")
    ap.add_argument("--samples", type=int, default=sc.DEFAULTS["samples"])
    ap.add_argument("--window", type=int, default=sc.DEFAULTS["windowSeconds"])
    ap.add_argument("--min-liquidity", type=float, default=sc.DEFAULTS["minLiquidityUsd"])
    ap.add_argument("--cap", type=float, default=sc.DEFAULTS["capPct"])
    ap.add_argument("--no-score", action="store_true", help="index only, skip price/liquidity reads")
    ap.add_argument("--once", action="store_true", help="single pass (the default)")
    ap.add_argument("--interval", type=int, default=0, help="loop forever, sleeping N seconds between passes")
    ap.add_argument("--verbose", action="store_true")
    a = ap.parse_args(argv)

    a.contract = a.contract.lower()
    a.agent_id = a.agent_id.lower()
    if a.state is None:
        # a non-default --out gets its own state, so a test run can never corrupt the real index
        a.state = DEFAULT_STATE if os.path.abspath(a.out) == os.path.abspath(DEFAULT_OUT) \
            else os.path.join(a.out, ".indexer-state.json")
    if a.score_cache is None:
        a.score_cache = os.path.join(os.path.dirname(os.path.abspath(a.state)), "score-cache.json")
    if a.lock is None:
        a.lock = os.path.join(os.path.dirname(os.path.abspath(a.state)), ".indexer.lock")
    if a.score_rpc is None:
        default_rpc = ",".join(LATEST_RPCS)
        a.score_rpc = a.rpc if a.rpc != default_rpc else ",".join(ARCHIVE_RPCS)

    with Lock(a.lock):
        if a.interval and not a.once:
            while True:
                try:
                    run_once(a)
                except SystemExit:
                    raise
                except Exception as e:
                    log(f"pass failed: {type(e).__name__}: {e}")
                log(f"sleeping {a.interval}s")
                time.sleep(a.interval)
        run_once(a)
    return 0


if __name__ == "__main__":
    sys.exit(main())
