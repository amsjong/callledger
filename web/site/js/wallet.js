// Wallet connection: injected providers only.
//
// EIP-6963 discovery plus a `window.ethereum` / `window.binancew3w.ethereum` fallback. No
// WalletConnect, no QR pairing, no third-party wallet SDK — nothing leaves the page except the
// JSON-RPC the wallet itself makes. The app only ever asks for:
//   eth_requestAccounts, eth_accounts, eth_chainId, wallet_switchEthereumChain, eth_sendTransaction
// It never requests personal_sign, eth_signTypedData_v4, a token approval, or a transfer, and every
// transaction it builds carries value 0.

import { ethers } from "./core.js";
import CONFIG from "../config.js";
import { agentIdBalance as readBalance, handleOf, ledgerAt } from "./chain.js";

const listeners = new Set();

export const wallet = {
  /** [{ info: { uuid, name, icon, rdns }, provider }] */
  discovered: [],
  selected: null,
  account: null,
  chainId: null,
  /** Agent ID state for the connected account */
  handle: "",
  agentIdBalance: null, // bigint | null (null = not checked yet)
  connecting: false,
  error: null,
};

export function onWalletChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function notify() {
  for (const cb of listeners) {
    try {
      cb(wallet);
    } catch (e) {
      console.error("wallet listener failed", e);
    }
  }
}

// ------------------------------------------------------------------ discovery
function guessName(p) {
  if (!p) return "Injected wallet";
  if (p.isBinance || p.isBinanceChain || p.isBinanceWallet) return "Binance Wallet";
  if (p.isMetaMask) return "MetaMask";
  if (p.isTrust || p.isTrustWallet) return "Trust Wallet";
  if (p.isOkxWallet || p.isOKExWallet) return "OKX Wallet";
  if (p.isRabby) return "Rabby";
  if (p.isCoinbaseWallet) return "Coinbase Wallet";
  return "Injected wallet";
}

function knownProvider(p) {
  return wallet.discovered.some((d) => d.provider === p);
}

function addInjected() {
  const candidates = [];
  const eth = globalThis.window?.ethereum;
  if (eth) {
    // some wallets expose every injected provider in an array on window.ethereum
    if (Array.isArray(eth.providers)) candidates.push(...eth.providers);
    candidates.push(eth);
  }
  const bw3w = globalThis.window?.binancew3w?.ethereum;
  if (bw3w) candidates.push(bw3w);

  let n = 0;
  for (const p of candidates) {
    if (!p || knownProvider(p)) continue;
    wallet.discovered.push({
      info: { uuid: `injected-${++n}-${wallet.discovered.length}`, name: guessName(p), icon: "", rdns: "" },
      provider: p,
    });
  }
}

let discovered = false;

