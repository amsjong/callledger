// My calls / Reveal.
//
// Read live from the contract, never from the indexer: a reveal is time-critical (7 days after the
// horizon, then the call is a permanent loss) so this page must never show stale state.

import { html, $, safeAddr, safeHash, downloadJson } from "../dom.js";
import {
  ethers,
  shortAddr,
  localTime,
  relTime,
  horizonLabel,
  effectiveStatus,
  isRevealable,
  computeHash,
  handleLabel,
  REVEAL_WINDOW,
  MODE_NAME,
  DIRECTION_NAME,
} from "../core.js";
import {
  setView,
  confirmTx,
  toast,
  toastError,
  explorerAddrLink,
  statusPill,
  dirPill,
  onRouteLeave,
} from "../ui.js";
import { liveAgent, liveBlockTime, tokenSymbol } from "../chain.js";
import { wallet, onWalletChange, sendLedgerTx } from "../wallet.js";
import { ticketForCall, ticketsFor, ticketFilename, removeTicket } from "../tickets.js";
import CONFIG from "../../config.js";

export async function renderMine() {
  bindViewOnce();
  await draw();
  onRouteLeave(onWalletChange(() => draw()));
}

let drawing = false;
let viewBound = false;
let currentRows = [];

/** One delegated handler on #view, attached once: draw() only ever replaces innerHTML. */
function bindViewOnce() {
  if (viewBound) return;
  viewBound = true;
  $("#view").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-reveal]");
    if (btn) {
      const c = currentRows.find((r) => r.callId === Number(btn.dataset.reveal));
      if (c) await doReveal(c, btn);
      return;
    }
    const dl = e.target.closest("button[data-ticket]");
    if (dl) {
      const t = ticketsFor(CONFIG.chainId, CONFIG.contract, wallet.account).find(
        (x) => String(x.hash).toLowerCase() === dl.dataset.ticket,
      );
      if (t) downloadJson(ticketFilename(t), t);
      return;
    }
    const rm = e.target.closest("button[data-forget]");
    if (rm) {
      const t = ticketsFor(CONFIG.chainId, CONFIG.contract, wallet.account).find(
        (x) => String(x.hash).toLowerCase() === rm.dataset.forget,
      );
      if (t && confirm("Forget this ticket from this browser? The downloaded file still works.")) {
        removeTicket(t);
        await draw();
      }
    }
  });
}

async function draw() {
  if (drawing) return;
  drawing = true;
  try {
    if (!wallet.account) {
      setView(html`
        <h1>My calls</h1>
        <p class="warnbox">Connect a wallet above to see your calls and reveal sealed ones.</p>
        ${orphanTicketsSection()}
      `);
      return;
    }

    setView(html`<h1>My calls</h1>
      <p class="muted">Reading your calls from the chain…</p>`);

    let live;
    let now;
    try {
      [live, now] = await Promise.all([liveAgent(wallet.account), liveBlockTime()]);
    } catch (e) {
      setView(html`<h1>My calls</h1>
        <p class="warnbox">Could not read the chain: ${String(e.shortMessage || e.message || e)}</p>`);
      return;
    }

    const rows = live.calls.slice().reverse();
    await Promise.all(
      rows.map(async (c) => {
        c.symbol = c.token ? await tokenSymbol(c.token).catch(() => "") : "";
        c.ticket = ticketForCall(CONFIG.chainId, CONFIG.contract, wallet.account, c);
      }),
    );
    currentRows = rows;

    const revealable = rows.filter((c) => isRevealable(c, now));
    const dueSoon = rows.filter((c) => Number(c.status) === 1 && Number(c.mode) === 1 && now < c.expiryTime);

    setView(html`
      <h1>My calls</h1>
      <p class="muted small">
        ${handleLabel(wallet.handle, wallet.account)} · ${rows.length} call${rows.length === 1 ? "" : "s"} ·
        read live from the chain
      </p>

      ${revealable.length
        ? html`<div class="okbox">
            <strong>${revealable.length} call${revealable.length === 1 ? "" : "s"} can be revealed now.</strong>
            Reveal before the deadline or the call scores −20.
          </div>`
        : ""}
      ${dueSoon.length
        ? html`<p class="muted small">
            ${dueSoon.length} sealed call${dueSoon.length === 1 ? "" : "s"} still inside the horizon.
          </p>`
        : ""}
      ${rows.length
        ? html`<div class="tablewrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Mode</th>
                  <th>Token</th>
                  <th>Pool</th>
                  <th>Direction</th>
                  <th>Horizon</th>
                  <th>Commit time</th>
                  <th>Status</th>
                  <th>Deadline</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${rows.map((c) => row(c, now))}
              </tbody>
            </table>
          </div>`
        : html`<p class="empty">
            You have not posted any calls yet. <a href="#/commit">Post one.</a>
          </p>`}
      ${orphanTicketsSection(rows)}
      <p class="muted small">
        A sealed call can only be revealed between its expiry time and 7 days later, and only with
        the exact salt from its reveal ticket.
      </p>
    `);
  } finally {
    drawing = false;
  }
}

