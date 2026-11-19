// web/test/render.test.mjs — render the real pages over a minimal DOM stub, with hostile data.
//
// modules.test.mjs proves the escaping helpers escape. This proves the *pages* use them: it feeds
// the leaderboard, an agent page and the shell the kind of data an attacker actually controls — an
// Agent ID handle, an ERC-20 symbol, a void reason, an address-shaped field — and then inspects the
// markup those renderers produced for a script tag, an event-handler attribute, or an href that is
// neither the configured explorer nor a relative route.
//
// A stub rather than a browser on purpose: this has to run in CI with no Chrome. The stub is only
// as rich as the pages need, and anything a page reaches for that is missing throws, which is
// itself the signal we want.
//
//   node web/test/render.test.mjs

import { readFile } from "node:fs/promises";
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

// ------------------------------------------------------------------ the stub
/** The payloads below are what a hostile agent can put on chain, verbatim. */
const XSS = `"><img src=x onerror=alert(1)><script>alert(2)</script>`;
const HOSTILE_HANDLE = `<svg onload=alert(3)>`;
const HOSTILE_SYMBOL = `" onmouseover="alert(4)`;
const HOSTILE_HREF = `javascript:alert(5)`;

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this.attrs = {};
    this.dataset = {};
    this._html = "";
    this._text = "";
    this.classList = {
      _s: new Set(),
      add: (c) => this.classList._s.add(c),
      remove: (c) => this.classList._s.delete(c),
      toggle: (c, on) => (on ? this.classList._s.add(c) : this.classList._s.delete(c)),
      contains: (c) => this.classList._s.has(c),
    };
  }
  set innerHTML(v) {
    this._html = String(v);
  }
  get innerHTML() {
    return this._html;
  }
  set textContent(v) {
    this._text = String(v);
  }
  get textContent() {
    return this._text;
  }
  set className(v) {
    this.attrs.class = String(v);
  }
  get className() {
    return this.attrs.class || "";
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return k in this.attrs ? this.attrs[k] : null;
  }
  appendChild(c) {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
  }
  addEventListener() {}
  removeEventListener() {}
  querySelector(sel) {
    return doc._find(sel, this) || null;
  }
  querySelectorAll(sel) {
    const hit = doc._find(sel, this);
    return hit ? [hit] : [];
  }
  closest() {
    return null;
  }
  focus() {}
  scrollIntoView() {}
  /** Everything this element and its descendants put into the document. */
  allHtml() {
    return [this._html, ...this.children.map((c) => c.allHtml())].join("\n");
  }
}

/**
 * Elements are addressed by id only, which is all the pages use (`$("#view")`, `$("#followbox")`).
 * Any id a page asks for is created on demand, so a renderer never silently skips a section just
 * because the stub had not heard of it.
 */
