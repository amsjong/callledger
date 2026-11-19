// web/test/modules.test.mjs — load every site module in node and check its exported surface.
//
// No network, no browser. This catches the class of mistake a static site hides until a user clicks
// the thing: a renamed export, a typo'd import, a module that touches `document` at import time
// (which would break the page before the shell mounts), and a stray `innerHTML =` on chain data.
//
//   node web/test/modules.test.mjs

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, "..", "site");

let pass = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${detail ? `  -- ${detail}` : ""}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? `  -- ${detail}` : ""}`);
  }
}

console.log("== modules load in a DOM-free environment ==");
// Everything but app.js, which boots the app on import on purpose.
const MODULES = [
  ["../site/config.js", ["CONFIG", "MAINNET", "LOCAL", "default"]],
  ["../site/js/core.js", ["computeHash", "randomSalt", "makeTicket", "parseTicket", "ticketKey", "describeCall", "txPreview", "encodeCall", "effectiveStatus", "isRevealable", "ledgerInterface", "CALL_LEDGER_ABI", "AGENT_ID_ABI", "explainError", "localTime", "horizonLabel", "handleLabel", "shortAddr", "fmtScore", "fmtRate", "fmtPct", "fmtUsd", "relTime", "MIN_HORIZON", "MAX_HORIZON", "REVEAL_WINDOW", "HORIZON_PRESETS", "POOL_KIND_NAME", "MODE_NAME", "DIRECTION_NAME", "checkHorizon", "ethers"]],
  ["../site/js/dom.js", ["html", "raw", "setHtml", "escapeHtml", "safeAddr", "safeHash", "toHtmlString", "downloadJson", "$", "$$", "copyToClipboard"]],
  ["../site/js/chain.js", ["withProvider", "ledgerAt", "agentIdAt", "liveAgent", "liveBlockTime", "poolKindOf", "agentIdBalance", "handleOf", "isFollowing", "tokenSymbol", "fetchData", "toCall", "toAgent"]],
  ["../site/js/wallet.js", ["wallet", "discoverWallets", "connectWallet", "disconnectWallet", "tryEagerConnect", "onWalletChange", "refreshAgentId", "hasAgentId", "canWrite", "ensureChain", "getSigner", "sendLedgerTx"]],
  ["../site/js/tickets.js", ["listTickets", "saveTicket", "updateTicket", "removeTicket", "ticketsFor", "ticketForCall", "ticketFilename"]],
  ["../site/js/ui.js", ["mountShell", "setView", "markActiveNav", "confirmTx", "toast", "toastError", "loadMeta", "updatedLabel", "makeSortable", "renderWalletBar", "scorePill", "statusPill", "dirPill", "agentLink", "explorerAddrLink", "explorerTxLink", "onRouteLeave", "clearRoute", "RISK_TEXT", "AGENT_ID_PROMPT"]],
  ["../site/js/pages/leaderboard.js", ["renderLeaderboard", "EXPLAINER"]],
  ["../site/js/pages/agent.js", ["renderAgent"]],
  ["../site/js/pages/commit.js", ["renderCommit"]],
  ["../site/js/pages/mine.js", ["renderMine"]],
  ["../site/js/pages/how.js", ["renderHow"]],
];

const loaded = {};
for (const [path, expected] of MODULES) {
  try {
    const mod = await import(path);
    loaded[path] = mod;
    const missing = expected.filter((k) => !(k in mod));
    check(`${path} loads and exports its surface`, missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : `${expected.length} exports`);
  } catch (e) {
    check(`${path} loads`, false, String(e.message || e).slice(0, 160));
  }
}

console.log("\n== escaping ==");
{
  const { escapeHtml, html, toHtmlString, safeAddr, safeHash } = loaded["../site/js/dom.js"];
  const evil = `<img src=x onerror="alert(1)">&'"`;
  check("escapeHtml neutralises tags and quotes", escapeHtml(evil) === "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;&quot;", escapeHtml(evil));
  const out = toHtmlString(html`<td>${evil}</td>`);
  check("html`` escapes interpolated values", !out.includes("<img") && out.includes("&lt;img"), out.slice(0, 60));
  check("html`` keeps its own markup", out.startsWith("<td>") && out.endsWith("</td>"));
  const nested = toHtmlString(html`<tr>${html`<td>${evil}</td>`}</tr>`);
  check("nested html`` is not double-escaped", nested === `<tr><td>${escapeHtml(evil)}</td></tr>`, nested.slice(0, 80));
  check("arrays render element-wise", toHtmlString(html`${[1, 2, 3].map((n) => html`<b>${n}</b>`)}`) === "<b>1</b><b>2</b><b>3</b>");
  check("null/undefined/false render empty", toHtmlString(html`[${null}${undefined}${false}]`) === "[]");
  // a hostile ERC-20 symbol is the realistic attack: it goes straight into a table cell
  const sym = '"><script>fetch("//evil")</script>';
  check("a hostile token symbol cannot break out of a cell", !toHtmlString(html`<td>${sym}</td>`).includes("<script"));
  check("safeAddr rejects a non-address", safeAddr("javascript:alert(1)") === "" && safeAddr("0x" + "a".repeat(39)) === "");
  check("safeAddr accepts an address", safeAddr("0x286eBa3895fdcb3534E2F7c28a36d622650A2528") !== "");
  check("safeHash rejects a short hash", safeHash("0xdead") === "");
}

