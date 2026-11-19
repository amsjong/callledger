// Reveal tickets in localStorage.
//
// A sealed call is unrevealable without its salt, and the salt exists nowhere on chain. This is a
// convenience copy only — the downloaded file is the real backup, which is why the commit page
// forces the download before it sends the transaction.

import { parseTicket, ticketKey } from "./core.js";

const KEY = "callledger.tickets.v1";

function store() {
  try {
    return globalThis.localStorage;
  } catch {
    return null; // private mode / disabled storage: the downloaded file still works
  }
}

export function listTickets() {
  const s = store();
  if (!s) return [];
  let rows;
  try {
    rows = JSON.parse(s.getItem(KEY) || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    try {
      out.push(parseTicket(row)); // a corrupted entry is dropped, not allowed to break the page
    } catch {
      /* skip */
    }
  }
  return out;
}

function writeAll(rows) {
  const s = store();
  if (!s) return false;
  try {
    s.setItem(KEY, JSON.stringify(rows));
    return true;
  } catch (e) {
    console.warn("could not write tickets to localStorage", e);
    return false;
  }
}

/** Insert or replace a ticket. Returns false if storage is unavailable (the file is then the only copy). */
export function saveTicket(ticket) {
  const k = ticketKey(ticket);
  const rows = listTickets().filter((t) => ticketKey(t) !== k);
  rows.push(ticket);
  return writeAll(rows);
}

export function updateTicket(ticket, patch) {
  const k = ticketKey(ticket);
  const rows = listTickets().map((t) => (ticketKey(t) === k ? { ...t, ...patch } : t));
  writeAll(rows);
  return rows.find((t) => ticketKey(t) === k);
}

export function removeTicket(ticket) {
  const k = ticketKey(ticket);
  writeAll(listTickets().filter((t) => ticketKey(t) !== k));
}

export function ticketsFor(chainId, contract, agent) {
  const c = String(contract).toLowerCase();
  const a = String(agent || "").toLowerCase();
  return listTickets().filter(
    (t) =>
      Number(t.chainId) === Number(chainId) &&
      String(t.contract).toLowerCase() === c &&
      (!a || String(t.agent).toLowerCase() === a),
  );
}

/** The ticket matching a specific sealed call, by callId first and then by commit hash. */
export function ticketForCall(chainId, contract, agent, call) {
  const mine = ticketsFor(chainId, contract, agent);
  const byId = mine.find((t) => t.callId !== null && Number(t.callId) === Number(call.callId));
  if (byId) return byId;
  const hash = String(call.commitHash || "").toLowerCase();
  return mine.find((t) => String(t.hash).toLowerCase() === hash) || null;
}

export function ticketFilename(ticket) {
  const id = ticket.callId !== null && ticket.callId !== undefined ? `call-${ticket.callId}` : `hash-${String(ticket.hash).slice(2, 12)}`;
  return `callledger-reveal-ticket-${id}.json`;
}
