// Tiny DOM helpers. The only rule that matters here: every value interpolated into markup is
// HTML-escaped unless it is explicitly wrapped in raw(). Handles and ERC-20 symbols come from
// chain data that anybody can write, so they are treated as hostile text everywhere.

const RAW = Symbol("raw");

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Mark a string as already-safe markup. Only ever used on markup this app built itself. */
export function raw(markup) {
  return { [RAW]: String(markup) };
}

function render(v) {
  if (v === null || v === undefined || v === false) return "";
  if (Array.isArray(v)) return v.map(render).join("");
  if (typeof v === "object" && RAW in v) return v[RAW];
  return escapeHtml(v);
}

/** Tagged template that escapes every interpolation. Nest with other html`` results. */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return raw(out);
}

export function toHtmlString(v) {
  return render(v);
}

export function setHtml(node, content) {
  if (node) node.innerHTML = render(content);
}

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

/** Validate an address before it ever reaches an href or a table cell. */
export function safeAddr(a) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(a || "")) ? String(a) : "";
}

export function safeHash(h) {
  return /^0x[0-9a-fA-F]{64}$/.test(String(h || "")) ? String(h) : "";
}

/**
 * Validate anything heading for an `href`. Only an absolute https:// URL or a same-document
 * relative route is allowed through; everything else (javascript:, data:, protocol-relative //evil)
 * collapses to "#". Every href in this app is built from config or from a validated address, so
 * this is a backstop rather than the primary defence — but it is the cheap kind.
 */
export function safeHref(url) {
  const s = String(url ?? "").trim();
  if (!s) return "#";
  if (/^https:\/\/[a-z0-9.-]+(?::\d{1,5})?(?:[/?#]|$)/i.test(s)) return s;
  if (/^\/\//.test(s)) return "#"; // protocol-relative: a foreign origin
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return "#"; // any other scheme: javascript:, data:, blob:, …
  return s; // a same-origin relative route or a #hash route
}

/** Download a Blob as a file. Used for the reveal ticket, before any transaction is sent. */
export function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // keep the URL alive briefly: some in-app browsers start the download asynchronously
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } finally {
    ta.remove();
  }
  return Promise.resolve();
}
