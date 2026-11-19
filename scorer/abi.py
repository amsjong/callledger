"""Minimal ABI encode/decode for the static types CallLedger and the pools actually use (stdlib only).

Deliberately not a general ABI codec: it handles uint*/int*/address/bool/bytes32 (static, one word
each), plus `string`/`bytes`/`uint256[]` decoding for the few dynamic returns we read (handles,
ERC-20 symbols, callsOf). Anything else should be added here rather than hand-rolled at the call site.
"""

from .keccak import keccak256, selector  # noqa: F401  (re-exported for callers)

ZERO_ADDR = "0x" + "0" * 40

# Chain-supplied text (Agent ID handles, ERC-20 symbols) is stored raw but length-capped: nothing
# on chain bounds it, and one token returning a megabyte from symbol() would otherwise land in
# every JSON file the site serves.
MAX_TEXT = 64


# ------------------------------------------------------------------ encoding
def enc_uint(v):
    v = int(v)
    if v < 0:
        v += 1 << 256
    if not 0 <= v < (1 << 256):
        raise ValueError(f"uint out of range: {v}")
    return v.to_bytes(32, "big")


def enc_addr(a):
    a = (a or ZERO_ADDR).lower()
    if a.startswith("0x"):
        a = a[2:]
    if len(a) != 40:
        raise ValueError(f"bad address: 0x{a}")
    return bytes(12) + bytes.fromhex(a)


def enc_bytes32(b):
    if isinstance(b, str):
        b = bytes.fromhex(b[2:] if b.startswith("0x") else b)
    if len(b) != 32:
        raise ValueError("bytes32 must be 32 bytes")
    return b


def calldata(signature, *args):
    """calldata("getPool(address,address,uint24)", a, b, 500) -> "0x..."

    Argument types are taken from the signature; only static single-word types are supported.
    """
    types = signature[signature.index("(") + 1:signature.rindex(")")]
    types = [t for t in types.split(",") if t]
    if len(types) != len(args):
        raise ValueError(f"{signature}: expected {len(types)} args, got {len(args)}")
    out = bytes.fromhex(selector(signature)[2:])
    for t, v in zip(types, args):
        if t == "address":
            out += enc_addr(v)
        elif t == "bool":
            out += enc_uint(1 if v else 0)
        elif t == "bytes32":
            out += enc_bytes32(v)
        elif t.startswith("uint") or t.startswith("int"):
            out += enc_uint(v)
        else:
            raise ValueError(f"unsupported arg type {t!r} in {signature}")
    return "0x" + out.hex()


# ------------------------------------------------------------------ decoding
def raw(hexstr):
    """hex string -> bytes"""
    h = hexstr[2:] if hexstr.startswith("0x") else hexstr
    if len(h) % 2:
        h = "0" + h
    return bytes.fromhex(h)


def words(hexstr):
    """hex string -> list of 32-byte words as unsigned ints"""
    b = raw(hexstr)
    return [int.from_bytes(b[i:i + 32], "big") for i in range(0, len(b) - len(b) % 32, 32)]


def word_at(hexstr, i):
    return words(hexstr)[i]


def word0(hexstr, default=None):
    """First ABI word, or `default` when there is none.

    An `eth_call` to an address with no code (wrong contract address, a self-destructed token)
    answers `"0x"`, which is truthy but decodes to zero words -- so `words(x)[0]` at a call site
    raises IndexError and takes the whole run down. Every optional probe goes through this.
    """
    if not hexstr:
        return default
    w = words(hexstr)
    return w[0] if w else default


def cap_text(s, limit=MAX_TEXT):
    """Trim chain-supplied text to `limit` characters and drop NULs (they break logs and paths)."""
    return str(s or "").replace("\x00", "")[:limit]


def to_addr(word):
    """an ABI word (int) -> checksum-less lowercase address"""
    if isinstance(word, str):
        word = words(word)[0]
    return "0x%040x" % (word & ((1 << 160) - 1))


def to_int(word, bits=256):
    """two's-complement signed read of a word"""
    if word >= 1 << (bits - 1):
        return word - (1 << bits)
    return word


def to_bytes32(word):
    return "0x%064x" % word


def dec_string(hexstr):
    """Decode an ABI-encoded `string`/`bytes` return. Falls back to a bytes32-style return (some
    old ERC-20s return bytes32 from symbol()), and to "" on anything undecodable."""
    b = raw(hexstr)
    if len(b) == 0:
        return ""
    try:
        if len(b) >= 64:
            off = int.from_bytes(b[0:32], "big")
            if off == 32 and len(b) >= 64:
                n = int.from_bytes(b[32:64], "big")
                if 0 <= n <= len(b) - 64:
                    return b[64:64 + n].decode("utf-8", "replace")
        if len(b) == 32:  # bytes32 string, right-padded with zeros
            return b.rstrip(b"\x00").decode("utf-8", "replace")
    except Exception:
        pass
    return ""


def dec_uint_array(hexstr):
    """Decode an ABI-encoded `uint256[]` return."""
    w = words(hexstr)
    if len(w) < 2:
        return []
    n = w[1]
    return w[2:2 + n]