/** Start EIP-6963 discovery. Safe to call repeatedly; wallets that announce late still show up. */
export function discoverWallets() {
  if (discovered) return;
  discovered = true;
  if (!globalThis.window) return;

  window.addEventListener("eip6963:announceProvider", (ev) => {
    const detail = ev.detail;
    if (!detail?.provider || !detail?.info) return;
    if (wallet.discovered.some((d) => d.info.uuid === detail.info.uuid) || knownProvider(detail.provider)) return;
    wallet.discovered.push({ info: detail.info, provider: detail.provider });
    notify();
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  // give 6963 a moment to answer before falling back to the legacy injection
  addInjected();
  setTimeout(() => {
    addInjected();
    notify();
  }, 400);
}

// ------------------------------------------------------------------ connection
function bindEvents(provider) {
  if (provider.__clBound) return;
  provider.__clBound = true;
  provider.on?.("accountsChanged", (accounts) => {
    wallet.account = accounts?.[0] ? ethers.getAddress(accounts[0]) : null;
    wallet.handle = "";
    wallet.agentIdBalance = null;
    notify();
    if (wallet.account) refreshAgentId();
  });
  provider.on?.("chainChanged", (chainIdHex) => {
    wallet.chainId = Number(BigInt(chainIdHex));
    notify();
  });
  provider.on?.("disconnect", () => {
    disconnectWallet();
  });
}

export async function connectWallet(entry) {
  const target = entry || wallet.discovered[0];
  if (!target) throw new Error("No injected wallet found. Open this page in a wallet's browser, or install one.");
  wallet.connecting = true;
  wallet.error = null;
  notify();
  try {
    const provider = target.provider;
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    if (!accounts?.length) throw new Error("The wallet returned no accounts.");
    const chainIdHex = await provider.request({ method: "eth_chainId" });
    wallet.selected = target;
    wallet.account = ethers.getAddress(accounts[0]);
    wallet.chainId = Number(BigInt(chainIdHex));
    bindEvents(provider);
    notify();
    await refreshAgentId();
    return wallet.account;
  } catch (e) {
    wallet.error = e;
    throw e;
  } finally {
    wallet.connecting = false;
    notify();
  }
}

export function disconnectWallet() {
  // There is no way to make an injected wallet forget us; this just drops our own state.
  wallet.selected = null;
  wallet.account = null;
  wallet.chainId = null;
  wallet.handle = "";
  wallet.agentIdBalance = null;
  notify();
}

/** Reconnect silently if the wallet already authorised this origin (no popup). */
export async function tryEagerConnect() {
  discoverWallets();
  for (const entry of wallet.discovered) {
    try {
      const accounts = await entry.provider.request({ method: "eth_accounts" });
      if (accounts?.length) {
        const chainIdHex = await entry.provider.request({ method: "eth_chainId" });
        wallet.selected = entry;
        wallet.account = ethers.getAddress(accounts[0]);
        wallet.chainId = Number(BigInt(chainIdHex));
        bindEvents(entry.provider);
        notify();
        await refreshAgentId();
        return true;
      }
    } catch {
      /* a wallet that will not answer eth_accounts simply stays disconnected */
    }
  }
  return false;
}

// ------------------------------------------------------------------ Agent ID gate
/** Who the connected account is, per the Agent ID registry. Read through the public RPC. */
export async function refreshAgentId() {
  if (!wallet.account) return;
  try {
    const bal = await readBalance(wallet.account);
    wallet.agentIdBalance = bal;
    wallet.handle = bal > 0n ? await handleOf(wallet.account) : "";
  } catch (e) {
    wallet.agentIdBalance = null;
    wallet.handle = "";
    console.warn("Agent ID lookup failed", e);
  }
  notify();
}

export function hasAgentId() {
  return wallet.agentIdBalance !== null && wallet.agentIdBalance > 0n;
}

export function canWrite() {
  return Boolean(wallet.account) && wallet.chainId === CONFIG.chainId && hasAgentId();
}

// ------------------------------------------------------------------ chain switching
/**
 * Ask the wallet which chain it is on, rather than trusting `wallet.chainId`.
 *
 * The cached value comes from the `chainChanged` event, and plenty of injected wallets emit that
 * late, unreliably, or not at all — so a user who switches networks mid-flow could otherwise have
 * a transaction go out on the wrong chain while our state still said 56.
 */
export async function liveChainId() {
  if (!wallet.selected) throw new Error("Connect a wallet first.");
  const hex = await wallet.selected.provider.request({ method: "eth_chainId" });
  const id = Number(BigInt(hex));
  if (wallet.chainId !== id) {
    wallet.chainId = id;
    notify();
  }
  return id;
}

/** Who the wallet says is active right now, re-read rather than remembered (same reasoning). */
export async function liveAccount() {
  if (!wallet.selected) throw new Error("Connect a wallet first.");
  const accounts = await wallet.selected.provider.request({ method: "eth_accounts" });
  const a = accounts?.[0] ? ethers.getAddress(accounts[0]) : null;
  if (a !== wallet.account) {
    wallet.account = a;
    wallet.handle = "";
    wallet.agentIdBalance = null;
    notify();
  }
  return a;
}

export async function ensureChain() {
  if (!wallet.selected) throw new Error("Connect a wallet first.");
  if ((await liveChainId()) === CONFIG.chainId) return true;
  try {
    await wallet.selected.provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CONFIG.chainHex }],
    });
  } catch (e) {
    throw new Error(
      `This app only works on ${CONFIG.name} (chain ${CONFIG.chainId}). ` +
        `Switch networks in your wallet and try again. (${e.shortMessage || e.message || e})`,
    );
  }
  if ((await liveChainId()) !== CONFIG.chainId) {
    throw new Error(`Still on chain ${wallet.chainId}; this app needs chain ${CONFIG.chainId}.`);
  }
  return true;
}

// ------------------------------------------------------------------ sending
/** An ethers signer bound to the selected injected provider. */
export async function getSigner() {
  if (!wallet.selected) throw new Error("Connect a wallet first.");
  const bp = new ethers.BrowserProvider(wallet.selected.provider, CONFIG.chainId);
  return bp.getSigner(wallet.account);
}

/**
 * Send a CallLedger transaction. The single choke point for every write in the app, and the only
 * place `eth_sendTransaction` is reached — so it re-establishes every precondition here, at send
 * time, rather than relying on whatever was true when the page was drawn:
 *
 *   - the wallet is on the configured chain (asked, not remembered);
 *   - the active account is still the one the arguments were built for (`expectFrom`);
 *   - the account holds an Agent ID, for the paths the contract gates;
 *   - `to` is always CONFIG.contract and `value` is always 0.
 *
 * `to` is deliberately not a parameter: no URL, ticket or JSON file can redirect a transaction.
 */
export async function sendLedgerTx(fn, args, { requireAgentId = true, expectFrom = null } = {}) {
  if (!wallet.account) throw new Error("Connect a wallet first.");
  await ensureChain();
  const from = await liveAccount();
  if (!from) throw new Error("The wallet has no account connected any more. Reconnect and try again.");
  if (expectFrom && from !== ethers.getAddress(expectFrom)) {
    throw new Error(
      `The wallet switched to ${from} while this was being confirmed, but the transaction was ` +
        `built for ${ethers.getAddress(expectFrom)}. Nothing was sent — start the step again with ` +
        "the account you want to use.",
    );
  }
  await refreshAgentId();
  if (requireAgentId && !hasAgentId()) {
    throw new Error("You need an Agent ID to post calls. Get one in the Binance App: Wallet > Agent ID.");
  }
  const signer = await getSigner();
  return ledgerAt(signer)[fn](...args, { value: 0 });
}
