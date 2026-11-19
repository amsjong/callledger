// CallLedger core: pure helpers shared by the browser app and the node tests.
//
// Nothing in here touches the DOM, a wallet, or network state that is not passed in, so
// web/test/*.mjs imports this exact module and checks its hash/encoding against the live contract.
// If a hash here ever disagreed with `CallLedger.computeHash`, every sealed call made in this app
// would be unrevealable — so that equality is the single most important invariant we test.

import { ethers } from "../vendor/ethers.min.js";

export { ethers };

// ------------------------------------------------------------------ ABIs
export const CALL_LEDGER_ABI = [
  // views
  "function computeHash(address agent, address token, address pool, uint8 direction, uint32 horizon, bytes32 salt) view returns (bytes32)",
  "function poolKindOf(address token, address pool) view returns (uint8)",
  "function totalCalls() view returns (uint256)",
  "function getCall(uint256 callId) view returns (tuple(address agent, uint64 commitBlock, uint32 horizon, uint8 status, uint8 mode, uint8 direction, uint8 poolKind, uint64 commitTime, uint64 expiryTime, uint64 revealTime, bytes32 commitHash, address token, address pool))",
  "function getAgent(address agent) view returns (tuple(string handle, uint64 firstSeen, uint32 commits, uint32 reveals, uint32 forfeits, uint32 openCalls, uint32 followers, uint32 following))",
  "function callCountOf(address agent) view returns (uint256)",
  "function callsOf(address agent, uint256 offset, uint256 limit) view returns (uint256[])",
  "function isForfeited(uint256 callId) view returns (bool)",
  "function revealDeadline(uint256 callId) view returns (uint64)",
  "function isFollowing(address follower, address agent) view returns (bool)",
  "function hashUsed(address agent, bytes32 commitHash) view returns (bool)",
  "function MIN_HORIZON() view returns (uint32)",
  "function MAX_HORIZON() view returns (uint32)",
  "function REVEAL_WINDOW() view returns (uint32)",
  "function agentId() view returns (address)",
  "function v2Factory() view returns (address)",
  "function v3Factory() view returns (address)",
  // writes (all non-payable, none of them move a token)
  "function commit(bytes32 commitHash, uint32 horizonSeconds) returns (uint256)",
  "function commitOpen(address token, address pool, uint8 direction, uint32 horizonSeconds) returns (uint256)",
  "function reveal(uint256 callId, address token, address pool, uint8 direction, bytes32 salt)",
  "function markExpired(uint256 callId)",
  "function follow(address agent)",
  "function unfollow(address agent)",
  // events
  "event AgentSeen(address indexed agent, string handle)",
  "event Committed(uint256 indexed callId, address indexed agent, string handle, bytes32 commitHash, uint32 horizon, uint64 commitTime, uint64 expiryTime)",
  "event OpenCall(uint256 indexed callId, address indexed agent, address indexed token, string handle, address pool, uint8 poolKind, uint8 direction, uint32 horizon, uint64 commitBlock, uint64 commitTime, uint64 expiryTime)",
  "event Revealed(uint256 indexed callId, address indexed agent, address indexed token, address pool, uint8 poolKind, uint8 direction, uint64 commitBlock, uint64 commitTime, uint64 expiryTime)",
  "event Forfeited(uint256 indexed callId, address indexed agent, address indexed markedBy)",
  "event Followed(address indexed follower, address indexed agent)",
  "event Unfollowed(address indexed follower, address indexed agent)",
  // custom errors, so a revert shows a name instead of a hex blob
  "error NotAgentHolder(address account)",
  "error BadHorizon(uint32 horizon)",
  "error HashAlreadyUsed()",
  "error ZeroHash()",
  "error UnknownCall(uint256 callId)",
  "error NotCommitter()",
  "error NotCommittedState()",
  "error NotSealed()",
  "error TooEarly(uint64 expiryTime)",
  "error RevealWindowClosed(uint64 deadline)",
  "error StillRevealable(uint64 deadline)",
  "error HashMismatch()",
  "error BadDirection(uint8 direction)",
  "error BadPool()",
  "error ZeroAddress()",
  "error SelfFollow()",
  "error AlreadyFollowing()",
  "error NotFollowing()",
  "error PageTooLarge()",
  "error SameFactory()",
  "error ProbeGasTooLow()",
];

export const AGENT_ID_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function handleOf(address owner) view returns (string)",
  "function ownerOfHandle(string handle) view returns (address)",
];

