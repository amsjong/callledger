// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal view interface of the SPACE ID Agent ID registry (soulbound ERC-721, BSC mainnet
///         0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F). Only views are used.
interface IAgentID {
    function balanceOf(address owner) external view returns (uint256);
    function handleOf(address owner) external view returns (string memory);
}

/// @notice The pool views CallLedger probes. Declared only to derive selectors; every call is made with a
///         low-level gas-capped staticcall, so a hostile or non-contract pool can never break the ledger.
interface IPoolProbe {
    function factory() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
}

interface IV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

interface IV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

/// @title CallLedger (v2)
/// @notice On-chain ledger of market calls made by Agent ID holders, in two modes:
///         - sealed: `commit` a hash, then `reveal` after the horizon or forfeit the call;
///         - open:   `commitOpen` publishes the call immediately for live followers.
///         Every call must name a token and a *canonical* PancakeSwap v2 pair or v3 pool that actually
///         contains that token, verified on-chain (see `_checkPool`). Scoring happens off-chain from public
///         chain data only — the pools' own TWAP oracles over fixed windows anchored at `commitBlock` and
///         `expiryTime` — so anyone can recompute every agent's record from the logs alone. The ledger
///         records *what was called and when*; it deliberately takes no view on price. See README
///         "Scoring spec" for the rules a scorer must enforce that this contract cannot (liquidity floors,
///         capped rewards vs. forfeit penalties, copy detection).
/// @dev    No owner, no admin, no payable functions, no token transfers, no approvals.
///         Every external call is a `view` staticcall. The pool/factory probes are gas-capped and their
///         failure is swallowed; the Agent ID registry calls are *not* capped, because the registry is the
///         gate itself — a registry that stops answering must fail closed, not be worked around. The two
///         functions that discharge an obligation already recorded on-chain (`reveal`, `unfollow`) are
///         therefore deliberately not gated on the registry: see their docs.
contract CallLedger {
    // ------------------------------------------------------------------ constants
    uint32 public constant MIN_HORIZON = 1 hours;
    uint32 public constant MAX_HORIZON = 30 days;
    uint32 public constant REVEAL_WINDOW = 7 days;
    uint256 public constant MAX_PAGE = 200;

    uint8 public constant LONG = 1;
    uint8 public constant SHORT = 2;

    uint8 public constant POOL_V2 = 1;
    uint8 public constant POOL_V3 = 2;

    /// @dev Gas forwarded to each pool/factory probe. Generous for an honest view, tight enough that a
    ///      hostile pool cannot grief the caller by burning the whole gas limit.
    uint256 private constant PROBE_GAS = 60_000;

    /// @dev EIP-150 forwards at most 63/64 of `gasleft()`, so a probe only really receives PROBE_GAS once at
    ///      least this much gas remains. Below it we revert instead of letting a gas-starved probe be read as
    ///      "the pool answered wrong": `poolKindOf` must never report 0 for a pool that is in fact canonical.
    // 64/63 for EIP-150 plus 3k for a cold-account access (2600) and call overhead before forwarding.
    uint256 private constant PROBE_GAS_FLOOR = (PROBE_GAS * 64) / 63 + 3_000;

    enum Status {
        None, // call does not exist
        Committed, // sealed and hidden, horizon may or may not have passed
        Revealed, // sealed call revealed, or open call (published at commit time)
        Forfeited // sealed call not revealed within the window (explicitly marked)
    }

    enum Mode {
        None,
        Sealed, // 1: commit hash now, reveal later
        Open // 2: published immediately, nothing to reveal
    }

    struct Call {
        address agent;
        uint64 commitBlock;
        uint32 horizon;
        // --- slot
        Status status;
        Mode mode;
        uint8 direction; // sealed: 0 until reveal
        uint8 poolKind; // POOL_V2 / POOL_V3, set when the pool becomes public
        uint64 commitTime;
        uint64 expiryTime; // commitTime + horizon
        uint64 revealTime; // open calls: == commitTime
        // --- slot
        bytes32 commitHash; // 0 for open calls
        address token; // sealed: 0 until reveal
        address pool; // sealed: 0 until reveal
    }

    struct Agent {
        string handle; // Agent ID handle snapshot at first interaction (e.g. "levi" for levi.ai)
        uint64 firstSeen; // timestamp of first own interaction (0 if only ever followed)
        uint32 commits; // total calls made (sealed + open)
        uint32 reveals; // sealed calls revealed
        uint32 forfeits; // sealed calls marked forfeited
        uint32 openCalls; // calls made in open mode
        uint32 followers;
        uint32 following;
    }

    // ------------------------------------------------------------------ storage
    IAgentID public immutable agentId;
    address public immutable v2Factory;
    address public immutable v3Factory;

    Call[] private _calls; // callId = index
    mapping(address => Agent) private _agents;
    mapping(address => uint256[]) private _callsOf;
    mapping(address => mapping(bytes32 => bool)) public hashUsed; // per agent: a copied hash cannot block the owner
    mapping(address => mapping(address => bool)) public isFollowing; // follower => agent => bool

    // ------------------------------------------------------------------ events
    event AgentSeen(address indexed agent, string handle);
    /// @notice Emitted for every call. `commitHash == 0` means open mode (an `OpenCall` follows in the same tx).
    event Committed(
        uint256 indexed callId,
        address indexed agent,
        string handle,
        bytes32 commitHash,
        uint32 horizon,
        uint64 commitTime,
        uint64 expiryTime
    );
    /// @notice Everything a live follower needs, published at commit time (open mode only).
    event OpenCall(
        uint256 indexed callId,
        address indexed agent,
        address indexed token,
        string handle,
        address pool,
        uint8 poolKind,
        uint8 direction,
        uint32 horizon,
        uint64 commitBlock,
        uint64 commitTime,
        uint64 expiryTime
    );
    event Revealed(
        uint256 indexed callId,
        address indexed agent,
        address indexed token,
        address pool,
        uint8 poolKind,
        uint8 direction,
        uint64 commitBlock,
        uint64 commitTime,
        uint64 expiryTime
    );
    event Forfeited(uint256 indexed callId, address indexed agent, address indexed markedBy);
    event Followed(address indexed follower, address indexed agent);
    event Unfollowed(address indexed follower, address indexed agent);

    // ------------------------------------------------------------------ errors
    error NotAgentHolder(address account);
    error BadHorizon(uint32 horizon);
    error HashAlreadyUsed();
    error ZeroHash();
    error UnknownCall(uint256 callId);
    error NotCommitter();
    error NotCommittedState();
    error NotSealed();
    error TooEarly(uint64 expiryTime);
    error RevealWindowClosed(uint64 deadline);
    error StillRevealable(uint64 deadline);
    error HashMismatch();
    error BadDirection(uint8 direction);
    error BadPool();
    error ZeroAddress();
    error SelfFollow();
    error AlreadyFollowing();
    error NotFollowing();
    error PageTooLarge();
    error SameFactory();
    error ProbeGasTooLow();

    constructor(IAgentID agentId_, address v2Factory_, address v3Factory_) {
        if (address(agentId_) == address(0) || v2Factory_ == address(0) || v3Factory_ == address(0)) {
            revert ZeroAddress();
        }
        // The two factories must differ: `poolKindOf` resolves the kind from `factory()`, so deploying with
        // one address for both would make every v3 pool permanently unclassifiable in an immutable contract.
        if (v2Factory_ == v3Factory_) revert SameFactory();
        agentId = agentId_;
        v2Factory = v2Factory_;
        v3Factory = v3Factory_;
    }

    // ------------------------------------------------------------------ modifiers / internals
    modifier onlyAgent() {
        if (agentId.balanceOf(msg.sender) == 0) revert NotAgentHolder(msg.sender);
        _touch(msg.sender);
        _;
    }

    function _touch(address a) internal {
        Agent storage p = _agents[a];
        if (p.firstSeen == 0) {
            p.firstSeen = uint64(block.timestamp);
            if (bytes(p.handle).length == 0) p.handle = agentId.handleOf(a);
            emit AgentSeen(a, p.handle);
        }
    }

    function _get(uint256 callId) internal view returns (Call storage c) {
        if (callId >= _calls.length) revert UnknownCall(callId);
        c = _calls[callId];
    }

    // ------------------------------------------------------------------ pool sanity
    /// @dev One gas-capped staticcall returning exactly one word, or `ok == false`. Never bubbles the
    ///      callee's returndata, so hostile pools degrade to a clean `BadPool`. The only way it reverts is
    ///      `ProbeGasTooLow`, i.e. the *caller* left too little gas for the probe to be answered at all —
    ///      which is reported rather than silently conflated with a pool that answered wrong.
    function _probeWord(address target, bytes memory cd) private view returns (bool ok, bytes32 word) {
        if (gasleft() < PROBE_GAS_FLOOR) revert ProbeGasTooLow();
        assembly ("memory-safe") {
            let out := mload(0x40)
            mstore(0x40, add(out, 0x20))
            mstore(out, 0)
            let success := staticcall(PROBE_GAS, target, add(cd, 0x20), mload(cd), out, 0x20)
            // a non-contract target "succeeds" with 0 bytes of returndata: the length check rejects it
            ok := and(success, eq(returndatasize(), 0x20))
            word := mload(out)
        }
    }

    function _probeAddr(address target, bytes memory cd) private view returns (bool, address) {
        (bool ok, bytes32 w) = _probeWord(target, cd);
        if (!ok || uint256(w) >> 160 != 0) return (false, address(0)); // reject dirty upper bits
        return (true, address(uint160(uint256(w))));
    }

    function _probeFee(address target) private view returns (bool, uint24) {
        (bool ok, bytes32 w) = _probeWord(target, abi.encodeCall(IPoolProbe.fee, ()));
        if (!ok || uint256(w) >> 24 != 0) return (false, 0);
        return (true, uint24(uint256(w)));
    }

    /// @notice Classify `pool`: POOL_V2 (1), POOL_V3 (2), or 0 if it is not a canonical PancakeSwap pool
    ///         holding `token`.
    /// @dev    Three independent facts must hold, else 0:
    ///         1. pool.factory() is one of the two configured factories;
    ///         2. token == pool.token0() or pool.token1();
    ///         3. the factory itself maps that token pair (and fee, for v3) back to `pool`.
    ///         (3) is what defeats a fake pool that merely *claims* the right factory and tokens.
    ///         Every probe is a gas-capped staticcall whose failure is swallowed, so a hostile or
    ///         non-contract pool simply classifies as 0 instead of bubbling garbage up.
    function poolKindOf(address token, address pool) public view returns (uint8) {
        if (token == address(0) || pool == address(0)) return 0;

        (bool okF, address factory) = _probeAddr(pool, abi.encodeCall(IPoolProbe.factory, ()));
        if (!okF) return 0;
        bool isV2 = factory == v2Factory;
        if (!isV2 && factory != v3Factory) return 0;

        (bool ok0, address t0) = _probeAddr(pool, abi.encodeCall(IPoolProbe.token0, ()));
        (bool ok1, address t1) = _probeAddr(pool, abi.encodeCall(IPoolProbe.token1, ()));
        if (!ok0 || !ok1) return 0;
        if (token != t0 && token != t1) return 0;

        if (isV2) {
            (bool okP, address canonical) = _probeAddr(v2Factory, abi.encodeCall(IV2Factory.getPair, (t0, t1)));
            return (okP && canonical == pool) ? POOL_V2 : 0;
        }
        (bool okFee, uint24 fee) = _probeFee(pool);
        if (!okFee) return 0;
        (bool okP3, address canonical3) = _probeAddr(v3Factory, abi.encodeCall(IV3Factory.getPool, (t0, t1, fee)));
        return (okP3 && canonical3 == pool) ? POOL_V3 : 0;
    }

    /// @dev Same check, reverting `BadPool` on rejection. Used by every write path that publishes a pool.
    function _checkPool(address token, address pool) internal view returns (uint8 poolKind) {
        poolKind = poolKindOf(token, pool);
        if (poolKind == 0) revert BadPool();
    }

    /// @notice The hash an agent must commit. Binds the agent address so a hash cannot be copied.
    function computeHash(address agent, address token, address pool, uint8 direction, uint32 horizon, bytes32 salt)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(agent, token, pool, direction, horizon, salt));
    }

    // ------------------------------------------------------------------ sealed mode
    /// @notice Commit a hidden call. Returns the new callId.
    /// @dev    The pool cannot be checked here (it is still secret); it is checked at reveal. A sealed call
    ///         naming a non-canonical pool therefore cannot be revealed at all and forfeits once the reveal
    ///         window closes. That is intended: it makes a bad pool a loss, not an exploitable escape hatch.
    function commit(bytes32 commitHash, uint32 horizonSeconds) external onlyAgent returns (uint256 callId) {
        if (horizonSeconds < MIN_HORIZON || horizonSeconds > MAX_HORIZON) revert BadHorizon(horizonSeconds);
        if (commitHash == bytes32(0)) revert ZeroHash();
        if (hashUsed[msg.sender][commitHash]) revert HashAlreadyUsed();

        hashUsed[msg.sender][commitHash] = true;
        callId = _calls.length;
        uint64 nowTs = uint64(block.timestamp);
        uint64 expiry = nowTs + horizonSeconds;
        _calls.push(
            Call({
                agent: msg.sender,
                commitBlock: uint64(block.number),
                horizon: horizonSeconds,
                status: Status.Committed,
                mode: Mode.Sealed,
                direction: 0,
                poolKind: 0,
                commitTime: nowTs,
                expiryTime: expiry,
                revealTime: 0,
                commitHash: commitHash,
                token: address(0),
                pool: address(0)
            })
        );
        _callsOf[msg.sender].push(callId);
        Agent storage p = _agents[msg.sender];
        p.commits += 1;
        emit Committed(callId, msg.sender, p.handle, commitHash, horizonSeconds, nowTs, expiry);
    }

    /// @notice Reveal a sealed call after its horizon has passed and before the reveal window closes.
    /// @dev    The revealed pool must pass `_checkPool`; if it does not, the reveal reverts and the call
    ///         forfeits when the window closes.
    ///         Deliberately **not** `onlyAgent`: the only caller that can get past the checks below is the
    ///         committer themselves (`c.agent == msg.sender` *and* a preimage of their own bound hash), who
    ///         necessarily held an Agent ID at commit time and was already `_touch`ed then. Re-checking the
    ///         registry here would add no authentication and would let an Agent ID that expires, is burned,
    ///         or whose registry stops answering mid-horizon turn an honest in-flight call into a forfeit.
    function reveal(uint256 callId, address token, address pool, uint8 direction, bytes32 salt) external {
        Call storage c = _get(callId);
        if (c.agent != msg.sender) revert NotCommitter();
        if (c.mode != Mode.Sealed) revert NotSealed();
        if (c.status != Status.Committed) revert NotCommittedState();
        if (block.timestamp < c.expiryTime) revert TooEarly(c.expiryTime);
        uint64 deadline = c.expiryTime + REVEAL_WINDOW;
        if (block.timestamp > deadline) revert RevealWindowClosed(deadline);
        if (direction != LONG && direction != SHORT) revert BadDirection(direction);
        if (computeHash(msg.sender, token, pool, direction, c.horizon, salt) != c.commitHash) revert HashMismatch();
        uint8 kind = _checkPool(token, pool);

        c.status = Status.Revealed;
        c.token = token;
        c.pool = pool;
        c.poolKind = kind;
        c.direction = direction;
        c.revealTime = uint64(block.timestamp);
        _agents[msg.sender].reveals += 1;
        emit Revealed(callId, msg.sender, token, pool, kind, direction, c.commitBlock, c.commitTime, c.expiryTime);
    }

    /// @notice Record a forfeit for a sealed call whose reveal window has closed. Any Agent ID holder may call it.
    /// @dev    Purely bookkeeping: isForfeited() already reports the same truth without this tx.
    function markExpired(uint256 callId) external onlyAgent {
        Call storage c = _get(callId);
        if (c.mode != Mode.Sealed) revert NotSealed();
        if (c.status != Status.Committed) revert NotCommittedState();
        uint64 deadline = c.expiryTime + REVEAL_WINDOW;
        if (block.timestamp <= deadline) revert StillRevealable(deadline);
        c.status = Status.Forfeited;
        _agents[c.agent].forfeits += 1;
        emit Forfeited(callId, c.agent, msg.sender);
    }

    // ------------------------------------------------------------------ open mode
    /// @notice Publish a call immediately: no hash, no salt, nothing to reveal and nothing to forfeit.
    ///         The pool is verified here, at commit time, so an open call is always scoreable.
    function commitOpen(address token, address pool, uint8 direction, uint32 horizonSeconds)
        external
        onlyAgent
        returns (uint256 callId)
    {
        if (horizonSeconds < MIN_HORIZON || horizonSeconds > MAX_HORIZON) revert BadHorizon(horizonSeconds);
        if (direction != LONG && direction != SHORT) revert BadDirection(direction);
        uint8 kind = _checkPool(token, pool);

        callId = _calls.length;
        uint64 nowTs = uint64(block.timestamp);
        uint64 expiry = nowTs + horizonSeconds;
        _calls.push(
            Call({
                agent: msg.sender,
                commitBlock: uint64(block.number),
                horizon: horizonSeconds,
                status: Status.Revealed,
                mode: Mode.Open,
                direction: direction,
                poolKind: kind,
                commitTime: nowTs,
                expiryTime: expiry,
                revealTime: nowTs,
                commitHash: bytes32(0),
                token: token,
                pool: pool
            })
        );
        _callsOf[msg.sender].push(callId);
        Agent storage p = _agents[msg.sender];
        p.commits += 1;
        p.openCalls += 1;
        emit Committed(callId, msg.sender, p.handle, bytes32(0), horizonSeconds, nowTs, expiry);
        emit OpenCall(
            callId,
            msg.sender,
            token,
            p.handle,
            pool,
            kind,
            direction,
            horizonSeconds,
            uint64(block.number),
            nowTs,
            expiry
        );
    }

    // ------------------------------------------------------------------ social
    function follow(address agent) external onlyAgent {
        if (agent == msg.sender) revert SelfFollow();
        if (agent == address(0)) revert ZeroAddress();
        if (agentId.balanceOf(agent) == 0) revert NotAgentHolder(agent);
        if (isFollowing[msg.sender][agent]) revert AlreadyFollowing();
        Agent storage t = _agents[agent];
        if (bytes(t.handle).length == 0) t.handle = agentId.handleOf(agent);
        isFollowing[msg.sender][agent] = true;
        t.followers += 1;
        _agents[msg.sender].following += 1;
        emit Followed(msg.sender, agent);
    }

    /// @notice Drop a follow. Deliberately **not** `onlyAgent`: the `isFollowing` flag is the authentication
    ///         (it can only have been set by this same address via `follow`, which did gate on the registry
    ///         and `_touch`ed them), and nobody should be stuck following forever because their own Agent ID
    ///         lapsed. Only ever removes the caller's own follow.
    function unfollow(address agent) external {
        if (!isFollowing[msg.sender][agent]) revert NotFollowing();
        isFollowing[msg.sender][agent] = false;
        _agents[agent].followers -= 1;
        _agents[msg.sender].following -= 1;
        emit Unfollowed(msg.sender, agent);
    }

    // ------------------------------------------------------------------ views
    function totalCalls() external view returns (uint256) {
        return _calls.length;
    }

    function getCall(uint256 callId) external view returns (Call memory) {
        return _get(callId);
    }

    function getAgent(address agent) external view returns (Agent memory) {
        return _agents[agent];
    }

    function callCountOf(address agent) external view returns (uint256) {
        return _callsOf[agent].length;
    }

    /// @notice Paginated list of callIds made by `agent`, oldest first.
    function callsOf(address agent, uint256 offset, uint256 limit) external view returns (uint256[] memory ids) {
        if (limit > MAX_PAGE) revert PageTooLarge();
        uint256[] storage all = _callsOf[agent];
        uint256 n = all.length;
        if (offset >= n) return new uint256[](0);
        uint256 end = offset + limit;
        if (end > n) end = n;
        ids = new uint256[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            ids[i - offset] = all[i];
        }
    }

    /// @notice Effective status: a sealed Committed call past its reveal deadline is reported as forfeited.
    ///         Open calls can never be forfeited.
    function isForfeited(uint256 callId) public view returns (bool) {
        Call storage c = _get(callId);
        if (c.status == Status.Forfeited) return true;
        return c.status == Status.Committed && block.timestamp > uint256(c.expiryTime) + REVEAL_WINDOW;
    }

    function revealDeadline(uint256 callId) external view returns (uint64) {
        return _get(callId).expiryTime + REVEAL_WINDOW;
    }
}
