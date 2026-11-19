# CallLedger indexer

Reads the CallLedger event log, runs the v1 scorer over it, and writes the static JSON the web app
serves. **Python 3 standard library only** — no pip install, no database, no daemon.

```sh
python3 indexer/index.py --once
```

Writes into `web/site/data/` (override with `--out`):

| file                     | contents |
| ------------------------ | -------- |
| `meta.json`              | `lastIndexedBlock`, `updatedAt` (ISO UTC), contract, chainId, deploy block, event counts, the published scoring parameters |
| `leaderboard.json`       | one row per agent |
| `calls.json`             | the newest 200 calls |
| `agents/<addr>.json`     | profile + that agent's call history, newest first, capped at 2000 rows (`callsTruncated` says when it was) |

All four are written **atomically** (temp file in the same directory, `fsync`, `os.rename`), so a web
server never sees a half-written file, and with mode 0644 so it can serve them.

`meta.json` is written **last**, after the agent files and the two indexes. It is what the site shows
as "last updated" and what a reader treats as the freshness marker, so it must never advertise a
block whose data a failed write further down the list left stale. Agent file names are re-checked
against `^0x[0-9a-f]{40}$` at the write site rather than assumed to be hex.

Everything works with **zero calls** — the contract has none today, and the output is valid, empty
JSON that the site renders as "No calls yet. Be the first."

## How it indexes

1. `eth_chainId` must match `--chain-id` (56 by default). Pointing the mainnet state file at a fork,
   or the reverse, exits with an error instead of mixing them.
2. It reads up to `head - --reorg-margin` (default 50 blocks, ~22s on BSC) and never past it, so a
   shallow reorg cannot leave a confirmed-looking event in the output.
3. `eth_getLogs` over the contract address in `--chunk` block ranges (default 1000, because BSC
   public endpoints cap the range at ~1000–2000). A chunk that errors is retried at a quarter of the
   size, down to 50 blocks, then raised.
4. Every log is decoded by a **topic0 derived from the event signature** in
   `contracts/src/CallLedger.sol`, not from a hard-coded constant. `hashlib.sha3_256` is *not*
   Ethereum's keccak256, so `scorer/keccak.py` implements the real thing and self-tests against
   published vectors on import.
5. Decoded events are kept in `indexer/state.json` with `lastBlock`. The next run re-scans the last
   `--reorg-margin` blocks: it drops anything it had recorded at or after that point and re-fetches,
   so a reorged event is replaced rather than duplicated. A state file that is valid JSON but not a
   valid state (wrong types, malformed event entries) is discarded with a message and re-indexed from
   the deploy block, rather than raising halfway through the next pass.
6. The event log is folded into one record per `callId`, then cross-checked against the live views:
   `totalCalls()` (a mismatch is logged), and `getCall(callId)` for any call still in a non-final
   state — which catches a reveal or a `markExpired` whose log was somehow missed. Where the chain
   and the log disagree, the chain wins and the discrepancy is logged.

   If that `getCall` probe **fails** (RPC error, empty return) for a sealed call whose reveal window
   looks closed, the call is left **unscored for that pass** instead of being scored as a forfeit.
   The event log stops at the reorg-safe head, so a reveal in the last few blocks is invisible to it
   — and a `FORFEIT` once written to the score cache is never revisited. Deferring is recoverable;
   a cached −20 for a call that was actually revealed is not.
7. Per the scoring spec, the record is derived from the **event log**, not from `getAgent`, because
   the on-chain `forfeits` counter only moves when somebody bothers to call `markExpired`. `getAgent`
   is still read for the live `followers`/`following` counters, and `handleOf` from the Agent ID
   registry for the live display handle (the stored `handle` is a snapshot that can go stale).
8. The scorer runs (see `scorer/README.md`). Final results (`SCORED`/`VOID`/`FORFEIT`) are cached in
   `indexer/score-cache.json`, keyed by chain + contract + callId + the parameter set, so a
   finalised call is never re-scored and changing a parameter invalidates everything.

### Leaderboard fields

