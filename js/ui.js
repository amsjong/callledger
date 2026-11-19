// Shared chrome: the risk banner, the wallet bar, the transaction confirmation box, toasts,
// status pills, and the sortable-table helper. Nothing here knows about a specific page.

import { html, raw, setHtml, $, escapeHtml, safeAddr, safeHash, safeHref } from "./dom.js";
import {
  shortAddr,
  handleLabel,
  fmtScore,
  explainError,
  txPreview,
  localTime,
} from "./core.js";
import CONFIG, { MAINNET } from "../config.js";
import {
  wallet,
  discoverWallets,
  connectWallet,
  disconnectWallet,
  onWalletChange,
  hasAgentId,
  canWrite,
  ensureChain,
} from "./wallet.js";
import { fetchData } from "./chain.js";

export const RISK_TEXT =
  "Not financial advice. Past calls don't predict future results. This app never touches your funds.";

export const AGENT_ID_PROMPT =
  "You need an Agent ID to post calls. Get one in the Binance App: Wallet > Agent ID.";

// ------------------------------------------------------------------ links
/**
 * The explorer origin, validated once. Every outbound link in the app is `explorerBase() + "/..."`
 * with an address or tx hash that has already passed a hex test, so there is no path by which a
 * handle, a token symbol, a ticket or a URL fragment can reach an href.
 */
export function explorerBase() {
  for (const candidate of [CONFIG.explorer, MAINNET.explorer]) {
    const u = String(candidate || "").replace(/\/+$/, "");
    if (/^https:\/\/[a-z0-9.-]+$/i.test(u)) return u;
  }
  return ""; // neither value is a plain https origin: degrade to a same-origin relative path
}

export function explorerAddrLink(address, label) {
  const a = safeAddr(address);
  if (!a) return html`<span class="muted">—</span>`;
  return html`<a href="${explorerBase()}/address/${a}" target="_blank" rel="noopener noreferrer"
    >${label ?? shortAddr(a)}</a
  >`;
}

export function explorerTxLink(hash, label) {
  const h = safeHash(hash);
  if (!h) return html`<span class="muted">—</span>`;
  return html`<a href="${explorerBase()}/tx/${h}" target="_blank" rel="noopener noreferrer"
    >${label ?? shortAddr(h, 8, 6)}</a
  >`;
}

export function agentLink(address, handle) {
  const a = safeAddr(address);
  if (!a) return html`<span class="muted">—</span>`;
  return html`<a href="#/agent/${a.toLowerCase()}">${handleLabel(handle, a)}</a>`;
}

// ------------------------------------------------------------------ pills
const SCORE_CLASS = { SCORED: "ok", PENDING: "wait", VOID: "void", FORFEIT: "bad" };

export function scorePill(score) {
  if (!score || !score.status) return html`<span class="pill">—</span>`;
  const cls = SCORE_CLASS[score.status] || "";
  const title =
    score.voidReason ||
    score.reason ||
    (score.status === "SCORED" ? `raw ${score.rawReturnPct}%` : "");
  const value =
    score.cappedScore === null || score.cappedScore === undefined
      ? score.status
      : `${fmtScore(score.cappedScore)}`;
  return html`<span class="pill ${cls}" title="${title}">${value}</span>`;
}

export function statusPill(text) {
  const t = String(text || "");
  const cls = /Forfeit/i.test(t) ? "bad" : /Revealed/i.test(t) ? "ok" : /revealable/i.test(t) ? "wait" : "";
  return html`<span class="pill ${cls}">${t}</span>`;
}

export function dirPill(direction) {
  const d = String(direction || "");
  if (!d) return html`<span class="muted">—</span>`;
  return html`<span class="pill ${/long/i.test(d) ? "ok" : "bad"}">${d}</span>`;
}

// ------------------------------------------------------------------ toasts
export function toast(message, kind = "info", ms = 6000) {
  const host = $("#toasts");
  if (!host) return;
  const node = document.createElement("div");
  node.className = `toast ${kind}`;
  node.textContent = String(message);
  const close = document.createElement("button");
  close.className = "toast-x";
  close.type = "button";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";
  close.addEventListener("click", () => node.remove());
  node.appendChild(close);
  host.appendChild(node);
  if (ms) setTimeout(() => node.remove(), ms);
  return node;
}

export function toastError(e) {
  console.error(e);
  return toast(explainError(e), "error", 12000);
}

