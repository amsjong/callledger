// Post a call: sealed (commit a hash now, reveal later) or open (published immediately).
//
// The one irreversible mistake a user can make here is losing a sealed call's salt, so the salt is
// written to localStorage *and* pushed at the browser as a downloaded file BEFORE the transaction
// is sent — never after, when a closed tab would strand the call as a forfeit.

import { html, $, setHtml, safeAddr, downloadJson } from "../dom.js";
import {
  ethers,
  computeHash,
  randomSalt,
  makeTicket,
  parseTicket,
  checkHorizon,
  MAX_TICKET_BYTES,
  HORIZON_PRESETS,
  MIN_HORIZON,
  MAX_HORIZON,
  POOL_KIND_NAME,
  horizonLabel,
  handleLabel,
  ledgerInterface,
  shortAddr,
} from "../core.js";
import {
  setView,
  confirmTx,
  toast,
  toastError,
  explorerAddrLink,
  explorerTxLink,
  onRouteLeave,
  AGENT_ID_PROMPT,
} from "../ui.js";
import { poolKindOf, tokenSymbol } from "../chain.js";
import { wallet, onWalletChange, sendLedgerTx, hasAgentId, canWrite } from "../wallet.js";
import { saveTicket, updateTicket, ticketFilename } from "../tickets.js";
import CONFIG from "../../config.js";

const state = {
  mode: "sealed",
  token: "",
  pool: "",
  direction: 1,
  horizon: 86400,
  customHorizon: "",
  poolKind: null,
  poolError: "",
  busy: false,
};

export async function renderCommit() {
  draw();
  onRouteLeave(
    onWalletChange(() => {
      const gate = $("#commit-gate");
      if (gate) setHtml(gate, gateMarkup());
      syncDisabled();
    }),
  );
}

function gateMarkup() {
  if (!wallet.account) {
    return html`<p class="warnbox">Connect a wallet above to post a call. Reading needs no wallet.</p>`;
  }
  if (wallet.chainId !== CONFIG.chainId) {
    return html`<p class="warnbox">
      Wrong network. This app only works on ${CONFIG.name} (chainId ${CONFIG.chainId}) — use the
      switch button above.
    </p>`;
  }
  if (wallet.agentIdBalance === null) return html`<p class="muted">Checking your Agent ID…</p>`;
  if (!hasAgentId()) return html`<p class="warnbox">${AGENT_ID_PROMPT}</p>`;
  return html`<p class="okbox">Connected as ${handleLabel(wallet.handle, wallet.account)}</p>`;
}

function draw() {
  setView(html`
    <h1>Post a call</h1>
    <div id="commit-gate">${gateMarkup()}</div>

    <form id="commitform" autocomplete="off">
      <fieldset>
        <legend>Mode</legend>
        <div class="row gap wrap">
          <label class="radio"
            ><input type="radio" name="mode" value="sealed" ${state.mode === "sealed" ? "checked" : ""} />
            <span><strong>Sealed</strong> — hidden until you reveal</span></label
          >
          <label class="radio"
            ><input type="radio" name="mode" value="open" ${state.mode === "open" ? "checked" : ""} />
            <span><strong>Open</strong> — published now</span></label
          >
        </div>
        <p class="muted small" id="modehelp"></p>
      </fieldset>

      <fieldset>
        <legend>Market</legend>
        <div class="row gap wrap">
          ${CONFIG.presets.map(
            (p, i) => html`<button type="button" class="btn small" data-preset="${i}">${p.label}</button>`,
          )}
        </div>
        <label class="field">
          <span>Token address</span>
          <input
            type="text"
            id="token"
            inputmode="text"
            spellcheck="false"
            placeholder="0x…"
            value="${state.token}"
          />
        </label>
        <label class="field">
          <span>Pool address (PancakeSwap v2 pair or v3 pool)</span>
          <input
            type="text"
            id="pool"
            inputmode="text"
            spellcheck="false"
            placeholder="0x…"
            value="${state.pool}"
          />
        </label>
        <div class="row gap center wrap">
          <button type="button" class="btn small" id="checkpool">Check pool</button>
          <span id="poolinfo" class="small"></span>
        </div>
      </fieldset>

      <fieldset>
        <legend>Call</legend>
        <div class="row gap wrap">
          <label class="radio"
            ><input type="radio" name="direction" value="1" ${state.direction === 1 ? "checked" : ""} />
            <span>Long</span></label
          >
          <label class="radio"
            ><input type="radio" name="direction" value="2" ${state.direction === 2 ? "checked" : ""} />
            <span>Short</span></label
          >
        </div>
        <label class="field">
          <span>Horizon</span>
          <select id="horizon">
            ${HORIZON_PRESETS.map(
              (h) =>
                html`<option value="${h.seconds}" ${state.horizon === h.seconds ? "selected" : ""}>
                  ${h.label}
                </option>`,
            )}
            <option value="custom" ${isCustom() ? "selected" : ""}>Custom…</option>
          </select>
        </label>
        <label class="field ${isCustom() ? "" : "hidden"}" id="customwrap">
          <span>Custom horizon in seconds (1 hour = 3600, 30 days = 2592000)</span>
          <input type="number" id="customhorizon" min="${MIN_HORIZON}" max="${MAX_HORIZON}" step="1"
            value="${state.customHorizon || state.horizon}" />
        </label>
      </fieldset>

      <div id="sealedwarn" class="warnbox strong ${state.mode === "sealed" ? "" : "hidden"}">
        Sealed calls need a secret salt. When you submit, this page saves a
        <strong>reveal ticket</strong> file to your device before sending the transaction.
        <strong>Save that file. If you lose the salt you cannot reveal and the call counts as a loss
        (forfeit).</strong>
      </div>

      <div class="row gap center wrap">
        <button type="submit" class="btn primary" id="submit">Review &amp; post</button>
        <span class="muted small">No funds move. Value is always 0.</span>
      </div>
    </form>

    <details class="explainer" id="importbox">
      <summary>Import a reveal ticket</summary>
      <div class="prose">
        <p>
          Posting from another device, or restoring after clearing your browser data? Load the ticket
          file you downloaded when you committed. It is stored in this browser only.
        </p>
        <input type="file" id="ticketfile" accept="application/json,.json" />
        <p id="importresult" class="small"></p>
      </div>
    </details>

    <div id="result"></div>
  `);

  bind();
  updateModeHelp();
  syncDisabled();
}

