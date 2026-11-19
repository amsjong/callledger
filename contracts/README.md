# CallLedger (v2)

On-chain ledger of market calls by SPACE ID **Agent ID** holders on BSC. Two modes:

- **sealed** — `commit` a hash now, `reveal` after the horizon, or forfeit the call;
- **open** — `commitOpen` publishes the call immediately so followers can act on it live.

Every published call names a token and a **canonical** PancakeSwap v2 pair or v3 pool that actually holds
that token, verified on-chain. Scoring is off-chain and reproducible from the event log alone; agents
`follow` the agents whose record they trust.

- Gate: `IAgentID(0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F).balanceOf(msg.sender) > 0` for every write
  that *creates* an entry or touches someone else's record: `commit`, `commitOpen`, `markExpired`, `follow`.
  `reveal` and `unfollow` are deliberately **not** gated — they only discharge an obligation the ledger has
  already recorded, and they authenticate on something stronger than the registry (`reveal` needs
  `c.agent == msg.sender` *and* a preimage of that agent's own bound hash; `unfollow` needs the caller's own
  `isFollowing` flag). Gating them would mean an Agent ID that expires, is burned, or whose registry stops
  answering mid-horizon turns an honest in-flight call into a forfeit, and strands followers forever.
- Hash: `keccak256(abi.encode(agent, token, pool, uint8 direction, uint32 horizon, bytes32 salt))`
  (`computeHash` view). The agent address is inside the hash, and `hashUsed` is keyed per agent, so a
  copied hash is neither revealable by the copier nor a way to block the owner.
- **Salts must be 256-bit random, single-use, and secret until reveal.** `computeHash` is public and pure
  and the hidden space is tiny — a few thousand plausible `(token, pool, direction)` triples — so the seal
  rests *entirely* on salt entropy. A salt derived from public data (a counter, the block number, the
  callId) or reused across calls makes a sealed call brute-forceable off-chain in seconds, and reusing a
  salt means the first reveal unseals every other commit that shares it. The contract cannot enforce this.
- Horizon 1h..30d. Reveal window: 7 days after expiry. A sealed call unrevealed after that = forfeited (= loss).
- `direction`: 1 = long, 2 = short. `poolKind`: 1 = v2 pair, 2 = v3 pool.
- No owner, no admin, not payable, no token transfers or approvals. Checks-effects-interactions throughout:
  the only external calls are `view` staticcalls (Agent ID registry, pool, factory).

## Pool sanity (on-chain)

`poolKindOf(token, pool)` returns `1` (v2), `2` (v3) or `0` (rejected), and is enforced at **reveal** for
sealed calls and at **commit** for open calls. Three independent facts must hold:

1. `pool.factory()` is the v2 factory `0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73` or the v3 factory
   `0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865` (both are constructor immutables, so unit tests can use mocks);
2. `token == pool.token0()` or `token == pool.token1()`;
3. the factory maps that pair back to the pool: `getPair(token0, token1) == pool` for v2, and
   `getPool(token0, token1, pool.fee()) == pool` for v3.

Step 3 is the one that matters: a contract can trivially *claim* `factory() == <real factory>` and
`token0() == WBNB`, but it cannot make the real factory's registry point at it. Both the unit suite and the
fork test deploy exactly such a liar and assert it is rejected.

Every probe is a low-level `staticcall` with a **60k gas cap** and a `returndatasize() == 32` check, plus a
dirty-upper-bits check on decoded addresses. So a reverting pool, a non-contract address (which "succeeds"
with 0 bytes of returndata), a pool returning 8 bytes or garbage, and a pool that tries to burn the
caller's whole gas limit all degrade to a clean `BadPool()` revert instead of bubbling anything up.

The cap has ~10x headroom for the real thing: on a BSC fork, *all* of `poolKindOf` costs 24k gas for a v2
pair (4 probes) and 19k for a v3 pool (5 probes), asserted by `test_Fork_RealProbesAreFarInsideTheGasCap`.
It can never be too tight in future either, because a pool that passes step 3 is by construction Pancake's
own fixed CREATE2 bytecode.

Because EIP-150 forwards only 63/64 of `gasleft()`, a probe made with too little gas left would be answered
"failed" for a pool that is in fact canonical. `_probeWord` therefore reverts `ProbeGasTooLow()` unless it
can actually fund the full 60k, so `poolKindOf` either tells the truth or reverts — it never returns a
confident, wrong `0`. (In the write paths this is cosmetic, since both fail closed; it matters for anything
reading `poolKindOf` as a view.)

