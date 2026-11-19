// web/test/hash.test.mjs — the site's commit hash must equal the live contract's computeHash.
//
// Read-only: this only ever makes eth_call against BSC mainnet. If this test fails, every sealed
// call made in the app would be unrevealable, so it imports the *same* module the browser loads
// (site/js/core.js) rather than re-deriving the encoding.
//
//   node web/test/hash.test.mjs
//   node web/test/hash.test.mjs --rpc https://bsc-dataseed.bnbchain.org

import {
  ethers,
  computeHash,
  randomSalt,
  CALL_LEDGER_ABI,
  MIN_HORIZON,
  MAX_HORIZON,
  DIRECTION,
  makeTicket,
  parseTicket,
  ticketKey,
  effectiveStatus,
  isRevealable,
  REVEAL_WINDOW,
  horizonLabel,
  shortAddr,
  handleLabel,
  describeCall,
  encodeCall,
  txPreview,
} from "../site/js/core.js";
import { MAINNET } from "../site/config.js";

const argv = process.argv.slice(2);
const rpcArg = argv.includes("--rpc") ? argv[argv.indexOf("--rpc") + 1] : null;
const RPCS = rpcArg ? [rpcArg] : MAINNET.rpcUrls;

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

function throws(name, fn, match) {
  try {
    fn();
    check(name, false, "did not throw");
  } catch (e) {
    check(name, !match || e.message.includes(match), e.message.slice(0, 80));
  }
}

async function firstWorkingProvider(urls, chainId) {
  const errors = [];
  for (const url of urls) {
    try {
      const p = new ethers.JsonRpcProvider(url, chainId, { staticNetwork: true });
      const n = await p.getBlockNumber();
      console.log(`  using ${url} (block ${n})`);
      return p;
    } catch (e) {
      errors.push(`${url}: ${e.shortMessage || e.message}`);
    }
  }
  throw new Error(`no RPC answered:\n   ${errors.join("\n   ")}`);
}

function randAddr() {
  return ethers.getAddress(ethers.hexlify(ethers.randomBytes(20)));
}

console.log("== pure helpers ==");
{
  const t = {
    agent: randAddr(),
    token: randAddr(),
    pool: randAddr(),
    direction: 1,
    horizon: 86400,
    salt: randomSalt(),
  };
  const h = computeHash(t);
  check("computeHash returns a 32-byte hex string", /^0x[0-9a-f]{64}$/.test(h), h);
  check("computeHash is deterministic", computeHash(t) === h);
  check(
    "a different salt gives a different hash",
    computeHash({ ...t, salt: randomSalt() }) !== h,
  );
  check("a different direction gives a different hash", computeHash({ ...t, direction: 2 }) !== h);
  check(
    "lowercase and checksummed addresses hash the same",
    computeHash({ ...t, token: t.token.toLowerCase() }) === h,
  );
  check("randomSalt is 32 bytes", /^0x[0-9a-f]{64}$/.test(randomSalt()));
  check("randomSalt does not repeat", randomSalt() !== randomSalt());

  throws("direction 0 is rejected", () => computeHash({ ...t, direction: 0 }), "direction must be");
  throws("direction 3 is rejected", () => computeHash({ ...t, direction: 3 }), "direction must be");
  throws("horizon below 1h is rejected", () => computeHash({ ...t, horizon: MIN_HORIZON - 1 }), "horizon must be");
  throws("horizon above 30d is rejected", () => computeHash({ ...t, horizon: MAX_HORIZON + 1 }), "horizon must be");
  throws("a short salt is rejected", () => computeHash({ ...t, salt: "0x1234" }), "salt must be");
  throws("a bad address is rejected", () => computeHash({ ...t, pool: "0xnope" }));

  // tickets
  const ticket = makeTicket({ ...t, chainId: 56, contract: MAINNET.contract, hash: h });
  const round = parseTicket(JSON.stringify(ticket));
  check("a ticket round-trips through JSON", round.hash === h && round.salt === t.salt.toLowerCase());
  check("ticketKey is stable across case", ticketKey(round) === ticketKey({ ...round, contract: MAINNET.contract.toLowerCase() }));
  throws("a ticket with a tampered hash is rejected", () => parseTicket(JSON.stringify({ ...ticket, hash: computeHash({ ...t, direction: 2 }) })), "does not match");
  throws("a tampered direction is caught via the hash", () => parseTicket(JSON.stringify({ ...ticket, direction: 2 })), "does not match");
  throws("a non-ticket file is rejected", () => parseTicket('{"hello":1}'), "not a CallLedger reveal ticket");
  throws("garbage is rejected", () => parseTicket("not json"), "not valid JSON");

  // status logic
  const now = 1_700_000_000;
  check("sealed before expiry", effectiveStatus({ status: 1, mode: 1, expiryTime: now + 10 }, now).includes("awaiting"));
  check("sealed inside the reveal window", effectiveStatus({ status: 1, mode: 1, expiryTime: now - 10 }, now).includes("revealable"));
  check("sealed past the reveal window is Forfeited", effectiveStatus({ status: 1, mode: 1, expiryTime: now - REVEAL_WINDOW - 1 }, now) === "Forfeited");
  check("explicit forfeit is Forfeited", effectiveStatus({ status: 3, mode: 1, expiryTime: now }, now) === "Forfeited");
  check("open call reads Revealed", effectiveStatus({ status: 2, mode: 2, expiryTime: now }, now) === "Revealed");
  check("isRevealable: at expiry yes", isRevealable({ status: 1, mode: 1, expiryTime: now }, now));
  check("isRevealable: before expiry no", !isRevealable({ status: 1, mode: 1, expiryTime: now + 1 }, now));
  check("isRevealable: past the window no", !isRevealable({ status: 1, mode: 1, expiryTime: now - REVEAL_WINDOW - 1 }, now));
  check("isRevealable: open call no", !isRevealable({ status: 2, mode: 2, expiryTime: now - 1 }, now));

  // formatting + confirmation strings
  check("horizonLabel", horizonLabel(86400) === "1d" && horizonLabel(3600) === "1h" && horizonLabel(5400) === "90m");
  check("shortAddr elides the middle", shortAddr(MAINNET.contract) === "0x286e…2528", shortAddr(MAINNET.contract));
  check("handleLabel appends .ai", handleLabel("space", MAINNET.contract) === "space.ai");
  check("handleLabel falls back to the address", handleLabel("", MAINNET.contract) === "0x286e…2528");
  const desc = describeCall("commit", [h, 86400]);
  check("describeCall prints the real signature", desc === `commit(bytes32 ${h}, uint32 86400)`, desc);
  const descOpen = describeCall("commitOpen", [t.token, t.pool, 1, 3600]);
  check(
    "describeCall for commitOpen names every type",
    descOpen === `commitOpen(address ${t.token}, address ${t.pool}, uint8 1, uint32 3600)`,
    descOpen,
  );
  const prev = txPreview({ contract: MAINNET.contract, fn: "commit", args: [h, 86400], chainId: 56 });
  check("txPreview value is always 0", prev.value === "0");
  check("txPreview data matches encodeCall", prev.data === encodeCall("commit", [h, 86400]));
  check("commit selector is the first 4 bytes of the calldata", prev.data.startsWith("0x" + ethers.id("commit(bytes32,uint32)").slice(2, 10)));
}