// ------------------------------------------------------------------ confirmation box
/**
 * Show exactly what is about to be signed — the contract, the chain, the function signature with
 * decoded arguments, and the fact that value is 0 — and resolve true only if the user confirms.
 */
export function confirmTx({ fn, args, title = "Confirm transaction", notes = [] }) {
  const preview = txPreview({ contract: CONFIG.contract, fn, args, chainId: CONFIG.chainId });
  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.className = "modal-host";
    setHtml(
      host,
      html`
        <div class="modal" role="dialog" aria-modal="true" aria-label="${title}">
          <h3>${title}</h3>
          <p class="muted small">
            Check this against your wallet's own prompt. This app never asks for a signature, an
            approval or a transfer, and never sends value.
          </p>
          <dl class="kv">
            <dt>Function</dt>
            <dd><code class="wrap">${preview.signature}</code></dd>
            <dt>Contract</dt>
            <dd><code class="wrap">${preview.contract}</code></dd>
            <dt>Chain</dt>
            <dd>${CONFIG.name} (chainId ${CONFIG.chainId})</dd>
            <dt>Value</dt>
            <dd>0 ${CONFIG.nativeSymbol}</dd>
            <dt>Calldata</dt>
            <dd><code class="wrap tiny">${preview.data}</code></dd>
          </dl>
          ${notes.length
            ? html`<ul class="notes">
                ${notes.map((n) => html`<li>${n}</li>`)}
              </ul>`
            : ""}
          <div class="row end gap">
            <button type="button" class="btn ghost" data-act="cancel">Cancel</button>
            <button type="button" class="btn primary" data-act="ok">Confirm &amp; send</button>
          </div>
        </div>
      `,
    );
    const finish = (v) => {
      host.remove();
      document.removeEventListener("keydown", onKey);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === "Escape") finish(false);
    };
    host.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "ok") finish(true);
      else if (act === "cancel" || e.target === host) finish(false);
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(host);
    host.querySelector('[data-act="ok"]')?.focus();
  });
}

// ------------------------------------------------------------------ meta.json ("last updated")
let metaCache;

export async function loadMeta() {
  if (metaCache !== undefined) return metaCache;
  try {
    metaCache = await fetchData("meta.json");
  } catch {
    metaCache = null;
  }
  return metaCache;
}

export function updatedLabel(meta) {
  if (!meta?.updatedAt) return "not indexed yet";
  const d = new Date(meta.updatedAt);
  return Number.isNaN(d.getTime()) ? String(meta.updatedAt) : localTime(Math.floor(d.getTime() / 1000));
}

// ------------------------------------------------------------------ wallet bar
export function renderWalletBar() {
  const host = $("#walletbar");
  if (!host) return;
  const wrongChain = wallet.account && wallet.chainId !== CONFIG.chainId;

  if (!wallet.account) {
    const options = wallet.discovered;
    setHtml(
      host,
      html`
        <div class="wbar">
          <span class="muted small">Read-only. Connect a wallet to post or follow.</span>
          <div class="row gap wrap">
            ${options.length
              ? options.map(
                  (o, i) =>
                    html`<button type="button" class="btn" data-connect="${i}">
                      Connect ${o.info.name}
                    </button>`,
                )
              : html`<button type="button" class="btn" data-connect="scan">Connect wallet</button>`}
          </div>
        </div>
      `,
    );
    return;
  }

  setHtml(
    host,
    html`
      <div class="wbar">
        <div class="row gap wrap center">
          ${hasAgentId()
            ? html`<span class="pill ok">Connected as ${handleLabel(wallet.handle, wallet.account)}</span>`
            : wallet.agentIdBalance === null
              ? html`<span class="pill wait">Checking Agent ID…</span>`
              : html`<span class="pill bad">No Agent ID</span>`}
          <code class="small">${shortAddr(wallet.account, 8, 6)}</code>
          ${wrongChain
            ? html`<button type="button" class="btn warn" data-act="switch">
                Switch to ${CONFIG.name}
              </button>`
            : html`<span class="muted small">${CONFIG.name}</span>`}
          <button type="button" class="btn ghost small" data-act="disconnect">Disconnect</button>
        </div>
        ${!hasAgentId() && wallet.agentIdBalance !== null
          ? html`<p class="warnbox">${AGENT_ID_PROMPT}</p>`
          : ""}
      </div>
    `,
  );
}