console.log("\n== href validation ==");
{
  const { safeHref } = loaded["../site/js/dom.js"];
  const blocked = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "  javascript:alert(1)", // leading whitespace is stripped by the URL parser, so by us too
    "data:text/html,<script>alert(1)</script>",
    "blob:https://evil",
    "vbscript:msgbox",
    "//evil.example/x", // protocol-relative: a foreign origin
    "http://evil.example/x", // plain http is not an explorer link
  ];
  for (const u of blocked) check(`safeHref blocks ${u.trim().slice(0, 28)}`, safeHref(u) === "#", safeHref(u));
  check("safeHref keeps an https explorer URL", safeHref("https://bscscan.com/tx/0xabc") === "https://bscscan.com/tx/0xabc");
  check("safeHref keeps a hash route", safeHref("#/agent/0xabc") === "#/agent/0xabc");
  check("safeHref keeps a relative asset path", safeHref("css/app.css") === "css/app.css");
}

console.log("\n== reveal ticket validation ==");
{
  const core = loaded["../site/js/core.js"];
  const AGENT = "0x1111111111111111111111111111111111111111";
  const base = core.makeTicket({
    chainId: 56,
    contract: "0x286eBa3895fdcb3534E2F7c28a36d622650A2528",
    agent: AGENT,
    token: "0x2222222222222222222222222222222222222222",
    pool: "0x3333333333333333333333333333333333333333",
    direction: 1,
    horizon: 86400,
    salt: "0x" + "ab".repeat(32),
  });
  const good = { ...base, hash: core.computeHash(base) };
  const parse = (o, opt) => core.parseTicket(JSON.stringify(o), opt);
  const refuses = (name, o, opt) => {
    let threw = false;
    try {
      parse(o, opt);
    } catch {
      threw = true;
    }
    check(`parseTicket refuses ${name}`, threw);
  };

  check("parseTicket round-trips a ticket this app wrote", parse(good).hash === good.hash);
  refuses("a file that is not a ticket", { kind: "something-else" });
  refuses("an unknown ticket version", { ...good, version: 99 });
  refuses("a tampered hash", { ...good, hash: "0x" + "00".repeat(32) });
  refuses("a malformed salt", { ...good, salt: "0xzz" });
  refuses("an out-of-range horizon", { ...good, horizon: 1 });
  refuses("a bad direction", { ...good, direction: 7 });
  refuses("a missing field", { ...good, salt: undefined });
  refuses("an oversized file", { ...good, junk: "x".repeat(9000) });
  refuses("an array", []);
  // the agent is baked into the commit hash: a ticket for another account is unusable
  refuses("a ticket belonging to another account", good, { expectAgent: "0x4444444444444444444444444444444444444444" });
  check("parseTicket accepts the matching account", parse(good, { expectAgent: AGENT }).agent === AGENT);

  // free-text / loose fields must not survive as attacker-chosen strings
  const dirty = parse({ ...good, createdAt: '"><img src=x onerror=alert(1)>', callId: "../../etc/passwd", txHash: "javascript:1" });
  check("parseTicket drops a junk createdAt", !/[<>"]/.test(dirty.createdAt), dirty.createdAt);
  check("parseTicket drops a non-numeric callId", dirty.callId === null);
  check("parseTicket drops a non-hash txHash", dirty.txHash === null);
  check("parseTicket keeps a real callId and txHash",
    parse({ ...good, callId: 7, txHash: "0x" + "cd".repeat(32) }).callId === 7);
}

console.log("\n== every write re-checks chain and account at send time ==");
{
  const walletSrc = await readFile(join(siteDir, "js", "wallet.js"), "utf8");
  check("sendLedgerTx is the only eth_sendTransaction path (via ledgerAt(signer))",
    /ledgerAt\(signer\)\[fn\]/.test(walletSrc));
  check("sendLedgerTx calls ensureChain before sending", /sendLedgerTx[\s\S]{0,600}await ensureChain\(\)/.test(walletSrc));
  check("sendLedgerTx re-reads the live account", /sendLedgerTx[\s\S]{0,800}await liveAccount\(\)/.test(walletSrc));
  check("sendLedgerTx honours expectFrom", /expectFrom[\s\S]{0,400}ethers\.getAddress\(expectFrom\)/.test(walletSrc));
  check("ensureChain asks the wallet rather than trusting the cached chainId",
    /ensureChain[\s\S]{0,300}await liveChainId\(\)/.test(walletSrc));
  const callers = await Promise.all(
    ["pages/commit.js", "pages/mine.js", "pages/agent.js"].map((p) => readFile(join(siteDir, "js", p), "utf8")),
  );
  const sends = callers.flatMap((t) => t.match(/sendLedgerTx\([\s\S]*?\);/g) || []);
  check("every sendLedgerTx call pins the account it was built for",
    sends.length >= 4 && sends.every((s) => /expectFrom/.test(s)),
    `${sends.length} call site(s)`);
  const mineSrc = callers[1];
  check("doReveal re-checks the reveal window against chain time, twice",
    (mineSrc.match(/assertRevealable\(call\)/g) || []).length >= 2);
  check("assertRevealable reads the chain clock", /assertRevealable[\s\S]{0,400}await liveBlockTime\(\)/.test(mineSrc));
}

console.log("\n== no raw innerHTML on chain data ==");
{
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "vendor" && entry.name !== "data") await walk(p);
      } else if (entry.name.endsWith(".js")) {
        files.push(p);
      }
    }
  }
  await walk(siteDir);
  const offenders = [];
  for (const f of files) {
    const text = await readFile(f, "utf8");
    // dom.js is the one place allowed to assign innerHTML; everywhere else must go through html``.
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (!/\.innerHTML\s*=/.test(line)) return;
      const isDom = f.endsWith("dom.js");
      const isClear = /innerHTML\s*=\s*""/.test(line);
      const isSanitised = /toHtmlString|render\(/.test(line);
      if (!isDom && !isClear && !isSanitised) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  check("every innerHTML assignment goes through the escaping helpers", offenders.length === 0, offenders.join(" | ").slice(0, 200));

  const texts = await Promise.all(files.map((f) => readFile(f, "utf8")));
  // Comments are stripped first: wallet.js documents *not* doing these things, and a prose mention
  // must not read as a call site.
  const code = texts.map(stripComments).join("\n");
  check("no personal_sign / eth_signTypedData anywhere", !/personal_sign|signTypedData/.test(code));
  check("no eth_sign / eth_sendRawTransaction", !/eth_sign\b|eth_sendRawTransaction/.test(code));
  check("no token approve/transfer calldata anywhere", !/\bapprove\s*\(|\btransferFrom\s*\(|\btransfer\s*\(\s*address/.test(code));
  // Only an actual dependency counts; the "How it works" page says the words on purpose.
  check(
    "no WalletConnect / QR / external wallet SDK is imported",
    !/(?:import|require)[^\n]*(walletconnect|qrcode|web3modal|@wagmi|rainbowkit)/i.test(code),
  );
  check("no http(s) CDN at runtime", !/https?:\/\/(cdn|unpkg|jsdelivr|fonts)/.test(code));
  check(
    "every literal https:// URL lives in config.js",
    files.every((f, i) => f.endsWith("config.js") || !/https:\/\//.test(stripComments(texts[i]))),
    files.filter((f, i) => !f.endsWith("config.js") && /https:\/\//.test(stripComments(texts[i]))).join(", "),
  );
  const valueAssignments = code.match(/value:\s*[^,}\n]+/g) || [];
  check(
    "every transaction carries value 0",
    valueAssignments.length > 0 && valueAssignments.every((v) => /value:\s*"?0"?\s*$/.test(v)),
    valueAssignments.join(" | "),
  );
}

/** Crude but adequate: drops // and block comments so prose cannot trip a code-pattern scan. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

console.log("\n== index.html ==");
{
  const htmlText = await readFile(join(siteDir, "index.html"), "utf8");
  check("loads js/app.js as a module", /<script type="module" src="js\/app\.js">/.test(htmlText));
  check("uses only relative asset URLs", !/(src|href)="\//.test(htmlText.replace(/href="data:,"/, "")));
  check("no external script or stylesheet", !/(src|href)="https?:/.test(htmlText));
  check("has a viewport meta for phones", /name="viewport"/.test(htmlText));
  check('does not use the word "Binance" in the title', !/Binance/i.test(htmlText.match(/<title>.*<\/title>/)?.[0] || ""));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("FAILED: " + failures.join(", "));
  process.exit(1);
}
