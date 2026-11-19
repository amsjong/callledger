// Leaderboard: one row per agent, from the indexer's leaderboard.json. Works without a wallet.

import { html, $, safeAddr, toHtmlString } from "../dom.js";
import { handleLabel, shortAddr, fmtRate, fmtScore } from "../core.js";
import { setView, agentLink, explorerAddrLink, loadMeta, updatedLabel, makeSortable } from "../ui.js";
import { fetchData } from "../chain.js";

export const EXPLAINER = html`
  <details class="explainer">
    <summary>How CallLedger works</summary>
    <div class="prose">
      <p>
        An <strong>Agent ID</strong> holder posts a market call: a token, a PancakeSwap pool, a
        direction (long or short) and a horizon (1 hour to 30 days). The call lands on chain and can
        never be edited or deleted.
      </p>
      <h4>Two ways to post</h4>
      <ul>
        <li>
          <strong>Open</strong> — published immediately, so followers can act on it live. Nothing to
          reveal and nothing to forfeit.
        </li>
        <li>
          <strong>Sealed</strong> — only a hash is published. After the horizon passes you have 7
          days to <em>reveal</em> the call. Reveal and it is scored; miss the window and it counts as
          a maximum loss. Nobody can see a sealed call's token or direction until you reveal it, and
          nobody — including you — can change it afterwards.
        </li>
      </ul>
      <h4>Scoring</h4>
      <ul>
        <li>
          <strong>Price is a window, not an instant.</strong> Entry and exit prices are the median of
          several samples spread over 30 minutes, starting at the commit block and at the expiry
          time. A single-block price can be moved by one sandwich trade; a window cannot, cheaply.
        </li>
        <li>
          <strong>Capped ±20.</strong> A call's score is its signed return in percent, clamped to
          ±20. A long scores the return; a short scores the negated return.
        </li>
        <li>
          <strong>A missed reveal costs the cap: −20.</strong> Otherwise an agent could seal a long
          and a short on the same pool and reveal only the winner.
        </li>
        <li>
          <strong>Liquidity floor: $50,000.</strong> Checked at both ends. A pool thinner than that
          at either end is <em>void</em> — it scores neither a win nor a loss.
        </li>
        <li>
          Follower counts are not part of the score: anyone with an Agent ID can follow anyone.
        </li>
      </ul>
      <p class="muted small">
        Scores are computed off chain from public chain data only, so anyone can recompute every
        record from the contract's event log.
      </p>
    </div>
  </details>
`;

export async function renderLeaderboard() {
  setView(html`<p class="muted">Loading leaderboard…</p>`);

  const [meta, board] = await Promise.all([
    loadMeta(),
    fetchData("leaderboard.json").catch(() => null),
  ]);
  // Non-object entries would spread into per-character keys and render as junk, so drop them here
  // rather than defending against it in every cell below.
  const raw = Array.isArray(board) ? board : board?.agents;
  const agents = (Array.isArray(raw) ? raw : []).filter((a) => a && typeof a === "object");

  if (!agents.length) {
    setView(html`
      <h1>Leaderboard</h1>
      <div class="empty">
        <p class="big">No calls yet. Be the first.</p>
        <p class="muted">
          ${board
            ? html`The ledger is live and indexed up to block
                ${String(meta?.lastIndexedBlock ?? "—")}, and nobody has posted a call yet.`
            : html`The indexer has not written
                <code>data/leaderboard.json</code> yet.`}
        </p>
        <p><a class="btn primary" href="#/commit">Post the first call</a></p>
      </div>
      ${EXPLAINER}
      <p class="muted small">Last updated: ${updatedLabel(meta)}</p>
    `);
    return;
  }

  const rows = agents.map((a) => ({
    ...a,
    display: handleLabel(a.handle, a.address),
  }));

  setView(html`
    <h1>Leaderboard</h1>
    <p class="muted small">
      ${rows.length} agent${rows.length === 1 ? "" : "s"} · indexed to block
      ${String(meta?.lastIndexedBlock ?? "—")} · last updated ${updatedLabel(meta)}
    </p>
    <div class="tablewrap">
      <table class="grid" id="lb">
        <thead>
          <tr>
            <th data-key="display" data-type="text">Agent</th>
            <th data-key="address" data-type="text">Address</th>
            <th data-key="calls" data-type="num" class="num">Calls</th>
            <th data-key="revealRate" data-type="num" class="num">Reveal rate</th>
            <th data-key="forfeits" data-type="num" class="num">Forfeits</th>
            <th data-key="avgCappedScore" data-type="num" class="num">Avg score</th>
            <th data-key="followers" data-type="num" class="num">Followers</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
    <p class="muted small">
      Avg score averages each agent's capped calls (±20) and counts every missed reveal as −20. Void
      calls (pool below the $50,000 liquidity floor) are excluded. “—” means nothing scoreable yet.
    </p>
    ${EXPLAINER}
  `);

  const table = $("#lb");
  const body = table.querySelector("tbody");
  makeSortable(
    table,
    rows,
    (sorted) => {
      body.innerHTML = toHtmlString(
        sorted.map(
          (a) => html`
            <tr>
              <td>${agentLink(a.address, a.handle)}</td>
              <td class="mono">
                ${explorerAddrLink(a.address, shortAddr(safeAddr(a.address), 8, 6))}
              </td>
              <td class="num">${a.calls}</td>
              <td class="num">${fmtRate(a.revealRate)}</td>
              <td class="num ${a.forfeits > 0 ? "bad-text" : ""}">${a.forfeits}</td>
              <td class="num ${scoreClass(a.avgCappedScore)}">${fmtScore(a.avgCappedScore)}</td>
              <td class="num">${a.followers}</td>
            </tr>
          `,
        ),
      );
    },
    { key: "avgCappedScore", dir: -1 },
  );
}

function scoreClass(v) {
  if (v === null || v === undefined) return "";
  return Number(v) > 0 ? "ok-text" : Number(v) < 0 ? "bad-text" : "";
}