function bindWalletBar() {
  const host = $("#walletbar");
  if (!host) return;
  host.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    try {
      if (btn.dataset.connect !== undefined) {
        discoverWallets();
        const idx = Number(btn.dataset.connect);
        await connectWallet(Number.isInteger(idx) ? wallet.discovered[idx] : undefined);
        toast(`Connected ${shortAddr(wallet.account, 8, 6)}`, "ok");
      } else if (btn.dataset.act === "disconnect") {
        disconnectWallet();
      } else if (btn.dataset.act === "switch") {
        await ensureChain();
      }
    } catch (err) {
      toastError(err);
    }
  });
}

// ------------------------------------------------------------------ shell
export function mountShell() {
  const root = document.getElementById("app");
  setHtml(
    root,
    html`
      <header class="site">
        <a class="brand" href="#/">CallLedger</a>
        <nav class="nav">
          <a href="#/">Leaderboard</a>
          <a href="#/commit">Post a call</a>
          <a href="#/mine">My calls</a>
          <a href="#/how">How it works</a>
        </nav>
      </header>
      <p class="risk" role="note">${RISK_TEXT}</p>
      ${CONFIG.chainId !== 56
        ? html`<p class="warnbox">
            Test mode: chainId ${CONFIG.chainId} via ${CONFIG.rpcUrls[0]}. Not BSC mainnet.
          </p>`
        : ""}
      <div id="walletbar"></div>
      <main id="view" class="view"><p class="muted">Loading…</p></main>
      <footer class="site">
        <a href="${explorerBase()}/address/${safeAddr(CONFIG.contract)}#code" target="_blank" rel="noopener noreferrer"
          >Contract on BscScan</a
        >
        <a href="${safeHref(CONFIG.githubUrl)}" target="_blank" rel="noopener noreferrer">GitHub</a>
        <span class="muted">Data updated <span id="updated">…</span></span>
      </footer>
      <div id="toasts" aria-live="polite"></div>
    `,
  );
  bindWalletBar();
  onWalletChange(renderWalletBar);
  renderWalletBar();
  loadMeta().then((meta) => {
    const node = $("#updated");
    if (node) node.textContent = updatedLabel(meta);
  });
}

export function setView(content) {
  setHtml($("#view"), content);
}

// ------------------------------------------------------------------ route-scoped cleanup
// Pages subscribe to wallet changes; without this they would stack up a listener per visit and a
// single wallet event would redraw a page several times (or redraw a page the user has left).
const routeDisposers = [];

export function onRouteLeave(dispose) {
  if (typeof dispose === "function") routeDisposers.push(dispose);
  return dispose;
}

export function clearRoute() {
  while (routeDisposers.length) {
    try {
      routeDisposers.pop()();
    } catch (e) {
      console.warn("route cleanup failed", e);
    }
  }
}

export function markActiveNav(routeName) {
  for (const a of document.querySelectorAll(".nav a")) {
    const href = a.getAttribute("href") || "";
    a.classList.toggle("active", href === `#/${routeName}` || (routeName === "" && href === "#/"));
  }
}

// ------------------------------------------------------------------ sortable tables
/**
 * Make a table sortable by clicking its <th data-key="..." data-type="num|text">.
 * Re-renders rows through `renderRows(sortedData)`.
 */
export function makeSortable(table, data, renderRows, initial = { key: null, dir: -1 }) {
  let state = { ...initial };
  const apply = () => {
    const rows = [...data];
    if (state.key) {
      const type = table.querySelector(`th[data-key="${CSS.escape(state.key)}"]`)?.dataset.type || "text";
      rows.sort((a, b) => {
        const av = a[state.key];
        const bv = b[state.key];
        // nulls always sort last, whichever direction
        if (av === null || av === undefined) return bv === null || bv === undefined ? 0 : 1;
        if (bv === null || bv === undefined) return -1;
        const cmp = type === "num" ? Number(av) - Number(bv) : String(av).localeCompare(String(bv));
        return cmp * state.dir;
      });
    }
    renderRows(rows);
    for (const th of table.querySelectorAll("th[data-key]")) {
      th.setAttribute(
        "aria-sort",
        th.dataset.key === state.key ? (state.dir === 1 ? "ascending" : "descending") : "none",
      );
    }
  };
  table.querySelectorAll("th[data-key]").forEach((th) => {
    th.tabIndex = 0;
    th.addEventListener("click", () => {
      state = th.dataset.key === state.key ? { key: state.key, dir: -state.dir } : { key: th.dataset.key, dir: -1 };
      apply();
    });
    th.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        th.click();
      }
    });
  });
  apply();
}

export { escapeHtml, raw, html, canWrite };
