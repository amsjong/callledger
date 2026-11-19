# CallLedger scorer

Off-chain scoring for CallLedger, implementing the spec in `../contracts/README.md`. **Python 3
standard library only.** Every result is a pure function of public chain data, so two independent
runs must agree.

```
scorer/
  scorer_v1.py     the v1 rules (current). Importable module + single-call CLI.
  score.py         the original v0 spot-price stub, kept working for comparison.
  rpc.py           JSON-RPC with a URL list, retries, 429 backoff, failover; block/time search.
  abi.py           minimal ABI encode/decode for the types this project uses.
  keccak.py        Ethereum keccak256 (hashlib's sha3 is the *other* one), selectors, event topic0s.
  test_scorer.py   self-tests against live BSC mainnet (read-only eth_call only).
```

## v1 rules

| | |
| --- | --- |
| **price** | the **median of K spot samples** (default K=7) spread over a W-second window (default 1800s) starting at the anchor block. `p0` anchors at `commitBlock`; `p1` anchors at the first block with `timestamp >= expiryTime`. v2 from `getReserves`, v3 from `slot0.sqrtPriceX96`, both decimal-adjusted; the price of `token` in the pool's *other* token. |
| **pending** | if the `p1` window has not fully elapsed, the call is `PENDING` and nothing is cached. |
| **liquidity floor** | pool USD liquidity must be **>= $50,000 at both anchors**. Valued as 2x the quote side: directly if the quote token is USDT/USDC/BUSD/FDUSD, via the canonical WBNB/USDT v2 pair *at the same block* if it is WBNB, otherwise the pool is unpriceable -> `VOID`. v2 uses reserves, v3 uses `balanceOf(pool)`. |
| **canonical pool** | re-checked off chain: `factory()` must be the Pancake v2 or v3 factory, the token must be one of the pool's two tokens, and `getPair`/`getPool(…, fee())` must map that pair back to this pool. Else `VOID`. |
| **unpriceable token** | either side of the pool reporting `decimals() > 36` makes the pool `VOID`. Balances are scaled by `10 ** decimals`, so an absurd value is not a wrong price — `decimals()` returning `2**255` would hang the run on an unbounded integer. `decimals()` reverting is normal and assumed to be 18; `symbol()` reverting or returning `bytes32` is also normal, and the symbol is capped at 64 characters. |
| **score** | `clamp(signed return %, -R, +R)` with `R = 20`. A long scores `r`, a short scores `-r`. |
| **forfeit** | a sealed call with status `Forfeited`, **or** still `Committed` past `expiryTime + 7 days`, scores exactly `-R`. |
| **void** | excluded from averages entirely — neither a win nor a loss. |

Statuses: `SCORED`, `PENDING`, `VOID`, `FORFEIT`.

Why a window rather than a single block: `expiryTime` is public from the moment of the commit, so an
agent knows exactly which block to aim at. A round-trip sandwich (move the price in the observation
block, unwind in the next) costs only the swap fees — in a $50k pool, ~$30 buys a fake +50% "call".
A liquidity floor does not fix that; only time-weighting does, because the cost of manipulation then
scales with the window.

Why the cap and the forfeit penalty are both load-bearing: a sealed `commit` is a free option.
Nothing stops an agent sealing a long *and* a short on the same pool in the same block with different
salts — same entry, so exactly one must win — and revealing only the winner. Under magnitude-weighted
scoring the revealed winner pays `+|r|` while the forfeit pays a fixed penalty, so the hedge is +EV
on anything volatile unless the penalty dominates the biggest possible win. Hence `cap == penalty`.

## Output

Per call: `status`, `p0`, `p1`, `rawReturnPct`, `signedReturnPct`, `cappedScore`, `liquidityUsd0`,
`liquidityUsd1`, `voidReason`, plus a `detail` block with the sample blocks actually used and the
min/max price seen in each window.

## CLI

```sh
python3 -m scorer.scorer_v1 \
  --token 0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c \
  --pool  0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae \
  --direction 1 --commit-block 133974464 --horizon 86400

# parameters (all published, none are contract constants)
#   --samples 7  --window 1800  --min-liquidity 50000  --cap 20
# --mode 1|2 and --status 1|2|3 exercise the sealed/forfeit paths
```

The v0 stub still runs unchanged: `python3 scorer/score.py --token … --pool … --direction 1
--commit-block N --expiry-time TS`. It reports a single-block spot price and no floor — it is kept
only as a cross-check on the price math, not as a scorer.

## Caching

`scorer_v1.Cache` persists final results keyed by chain + contract + callId, with the parameter set
folded into the key. `PENDING` is never cached (it changes by definition) and changing any parameter
invalidates every entry, so tightening the floor or the cap re-scores the whole history. The indexer
uses this; see `../indexer/README.md`.

## RPC

Historical `eth_call` needs an archive node. Probed 20 Nov 2026:

| endpoint | historical state |
| --- | --- |
| `bsc-mainnet.public.blastapi.io` | archive OK (tested 30M blocks back). **Default for the scorer.** |
| `bsc-dataseed.bnbchain.org` | recent only; fails a few hundred blocks back. Fine for logs/head. |
| `bsc-rpc.publicnode.com` | ~5k blocks back OK, 30k+ blocked (403) |
| `bsc.drpc.org` | archive OK, rate-limits quickly (429) on the free tier |
| ankr / llamarpc / blockpi public | did not answer |

`rpc.py` takes a **list**: it sticks to whichever endpoint answers and rotates on an error or a 429,
retrying the whole list with exponential backoff. Block timestamps are cached (they are immutable),
and `first_block_at_or_after` interpolates from the ~0.45s BSC block time before binary-searching, so
a timestamp lookup across ~100M blocks costs a handful of calls instead of ~27.

In production, score close to expiry: a window scored within minutes of expiring needs no archive
node at all, because even pruned nodes still hold that state.

## Tests

```sh
python3 scorer/test_scorer.py        # live BSC mainnet, read-only, no transactions
python3 scorer/keccak.py             # keccak vectors + the CallLedger event topic0s
```

`test_scorer.py` checks the keccak vectors and known selectors, the block/time search, canonical pool
resolution, a real 24h WBNB window in **both** the v2 pair and the v3 0.05% pool (and that the two
agree on the price to within 1% and on the return to within 1pp), the long/short sign, the liquidity
floor, the cap, price inversion when the token is the other side of the pair, and the full sealed-call
lifecycle (pending -> forfeit).

Section 11 needs no network: it drives a fake RPC to cover the ERC-20s you cannot conveniently find
on chain — `decimals()` returning `2**255`, `decimals()` and `symbol()` reverting, `symbol()`
returning `bytes32`, a 4000-character symbol, and a "pool" whose views answer nothing at all. Each
must come out as a `VOID` or a capped default, never an exception or a hang.

## Known gaps

- **Median-of-samples, not a true TWAP.** The contract README also allows the pools' own oracles (v2
  `price0CumulativeLast`, v3 `observe()`), which are strictly harder to manipulate across a window.
  The spec accepts median-of-samples and that is what is implemented; `observe()` is the obvious next
  step and would remove the dependence on sampling density.
- Liquidity is valued as 2x the quote side. That is exact for a balanced v2 pair and the standard
  convention for v3, where the token side's value is path-dependent.
- A pool whose quote token is neither a stablecoin nor WBNB is `VOID` rather than priced through a
  second hop.