console.log("\n== against the live contract (read-only eth_call) ==");
{
  const provider = await firstWorkingProvider(RPCS, MAINNET.chainId);
  const ledger = new ethers.Contract(MAINNET.contract, CALL_LEDGER_ABI, provider);

  check("contract reports the expected Agent ID registry", (await ledger.agentId()).toLowerCase() === MAINNET.agentId.toLowerCase());
  const [minH, maxH, revealW] = await Promise.all([ledger.MIN_HORIZON(), ledger.MAX_HORIZON(), ledger.REVEAL_WINDOW()]);
  check("MIN_HORIZON matches core.js", Number(minH) === MIN_HORIZON, `${minH}`);
  check("MAX_HORIZON matches core.js", Number(maxH) === MAX_HORIZON, `${maxH}`);
  check("REVEAL_WINDOW matches core.js", Number(revealW) === REVEAL_WINDOW, `${revealW}`);

  // the invariant: random inputs must hash identically on-chain and in the browser module
  const cases = [];
  for (let i = 0; i < 8; i++) {
    cases.push({
      agent: randAddr(),
      token: randAddr(),
      pool: randAddr(),
      direction: i % 2 === 0 ? DIRECTION.LONG : DIRECTION.SHORT,
      horizon: [MIN_HORIZON, 4 * 3600, 86400, 3 * 86400, 7 * 86400, 14 * 86400, MAX_HORIZON, 90061][i],
      salt: randomSalt(),
    });
  }
  // edge cases: zero salt, all-ff salt, the zero address, real mainnet addresses
  cases.push({
    agent: MAINNET.contract,
    token: MAINNET.presets[0].token,
    pool: MAINNET.presets[0].pool,
    direction: DIRECTION.LONG,
    horizon: 86400,
    salt: "0x" + "00".repeat(32),
  });
  cases.push({
    agent: ethers.ZeroAddress,
    token: ethers.ZeroAddress,
    pool: ethers.ZeroAddress,
    direction: DIRECTION.SHORT,
    horizon: MIN_HORIZON,
    salt: "0x" + "ff".repeat(32),
  });

  let mismatches = 0;
  for (const c of cases) {
    const local = computeHash(c);
    const onchain = await ledger.computeHash(c.agent, c.token, c.pool, c.direction, c.horizon, c.salt);
    if (local.toLowerCase() !== onchain.toLowerCase()) {
      mismatches++;
      console.log(`        local  ${local}\n        chain  ${onchain}\n        input  ${JSON.stringify(c)}`);
    }
  }
  check(`computeHash matches the live contract for all ${cases.length} cases`, mismatches === 0, `${mismatches} mismatch(es)`);

  // the contract's own pool check, read through the site's ABI
  const [kindV2, kindV3, kindBad] = await Promise.all([
    ledger.poolKindOf(MAINNET.presets[0].token, MAINNET.presets[0].pool),
    ledger.poolKindOf(MAINNET.presets[1].token, MAINNET.presets[1].pool),
    ledger.poolKindOf(MAINNET.presets[0].token, MAINNET.contract),
  ]);
  check("poolKindOf: WBNB/USDT v2 preset is a v2 pair", Number(kindV2) === 1, `${kindV2}`);
  check("poolKindOf: WBNB/USDT v3 preset is a v3 pool", Number(kindV3) === 2, `${kindV3}`);
  check("poolKindOf: the ledger itself is not a pool", Number(kindBad) === 0, `${kindBad}`);

  const total = await ledger.totalCalls();
  console.log(`  (live totalCalls = ${total})`);
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("FAILED: " + failures.join(", "));
  process.exit(1);
}