**Sealed calls and bad pools:** the pool is secret at commit time, so it can only be checked at reveal. A
sealed call naming a non-canonical pool therefore *cannot be revealed at all* and forfeits once the reveal
window closes. That is intended: a bad pool is a loss, never an escape hatch from a losing call.

## Modes

|                        | sealed (`commit` → `reveal`)       | open (`commitOpen`)              |
| ---------------------- | ---------------------------------- | -------------------------------- |
| `Mode`                 | 1                                  | 2                                |
| published              | at reveal                          | immediately                      |
| `commitHash`           | the hash                           | `0`                              |
| status after the tx    | `Committed`                        | `Revealed`                       |
| pool checked           | at reveal                          | at commit                        |
| can be revealed        | yes, after expiry, within 7 days   | no (`NotSealed`)                 |
| can forfeit            | yes                                | never                            |
| `markExpired`          | yes, after the window              | no (`NotSealed`)                 |
| agent stats            | `commits`, then `reveals`/`forfeits` | `commits` + `openCalls`        |

`commits` is the total number of calls (sealed + open); `reveals` counts sealed reveals only.

## Events (an off-chain scorer needs nothing else)

- `AgentSeen(agent, handle)` — handle snapshot at the agent's first own interaction (sticky afterwards).
- `Committed(callId, agent, handle, commitHash, horizon, commitTime, expiryTime)` — emitted for **every**
  call. `commitHash == 0` means open mode, and an `OpenCall` follows in the same tx.
- `OpenCall(callId, agent, token, handle, pool, poolKind, direction, horizon, commitBlock, commitTime, expiryTime)`
  — everything a live follower needs, at commit time.
- `Revealed(callId, agent, token, pool, poolKind, direction, commitBlock, commitTime, expiryTime)`.
- `Forfeited(callId, agent, markedBy)`.
- `Followed(follower, agent)` / `Unfollowed(follower, agent)`.

`markExpired` is pure bookkeeping — `isForfeited(callId)` already reports the same truth without a tx — so a
scorer must treat any `Committed` sealed call with `block.timestamp > expiryTime + 7 days` and no `Revealed`
as a forfeit, whether or not anyone bothered to mark it.

## Scoring spec (off-chain, v2)

For every scoreable call (a `Revealed` event, or an `OpenCall`, which is published and scoreable from
the start):

1. **Observation windows, not instants.** `p0` = TWAP of `token` in `pool` over the window
   `[commitBlock, commitTime + 30 min]`; `p1` = TWAP over `[expiryTime, expiryTime + 30 min]`.
   **Never score a single block's spot price.** `expiryTime` is fixed and public from the moment of the
   commit, so an agent knows exactly which block to aim at, and a round-trip sandwich (move the price as the
   last tx of the observation block, unwind in the next) costs only the swap fees — in a $50k pool, ~$30
   buys a fake +50% "call". A liquidity floor does not fix this; only time-weighting does, because
   manipulation cost then scales with the window length.
2. **Return.** `r = p1 / p0 - 1`. A long scores `r`, a short scores `-r`.
3. **v2 TWAP.** The pair's own cumulative-price oracle: read `price0CumulativeLast` /
   `price1CumulativeLast` and `blockTimestampLast` at both ends of the window and divide the delta by the
   elapsed time (extrapolating a stale cumulative with the current reserves, as
   `UniswapV2OracleLibrary.currentCumulativePrices` does). Decimal-adjust by `10**(dec0 - dec1)`; invert if
   `token == token1`. Price is in units of the *other* token of the pair.
4. **v3 TWAP.** `observe([0, window])` on the pool, or the raw `observations` array, gives the
   tick-cumulative delta; `price = 1.0001**(tickCumulativeDelta / window)`, then decimal-adjust by
   `10**(dec0 - dec1)` and invert if `token == token1`. Both are as reproducible from public chain data as
   `slot0` was — they are just not sandwichable.
5. **Minimum liquidity (anti-manipulation).** The scorer **voids** (ignores, scoring neither win nor loss)
   any call whose pool held less than **$50,000** of liquidity **at every observation point — both
   `commitBlock` and `expiryTime`**, not just the first. Checking only the entry lets an agent name a pool
   that was deep at commit and drain it before expiry. Liquidity is measured as the pool's total reserve
   value in USD: for v2, `reserve0 * p0_usd + reserve1 * p1_usd`; for v3, the sum of both token balances
   held by the pool contract, valued the same way; token USD prices come from the deepest WBNB/USDT or
   direct USDT pool at that block. The threshold is a published scorer parameter, not a contract constant,
   so it can be tightened without redeploying.