| field | meaning |
| ----- | ------- |
| `calls`, `sealedCalls`, `openCalls`, `reveals` | counts derived from the log |
| `revealRate` | `reveals / sealed calls past their expiry`; `null` when none are due yet |
| `forfeits` | includes **implicit** forfeits (sealed, unrevealed, past expiry + 7 days), not just `markExpired`ed ones. `explicitForfeits` is the marked subset |
| `scoredCalls`, `pendingCalls`, `voidCalls` | by scorer status |
| `avgCappedScore` | mean over `SCORED` **and** `FORFEIT` calls (a forfeit contributes exactly `-cap`); `null` if there are none. `ratedCalls` is that denominator. Void calls are excluded |
| `copyCalls` | open calls that duplicate an earlier open call in the same block (spec rule 8); recorded, never scored |
| `followers`, `following` | live from `getAgent`. **Not** part of the score — anyone with an Agent ID can follow anyone |
| `handle` / `handleIsLive` / `hasAgentId` | the live registry handle where available, else the on-chain snapshot |

## Options

```
--rpc URL[,URL...]        logs + head. Default: dataseed, publicnode, blastapi (tried in order)
--score-rpc URL[,URL...]  the scorer's RPC (needs historical eth_call). Defaults to an archive list,
                          or to --rpc when --rpc was given explicitly
--contract / --agent-id / --v2-factory / --v3-factory / --deploy-block / --chain-id
--out DIR                 output directory (default web/site/data)
--state FILE              state file. A non-default --out gets its own state file automatically,
                          so a test run can never corrupt the real index
--score-cache FILE / --lock FILE      default next to --state
--chunk N                 eth_getLogs range per request (default 1000)
--reorg-margin N          blocks to stay behind head (default 50)
--samples / --window / --min-liquidity / --cap     scoring parameters
--no-score                index only; skip every price and liquidity read
--once                    a single pass (the default)
--interval N              loop forever, sleeping N seconds between passes
--verbose
```

Every RPC list retries with exponential backoff, rotates to the next endpoint on an error or a 429,
and sticks to whichever endpoint answered.

## Locking

`--lock` (default `indexer/.indexer.lock`) is created `O_EXCL`. A second run exits 0 with a message
instead of racing on the output. A lock whose pid no longer exists is treated as stale and taken
over, so a crashed run does not wedge the next one — nor does a lock file that is empty or garbage,
which is what a `SIGKILL` between `open()` and `write()` leaves behind. `web/test/e2e.mjs` covers all
four cases (live pid, dead pid, empty, garbage); the live-pid case is the only one that exits without
indexing.

## Hostile inputs

Everything the indexer reads is attacker-supplied: anyone can deploy a token, and an Agent ID handle
can be re-registered to any string.

- **Handles and symbols** are stored raw (the web app escapes on render) but capped at 64 characters
  and stripped of NULs, so one oversized string cannot bloat every file the site serves.
- **`decimals()` out of range** (`> 36`) makes a token *unpriceable* and voids any pool holding it.
  This is not cosmetic: `10 ** decimals` is used to scale balances, and `decimals()` returning
  `2**255` would hang the pass on an unbounded integer rather than return a wrong number.
- **`symbol()` reverting, or returning `bytes32` instead of `string`**, and **`decimals()` reverting**
  are all normal and handled (`""` / the bytes32 decode / an assumed 18).
- **An empty `eth_call` return** (`"0x"`, what an address with no code answers) decodes to zero ABI
  words, so every optional probe goes through `abi.word0`, which returns `None` instead of raising
  `IndexError` and taking the pass down.
- **An undecodable log** is skipped with a message rather than aborting the pass.

A failure the indexer cannot absorb aborts *before* any output is written and without saving state,
so a partial run leaves the published data exactly as it was and the next run repeats the work.

## Running it on a schedule

Cron, every 5 minutes, with a log:

```cron
*/5 * * * * cd /home/ubuntu/levi && /usr/bin/python3 indexer/index.py --once >> /var/log/callledger-indexer.log 2>&1
```

The lock file makes an overlapping run a no-op, so a slow pass cannot pile up. Alternatively run one
long-lived process with `--interval 300`, or index in CI on a schedule (see `web/README.md` for the
GitHub Pages workflow).

Cadence matters for a second reason: **score each call soon after it expires.** Pruned BSC nodes only
serve recent state, so a window scored within minutes needs no archive node at all. An archive RPC is
only the fallback for catching up on old calls.

If call volume grows enough that re-reading the log from the deploy block in CI gets expensive, cache
`indexer/state.json` between runs (`actions/cache`) — it is the only thing that makes the pass
incremental.

## Files

```
indexer/index.py    everything above
indexer/state.json  lastBlock + decoded events + cached token metadata and block times  (generated)
indexer/score-cache.json   finalised scorer results                                     (generated)
indexer/.indexer.lock      present only while a run is in flight                        (generated)
```

The generated files are local caches: deleting them costs a full re-index, nothing else.