function row(c, now) {
  const token = safeAddr(c.token);
  const pool = safeAddr(c.pool);
  const sealed = Number(c.mode) === 1;
  const deadline = sealed ? Number(c.expiryTime) + REVEAL_WINDOW : null;
  const canReveal = isRevealable(c, now);

  let action = html`<span class="muted tiny">—</span>`;
  if (canReveal && c.ticket) {
    action = html`<button type="button" class="btn primary small" data-reveal="${c.callId}">Reveal</button>`;
  } else if (canReveal && !c.ticket) {
    action = html`<span class="bad-text tiny"
      >No ticket in this browser. <a href="#/commit">Import it</a> to reveal.</span
    >`;
  } else if (sealed && Number(c.status) === 1 && now < Number(c.expiryTime)) {
    action = html`<span class="muted tiny">Revealable ${relTime(c.expiryTime, now)}</span>`;
  } else if (c.ticket) {
    action = html`<button type="button" class="btn ghost small" data-ticket="${String(c.ticket.hash).toLowerCase()}">
      Ticket
    </button>`;
  }

  return html`
    <tr>
      <td class="num">${c.callId}</td>
      <td>${MODE_NAME[c.mode] || ""}</td>
      <td>
        ${token
          ? html`<span class="sym">${c.symbol || "?"}</span><br /><span class="mono tiny"
                >${explorerAddrLink(token, shortAddr(token, 8, 6))}</span
              >`
          : c.ticket
            ? html`<span class="muted">sealed</span><br /><span class="tiny">(ticket: ${c.ticket.token ? shortAddr(c.ticket.token, 6, 4) : ""})</span>`
            : html`<span class="muted">sealed</span>`}
      </td>
      <td>${pool ? explorerAddrLink(pool, shortAddr(pool, 6, 4)) : html`<span class="muted">sealed</span>`}</td>
      <td>
        ${Number(c.direction)
          ? dirPill(DIRECTION_NAME[c.direction])
          : c.ticket
            ? html`<span class="muted tiny">${DIRECTION_NAME[c.ticket.direction]} (ticket)</span>`
            : html`<span class="muted">—</span>`}
      </td>
      <td>${horizonLabel(c.horizon)}</td>
      <td class="nowrap small">${localTime(c.commitTime)}</td>
      <td>${statusPill(effectiveStatus(c, now))}</td>
      <td class="nowrap small">
        ${deadline
          ? Number(c.status) === 1
            ? html`${localTime(deadline)}<br /><span class="muted tiny">${relTime(deadline, now)}</span>`
            : html`<span class="muted">—</span>`
          : html`<span class="muted">—</span>`}
      </td>
      <td>${action}</td>
    </tr>
  `;
}

function orphanTicketsSection(rows = []) {
  if (!wallet.account) return "";
  const known = new Set(rows.filter((r) => r.ticket).map((r) => String(r.ticket.hash).toLowerCase()));
  const orphans = ticketsFor(CONFIG.chainId, CONFIG.contract, wallet.account).filter(
    (t) => !known.has(String(t.hash).toLowerCase()),
  );
  if (!orphans.length) return "";
  return html`
    <details class="explainer">
      <summary>${orphans.length} stored ticket${orphans.length === 1 ? "" : "s"} with no matching call</summary>
      <div class="prose">
        <p class="muted small">
          Either the commit transaction never landed, or it was made from a different address. The
          salt is kept either way.
        </p>
        <table class="grid">
          <thead>
            <tr><th>Hash</th><th>Token</th><th>Direction</th><th>Horizon</th><th>Created</th><th></th></tr>
          </thead>
          <tbody>
            ${orphans.map(
              (t) => html`<tr>
                <td class="mono tiny">${shortAddr(t.hash, 10, 8)}</td>
                <td class="mono tiny">${shortAddr(t.token, 8, 6)}</td>
                <td>${DIRECTION_NAME[t.direction]}</td>
                <td>${horizonLabel(t.horizon)}</td>
                <td class="tiny">${t.createdAt || ""}</td>
                <td>
                  <button type="button" class="btn ghost small" data-ticket="${String(t.hash).toLowerCase()}">Download</button>
                  <button type="button" class="btn ghost small" data-forget="${String(t.hash).toLowerCase()}">Forget</button>
                </td>
              </tr>`,
            )}
          </tbody>
        </table>
      </div>
    </details>
  `;
}

