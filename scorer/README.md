# CallLedger scorer (stub)

`python3 score.py --token <token> --pool <pancake v2/v3 pool> --direction 1|2 --commit-block N --expiry-time TS`

Rules (v1 spec):
- p0 = price of `token` (in the pool's other token) from pool state at `commitBlock` (eth_call at that block = state after it).
- p1 = same at the first block with `timestamp >= expiryTime` (binary search over block timestamps).
- v2: reserves ratio adjusted for decimals. v3: `slot0.sqrtPriceX96^2 / 2^192` adjusted for decimals.
- score = (p1/p0 - 1) * 100, negated for SHORT. Forfeited sealed calls = loss (fixed penalty, TBD).
- Void if the pool is not a canonical PancakeSwap v2/v3 pool for the token (also enforced on-chain in v2)
  or its liquidity at commitBlock is below $50k (off-chain rule, TODO in stub).

RPC: needs historical eth_call. Probed 20 Nov 2026:
- bsc-dataseed.bnbchain.org / defibit / 1rpc / meowrpc: recent state only (fails a few hundred blocks back).
- bsc-rpc.publicnode.com: ~5k blocks back OK, 30k+ blocked (403).
- bsc-mainnet.public.blastapi.io: archive OK (tested 30M blocks back). Default.
- bsc.drpc.org: archive OK but rate-limits quickly (429) on the free tier.
- ankr / llamarpc / blockpi public: did not answer.
For production run the scorer continuously (score within minutes of expiry, when even pruned nodes still
have state) and keep an archive RPC (BlastAPI public, or a free-tier key from drpc/Ankr/NodeReal/QuickNode) as fallback.

**Status:** score.py is a v0 SPOT-price stub (proves RPC access + price math). The contract README now requires
TWAP windows (v2 price cumulatives / v3 observe()) at both ends, a liquidity floor at both endpoints, and capped
reward vs forfeit penalty. Those are TODO for the v1 scorer.