const doc = {
  nodes: new Map(),
  readyState: "complete",
  baseURI: "http://localhost/",
  createElement: (t) => new El(t),
  getElementById(id) {
    if (!this.nodes.has(id)) {
      const el = new El("div");
      el.attrs.id = id;
      this.nodes.set(id, el);
    }
    return this.nodes.get(id);
  },
  /**
   * `#id` resolves to the real node; any other selector (`tbody`, `th[data-key]`) resolves to one
   * cached stand-in per selector. The pages only ever write into these, so a stand-in is enough —
   * and returning one rather than null is what keeps `makeSortable` on its normal path instead of
   * an error branch that would skip rendering the rows we want to inspect.
   */
  _find(sel, _root) {
    const s = String(sel);
    const m = s.match(/^#([\w.-]+)$/);
    if (m) return this.getElementById(m[1]);
    return this.getElementById(`__sel__${s}`);
  },
  querySelector(sel) {
    return this._find(sel) || null;
  },
  querySelectorAll(sel) {
    const hit = this._find(sel);
    return hit ? [hit] : [];
  },
  addEventListener() {},
  removeEventListener() {},
  body: new El("body"),
};

globalThis.document = doc;
globalThis.location = { search: "", hash: "", href: "http://localhost/" };
globalThis.scrollTo = () => {};
globalThis.CSS = { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
globalThis.localStorage = {
  _d: new Map(),
  getItem(k) {
    return this._d.has(k) ? this._d.get(k) : null;
  },
  setItem(k, v) {
    this._d.set(k, String(v));
  },
  removeItem(k) {
    this._d.delete(k);
  },
};

// ------------------------------------------------------------------ the hostile data the app loads
const AGENT_A = "0x1111111111111111111111111111111111111111";
const AGENT_B = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const POOL = "0x4444444444444444444444444444444444444444";

const DATA = {
  "meta.json": {
    // even "last updated" comes out of a file on disk
    updatedAt: XSS,
    lastIndexedBlock: XSS,
    scoring: { capPct: 20, minLiquidityUsd: 50000, windowSeconds: 1800, samples: 7 },
  },
  "leaderboard.json": {
    agents: [
      {
        address: AGENT_A,
        handle: HOSTILE_HANDLE,
        calls: 3,
        revealRate: 1,
        forfeits: 0,
        avgCappedScore: 4.2,
        followers: 1,
      },
      // an address field that is not an address, and a row that is not an object at all
      { address: HOSTILE_HREF, handle: XSS, calls: 1, revealRate: null, forfeits: 2, avgCappedScore: null, followers: 0 },
      "not-an-object",
      null,
    ],
  },
  [`agents/${AGENT_A}.json`]: {
    profile: {
      address: AGENT_A,
      handle: HOSTILE_HANDLE,
      hasAgentId: false,
      calls: 2,
      sealedCalls: 1,
      openCalls: 1,
      reveals: 1,
      revealRate: 1,
      forfeits: 0,
      avgCappedScore: -3,
      followers: 0,
      following: 0,
      firstSeen: 1_700_000_000,
    },
    calls: [
      {
        callId: 1,
        agent: AGENT_A,
        mode: XSS,
        token: TOKEN,
        tokenSymbol: HOSTILE_SYMBOL,
        pool: POOL,
        poolKind: XSS,
        direction: XSS,
        horizon: 86400,
        commitTime: 1_700_000_000,
        effectiveStatus: XSS,
        score: { status: "VOID", voidReason: XSS, cappedScore: null, rawReturnPct: XSS },
      },
      // a sealed row: no token/pool, and a token address that is not one
      {
        callId: 2,
        agent: AGENT_A,
        mode: "Sealed",
        token: HOSTILE_HREF,
        pool: HOSTILE_HREF,
        direction: "",
        horizon: 3600,
        commitTime: 1_700_000_000,
        effectiveStatus: "Sealed (revealable now)",
        score: { status: "PENDING", cappedScore: null },
      },
    ],
  },
};

globalThis.fetch = async (url) => {
  const name = String(url).split("/data/")[1];
  if (name in DATA) return { ok: true, status: 200, json: async () => DATA[name] };
  return { ok: false, status: 404, json: async () => ({}) };
};

// ------------------------------------------------------------------ render
const ui = await import("../site/js/ui.js");
const { renderLeaderboard } = await import("../site/js/pages/leaderboard.js");
const { renderAgent } = await import("../site/js/pages/agent.js");
const { renderHow } = await import("../site/js/pages/how.js");
const { renderCommit } = await import("../site/js/pages/commit.js");
const { renderMine } = await import("../site/js/pages/mine.js");
const { CONFIG } = await import("../site/config.js");

const rendered = [];

async function render(label, fn) {
  try {
    await fn();
    const html = [...doc.nodes.values()].map((n) => n.allHtml()).join("\n") + "\n" + doc.body.allHtml();
    rendered.push([label, html]);
    check(`${label} renders without throwing`, html.length > 0, `${html.length} chars`);
  } catch (e) {
    check(`${label} renders without throwing`, false, String(e.message || e).slice(0, 160));
  }
}

console.log("== pages render over hostile on-chain data ==");
ui.mountShell();
rendered.push(["shell", doc.getElementById("app").allHtml()]);
check("the shell renders", doc.getElementById("app").allHtml().includes("CallLedger"));

await render("leaderboard", () => renderLeaderboard());
await render("agent page", () => renderAgent(AGENT_A));
await render("agent page (bad address in the route)", () => renderAgent(HOSTILE_HREF));
await render("how it works", () => renderHow());
await render("post a call", () => renderCommit());
await render("my calls", () => renderMine());

console.log("\n== the rendered markup ==");
const ALL = rendered.map(([, h]) => h).join("\n");

check("no <script> reached the DOM", !/<script/i.test(ALL), (ALL.match(/<script[^>]*/i) || [""])[0]);
check("no <img>/<svg> injected by chain data", !/<img|<svg/i.test(ALL), (ALL.match(/<(img|svg)[^>]*/i) || [""])[0]);
// Scan attribute *names*, which means looking inside real tags and then throwing away the quoted
// values. Both steps matter: `&lt;svg onload=…&gt;` in a text node and `title="…onerror=…"` in an
// attribute are inert, and flagging either would be flagging escaping that worked. Every attribute
// this app emits is double-quoted (the html`` templates write `attr="${…}"`) and `escapeHtml` turns
// a `"` in the value into `&quot;`, so stripping `="…"` cannot swallow a tag boundary.
const TAGS = [...ALL.matchAll(/<[a-z][^>]*>/gi)].map((m) => m[0]);
const ATTR_NAMES = TAGS.map((t) => t.replace(/="[^"]*"/g, '=""')).join("\n");
check(
  "no inline event-handler attribute on any tag",
  !/\son[a-z]+\s*=/i.test(ATTR_NAMES),
  (ATTR_NAMES.match(/<[^>]*\son[a-z]+\s*=[^>]*>/i) || [""])[0].slice(0, 120),
);
check("there are tags to check at all", TAGS.length > 50, `${TAGS.length} tag(s)`);
check(
  "no tag carries an unquoted attribute value (which would hide one from the scan above)",
  !/\s[a-z-]+=(?!")[^\s>]/i.test(ATTR_NAMES),
  (ATTR_NAMES.match(/<[^>]*\s[a-z-]+=(?!")[^\s>][^>]*>/i) || [""])[0].slice(0, 120),
);
check("the hostile handle appears only escaped",
  ALL.includes("&lt;svg onload=alert(3)&gt;") && !ALL.includes(HOSTILE_HANDLE));
check("the hostile token symbol appears only escaped",
  ALL.includes("&quot; onmouseover=&quot;alert(4)") && !ALL.includes(HOSTILE_SYMBOL));

// Every href must be the configured explorer or a same-document route. This is the check that would
// have caught an unvalidated address being pasted straight into a link.
const hrefs = [...ALL.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
const base = ui.explorerBase();
const badHrefs = hrefs.filter(
  (h) => !(h.startsWith(`${base}/`) || h === CONFIG.githubUrl || h === "#" || h.startsWith("#") || /^(css|js)\//.test(h) || h.startsWith("data:,")),
);
check("every href is the explorer or a relative route", badHrefs.length === 0, badHrefs.join(" | ").slice(0, 200));
check("there are hrefs to check at all", hrefs.length > 5, `${hrefs.length} href(s)`);
check("no href carries a javascript:/data: scheme",
  !hrefs.some((h) => /^(javascript|data|blob|vbscript):/i.test(h)),
  hrefs.filter((h) => /^(javascript|data|blob|vbscript):/i.test(h)).join(" | "));
check("the bogus leaderboard address did not become a link", !ALL.includes(`/address/${HOSTILE_HREF}`));

console.log("\n== CSP compatibility ==");
{
  const indexHtml = await readFile(join(siteDir, "index.html"), "utf8");
  // script-src 'self' with no 'unsafe-inline' and no 'unsafe-eval'
  check("index.html has no inline <script> body", !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(indexHtml));
  check("index.html has no inline event handlers", !/\son[a-z]+\s*=/i.test(indexHtml));
  check("no eval / new Function in the rendered markup", !/\beval\(|new Function/.test(ALL));
  // style-src allows 'unsafe-inline', so style="" attributes are fine; style *elements* would be too
  check("no <style> element is injected at runtime", !/<style/i.test(ALL));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("FAILED: " + failures.join(", "));
  process.exit(1);
}