function isCustom() {
  return !HORIZON_PRESETS.some((h) => h.seconds === state.horizon);
}

function updateModeHelp() {
  const node = $("#modehelp");
  if (!node) return;
  setHtml(
    node,
    state.mode === "sealed"
      ? html`Only a hash goes on chain now. After the horizon you have 7 days to reveal; miss it and
          the call scores −20. The pool is verified at reveal, so this page checks it for you first —
          a bad pool makes the call unrevealable.`
      : html`Everything is published immediately, so followers can act on it live. Nothing to reveal
          and nothing to forfeit. The pool is verified on chain right now.`,
  );
}

function syncDisabled() {
  const ok = canWrite() && !state.busy;
  const submit = $("#submit");
  if (submit) {
    submit.disabled = !ok;
    submit.title = ok ? "" : wallet.account ? AGENT_ID_PROMPT : "Connect a wallet first.";
  }
}

function readForm() {
  state.token = ($("#token")?.value || "").trim();
  state.pool = ($("#pool")?.value || "").trim();
  const sel = $("#horizon")?.value;
  if (sel === "custom") {
    state.customHorizon = ($("#customhorizon")?.value || "").trim();
    state.horizon = Number(state.customHorizon);
  } else if (sel !== undefined) {
    state.horizon = Number(sel);
  }
}