export const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

export const ledgerInterface = new ethers.Interface(CALL_LEDGER_ABI);
export const agentIdInterface = new ethers.Interface(AGENT_ID_ABI);

// ------------------------------------------------------------------ constants mirroring the contract
export const MIN_HORIZON = 3600;
export const MAX_HORIZON = 30 * 24 * 3600;
export const REVEAL_WINDOW = 7 * 24 * 3600;

export const DIRECTION = { LONG: 1, SHORT: 2 };
export const DIRECTION_NAME = { 0: "", 1: "Long", 2: "Short" };
export const MODE = { SEALED: 1, OPEN: 2 };
export const MODE_NAME = { 0: "", 1: "Sealed", 2: "Open" };
export const STATUS_NAME = { 0: "None", 1: "Committed", 2: "Revealed", 3: "Forfeited" };
export const POOL_KIND_NAME = { 0: "unknown", 1: "Pancake v2 pair", 2: "Pancake v3 pool" };

export const HORIZON_PRESETS = [
  { label: "1 hour", seconds: 3600 },
  { label: "4 hours", seconds: 4 * 3600 },
  { label: "24 hours", seconds: 24 * 3600 },
  { label: "3 days", seconds: 3 * 24 * 3600 },
  { label: "7 days", seconds: 7 * 24 * 3600 },
  { label: "14 days", seconds: 14 * 24 * 3600 },
  { label: "30 days", seconds: 30 * 24 * 3600 },
];

// ------------------------------------------------------------------ the commit hash
/**
 * The exact preimage CallLedger hashes:
 *   keccak256(abi.encode(address agent, address token, address pool, uint8 direction,
 *                        uint32 horizon, bytes32 salt))
 * Returns the 0x-prefixed 32-byte hash. Throws on a malformed address/salt rather than
 * producing a hash nobody can reveal.
 */
export function computeHash({ agent, token, pool, direction, horizon, salt }) {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address", "uint8", "uint32", "bytes32"],
    [
      ethers.getAddress(agent),
      ethers.getAddress(token),
      ethers.getAddress(pool),
      checkDirection(direction),
      checkHorizon(horizon),
      checkSalt(salt),
    ],
  );
  return ethers.keccak256(encoded);
}

export function checkDirection(direction) {
  const d = Number(direction);
  if (d !== DIRECTION.LONG && d !== DIRECTION.SHORT) throw new Error(`direction must be 1 (long) or 2 (short), got ${direction}`);
  return d;
}

export function checkHorizon(horizon) {
  const h = Number(horizon);
  if (!Number.isInteger(h) || h < MIN_HORIZON || h > MAX_HORIZON) {
    throw new Error(`horizon must be a whole number of seconds between ${MIN_HORIZON} (1h) and ${MAX_HORIZON} (30d), got ${horizon}`);
  }
  return h;
}

export function checkSalt(salt) {
  const s = String(salt);
  if (!/^0x[0-9a-fA-F]{64}$/.test(s)) throw new Error("salt must be 32 bytes of hex (0x + 64 hex chars)");
  return s.toLowerCase();
}

/**
 * 32 cryptographically random bytes. The seal rests entirely on this: `computeHash` is public and
 * the hidden space is tiny, so a guessable salt means a sealed call can be brute-forced off-chain.
 */
export function randomSalt() {
  const b = new Uint8Array(32);
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== "function") {
    throw new Error("no crypto.getRandomValues in this environment: refusing to generate a weak salt");
  }
  c.getRandomValues(b);
  return ethers.hexlify(b);
}

// ------------------------------------------------------------------ calldata + confirmations
/** Encoded calldata for any CallLedger function. */
export function encodeCall(fn, args) {
  return ledgerInterface.encodeFunctionData(fn, args);
}

/**
 * A human-readable one-liner for the confirmation box, e.g.
 *   commit(bytes32 0xab..cd, uint32 86400)
 * Built from the ABI fragment, so it cannot drift from what is actually being sent.
 */
export function describeCall(fn, args) {
  const frag = ledgerInterface.getFunction(fn);
  const parts = frag.inputs.map((input, i) => `${input.type} ${formatArg(args[i])}`);
  return `${frag.name}(${parts.join(", ")})`;
}

function formatArg(v) {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string" && v.startsWith("0x") && v.length === 42) return ethers.getAddress(v);
  return String(v);
}