// ------------------------------------------------------------------ reveal
/**
 * Re-read the chain clock and confirm the call is inside [expiryTime, expiryTime + 7d] *now*.
 *
 * `draw()` samples the block time once, and this page can then sit open for hours — long enough
 * for a call to enter or leave its reveal window while the button stays as it was drawn. The
 * contract reverts either way (`TooEarly` / `RevealWindowClosed`), so checking here only saves gas
 * and replaces a hex revert with a sentence; but for the closing edge it is the difference between
 * "you have N hours left" and a forfeit the user did not see coming.
 */
async function assertRevealable(call) {
  let now;
  try {
    now = await liveBlockTime();
  } catch (e) {
    throw new Error(
      `Could not read the chain clock to check the reveal window: ${String(e.shortMessage || e.message || e)}`,
    );
  }
  if (isRevealable(call, now)) return now;
  const expiry = Number(call.expiryTime);
  const deadline = expiry + REVEAL_WINDOW;
  if (Number(call.status) !== 1 || Number(call.mode) !== 1) {
    throw new Error(`Call #${call.callId} is no longer a sealed call awaiting reveal.`);
  }
  if (now < expiry) {
    throw new Error(
      `Call #${call.callId} cannot be revealed yet: its horizon ends ${localTime(expiry)} ` +
        `(${relTime(expiry, now)}). Nothing was sent.`,
    );
  }
  throw new Error(
    `The 7-day reveal window for call #${call.callId} closed ${localTime(deadline)} ` +
      `(${relTime(deadline, now)}). It is a permanent forfeit now and a reveal would revert; ` +
      "nothing was sent.",
  );
}

async function doReveal(call, btn) {
  const t = call.ticket;
  if (!t) {
    toast("No reveal ticket for this call in this browser.", "error");
    return;
  }
  if (!wallet.account) {
    toast("Connect a wallet first.", "error");
    return;
  }
  // Only the committer can reveal, and the hash binds that address, so pin it here and re-check it
  // at send time: the wallet can switch accounts while the confirmation box is open.
  const agent = ethers.getAddress(wallet.account);
  if (ethers.getAddress(t.agent) !== agent) {
    toast(
      `That ticket belongs to ${shortAddr(t.agent, 8, 6)}, not the connected ${shortAddr(agent, 8, 6)}. Only the committing account can reveal.`,
      "error",
      12000,
    );
    return;
  }
  // Re-derive the hash locally and refuse to send a reveal that cannot possibly match.
  const expect = computeHash({
    agent,
    token: t.token,
    pool: t.pool,
    direction: t.direction,
    horizon: Number(call.horizon),
    salt: t.salt,
  });
  const onchain = safeHash(call.commitHash);
  if (!onchain) {
    toast("This call has no readable commit hash on chain; refusing to send a reveal.", "error");
    return;
  }
  if (expect.toLowerCase() !== onchain.toLowerCase()) {
    toast(
      "This ticket does not match the committed hash (wrong salt, wrong horizon, or a different call). Reveal would revert.",
      "error",
      12000,
    );
    return;
  }
  try {
    await assertRevealable(call);
  } catch (e) {
    toast(String(e.message || e), "error", 15000);
    return;
  }

  const args = [
    Number(call.callId),
    ethers.getAddress(t.token),
    ethers.getAddress(t.pool),
    Number(t.direction),
    t.salt,
  ];
  const ok = await confirmTx({
    fn: "reveal",
    args,
    title: `Reveal call #${call.callId}`,
    notes: [
      "Revealing publishes the token, pool and direction. The salt becomes public — that is expected.",
      "The pool is verified on chain here. If it is not a canonical PancakeSwap pool the reveal reverts.",
    ],
  });
  if (!ok) return;

  try {
    btn.disabled = true;
    btn.textContent = "Sending…";
    // The window can close while the confirmation box is open, so check the clock once more.
    await assertRevealable(call);
    // reveal is deliberately not Agent-ID gated in the contract
    const tx = await sendLedgerTx("reveal", args, { requireAgentId: false, expectFrom: agent });
    toast("Transaction sent. Waiting for confirmation…", "info");
    const receipt = await tx.wait();
    toast(`Call #${call.callId} revealed. tx ${shortAddr(receipt.hash, 10, 8)}`, "ok", 12000);
    await draw();
  } catch (e) {
    toastError(e);
    btn.disabled = false;
    btn.textContent = "Reveal";
  }
}
