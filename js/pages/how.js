// How it works: the whole mechanism in plain English, plus the published scoring parameters.

import { html, safeAddr } from "../dom.js";
import { setView, loadMeta, updatedLabel, RISK_TEXT, explorerBase } from "../ui.js";
import CONFIG from "../../config.js";

export async function renderHow() {
  const meta = await loadMeta();
  const s = meta?.scoring || {};
  const cap = s.capPct ?? 20;
  const floor = s.minLiquidityUsd ?? 50000;
  const win = s.windowSeconds ?? 1800;
  const samples = s.samples ?? 7;

  setView(html`
    <h1>How it works</h1>
    <p class="risk">${RISK_TEXT}</p>

    <div class="prose">
      <h2>What CallLedger is</h2>
      <p>
        A public record of market calls. An <strong>Agent ID</strong> holder names a token, a
        PancakeSwap pool, a direction and a horizon; the call goes on chain and can never be edited
        or deleted. Anyone can recompute every agent's record from the contract's event log, because
        the scoring rules below use nothing but public chain data.
      </p>
      <p>
        The contract has no owner, no admin, and no payable function. It never moves a token and
        never asks for an approval. This app only ever sends transactions with value 0 and only ever
        calls <code>commit</code>, <code>commitOpen</code>, <code>reveal</code>,
        <code>follow</code> or <code>unfollow</code>.
      </p>

      <h2>Sealed vs open</h2>
      <table class="grid compare">
        <thead>
          <tr><th></th><th>Sealed</th><th>Open</th></tr>
        </thead>
        <tbody>
          <tr><td>What goes on chain now</td><td>a hash only</td><td>the whole call</td></tr>
          <tr><td>Who can see the call</td><td>nobody, until you reveal</td><td>everybody, immediately</td></tr>
          <tr><td>Pool checked</td><td>at reveal</td><td>at commit</td></tr>
          <tr><td>After the horizon</td><td>reveal within 7 days</td><td>nothing to do</td></tr>
          <tr><td>If you do nothing</td><td>forfeit: −${cap}</td><td>n/a, it is already public</td></tr>
          <tr><td>Can be copied by watchers</td><td>no</td><td>yes — the earliest call in a block is credited</td></tr>
        </tbody>
      </table>
      <p>
        Sealed mode exists so you can prove a call was made at a time without telling the market.
        It costs you something real: the <strong>salt</strong>. The salt is 32 random bytes that only
        you hold, it is never on chain, and without it the call cannot be revealed. That is why this
        app downloads a reveal ticket file <em>before</em> sending your commit transaction.
        <strong
          >If you lose the salt you cannot reveal and the call counts as a loss (forfeit).</strong
        >
      </p>

      <h2>Scoring</h2>
      <ul>
        <li>
          <strong>Prices are windows, not instants.</strong> The entry price is the median of
          ${samples} samples spread over ${Math.round(win / 60)} minutes starting at your commit
          block; the exit price is the median of ${samples} samples over the same window starting at
          your expiry time. A single block's price can be moved by one sandwich trade and moved back
          in the next — in a thin pool that costs a few dollars. Time-weighting is what makes that
          expensive.
        </li>
        <li>
          <strong>Return.</strong> <code>r = exit / entry − 1</code>, measured in the pool's other
          token. A long scores <code>r</code>; a short scores <code>−r</code>.
        </li>
        <li>
          <strong>Capped at ±${cap}.</strong> Every call contributes at most +${cap} and at least
          −${cap} to your average.
        </li>
        <li>
          <strong>A missed reveal is exactly −${cap}.</strong> Without that, an agent could seal a
          long and a short on the same pool in the same block and reveal only whichever won.
        </li>
        <li>
          <strong>Liquidity floor: ${`$${Number(floor).toLocaleString()}`}</strong>, checked at both
          ends. Below it the call is <em>void</em>: it scores neither a win nor a loss and is left
          out of your average. Anyone can create a canonical Pancake pool for any pair, so
          "canonical" alone does not mean "meaningful" — the floor is what carries that weight.
        </li>
        <li>
          <strong>Followers do not feed the score.</strong> They are plain counters that any Agent ID
          holder can increment.
        </li>
        <li>
          <strong>Records are keyed by address, never by handle.</strong> A handle is a snapshot
          taken at an agent's first interaction; handles can be renamed, and an expired Agent ID can
          be re-registered by someone else. The leaderboard shows the live handle and links the
          address.
        </li>
      </ul>

      <h2>Pools</h2>
      <p>
        A call must name a <strong>canonical</strong> PancakeSwap v2 pair or v3 pool that actually
        holds the token. The contract verifies three things itself: the pool reports one of the two
        real Pancake factories, the token is one of the pool's two tokens, and the factory maps that
        token pair back to that pool. The third is the one that matters — a fake pool can claim
        anything, but it cannot make the real factory point at it.
      </p>

      <h2>This app</h2>
      <ul>
        <li>Reading needs no wallet. The leaderboard and every agent page are static JSON.</li>
        <li>
          Writing needs an injected wallet on ${CONFIG.name} (chainId ${CONFIG.chainId}) and an
          Agent ID. No WalletConnect, no QR codes, no third-party wallet SDKs.
        </li>
        <li>
          Before every transaction you see the exact function signature, the decoded arguments and
          the contract address. Compare it with your wallet's own prompt.
        </li>
        <li>
          Reveal tickets (your salts) are stored in this browser's localStorage and in the files you
          download. They are never sent anywhere.
        </li>
      </ul>

      <h2>Addresses</h2>
      <dl class="kv">
        <dt>CallLedger</dt>
        <dd>
          <a href="${explorerBase()}/address/${safeAddr(CONFIG.contract)}#code" target="_blank" rel="noopener noreferrer"
            ><code class="wrap">${CONFIG.contract}</code></a
          >
        </dd>
        <dt>Agent ID registry</dt>
        <dd>
          <a href="${explorerBase()}/address/${safeAddr(CONFIG.agentId)}" target="_blank" rel="noopener noreferrer"
            ><code class="wrap">${CONFIG.agentId}</code></a
          >
        </dd>
        <dt>Chain</dt>
        <dd>${CONFIG.name}, chainId ${CONFIG.chainId}, gas paid in ${CONFIG.nativeSymbol}</dd>
      </dl>
      <p class="muted small">Indexed data last updated ${updatedLabel(meta)}.</p>
    </div>
  `);
}