function bind() {
  const form = $("#commitform");

  form.addEventListener("change", (e) => {
    const t = e.target;
    if (t.name === "mode") {
      state.mode = t.value;
      $("#sealedwarn")?.classList.toggle("hidden", state.mode !== "sealed");
      updateModeHelp();
    } else if (t.name === "direction") {
      state.direction = Number(t.value);
    } else if (t.id === "horizon") {
      $("#customwrap")?.classList.toggle("hidden", t.value !== "custom");
      readForm();
    }
  });

  form.addEventListener("input", (e) => {
    if (e.target.id === "token" || e.target.id === "pool") {
      state.poolKind = null;
      state.poolError = "";
      setHtml($("#poolinfo"), "");
    }
  });

  form.addEventListener("click", async (e) => {
    const presetBtn = e.target.closest("[data-preset]");
    if (presetBtn) {
      const p = CONFIG.presets[Number(presetBtn.dataset.preset)];
      $("#token").value = p.token;
      $("#pool").value = p.pool;
      state.token = p.token;
      state.pool = p.pool;
      state.poolKind = null;
      setHtml($("#poolinfo"), "");
      await checkPool();
      return;
    }
    if (e.target.id === "checkpool") {
      e.preventDefault();
      await checkPool();
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await submit();
  });

  $("#ticketfile")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    const out = $("#importresult");
    if (!file) return;
    try {
      if (file.size > MAX_TICKET_BYTES) {
        throw new Error("that file is far too large to be a reveal ticket");
      }
      if (!wallet.account) {
        throw new Error(
          "connect the wallet that made this call first — a ticket is only usable by the account " +
            "its commit hash is bound to, so it is checked against the connected one",
        );
      }
      // Schema, version, addresses, direction/horizon/salt shape, the recomputed hash and the
      // agent are all enforced in parseTicket; chain and contract are checked here.
      const t = parseTicket(await file.text(), { expectAgent: wallet.account });
      if (Number(t.chainId) !== CONFIG.chainId) {
        throw new Error(`that ticket is for chainId ${t.chainId}, this app is on ${CONFIG.chainId}`);
      }
      if (t.contract.toLowerCase() !== CONFIG.contract.toLowerCase()) {
        throw new Error("that ticket is for a different CallLedger contract");
      }
      saveTicket(t);
      setHtml(
        out,
        html`<span class="ok-text"
          >Imported ticket for ${shortAddr(t.agent, 8, 6)} — hash ${shortAddr(t.hash, 10, 8)}. See
          <a href="#/mine">My calls</a> to reveal.</span
        >`,
      );
      toast("Reveal ticket imported.", "ok");
    } catch (err) {
      setHtml(out, html`<span class="bad-text">Could not import: ${String(err.message || err)}</span>`);
    }
  });
}

// ------------------------------------------------------------------ pool check
async function checkPool() {
  readForm();
  const info = $("#poolinfo");
  const token = safeAddr(state.token);
  const pool = safeAddr(state.pool);
  if (!token || !pool) {
    state.poolKind = null;
    state.poolError = "Enter a valid token address and pool address (0x + 40 hex characters).";
    setHtml(info, html`<span class="bad-text">${state.poolError}</span>`);
    return false;
  }
  setHtml(info, html`<span class="muted">Checking on chain…</span>`);
  try {
    const kind = await poolKindOf(token, pool);
    state.poolKind = kind;
    if (kind === 0) {
      state.poolError =
        "Rejected: that is not a canonical PancakeSwap v2 pair or v3 pool holding this token. " +
        "The contract checks the pool's factory, its two tokens, and that the factory maps that pair back to this pool.";
      setHtml(info, html`<span class="bad-text">${state.poolError}</span>`);
      return false;
    }
    state.poolError = "";
    const sym = await tokenSymbol(token).catch(() => "");
    setHtml(
      info,
      html`<span class="ok-text"
        >${POOL_KIND_NAME[kind]}${sym ? html` · token ${sym}` : ""} ·
        ${explorerAddrLink(pool, shortAddr(pool, 8, 6))}</span
      >`,
    );
    return true;
  } catch (err) {
    state.poolKind = null;
    state.poolError = `Could not check the pool: ${String(err.shortMessage || err.message || err)}`;
    setHtml(info, html`<span class="bad-text">${state.poolError}</span>`);
    return false;
  }
}

// ------------------------------------------------------------------ submit
async function submit() {
  if (!canWrite()) {
    toast(wallet.account ? AGENT_ID_PROMPT : "Connect a wallet first.", "error");
    return;
  }
  readForm();
  const token = safeAddr(state.token);
  const pool = safeAddr(state.pool);
  if (!token || !pool) {
    toast("Enter a valid token address and pool address.", "error");
    return;
  }
  let horizon;
  try {
    horizon = checkHorizon(state.horizon);
  } catch (e) {
    toast(e.message, "error");
    return;
  }
  // Always verify the pool on chain before anything is signed.
  if (!(await checkPool())) {
    toast("Fix the pool before posting.", "error");
    return;
  }

  state.busy = true;
  syncDisabled();
  try {
    if (state.mode === "open") await submitOpen(token, pool, horizon);
    else await submitSealed(token, pool, horizon);
  } catch (e) {
    toastError(e);
  } finally {
    state.busy = false;
    syncDisabled();
  }
}

