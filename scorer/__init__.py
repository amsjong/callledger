"""CallLedger off-chain scorer (stdlib only).

- `keccak.py`      Ethereum keccak256 (hashlib's sha3 is the other one), selectors, event topic0s.
- `abi.py`         minimal ABI encode/decode for the types this project uses.
- `rpc.py`         JSON-RPC with a URL list, retries, 429 backoff, failover; block/time search.
- `scorer_v1.py`   the scoring spec: median-of-samples windows, liquidity floor, capped score.
- `score.py`       the original v0 single-call spot-price CLI, kept working for comparison.
"""
