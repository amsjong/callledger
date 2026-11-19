// Read-only chain access. Never needs a wallet: the leaderboard, agent pages and call history all
// work for a visitor who never connects anything.
//
// The configured RPCs are tried in order and the one that answers is kept; a failure rotates to the
// next and the whole list is retried a couple of times, because every public BSC endpoint
// rate-limits or drops requests under load.

import { ethers, CALL_LEDGER_ABI, AGENT_ID_ABI, ERC20_ABI } from "./core.js";
import CONFIG from "../config.js";

let providerIndex = 0;
const providers = new Map();

function providerFor(url) {
  if (!providers.has(url)) {
    providers.set(url, new ethers.JsonRpcProvider(url, CONFIG.chainId, { staticNetwork: true }));
  }
  return providers.get(url);
}

/**
 * Run `fn(provider)` against the first RPC that answers. `fn` must be a read-only operation: it can
 * be retried against several endpoints.
 */
export async function withProvider(fn, { attempts = 2 } = {}) {
  const urls = CONFIG.rpcUrls;
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    for (let k = 0; k < urls.length; k++) {
      const i = (providerIndex + k) % urls.length;
      try {
        const out = await fn(providerFor(urls[i]));
        providerIndex = i;
        return out;
      } catch (e) {
        last = e;
      }
    }
    if (attempt + 1 < attempts) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  throw last || new Error("no RPC endpoint answered");
}

export function ledgerAt(runner) {
  return new ethers.Contract(CONFIG.contract, CALL_LEDGER_ABI, runner);
}

export function agentIdAt(runner) {
  return new ethers.Contract(CONFIG.agentId, AGENT_ID_ABI, runner);
}

export const readLedger = (fn) => withProvider((p) => fn(ledgerAt(p), p));
export const readAgentId = (fn) => withProvider((p) => fn(agentIdAt(p), p));

// ------------------------------------------------------------------ typed reads
/** Plain-object copy of the Call struct (ethers Result objects do not survive spreading well). */
export function toCall(callId, c) {
  return {
    callId: Number(callId),
    agent: c.agent,
    commitBlock: Number(c.commitBlock),
    horizon: Number(c.horizon),
    status: Number(c.status),
    mode: Number(c.mode),
    direction: Number(c.direction),
    poolKind: Number(c.poolKind),
    commitTime: Number(c.commitTime),
    expiryTime: Number(c.expiryTime),
    revealTime: Number(c.revealTime),
    commitHash: c.commitHash,
    token: c.token === ethers.ZeroAddress ? null : c.token,
    pool: c.pool === ethers.ZeroAddress ? null : c.pool,
  };
}

export function toAgent(address, a) {
  return {
    address,
    handle: a.handle,
    firstSeen: Number(a.firstSeen),
    commits: Number(a.commits),
    reveals: Number(a.reveals),
    forfeits: Number(a.forfeits),
    openCalls: Number(a.openCalls),
    followers: Number(a.followers),
    following: Number(a.following),
  };
}

/** Live profile + full call history for one agent, straight from the contract. */
export async function liveAgent(address, { max = 200 } = {}) {
  return withProvider(async (p) => {
    const ledger = ledgerAt(p);
    const [agentRaw, count] = await Promise.all([
      ledger.getAgent(address),
      ledger.callCountOf(address),
    ]);
    const n = Number(count);
    const ids = [];
    // callsOf is capped at MAX_PAGE = 200 per call; walk backwards from the newest page.
    for (let offset = Math.max(0, n - max); offset < n; offset += 200) {
      const page = await ledger.callsOf(address, offset, Math.min(200, n - offset));
      ids.push(...page.map(Number));
    }
    const calls = [];
    for (const id of ids) calls.push(toCall(id, await ledger.getCall(id)));
    return { profile: toAgent(address, agentRaw), calls, totalCalls: n };
  });
}

export async function liveBlockTime() {
  return withProvider(async (p) => {
    const b = await p.getBlock("latest");
    return Number(b.timestamp);
  });
}

export async function poolKindOf(token, pool) {
  return Number(await readLedger((l) => l.poolKindOf(token, pool)));
}

export async function agentIdBalance(address) {
  return BigInt(await readAgentId((r) => r.balanceOf(address)));
}

export async function handleOf(address) {
  try {
    return String(await readAgentId((r) => r.handleOf(address)));
  } catch {
    return "";
  }
}

export async function isFollowing(follower, agent) {
  return Boolean(await readLedger((l) => l.isFollowing(follower, agent)));
}

const symbolCache = new Map();

/** ERC-20 symbol, best effort. Returns "" rather than throwing; always rendered escaped. */
export async function tokenSymbol(address) {
  const key = String(address).toLowerCase();
  if (symbolCache.has(key)) return symbolCache.get(key);
  let sym = "";
  try {
    sym = String(await withProvider((p) => new ethers.Contract(address, ERC20_ABI, p).symbol()));
  } catch {
    sym = "";
  }
  symbolCache.set(key, sym);
  return sym;
}

// ------------------------------------------------------------------ static data files
/**
 * Fetch one of the indexer's JSON files. Relative URL on purpose: the site must work from any
 * subpath (GitHub Pages project pages, a file:// style subdirectory, whatever).
 */
export async function fetchData(name) {
  const url = new URL(`data/${name}`, baseUrl());
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json();
}

export function baseUrl() {
  // document.baseURI without the hash/query, so `#/agent/0x..` never breaks a relative path
  const u = new URL(document.baseURI);
  u.hash = "";
  u.search = "";
  return u;
}
