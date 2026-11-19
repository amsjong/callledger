// Agent page: profile + full call history.
//
// Reads the indexer's agents/<address>.json when it exists and falls back to live contract reads
// (getAgent + callsOf + getCall) when it does not — so a brand new agent is visible immediately,
// before the next indexer run.

import { html, $, safeAddr, setHtml } from "../dom.js";
import {
  handleLabel,
  shortAddr,
  fmtRate,
  fmtScore,
  localTime,
  horizonLabel,
  effectiveStatus,
  MODE_NAME,
  DIRECTION_NAME,
} from "../core.js";
import {
  setView,
  explorerAddrLink,
  loadMeta,
  updatedLabel,
  scorePill,
  statusPill,
  dirPill,
  confirmTx,
  toast,
  toastError,
  onRouteLeave,
} from "../ui.js";
import { fetchData, liveAgent, isFollowing, tokenSymbol, liveBlockTime, handleOf } from "../chain.js";
import { wallet, onWalletChange, sendLedgerTx, hasAgentId } from "../wallet.js";
import CONFIG from "../../config.js";

export async function renderAgent(addrParam) {
  const address = safeAddr(addrParam);
  if (!address) {
    setView(html`<h1>Agent</h1>
      <p class="warnbox">That is not a valid address.</p>`);
    return;
  }
  setView(html`<p class="muted">Loading agent…</p>`);

  const meta = await loadMeta();
  let profile = null;
  let calls = [];
  let source = "indexer";

  try {
    // `address` is already validated as 0x + 40 hex by safeAddr, so it cannot escape data/agents/.
    const data = await fetchData(`agents/${address.toLowerCase()}.json`);
    // Shape-check before rendering: a half-written or hand-edited file must fall through to the
    // live contract read, not throw past the renderer and blank the page.
    if (!data || typeof data !== "object" || !data.profile || typeof data.profile !== "object") {
      throw new Error("indexed file has no profile");
    }
    profile = data.profile;
    calls = Array.isArray(data.calls) ? data.calls.filter((c) => c && typeof c === "object") : [];
  } catch {
    source = "live";
    try {
      const live = await liveAgent(address);
      const now = await liveBlockTime();
      const liveHandle = await handleOf(address);
      profile = {
        address,
        handle: liveHandle || live.profile.handle,
        calls: live.profile.commits,
        sealedCalls: live.profile.commits - live.profile.openCalls,
        openCalls: live.profile.openCalls,
        reveals: live.profile.reveals,
        revealRate: null,
        forfeits: live.profile.forfeits,
        avgCappedScore: null,
        followers: live.profile.followers,
        following: live.profile.following,
        firstSeen: live.profile.firstSeen || null,
      };
      calls = live.calls.map((c) => liveToRow(c, now));
      await Promise.all(
        calls.map(async (r) => {
          if (r.token) r.tokenSymbol = await tokenSymbol(r.token);
        }),
      );
      calls.reverse();
    } catch (e) {
      setView(html`<h1>Agent</h1>
        <p class="warnbox">
          Could not load this agent from the indexer or from the chain. ${String(e.message || e)}
        </p>`);
      return;
    }
  }

  const display = handleLabel(profile.handle, address);

  setView(html`
    <h1>${display}</h1>
    <p class="mono small">
      ${explorerAddrLink(address, address)}
      ${profile.hasAgentId === false
        ? html`<span class="pill bad" title="The handle shown is the snapshot taken on chain">Agent ID lapsed</span>`
        : ""}
    </p>
    <div id="followbox" class="row gap center"></div>

    <div class="cards">
      ${stat("Calls", profile.calls)} ${stat("Sealed", profile.sealedCalls)}
      ${stat("Open", profile.openCalls)} ${stat("Reveals", profile.reveals)}
      ${stat("Reveal rate", fmtRate(profile.revealRate))}
      ${stat("Forfeits", profile.forfeits, profile.forfeits > 0 ? "bad-text" : "")}
      ${stat("Avg score", fmtScore(profile.avgCappedScore))}
      ${stat("Followers", profile.followers)} ${stat("Following", profile.following)}
      ${stat("First seen", profile.firstSeen ? localTime(profile.firstSeen) : "—")}
    </div>

    <h2>Call history</h2>
    ${calls.length
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
                <th class="num">Score</th>
              </tr>
            </thead>
            <tbody>
              ${calls.map(callRow)}
            </tbody>
          </table>
        </div>`
      : html`<p class="empty">No calls from this agent yet.</p>`}
    <p class="muted small">
      ${source === "indexer"
        ? html`From the indexer · last updated ${updatedLabel(meta)}`
        : html`Read live from the chain (this agent is not in the indexed data yet).`}
    </p>
  `);

  await renderFollowBox(address, display);
  onRouteLeave(onWalletChange(() => renderFollowBox(address, display)));
}

function stat(label, value, cls = "") {
  return html`<div class="card">
    <div class="card-label">${label}</div>
    <div class="card-value ${cls}">${value ?? "—"}</div>
  </div>`;
}

function callRow(c) {
  const token = safeAddr(c.token);
  const pool = safeAddr(c.pool);
  return html`
    <tr>
      <td class="num">${c.callId}</td>
      <td>${c.mode}</td>
      <td>
        ${token
          ? html`<span class="sym">${c.tokenSymbol || "?"}</span>
              <br /><span class="mono tiny">${explorerAddrLink(token, shortAddr(token, 8, 6))}</span>`
          : html`<span class="muted">sealed</span>`}
      </td>
      <td>
        ${pool
          ? html`${explorerAddrLink(pool, shortAddr(pool, 6, 4))}
              <br /><span class="muted tiny">${c.poolKind || ""}</span>`
          : html`<span class="muted">sealed</span>`}
      </td>
      <td>${dirPill(c.direction)}</td>
      <td>${horizonLabel(c.horizon)}</td>
      <td class="nowrap small">${localTime(c.commitTime)}</td>
      <td>${statusPill(c.statusLabel || c.effectiveStatus || "")}</td>
      <td class="num">${scorePill(c.score)}</td>
    </tr>
  `;
}

/** Shape a live getCall result like an indexer row so one renderer covers both. */
function liveToRow(c, now) {
  return {
    callId: c.callId,
    agent: c.agent,
    mode: MODE_NAME[c.mode] || "",
    token: c.token,
    tokenSymbol: "",
    pool: c.pool,
    poolKind: c.poolKind === 1 ? "v2" : c.poolKind === 2 ? "v3" : "",
    direction: DIRECTION_NAME[c.direction] || "",
    horizon: c.horizon,
    commitBlock: c.commitBlock,
    commitTime: c.commitTime,
    expiryTime: c.expiryTime,
    statusLabel: effectiveStatus(c, now),
    score: { status: null },
  };
}

// ------------------------------------------------------------------ follow / unfollow
async function renderFollowBox(address, display) {
  const host = $("#followbox");
  if (!host) return;
  const me = wallet.account;

  if (!me) {
    setHtml(host, html`<span class="muted small">Connect a wallet to follow this agent.</span>`);
    return;
  }
  if (me.toLowerCase() === address.toLowerCase()) {
    setHtml(host, html`<span class="muted small">This is you.</span>`);
    return;
  }

  setHtml(host, html`<span class="muted small">Checking follow state…</span>`);
  let following = false;
  try {
    following = await isFollowing(me, address);
  } catch {
    setHtml(host, html`<span class="muted small">Could not read follow state.</span>`);
    return;
  }

  const blockedReason = wallet.chainId !== CONFIG.chainId
    ? `Switch to ${CONFIG.name} first.`
    : !following && !hasAgentId()
      ? "You need an Agent ID to follow."
      : "";

  setHtml(
    host,
    html`
      <button
        type="button"
        class="btn ${following ? "ghost" : "primary"}"
        id="followbtn"
        ${blockedReason ? "disabled" : ""}
      >
        ${following ? "Unfollow" : "Follow"} ${display}
      </button>
      ${blockedReason ? html`<span class="muted small">${blockedReason}</span>` : ""}
    `,
  );

  $("#followbtn")?.addEventListener("click", async () => {
    const btn = $("#followbtn");
    const fn = following ? "unfollow" : "follow";
    // `following` was read for this account; pin it so a mid-flow account switch cannot turn an
    // unfollow into a follow (or act on behalf of an account the user did not review).
    const from = me;
    try {
      const ok = await confirmTx({
        fn,
        args: [address],
        title: following ? "Unfollow agent" : "Follow agent",
        notes: [
          following
            ? "Unfollow only ever removes your own follow."
            : "Following is a public on-chain counter. It does not affect anyone's score.",
        ],
      });
      if (!ok) return;
      btn.disabled = true;
      btn.textContent = "Sending…";
      // unfollow is deliberately not Agent-ID gated in the contract
      const tx = await sendLedgerTx(fn, [address], { requireAgentId: !following, expectFrom: from });
      toast("Transaction sent. Waiting for confirmation…", "info");
      await tx.wait();
      toast(following ? "Unfollowed." : "Followed.", "ok");
      await renderFollowBox(address, display);
    } catch (e) {
      toastError(e);
      await renderFollowBox(address, display);
    }
  });
}