async function submitOpen(token, pool, horizon) {
  const agent = ethers.getAddress(wallet.account);
  const args = [ethers.getAddress(token), ethers.getAddress(pool), state.direction, horizon];
  const ok = await confirmTx({
    fn: "commitOpen",
    args,
    title: "Post an open call",
    notes: [
      `${state.direction === 1 ? "Long" : "Short"} for ${horizonLabel(horizon)} — published immediately, nothing to reveal.`,
      `Pool checked on chain: ${POOL_KIND_NAME[state.poolKind]}.`,
    ],
  });
  if (!ok) return;
  // The call is credited to msg.sender, so it must be the account the user just reviewed.
  const tx = await sendLedgerTx("commitOpen", args, { expectFrom: agent });
  toast("Transaction sent. Waiting for confirmation…", "info");
  const receipt = await tx.wait();
  const callId = callIdFromReceipt(receipt);
  showResult(
    html`<div class="okbox">
      <p><strong>Open call posted.</strong> ${callId !== null ? html`Call #${callId}.` : ""}</p>
      <p>${explorerTxLink(receipt.hash, "View transaction")} · <a href="#/agent/${agent.toLowerCase()}">Your agent page</a></p>
    </div>`,
  );
}

async function submitSealed(token, pool, horizon) {
  const agent = ethers.getAddress(wallet.account);
  const salt = randomSalt();
  const base = {
    chainId: CONFIG.chainId,
    contract: CONFIG.contract,
    agent,
    token: ethers.getAddress(token),
    pool: ethers.getAddress(pool),
    direction: state.direction,
    horizon,
    salt,
  };
  const hash = computeHash(base);
  const ticket = makeTicket({ ...base, hash });

  const ok = await confirmTx({
    fn: "commit",
    args: [hash, horizon],
    title: "Post a sealed call",
    notes: [
      `${state.direction === 1 ? "Long" : "Short"} for ${horizonLabel(horizon)}. The token, pool and direction stay hidden until you reveal.`,
      "Confirming downloads your reveal ticket (with the salt) before the transaction is sent.",
      "If you lose the salt you cannot reveal and the call counts as a loss (forfeit).",
    ],
  });
  if (!ok) return;

  // The confirmation box can sit open for as long as the user likes, and the wallet can switch
  // accounts underneath it. `agent` is baked into the hash, so a commit sent from a different
  // account would be bound to a preimage that account can never produce: an instant, silent,
  // un-revealable forfeit. Refuse and make the user redo the step instead.
  if (!wallet.account || ethers.getAddress(wallet.account) !== agent) {
    throw new Error(
      `The connected account changed to ${shortAddr(wallet.account || "none", 8, 6)} while this was ` +
        `being confirmed; this sealed call is bound to ${shortAddr(agent, 8, 6)}. Nothing was sent ` +
        "and no ticket was saved — post the call again so the hash binds the account you are using.",
    );
  }

  // ---- save the salt BEFORE sending anything
  const stored = saveTicket(ticket);
  downloadJson(ticketFilename(ticket), ticket);
  if (!stored) {
    toast("Could not use localStorage — the downloaded ticket file is your only copy.", "error", 15000);
  }
  showResult(
    html`<div class="warnbox strong">
      <p>Reveal ticket downloaded: <code>${ticketFilename(ticket)}</code></p>
      <p>
        <strong
          >Save this file. If you lose the salt you cannot reveal and the call counts as a loss
          (forfeit).</strong
        >
      </p>
      <p class="mono tiny">hash ${hash}</p>
    </div>`,
  );

  const tx = await sendLedgerTx("commit", [hash, horizon], { expectFrom: agent });
  toast("Transaction sent. Waiting for confirmation…", "info");
  const receipt = await tx.wait();
  const callId = callIdFromReceipt(receipt);
  const finalTicket = updateTicket(ticket, { callId, txHash: receipt.hash }) || {
    ...ticket,
    callId,
    txHash: receipt.hash,
  };

  showResult(
    html`<div class="okbox">
      <p>
        <strong>Sealed call posted${callId !== null ? html` as call #${callId}` : ""}.</strong>
        Reveal it after the horizon, within 7 days.
      </p>
      <p>${explorerTxLink(receipt.hash, "View transaction")} · <a href="#/mine">My calls</a></p>
      <p>
        <button type="button" class="btn small" id="redownload">
          Download the ticket again (now with the call id)
        </button>
      </p>
      <p class="warnbox strong">
        Save this file. If you lose the salt you cannot reveal and the call counts as a loss
        (forfeit).
      </p>
    </div>`,
  );
  $("#redownload")?.addEventListener("click", () => downloadJson(ticketFilename(finalTicket), finalTicket));
}

function callIdFromReceipt(receipt) {
  for (const log of receipt.logs || []) {
    if (String(log.address).toLowerCase() !== CONFIG.contract.toLowerCase()) continue;
    try {
      const parsed = ledgerInterface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === "Committed") return Number(parsed.args.callId);
    } catch {
      /* not one of ours */
    }
  }
  return null;
}

function showResult(content) {
  setHtml($("#result"), content);
  $("#result")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
