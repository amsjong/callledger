"""Pure-python Keccak-256 (stdlib only).

`hashlib.sha3_256` is the *NIST SHA-3* variant (0x06 domain padding) and does **not** produce the
same digest as Ethereum's keccak256 (0x01 padding), so the primitive has to live here. This is the
reference Keccak-f[1600] permutation; `selftest()` checks it against three published vectors and is
run on import, so a silently wrong hash can never reach a topic0 or a commit hash.
"""

_MASK = (1 << 64) - 1

# round constants for Keccak-f[1600], 24 rounds
_RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]

# rho rotation offsets, indexed [x][y]
_R = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14],
]

_RATE = 136  # 1088 bits: keccak-256 => 17 lanes of the 25-lane state


def _rol(x, n):
    return ((x << n) | (x >> (64 - n))) & _MASK


def _permute(a):
    """a is a 5x5 list of 64-bit lanes, a[x][y]. Mutated in place."""
    for rnd in range(24):
        # theta
        c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rol(c[(x + 1) % 5], 1) for x in range(5)]
        for x in range(5):
            dx = d[x]
            for y in range(5):
                a[x][y] ^= dx
        # rho + pi
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = _rol(a[x][y], _R[x][y])
        # chi
        for x in range(5):
            for y in range(5):
                a[x][y] = b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y] & _MASK)
        # iota
        a[0][0] ^= _RC[rnd]
    return a


def keccak256(data):
    """keccak256 of `bytes` (or str, utf-8 encoded) -> 32 bytes."""
    if isinstance(data, str):
        data = data.encode()
    data = bytes(data)
    # multirate padding, Keccak domain byte 0x01 (SHA-3 would use 0x06 here)
    padlen = _RATE - (len(data) % _RATE)
    if padlen == 1:
        data += b"\x81"  # first and last pad bit land in the same byte
    else:
        data += b"\x01" + b"\x00" * (padlen - 2) + b"\x80"

    a = [[0] * 5 for _ in range(5)]
    for off in range(0, len(data), _RATE):
        block = data[off:off + _RATE]
        for i in range(_RATE // 8):
            lane = int.from_bytes(block[i * 8:i * 8 + 8], "little")
            a[i % 5][i // 5] ^= lane
        _permute(a)
    out = b""
    for i in range(4):  # 4 lanes = 32 bytes
        out += (a[i % 5][i // 5]).to_bytes(8, "little")
    return out


def keccak_hex(data):
    return "0x" + keccak256(data).hex()


def selector(signature):
    """4-byte function selector for e.g. "getReserves()" -> "0x0902f1ac"."""
    return "0x" + keccak256(signature)[:4].hex()


def topic0(signature):
    """Event topic0 for e.g. "Followed(address,address)"."""
    return keccak_hex(signature)


_VECTORS = [
    (b"", "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"),
    (b"abc", "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"),
    # the canonical ERC-20 Transfer topic0
    (b"Transfer(address,address,uint256)", "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"),
]


def selftest():
    for data, want in _VECTORS:
        got = keccak_hex(data)
        if got != want:
            raise RuntimeError(f"keccak256 selftest failed for {data!r}: {got} != {want}")
    # exact-multiple-of-rate input must take the full-pad path without error
    if len(keccak256(b"a" * 136)) != 32:
        raise RuntimeError("keccak256 selftest failed on rate-multiple input")
    return True


selftest()

if __name__ == "__main__":
    print("selftest ok")
    for sig in (
        "AgentSeen(address,string)",
        "Committed(uint256,address,string,bytes32,uint32,uint64,uint64)",
        "OpenCall(uint256,address,address,string,address,uint8,uint8,uint32,uint64,uint64,uint64)",
        "Revealed(uint256,address,address,address,uint8,uint8,uint64,uint64,uint64)",
        "Forfeited(uint256,address,address)",
        "Followed(address,address)",
        "Unfollowed(address,address)",
    ):
        print(topic0(sig), sig)
