// Router + boot. Hash routing so the whole site is one static index.html that works from any
// subpath (GitHub Pages project page, a subdirectory, anywhere) with no server rewrites.

import { html } from "./dom.js";
import { mountShell, setView, markActiveNav, clearRoute, toastError } from "./ui.js";
import { discoverWallets, tryEagerConnect } from "./wallet.js";
import { renderLeaderboard } from "./pages/leaderboard.js";
import { renderAgent } from "./pages/agent.js";
import { renderCommit } from "./pages/commit.js";
import { renderMine } from "./pages/mine.js";
import { renderHow } from "./pages/how.js";

function parseRoute() {
  const hash = (globalThis.location.hash || "").replace(/^#\/?/, "");
  const [name, ...rest] = hash.split("/");
  return { name: name || "", args: rest };
}

let rendering = null;

async function route() {
  const { name, args } = parseRoute();
  clearRoute();
  markActiveNav(name);
  const run = async () => {
    switch (name) {
      case "":
      case "leaderboard":
        return renderLeaderboard();
      case "agent":
        return renderAgent(args[0]);
      case "commit":
        return renderCommit();
      case "mine":
        return renderMine();
      case "how":
        return renderHow();
      default:
        return setView(html`<h1>Not found</h1>
          <p class="muted">
            Nothing at <code>#/${name}</code>. <a href="#/">Back to the leaderboard.</a>
          </p>`);
    }
  };
  rendering = run().catch((e) => {
    toastError(e);
    setView(html`<h1>Something went wrong</h1>
      <p class="warnbox">${String(e.message || e)}</p>
      <p><a class="btn" href="#/">Back to the leaderboard</a></p>`);
  });
  await rendering;
  globalThis.scrollTo?.({ top: 0 });
}

function boot() {
  mountShell();
  discoverWallets();
  globalThis.addEventListener("hashchange", () => route());
  route();
  // a silent reconnect for a wallet that already authorised this origin (no popup)
  tryEagerConnect().catch(() => {});
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
