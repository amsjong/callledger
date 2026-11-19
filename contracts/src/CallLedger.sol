// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal view interface of the SPACE ID Agent ID registry (soulbound ERC-721, BSC mainnet
///         0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F). Only views are used.
interface IAgentID {
    function balanceOf(address owner) external view returns (uint256);
    function handleOf(address owner) external view returns (string memory);
}

/// @title CallLedger
/// @notice Commit-reveal ledger of market calls made by Agent ID holders.
///         An agent commits a hidden call (token, pool, direction, horizon); after the horizon expires
///         it must reveal within REVEAL_WINDOW or the call is forfeited (counted as a loss by the scorer).
///         Scoring happens off-chain from public chain data only (pool state at commitBlock and at the
///         first block with timestamp >= expiryTime), so anyone can recompute every agent's record.
/// @dev    No owner, no admin, no payable functions, no token transfers, no approvals.
///         The only external calls are view calls to the Agent ID registry.
contract CallLedger {
    // ------------------------------------------------------------------ constants
    uint32 public constant MIN_HORIZON = 1 hours;
    uint32 public constant MAX_HORIZON = 30 days;
    uint32 public constant REVEAL_WINDOW = 7 days;
    uint256 public constant MAX_PAGE = 200;

    uint8 public constant LONG = 1;
    uint8 public constant SHORT = 2;

    enum Status {
        None, // call does not exist
        Committed, // hidden, horizon may or may not have passed
        Revealed,
        Forfeited // not revealed within the window (explicitly marked)
    }

    struct Call {
        address agent;
        uint64 commitBlock;
        uint32 horizon;
        Status status;
        uint64 commitTime;
        uint64 expiryTime; // commitTime + horizon
        bytes32 commitHash;
        // filled on reveal
        address token;
        address pool;
        uint8 direction;
        uint64 revealTime;
    }

    struct Agent {
        string handle; // Agent ID handle snapshot at first interaction (e.g. "levi" for levi.ai)
        uint64 firstSeen; // timestamp of first own interaction (0 if only ever followed)
        uint32 commits;
        uint32 reveals;
        uint32 forfeits;
        uint32 followers;
        uint32 following;
    }

    // ------------------------------------------------------------------ storage
    IAgentID public immutable agentId;

    Call[] private _calls; // callId = index
    mapping(address => Agent) private _agents;
    mapping(address => uint256[]) private _callsOf;
    mapping(bytes32 => bool) public hashUsed;
    mapping(address => mapping(address => bool)) public isFollowing; // follower => agent => bool

    // ------------------------------------------------------------------ events
    event AgentSeen(address indexed agent, string handle);
    event Committed(
        uint256 indexed callId,
        address indexed agent,
        string handle,
        bytes32 commitHash,
        uint32 horizon,
        uint64 commitTime,
        uint64 expiryTime
    );
    event Revealed(
        uint256 indexed callId,
        address indexed agent,
        address indexed token,
        address pool,
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
    error TooEarly(uint64 expiryTime);
    error RevealWindowClosed(uint64 deadline);
    error StillRevealable(uint64 deadline);
    error HashMismatch();
    error BadDirection(uint8 direction);
    error ZeroAddress();
    error SelfFollow();
    error AlreadyFollowing();
    error NotFollowing();
    error PageTooLarge();

    constructor(IAgentID agentId_) {
        if (address(agentId_) == address(0)) revert ZeroAddress();
        agentId = agentId_;
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

    /// @notice The hash an agent must commit. Binds the agent address so a hash cannot be copied.
    function computeHash(
        address agent,
        address token,
        address pool,
        uint8 direction,
        uint32 horizon,
        bytes32 salt
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(agent, token, pool, direction, horizon, salt));
    }

    // ------------------------------------------------------------------ core
    /// @notice Commit a hidden call. Returns the new callId.
    function commit(bytes32 commitHash, uint32 horizonSeconds) external onlyAgent returns (uint256 callId) {
        if (horizonSeconds < MIN_HORIZON || horizonSeconds > MAX_HORIZON) revert BadHorizon(horizonSeconds);
        if (commitHash == bytes32(0)) revert ZeroHash();
        if (hashUsed[commitHash]) revert HashAlreadyUsed();

        hashUsed[commitHash] = true;
        callId = _calls.length;
        uint64 nowTs = uint64(block.timestamp);
        uint64 expiry = nowTs + horizonSeconds;
        _calls.push(
            Call({
                agent: msg.sender,
                commitBlock: uint64(block.number),
                horizon: horizonSeconds,
                status: Status.Committed,
                commitTime: nowTs,
                expiryTime: expiry,
                commitHash: commitHash,
                token: address(0),
                pool: address(0),
                direction: 0,
                revealTime: 0
            })
        );
        _callsOf[msg.sender].push(callId);
        Agent storage p = _agents[msg.sender];
        p.commits += 1;
        emit Committed(callId, msg.sender, p.handle, commitHash, horizonSeconds, nowTs, expiry);
    }

    /// @notice Reveal a call after its horizon has passed and before the reveal window closes.
    function reveal(uint256 callId, address token, address pool, uint8 direction, bytes32 salt) external onlyAgent {
        Call storage c = _get(callId);
        if (c.agent != msg.sender) revert NotCommitter();
        if (c.status != Status.Committed) revert NotCommittedState();
        if (block.timestamp < c.expiryTime) revert TooEarly(c.expiryTime);
        uint64 deadline = c.expiryTime + REVEAL_WINDOW;
        if (block.timestamp > deadline) revert RevealWindowClosed(deadline);
        if (direction != LONG && direction != SHORT) revert BadDirection(direction);
        if (token == address(0) || pool == address(0)) revert ZeroAddress();
        if (computeHash(msg.sender, token, pool, direction, c.horizon, salt) != c.commitHash) revert HashMismatch();

        c.status = Status.Revealed;
        c.token = token;
        c.pool = pool;
        c.direction = direction;
        c.revealTime = uint64(block.timestamp);
        _agents[msg.sender].reveals += 1;
        emit Revealed(callId, msg.sender, token, pool, direction, c.commitBlock, c.commitTime, c.expiryTime);
    }

    /// @notice Record a forfeit for a call whose reveal window has closed. Any Agent ID holder may call it.
    /// @dev    Purely bookkeeping: isForfeited() already reports the same truth without this tx.
    function markExpired(uint256 callId) external onlyAgent {
        Call storage c = _get(callId);
        if (c.status != Status.Committed) revert NotCommittedState();
        uint64 deadline = c.expiryTime + REVEAL_WINDOW;
        if (block.timestamp <= deadline) revert StillRevealable(deadline);
        c.status = Status.Forfeited;
        _agents[c.agent].forfeits += 1;
        emit Forfeited(callId, c.agent, msg.sender);
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

    function unfollow(address agent) external onlyAgent {
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

    /// @notice Effective status: a Committed call past its reveal deadline is reported as forfeited.
    function isForfeited(uint256 callId) public view returns (bool) {
        Call storage c = _get(callId);
        if (c.status == Status.Forfeited) return true;
        return c.status == Status.Committed && block.timestamp > uint256(c.expiryTime) + REVEAL_WINDOW;
    }

    function revealDeadline(uint256 callId) external view returns (uint64) {
        return _get(callId).expiryTime + REVEAL_WINDOW;
    }
}