/** The full set of facts a user should see before signing. */
export function txPreview({ contract, fn, args, chainId }) {
  return {
    contract: ethers.getAddress(contract),
    chainId,
    signature: describeCall(fn, args),
    data: encodeCall(fn, args),
    value: "0",
  };
}

// ------------------------------------------------------------------ reveal tickets
export const TICKET_KIND = "callledger-reveal-ticket";
export const TICKET_VERSION = 1;
/** A ticket is a dozen short fields; anything larger is not one, and is refused before parsing. */
export const MAX_TICKET_BYTES = 8192;

/** `createdAt` is the one free-text ticket field that reaches the DOM, so it is shape-checked. */
function checkCreatedAt(v) {
  const s = String(v ?? "");
  return /^[0-9T:.+\-Z]{1,32}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : "";
}

function checkCallId(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function checkTxHash(v) {
  const s = String(v ?? "");
  return /^0x[0-9a-fA-F]{64}$/.test(s) ? s.toLowerCase() : null;
}

/** The object saved to localStorage and downloaded as a file. The salt is the only irreplaceable part. */
export function makeTicket({ chainId, contract, agent, token, pool, direction, horizon, salt, hash }) {
  return {
    kind: TICKET_KIND,
    version: TICKET_VERSION,
    createdAt: new Date().toISOString(),
    chainId: Number(chainId),
    contract: ethers.getAddress(contract),
    agent: ethers.getAddress(agent),
    token: ethers.getAddress(token),
    pool: ethers.getAddress(pool),
    direction: checkDirection(direction),
    horizon: checkHorizon(horizon),
    salt: checkSalt(salt),
    hash,
    callId: null,
    txHash: null,
    warning: "Save this file. If you lose the salt you cannot reveal and the call counts as a loss (forfeit).",
  };
}

/**
 * Parse + validate an imported ticket. Throws with a plain-English reason.
 *
 * Every field is rebuilt through `makeTicket`, so unknown keys are dropped and each known one is
 * re-validated; the hash is recomputed from the contents rather than trusted. Pass `expectAgent`
 * to additionally require that the ticket belongs to the connected account — a ticket for someone
 * else's address cannot be revealed and should be refused at the door rather than stored.
 */
export function parseTicket(text, { expectAgent = null } = {}) {
  let t;
  if (typeof text === "string" && text.length > MAX_TICKET_BYTES) {
    throw new Error("that file is far too large to be a reveal ticket");
  }
  try {
    t = typeof text === "string" ? JSON.parse(text) : text;
  } catch {
    throw new Error("that file is not valid JSON");
  }
  if (!t || typeof t !== "object" || Array.isArray(t) || t.kind !== TICKET_KIND) {
    throw new Error("that file is not a CallLedger reveal ticket");
  }
  if (t.version !== undefined && Number(t.version) !== TICKET_VERSION) {
    throw new Error(`that ticket is version ${String(t.version).slice(0, 16)}; this app reads version ${TICKET_VERSION}`);
  }
  for (const k of ["contract", "agent", "token", "pool", "direction", "horizon", "salt"]) {
    if (t[k] === undefined || t[k] === null) throw new Error(`the ticket is missing "${k}"`);
  }
  const rebuilt = makeTicket(t);
  const hash = computeHash(rebuilt);
  if (t.hash && String(t.hash).toLowerCase() !== hash.toLowerCase()) {
    throw new Error("the ticket's hash does not match its own contents (edited or corrupted file)");
  }
  if (expectAgent && rebuilt.agent !== ethers.getAddress(expectAgent)) {
    throw new Error(
      `that ticket belongs to ${rebuilt.agent}, but ${ethers.getAddress(expectAgent)} is connected. ` +
        "The commit hash binds the agent address, so only that account can reveal it.",
    );
  }
  return {
    ...rebuilt,
    createdAt: checkCreatedAt(t.createdAt) || rebuilt.createdAt,
    hash,
    callId: checkCallId(t.callId),
    txHash: checkTxHash(t.txHash),
  };
}

/** The ticket key: a hash is unique per agent in the contract (`hashUsed` is keyed per agent). */
export function ticketKey(t) {
  return `${Number(t.chainId)}:${String(t.contract).toLowerCase()}:${String(t.agent).toLowerCase()}:${String(t.hash).toLowerCase()}`;
}

// ------------------------------------------------------------------ call status logic
/** Effective status of a call: an unmarked sealed call past its reveal window reads as forfeited. */
export function effectiveStatus(call, nowSeconds) {
  const status = Number(call.status);
  const mode = Number(call.mode);
  const expiry = Number(call.expiryTime);
  if (status === 3) return "Forfeited";
  if (mode === MODE.SEALED && status === 1) {
    if (nowSeconds > expiry + REVEAL_WINDOW) return "Forfeited";
    return nowSeconds < expiry ? "Sealed (awaiting horizon)" : "Sealed (revealable now)";
  }
  return STATUS_NAME[status] || "?";
}

/** Can this call be revealed right now? */
export function isRevealable(call, nowSeconds) {
  const expiry = Number(call.expiryTime);
  return (
    Number(call.mode) === MODE.SEALED &&
    Number(call.status) === 1 &&
    nowSeconds >= expiry &&
    nowSeconds <= expiry + REVEAL_WINDOW
  );
}

// ------------------------------------------------------------------ formatting
export function shortAddr(a, head = 6, tail = 4) {
  if (!a) return "";
  const s = String(a);
  return s.length <= head + tail + 2 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export function handleLabel(handle, address) {
  const h = (handle || "").trim();
  return h ? `${h}.ai` : shortAddr(address);
}

export function horizonLabel(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return "";
  if (s % 86400 === 0) return `${s / 86400}d`;
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

/** Local time with the viewer's zone spelled out, so "commit time" is never ambiguous. */
export function localTime(unixSeconds) {
  const n = Number(unixSeconds);
  if (!n) return "—";
  const d = new Date(n * 1000);
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZoneName: "short",
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

export function relTime(unixSeconds, nowSeconds = Math.floor(Date.now() / 1000)) {
  const d = Number(unixSeconds) - nowSeconds;
  const abs = Math.abs(d);
  const units = [
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
    [1, "second"],
  ];
  for (const [secs, name] of units) {
    if (abs >= secs || secs === 1) {
      const n = Math.round(d / secs);
      try {
        return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(n, name);
      } catch {
        return `${n} ${name}(s)`;
      }
    }
  }
  return "";
}

export function fmtPct(v, digits = 2) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "—";
  const n = Number(v);
  return `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

export function fmtScore(v, digits = 2) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "—";
  const n = Number(v);
  return `${n > 0 ? "+" : ""}${n.toFixed(digits)}`;
}

export function fmtUsd(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "—";
  return `$${Math.round(Number(v)).toLocaleString()}`;
}

export function fmtRate(v) {
  if (v === null || v === undefined) return "—";
  return `${Math.round(Number(v) * 100)}%`;
}

export function explorerAddress(explorer, address) {
  return `${explorer.replace(/\/$/, "")}/address/${address}`;
}

export function explorerTx(explorer, hash) {
  return `${explorer.replace(/\/$/, "")}/tx/${hash}`;
}

/**
 * Turn whatever a provider/wallet threw into one short sentence. Decodes CallLedger custom errors
 * (ethers populates `revert` for us once the ABI is known) and the usual wallet rejection codes.
 */
export function explainError(err) {
  if (!err) return "Unknown error.";
  if (err.code === "ACTION_REJECTED" || err.code === 4001) return "You rejected the request in your wallet.";
  const revert = err.revert || err.error?.revert || err.info?.error?.revert;
  if (revert?.name) {
    const args = (revert.args || []).map((a) => String(a)).join(", ");
    const hints = {
      NotAgentHolder: "That address does not hold an Agent ID.",
      BadPool: "That pool is not a canonical PancakeSwap v2/v3 pool holding this token.",
      HashAlreadyUsed: "You have already committed this exact hash. Generate a fresh salt.",
      TooEarly: "The horizon has not passed yet.",
      RevealWindowClosed: "The 7-day reveal window has closed; this call is a forfeit.",
      HashMismatch: "The salt/inputs do not match the committed hash.",
      BadHorizon: "The horizon must be between 1 hour and 30 days.",
      AlreadyFollowing: "You already follow this agent.",
      NotFollowing: "You do not follow this agent.",
      SelfFollow: "You cannot follow yourself.",
    };
    return `${revert.name}(${args})` + (hints[revert.name] ? ` — ${hints[revert.name]}` : "");
  }
  const msg = err.shortMessage || err.reason || err.message || String(err);
  return String(msg).slice(0, 300);
}
