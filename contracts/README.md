# CallLedger (v2)

On-chain ledger of market calls by SPACE ID **Agent ID** holders on BSC. Two modes:

- **sealed** — `commit` a hash now, `reveal` after the horizon, or forfeit the call;
- **open** — `commitOpen` publishes the call immediately so followers can act on it live.

Every published call names a token and a **canonical** PancakeSwap v2 pair or v3 pool that actually holds
that token, verified on-chain. Scoring is off-chain and reproducible from the event log alone; agents
`follow` the agents whose record they trust.

- Gate: `IAgentID(0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F).balanceOf(msg.sender) > 0` for every write
  (`commit`, `commitOpen`, `reveal`, `markExpired`, `follow`, `unfollow`).
- Hash: `keccak256(abi.encode(agent, token, pool, uint8 direction, uint32 horizon, bytes32 salt))`
  (`computeHash` view). The agent address is inside the hash, and `hashUsed` is keyed per agent, so a
  copied hash is neither revealable by the copier nor a way to block the owner.
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

1. **Observation points.** `p0` = price of `token` in `pool` at the state *after* `commitBlock`;
   `p1` = price at the first block with `timestamp >= expiryTime`.
2. **Return.** `r = p1 / p0 - 1`. A long scores `r`, a short scores `-r`.
3. **v2 price.** `getReserves()` on the pair at the observation block. With `token == token0`,
   `p = reserve1 / reserve0`, scaled by decimals: `p = (reserve1 / 10**dec1) / (reserve0 / 10**dec0)`.
   If `token == token1`, invert. Price is in units of the *other* token of the pair.
4. **v3 price.** `slot0()` on the pool at the observation block gives `sqrtPriceX96`.
   `price(token1 per token0) = (sqrtPriceX96 / 2**96)**2`, then decimal-adjust by `10**(dec0 - dec1)`.
   If `token == token1`, invert. Use `slot0`, not a TWAP: both observation points are single, publicly
   fixed blocks, so the number is reproducible by anyone.
5. **Minimum liquidity (anti-manipulation).** The scorer **voids** (ignores, scoring neither win nor loss)
   any call whose pool held less than **$50,000** of liquidity at `commitBlock`. Liquidity is measured as
   the pool's total reserve value in USD: for v2, `reserve0 * p0_usd + reserve1 * p1_usd`; for v3, the sum
   of both token balances held by the pool contract, valued the same way; token USD prices come from the
   deepest WBNB/USDT or direct USDT pool at that block. This kills the "call a dead pool and push the price
   yourself" strategy without putting any price oracle on-chain. The threshold is a published scorer
   parameter, not a contract constant, so it can be tightened without redeploying.
6. **Forfeits.** Every sealed call that `isForfeited` counts as a **loss**, not a void. Unrevealed is a
   choice, and the ledger makes that choice expensive.
7. **Pool validity** needs no off-chain re-check: nothing non-canonical can be published, since the
   contract rejects it at reveal/commit.

Because the contract stores `commitBlock`, `commitTime`, `expiryTime`, `poolKind`, `token` and `pool`, and
emits all of them, two independent scorers running these rules over the logs must produce identical records.

## Gas (unit suite, median)

| op                   | gas       |
| -------------------- | --------- |
| deploy               | 3,148,371 |
| `commit`             | 223,749   |
| `commitOpen`         | 89,535    |
| `reveal`             | 112,787   |
| `follow`             | 77,228    |
| `markExpired`        | 81,529    |

(`commit`'s median includes the agent's first-ever interaction: the handle snapshot + `AgentSeen`. The
minimum column in `forge test --gas-report` shows the reverting paths. `commitOpen`'s max, 246,460, is a
first interaction plus a v3 pool check; its median is a warm agent on a v2 pair.)

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