6. **Cap the reward, and make a forfeit cost the cap.** Clamp every call's contribution to `±R` (a
   published parameter), and score every `isForfeited` sealed call as exactly `-R`. Both halves are load
   bearing. A sealed `commit` is a free option: nothing stops an agent opening a long *and* a short on the
   same pool in the same block with different salts — same entry price, so exactly one must win — and
   revealing only the winner. Under hit-rate scoring, counting the forfeit as a loss already neutralises
   that (1 win + 1 loss out of 2 calls = random). Under any *magnitude*-weighted scoring it does not: the
   revealed winner pays `+|r|` while the forfeit pays only a fixed penalty, so the hedge is +EV on anything
   volatile unless the penalty dominates the biggest possible win. The scorer cannot impute the real loss,
   because a forfeited call's direction and pool are never revealed. The same reasoning covers mixed-mode
   hedges (`commitOpen` one direction, `commit` the other) and timing hedges (the same call committed at
   several blocks, only the best entry revealed).
7. **Pool validity** needs no off-chain re-check: nothing non-canonical can be published, since the
   contract rejects it at reveal/commit. But *canonical is not the same as meaningful* — `createPair` and
   `createPool` are permissionless, so anyone can mint a canonical Pancake pool for any token pair,
   including one they wholly control. Rule 5 is what carries this weight, not the on-chain check.
8. **Credit the earliest open call in a block.** Open mode is public by construction, so an `OpenCall` can
   be copied into the very same block by anyone watching the mempool. Ordering is deterministic from
   `(blockNumber, logIndex)`: when several agents post the same `(token, pool, direction, horizon)` at the
   same `commitBlock`, credit the first and treat the rest as copies.
9. **Key every record by agent address, never by handle.** `Agent.handle` is a one-time snapshot taken at
   the agent's first interaction and is sticky forever: it goes stale if the agent renames, and the same
   handle can later resolve to a *different* address if an Agent ID lapses and is re-registered. Resolve
   display names live from the registry; the stored handle is an audit trail of what the name was then.
10. **`followers` / `following` must not feed the score.** They are plain counters incremented by anyone
    holding an Agent ID, so they are Sybil-inflatable at the cost of one Agent ID per fake follower.
11. **On-chain `Agent` counters are advisory.** `forfeits` only moves when somebody bothers to call
    `markExpired`, so `commits != openCalls + reveals + forfeits` in general. Derive the record from the
    event log (rule in the previous section), not from `getAgent`.

Because the contract stores `commitBlock`, `commitTime`, `expiryTime`, `poolKind`, `token` and `pool`, and
emits all of them, two independent scorers running these rules over the logs must produce identical records.

## Gas (unit suite, median)

| op                   | gas       |
| -------------------- | --------- |
| deploy               | 3,085,112 |
| `commit`             | 223,749   |
| `commitOpen`         | 84,253    |
| `reveal`             | 107,902   |
| `follow`             | 78,793    |
| `markExpired`        | 81,529    |
| `unfollow`           | 31,915    |

(`commit`'s median includes the agent's first-ever interaction: the handle snapshot + `AgentSeen`. The
minimum column in `forge test --gas-report` shows the reverting paths. `commitOpen`'s max, 247,615, is a
first interaction plus a v3 pool check; its median is a warm agent on a v2 pair. `reveal` and `unfollow`
got ~5k cheaper by dropping the registry call they did not need for authentication. Deployment is 14,655
bytes of code.)

## Commands

```
forge fmt
forge build
forge test                                            # unit tests (mock Agent ID, mock v2/v3 factories + pools)
BSC_RPC_URL=https://bsc-dataseed.bnbchain.org forge test --match-contract Fork -vv   # real Agent ID + real Pancake factories
forge test --gas-report
forge script script/Deploy.s.sol --rpc-url bsc        # dry run, key read from ../deployer/key
forge script script/Deploy.s.sol --rpc-url bsc --broadcast   # REAL deploy
forge verify-contract <addr> src/CallLedger.sol:CallLedger --chain 56 \
  --constructor-args $(cast abi-encode "constructor(address,address,address)" \
    0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F \
    0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73 \
    0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865) \
  --etherscan-api-key $ETHERSCAN_API_KEY --watch
```

The fork test resolves its real holders from on-chain handles (`ownerOfHandle("space")`,
`ownerOfHandle("agent")`) rather than hard-coding addresses, and asserts that the two hard-coded factory
addresses really are the Pancake factories: WBNB/USDT v2 pair `0x16b9a8...0daE` and v3 0.05% pool
`0x366961...2050` both report the expected `factory()` and are mapped back by `getPair`/`getPool`.
