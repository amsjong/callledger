// web/test/e2e.mjs — the full write path, against a local anvil fork of BSC. No mainnet tx.
//
// Starts `anvil --fork-url <bsc> --port 8547`, impersonates the real holder of "space" (funded with
// anvil_setBalance), and drives commitOpen / commit / reveal / follow using the SITE's own core
// module for every hash and every piece of calldata. Then it runs the python indexer against the
// same fork, into a temp directory, and checks the JSON it writes.
//
//   node web/test/e2e.mjs
//   node web/test/e2e.mjs --keep        # leave anvil running afterwards (for manual poking)
//
// anvil is killed on exit, on failure, and on Ctrl-C.

import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ethers,
  computeHash,
  randomSalt,
  encodeCall,
  describeCall,
  ledgerInterface,
  makeTicket,
  parseTicket,
  CALL_LEDGER_ABI,
  AGENT_ID_ABI,
  DIRECTION,
  effectiveStatus,
  isRevealable,
} from "../site/js/core.js";
import { MAINNET } from "../site/config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

const PORT = Number(process.env.ANVIL_PORT || 8547);
const RPC = `http://127.0.0.1:${PORT}`;
const FORK_URL = process.env.FORK_RPC_URL || "https://bsc-dataseed.bnbchain.org";
const ANVIL = process.env.ANVIL_BIN || join(process.env.HOME || "/home/ubuntu", ".foundry", "bin", "anvil");
const PYTHON = process.env.PYTHON_BIN || "python3";
const KEEP = process.argv.includes("--keep");

const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const V2_PAIR = "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE";
const V3_POOL = "0x36696169C63e42cd08ce11f5deeBbCeBae652050";

let pass = 0;
const failures = [];
let anvil = null;
const anvilLog = [];

function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${detail ? `  -- ${detail}` : ""}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? `  -- ${detail}` : ""}`);
  }
}

function eq(name, got, want) {
  check(name, String(got) === String(want), `got ${got}, want ${want}`);
}

// ------------------------------------------------------------------ anvil lifecycle
function startAnvil() {
  console.log(`starting anvil on ${RPC} forking ${FORK_URL}`);
  // --chain-id 31337 is explicit: recent anvil inherits the forked chain's id (56), and the app's
  // `?env=local` test mode expects 31337 so a local fork can never be mistaken for mainnet.
  anvil = spawn(
    ANVIL,
    ["--fork-url", FORK_URL, "--port", String(PORT), "--host", "127.0.0.1", "--chain-id", "31337"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  anvil.stdout.on("data", (d) => anvilLog.push(String(d)));
  anvil.stderr.on("data", (d) => anvilLog.push(String(d)));
  anvil.on("error", (e) => {
    anvilLog.push(`spawn error: ${e.message}`);
  });
}

function stopAnvil() {
  if (anvil && !anvil.killed) {
    anvil.kill("SIGTERM");
    setTimeout(() => anvil?.killed || anvil?.kill("SIGKILL"), 2000);
  }
}

process.on("SIGINT", () => {
  stopAnvil();
  process.exit(130);
});

async function waitForRpc(timeoutMs = 90_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const p = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true, polling: true });
      const n = await p.getBlockNumber();
      if (n > 0) return p;
    } catch {
      /* not up yet */
    }
    if (anvil?.exitCode !== null && anvil?.exitCode !== undefined) {
      throw new Error(`anvil exited with code ${anvil.exitCode}:\n${anvilLog.join("")}`);
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error(`anvil did not answer on ${RPC} within ${timeoutMs}ms:\n${anvilLog.join("").slice(-2000)}`);
}

function runPython(args, env = {}) {
  return new Promise((resolve) => {
    const proc = spawn(PYTHON, args, { cwd: REPO, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (out += d));
    proc.on("close", (code) => resolve({ code, out }));
  });
}

// ------------------------------------------------------------------ the test
async function main() {
  startAnvil();
  const provider = await waitForRpc();
  const net = await provider.getNetwork();
  const forkBlock = await provider.getBlockNumber();
  console.log(`anvil up: chainId ${net.chainId}, fork block ${forkBlock}\n`);

  console.log("== fork sanity ==");
  eq("chainId is the local anvil default", net.chainId, 31337n);
  check("fork block is past the CallLedger deploy block", forkBlock > MAINNET.deployBlock, `${forkBlock} > ${MAINNET.deployBlock}`);
  const code = await provider.getCode(MAINNET.contract);
  check("the forked CallLedger has code at the mainnet address", code.length > 2, `${(code.length - 2) / 2} bytes`);

  const rpc = (method, params = []) => provider.send(method, params);
  // Raw eth_getBlockByNumber, not provider.getBlock: ethers caches the "latest" block for a few
  // hundred ms, which reads as "evm_increaseTime did nothing" right after a time jump.
  const chainNow = async () => Number(BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp));

  // ---------------------------------------------------------------- real Agent ID holders
  console.log("\n== resolve real Agent ID holders from the registry ==");
  const registry = new ethers.Contract(MAINNET.agentId, AGENT_ID_ABI, provider);
  const space = await registry.ownerOfHandle("space");
  const other = await registry.ownerOfHandle("agent");
  check("ownerOfHandle(\"space\") resolves", space !== ethers.ZeroAddress, space);
  check("ownerOfHandle(\"agent\") resolves", other !== ethers.ZeroAddress, other);
  check("they are different addresses", space.toLowerCase() !== other.toLowerCase());
  const [balSpace, balOther, handleSpace] = await Promise.all([
    registry.balanceOf(space),
    registry.balanceOf(other),
    registry.handleOf(space),
  ]);
  check("space holds an Agent ID", balSpace > 0n, `balance ${balSpace}`);
  check("agent holds an Agent ID", balOther > 0n, `balance ${balOther}`);
  eq("handleOf(space) is the bare handle", handleSpace, "space");

  // ---------------------------------------------------------------- impersonate + fund
  const nonHolder = ethers.getAddress("0x" + "7e".repeat(20));
  for (const a of [space, other, nonHolder]) {
    await rpc("anvil_setBalance", [a, "0x" + (10n ** 19n).toString(16)]);
    await rpc("anvil_impersonateAccount", [a]);
  }
  const spaceSigner = await provider.getSigner(space);
  check("the impersonated holder is funded", (await provider.getBalance(space)) > 0n);

  const ledger = new ethers.Contract(MAINNET.contract, CALL_LEDGER_ABI, provider);

  // ---------------------------------------------------------------- pool checks via the site ABI
  console.log("\n== pool checks (the contract's own view, read through the site ABI) ==");
  eq("poolKindOf(WBNB, v3 pool) == 2", await ledger.poolKindOf(WBNB, V3_POOL), 2);
  eq("poolKindOf(WBNB, v2 pair) == 1", await ledger.poolKindOf(WBNB, V2_PAIR), 1);
  eq("poolKindOf(WBNB, the ledger itself) == 0", await ledger.poolKindOf(WBNB, MAINNET.contract), 0);

  const before = {
    total: Number(await ledger.totalCalls()),
    space: await ledger.getAgent(space),
    other: await ledger.getAgent(other),
  };

  // ---------------------------------------------------------------- 1. open call on the v3 pool
  console.log("\n== commitOpen: a v3 WBNB/USDT long, published immediately ==");
  const openArgs = [WBNB, V3_POOL, DIRECTION.LONG, 3600];
  console.log(`  sending ${describeCall("commitOpen", openArgs)}`);
  const openTx = await spaceSigner.sendTransaction({
    to: MAINNET.contract,
    data: encodeCall("commitOpen", openArgs), // calldata built by the site's core module
    value: 0,
  });
  const openRc = await openTx.wait();
  check("commitOpen succeeded", openRc.status === 1);
  const openEvents = parseEvents(openRc);
  check("AgentSeen emitted on the first interaction", openEvents.some((e) => e.name === "AgentSeen"), names(openEvents));
  eq("AgentSeen carries the handle", openEvents.find((e) => e.name === "AgentSeen")?.args.handle, "space");
  const committed0 = openEvents.find((e) => e.name === "Committed");
  const openCall0 = openEvents.find((e) => e.name === "OpenCall");
  check("Committed emitted", Boolean(committed0));
  check("OpenCall emitted in the same tx", Boolean(openCall0));
  eq("open mode has a zero commitHash", committed0?.args.commitHash, ethers.ZeroHash);
  const openId = Number(committed0.args.callId);
  eq("OpenCall is for the same callId", Number(openCall0.args.callId), openId);
  eq("OpenCall poolKind is v3", Number(openCall0.args.poolKind), 2);

  let c0 = await ledger.getCall(openId);
  eq("getCall: mode is Open", c0.mode, 2);
  eq("getCall: status is Revealed immediately", c0.status, 2);
  eq("getCall: direction is Long", c0.direction, 1);
  eq("getCall: poolKind is v3", c0.poolKind, 2);
  eq("getCall: token is WBNB", c0.token.toLowerCase(), WBNB.toLowerCase());
  eq("getCall: pool is the v3 pool", c0.pool.toLowerCase(), V3_POOL.toLowerCase());
  eq("getCall: agent is the holder", c0.agent.toLowerCase(), space.toLowerCase());
  eq("getCall: expiry is commit + horizon", Number(c0.expiryTime), Number(c0.commitTime) + 3600);
  check("an open call is never revealable", !isRevealable(normalise(openId, c0), Number(c0.commitTime) + 7200));

  // ---------------------------------------------------------------- 2. sealed call on the v2 pair
  console.log("\n== commit: a sealed v2 WBNB/USDT short ==");
  const horizon = 7200;
  const salt = randomSalt();
  const preimage = {
    agent: space,
    token: WBNB,
    pool: V2_PAIR,
    direction: DIRECTION.SHORT,
    horizon,
    salt,
  };
  const hash = computeHash(preimage);
  const onchainHash = await ledger.computeHash(space, WBNB, V2_PAIR, DIRECTION.SHORT, horizon, salt);
  eq("the site's hash equals the contract's computeHash", hash.toLowerCase(), onchainHash.toLowerCase());

  // the reveal ticket the web app would have downloaded before sending
  const ticket = parseTicket(
    JSON.stringify(makeTicket({ ...preimage, chainId: 31337, contract: MAINNET.contract, hash })),
  );
  eq("the reveal ticket round-trips to the same hash", ticket.hash.toLowerCase(), hash.toLowerCase());

  console.log(`  sending ${describeCall("commit", [hash, horizon])}`);
  const sealTx = await spaceSigner.sendTransaction({
    to: MAINNET.contract,
    data: encodeCall("commit", [hash, horizon]),
    value: 0,
  });
  const sealRc = await sealTx.wait();
  check("commit succeeded", sealRc.status === 1);
  const sealEvents = parseEvents(sealRc);
  const committed1 = sealEvents.find((e) => e.name === "Committed");
  check("Committed emitted", Boolean(committed1));
  check("no OpenCall for a sealed commit", !sealEvents.some((e) => e.name === "OpenCall"), names(sealEvents));
  const sealedId = Number(committed1.args.callId);
  eq("the committed hash is on chain", committed1.args.commitHash.toLowerCase(), hash.toLowerCase());

  let c1 = await ledger.getCall(sealedId);
  eq("getCall: mode is Sealed", c1.mode, 1);
  eq("getCall: status is Committed", c1.status, 1);
  eq("getCall: token is still hidden", c1.token, ethers.ZeroAddress);
  eq("getCall: pool is still hidden", c1.pool, ethers.ZeroAddress);
  eq("getCall: direction is still hidden", c1.direction, 0);
  check("hashUsed is now set for this agent", await ledger.hashUsed(space, hash));
  check("committing the same hash again reverts", await reverts(ledger, space, "commit", [hash, horizon], "HashAlreadyUsed"));

  const expiry = Number(c1.expiryTime);
  const nowBefore = await chainNow();
  check(
    "effectiveStatus before expiry says awaiting horizon",
    effectiveStatus(normalise(sealedId, c1), nowBefore).includes("awaiting"),
    effectiveStatus(normalise(sealedId, c1), nowBefore),
  );
  check("revealing before expiry reverts TooEarly", await reverts(ledger, space, "reveal", [sealedId, WBNB, V2_PAIR, DIRECTION.SHORT, salt], "TooEarly"));

  // ---------------------------------------------------------------- 3. travel past the horizon, reveal
  console.log("\n== travel past the horizon and reveal ==");
  await rpc("evm_increaseTime", [horizon + 120]);
  await rpc("evm_mine", []);
  const nowAfter = await chainNow();
  check("the chain clock is past the expiry", nowAfter > expiry, `${nowAfter} > ${expiry}`);
  check("the call is revealable now", isRevealable(normalise(sealedId, c1), nowAfter));

  const revealArgs = [sealedId, WBNB, V2_PAIR, DIRECTION.SHORT, ticket.salt];
  console.log(`  sending ${describeCall("reveal", revealArgs)}`);
  const revealTx = await spaceSigner.sendTransaction({
    to: MAINNET.contract,
    data: encodeCall("reveal", revealArgs),
    value: 0,
  });
  const revealRc = await revealTx.wait();
  check("reveal succeeded", revealRc.status === 1);
  const revealEvents = parseEvents(revealRc);
  const revealed = revealEvents.find((e) => e.name === "Revealed");
  check("Revealed emitted", Boolean(revealed), names(revealEvents));
  eq("Revealed: callId", Number(revealed.args.callId), sealedId);
  eq("Revealed: token", revealed.args.token.toLowerCase(), WBNB.toLowerCase());
  eq("Revealed: pool", revealed.args.pool.toLowerCase(), V2_PAIR.toLowerCase());
  eq("Revealed: poolKind is v2", Number(revealed.args.poolKind), 1);
  eq("Revealed: direction is Short", Number(revealed.args.direction), 2);

  c1 = await ledger.getCall(sealedId);
  eq("getCall: status is now Revealed", c1.status, 2);
  eq("getCall: token is published", c1.token.toLowerCase(), WBNB.toLowerCase());
  eq("getCall: pool is published", c1.pool.toLowerCase(), V2_PAIR.toLowerCase());
  eq("getCall: direction is published", c1.direction, 2);
  check("revealing twice reverts", await reverts(ledger, space, "reveal", revealArgs, "NotCommittedState"));
  check(
    "a non-committer cannot reveal someone else's call",
    await reverts(ledger, other, "reveal", revealArgs, "NotCommitter"),
  );
  // A second sealed call, this time a long with a 1h horizon, to pin down the hash's binding:
  // every field is inside the preimage, so a reveal that differs in any one of them must fail.
  const horizon2 = 3600;
  const salt2 = randomSalt();
  const preimage2 = { ...preimage, direction: DIRECTION.LONG, horizon: horizon2, salt: salt2 };
  const hash2 = computeHash(preimage2);
  await (
    await spaceSigner.sendTransaction({
      to: MAINNET.contract,
      data: encodeCall("commit", [hash2, horizon2]),
      value: 0,
    })
  ).wait();
  const id2 = Number(await ledger.totalCalls()) - 1;
  await rpc("evm_increaseTime", [horizon2 + 120]);
  await rpc("evm_mine", []);
  check(
    "a wrong salt reverts HashMismatch",
    await reverts(ledger, space, "reveal", [id2, WBNB, V2_PAIR, DIRECTION.LONG, randomSalt()], "HashMismatch"),
  );
  check(
    "the wrong direction reverts HashMismatch (direction is inside the hash)",
    await reverts(ledger, space, "reveal", [id2, WBNB, V2_PAIR, DIRECTION.SHORT, salt2], "HashMismatch"),
  );
  check(
    "the wrong pool reverts HashMismatch (pool is inside the hash)",
    await reverts(ledger, space, "reveal", [id2, WBNB, V3_POOL, DIRECTION.LONG, salt2], "HashMismatch"),
  );
  check(
    "the right preimage reveals it",
    !(await reverts(ledger, space, "reveal", [id2, WBNB, V2_PAIR, DIRECTION.LONG, salt2])),
  );
  await (
    await spaceSigner.sendTransaction({
      to: MAINNET.contract,
      data: encodeCall("reveal", [id2, WBNB, V2_PAIR, DIRECTION.LONG, salt2]),
      value: 0,
    })
  ).wait();

  // ---------------------------------------------------------------- 4. follow
  console.log("\n== follow ==");
  check("space does not follow agent yet", !(await ledger.isFollowing(space, other)));
  const followTx = await spaceSigner.sendTransaction({
    to: MAINNET.contract,
    data: encodeCall("follow", [other]),
    value: 0,
  });
  const followRc = await followTx.wait();
  check("follow succeeded", followRc.status === 1);
  const followEvents = parseEvents(followRc);
  const followed = followEvents.find((e) => e.name === "Followed");
  check("Followed emitted", Boolean(followed), names(followEvents));
  eq("Followed: follower", followed.args.follower.toLowerCase(), space.toLowerCase());
  eq("Followed: agent", followed.args.agent.toLowerCase(), other.toLowerCase());
  check("isFollowing is now true", await ledger.isFollowing(space, other));
  check("following again reverts", await reverts(ledger, space, "follow", [other], "AlreadyFollowing"));
  check("following yourself reverts", await reverts(ledger, space, "follow", [space], "SelfFollow"));

  // ---------------------------------------------------------------- 5. the Agent ID gate
  console.log("\n== the Agent ID gate ==");
  eq("the non-holder really holds nothing", await registry.balanceOf(nonHolder), 0);
  check(
    "a non-holder's commitOpen reverts NotAgentHolder",
    await reverts(ledger, nonHolder, "commitOpen", [WBNB, V2_PAIR, DIRECTION.LONG, 3600], "NotAgentHolder"),
  );
  check(
    "a non-holder's commit reverts NotAgentHolder",
    await reverts(ledger, nonHolder, "commit", [ethers.id("anything"), 3600], "NotAgentHolder"),
  );
  check(
    "a non-holder's follow reverts NotAgentHolder",
    await reverts(ledger, nonHolder, "follow", [space], "NotAgentHolder"),
  );

  // ---------------------------------------------------------------- 6. aggregate state
  console.log("\n== aggregate state ==");
  const total = Number(await ledger.totalCalls());
  eq("totalCalls grew by 3", total, before.total + 3);
  const agentSpace = await ledger.getAgent(space);
  const agentOther = await ledger.getAgent(other);
  eq("getAgent(space).handle", agentSpace.handle, "space");
  eq("getAgent(space).commits", Number(agentSpace.commits) - Number(before.space.commits), 3);
  eq("getAgent(space).openCalls", Number(agentSpace.openCalls) - Number(before.space.openCalls), 1);
  eq("getAgent(space).reveals", Number(agentSpace.reveals) - Number(before.space.reveals), 2);
  eq("getAgent(space).forfeits", Number(agentSpace.forfeits), 0);
  eq("getAgent(space).following", Number(agentSpace.following) - Number(before.space.following), 1);
  eq("getAgent(agent).followers", Number(agentOther.followers) - Number(before.other.followers), 1);
  const ids = (await ledger.callsOf(space, 0, 200)).map(Number);
  check("callsOf lists every call", ids.includes(openId) && ids.includes(sealedId) && ids.includes(id2), ids.join(","));
  eq("callCountOf matches", Number(await ledger.callCountOf(space)), ids.length);

  // give the scorer a chance at a non-PENDING result: push past the expiry windows
  await rpc("evm_increaseTime", [3600]);
  await rpc("evm_mine", []);
  await rpc("evm_increaseTime", [1200]);
  await rpc("evm_mine", []);
  await rpc("evm_mine", []);

  // ---------------------------------------------------------------- 7. the indexer, on the fork
  console.log("\n== indexer against the fork (temp output dir, never the real data dir) ==");
  const outDir = await mkdtemp(join(tmpdir(), "callledger-e2e-"));
  const res = await runPython([
    join(REPO, "indexer", "index.py"),
    "--once",
    "--rpc",
    RPC,
    "--chain-id",
    "31337",
    "--out",
    outDir,
    // forkBlock + 1 is the first *locally mined* block: a range that reaches back into the forked
    // history makes anvil forward eth_getLogs to the public RPC, which rate-limits it.
    "--deploy-block",
    String(forkBlock + 1),
    "--reorg-margin",
    "0",
    "--chunk",
    "500",
  ]);
  console.log(
    res.out
      .trim()
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n"),
  );
  check("the indexer exited 0", res.code === 0, `exit ${res.code}`);

  try {
    const meta = JSON.parse(await readFile(join(outDir, "meta.json"), "utf8"));
    const board = JSON.parse(await readFile(join(outDir, "leaderboard.json"), "utf8"));
    const calls = JSON.parse(await readFile(join(outDir, "calls.json"), "utf8"));
    const agentFile = JSON.parse(await readFile(join(outDir, "agents", `${space.toLowerCase()}.json`), "utf8"));

    eq("meta: chainId", meta.chainId, 31337);
    eq("meta: indexed every call", meta.indexedCalls, 3);
    eq("meta: Committed events decoded", meta.events.Committed, 3);
    eq("meta: OpenCall events decoded", meta.events.OpenCall, 1);
    eq("meta: Revealed events decoded", meta.events.Revealed, 2);
    eq("meta: Followed events decoded", meta.events.Followed, 1);
    eq("meta: AgentSeen events decoded", meta.events.AgentSeen, 1);
    check("meta: updatedAt is ISO UTC", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(meta.updatedAt), meta.updatedAt);
    eq("meta: the scoring cap is published", meta.scoring.capPct, 20);
    eq("meta: the liquidity floor is published", meta.scoring.minLiquidityUsd, 50000);

    const row = board.agents.find((a) => a.address === space.toLowerCase());
    check("leaderboard: the agent is listed", Boolean(row), board.agents.map((a) => a.address).join(","));
    eq("leaderboard: handle", row.handle, "space");
    eq("leaderboard: calls", row.calls, 3);
    eq("leaderboard: sealedCalls", row.sealedCalls, 2);
    eq("leaderboard: openCalls", row.openCalls, 1);
    eq("leaderboard: reveals", row.reveals, 2);
    eq("leaderboard: revealRate is 1 (2 of 2 past expiry)", row.revealRate, 1);
    eq("leaderboard: forfeits", row.forfeits, 0);
    eq("leaderboard: following", row.following, 1);
    const otherRow = board.agents.find((a) => a.address === other.toLowerCase());
    check("leaderboard: the followed agent appears too", Boolean(otherRow));
    eq("leaderboard: followers of the followed agent", otherRow?.followers, 1);

    eq("calls.json: every call present", calls.count, 3);
    const openRow = calls.calls.find((c) => c.callId === openId);
    const sealedRow = calls.calls.find((c) => c.callId === sealedId);
    eq("calls.json: open call mode", openRow.mode, "Open");
    eq("calls.json: open call direction", openRow.direction, "LONG");
    eq("calls.json: open call poolKind", openRow.poolKind, "v3");
    eq("calls.json: open call token symbol was resolved", openRow.tokenSymbol, "WBNB");
    eq("calls.json: open call pool", openRow.pool, V3_POOL.toLowerCase());
    eq("calls.json: sealed call mode", sealedRow.mode, "Sealed");
    eq("calls.json: sealed call direction", sealedRow.direction, "SHORT");
    eq("calls.json: sealed call poolKind", sealedRow.poolKind, "v2");
    eq("calls.json: sealed call status", sealedRow.effectiveStatus, "Revealed");
    check("calls.json: horizon recorded", sealedRow.horizon === horizon, `${sealedRow.horizon}`);
    check(
      "calls.json: every call carries a score status",
      calls.calls.every((c) => ["SCORED", "PENDING", "VOID", "FORFEIT"].includes(c.score.status)),
      calls.calls.map((c) => `${c.callId}:${c.score.status}`).join(" "),
    );
    for (const c of calls.calls) {
      console.log(
        `    call ${c.callId} ${c.mode}/${c.direction}/${c.poolKind} -> ${c.score.status}` +
          (c.score.cappedScore !== null ? ` score ${c.score.cappedScore}` : "") +
          (c.score.liquidityUsd0 ? ` liq0 $${Math.round(c.score.liquidityUsd0).toLocaleString()}` : "") +
          (c.score.voidReason ? ` void: ${c.score.voidReason}` : "") +
          (c.score.reason ? ` (${c.score.reason})` : ""),
      );
    }
    const scored = calls.calls.filter((c) => c.score.status === "SCORED");
    check(
      "any SCORED call passed the liquidity floor at both ends",
      scored.every((c) => c.score.liquidityUsd0 >= 50000 && c.score.liquidityUsd1 >= 50000),
      scored.map((c) => `${c.callId}`).join(","),
    );
    check(
      "any SCORED call is inside the cap",
      scored.every((c) => Math.abs(c.score.cappedScore) <= 20),
    );

    eq("agents/<addr>.json: profile address", agentFile.profile.address, space.toLowerCase());
    eq("agents/<addr>.json: full history", agentFile.calls.length, 3);
    check(
      "agents/<addr>.json: history carries commit times",
      agentFile.calls.every((c) => c.commitTime > 0 && c.expiryTime > c.commitTime),
    );

    // a second pass must be a no-op that still produces identical output
    const res2 = await runPython([
      join(REPO, "indexer", "index.py"),
      "--once",
      "--rpc",
      RPC,
      "--chain-id",
      "31337",
      "--out",
      outDir,
      "--deploy-block",
      String(forkBlock),
      "--reorg-margin",
      "0",
      "--chunk",
      "500",
    ]);
    check("a second indexer pass exits 0 (incremental)", res2.code === 0, `exit ${res2.code}`);
    const meta2 = JSON.parse(await readFile(join(outDir, "meta.json"), "utf8"));
    eq("the second pass still reports every call", meta2.indexedCalls, 3);
    check("the second pass re-scored cleanly", /scored 3 call/.test(res2.out), res2.out.match(/scored.*/)?.[0] || "");
    check("the second pass fetched no new logs", /nothing new to fetch|0 log/.test(res2.out));
  } finally {
    if (!KEEP) await rm(outDir, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------- 8. the lock file
  console.log("\n== indexer lock ==");
  const lockDir = await mkdtemp(join(tmpdir(), "callledger-lock-"));
  const lockPath = join(lockDir, ".indexer.lock");
  await writeFile(lockPath, `${process.pid} held-by-this-test\n`);
  const locked = await runPython([
    join(REPO, "indexer", "index.py"),
    "--once",
    "--rpc",
    RPC,
    "--chain-id",
    "31337",
    "--out",
    lockDir,
    // forkBlock + 1 is the first *locally mined* block: a range that reaches back into the forked
    // history makes anvil forward eth_getLogs to the public RPC, which rate-limits it.
    "--deploy-block",
    String(forkBlock + 1),
    "--lock",
    lockPath,
  ]);
  // the lock names a live pid (ours), so the run must bail out instead of racing
  check("a held lock makes a second run exit without indexing", /holds|another indexer/.test(locked.out), locked.out.trim().slice(0, 120));

  // A crash leaves the lock behind. The pid in it is gone, so the next run must take it over --
  // otherwise the 10-minute systemd timer never indexes again until somebody notices by hand.
  const indexerArgs = (extra = []) => [
    join(REPO, "indexer", "index.py"), "--once",
    "--rpc", RPC, "--chain-id", "31337", "--out", lockDir,
    "--deploy-block", String(forkBlock + 1), "--lock", lockPath,
    "--reorg-margin", "0", "--chunk", "500", ...extra,
  ];
  for (const [label, contents] of [
    ["a dead pid", "999999 crashed-run\n"],
    ["an empty file (killed between create and write)", ""],
    ["garbage", "not-a-pid at all\n"],
  ]) {
    await writeFile(lockPath, contents);
    const stale = await runPython(indexerArgs(["--no-score"]));
    check(`a stale lock holding ${label} is taken over`,
      stale.code === 0 && /removing stale lock/.test(stale.out),
      `exit ${stale.code}: ${stale.out.trim().split("\n")[0] || ""}`.slice(0, 120));
    check(`...and the lock is released afterwards (${label})`,
      !(await readFile(lockPath, "utf8").then(() => true).catch(() => false)));
  }

  // Valid JSON is not a valid state file: a truncated or hand-edited one must be discarded and
  // re-indexed from the deploy block, not crash the pass after it has spent its RPC budget.
  const statePath = join(lockDir, ".indexer-state.json");
  // The chain/contract must match, or the state is rejected before the shape check is reached.
  const stateFor = (extra) =>
    JSON.stringify({ chainId: 31337, contract: MAINNET.contract.toLowerCase(), ...extra });
  for (const [label, contents, expect] of [
    ["a truncated event list", stateFor({ lastBlock: forkBlock, events: [{ nope: 1 }, "x", null] }), /malformed event/],
    ["the wrong types", stateFor({ lastBlock: "soon", events: "none" }), /wrong shape/],
    ["an unparseable file", "{not json at all", /unreadable/],
    ["a foreign chain", '{"chainId":1,"contract":"0xdead","lastBlock":9,"events":[]}', /different chain\/contract/],
  ]) {
    await writeFile(statePath, contents);
    const r = await runPython(indexerArgs(["--no-score"]));
    check(`a corrupt state file (${label}) is discarded, not fatal`,
      r.code === 0 && expect.test(r.out),
      `exit ${r.code}: ${(r.out.match(/state file[^\n]*|[^\n]*different chain[^\n]*/) || [""])[0]}`.slice(0, 110));
  }

  // meta.json is the freshness marker the site reads, so it must be the last file written: if a
  // later write failed, it would otherwise advertise data that was never published.
  {
    const srcLines = (await readFile(join(REPO, "indexer", "index.py"), "utf8")).split("\n");
    const at = (needle) => srcLines.findIndex((l) => l.includes(needle));
    const metaAt = at('write_json_atomic(os.path.join(args.out, "meta.json")');
    const boardAt = at('write_json_atomic(os.path.join(args.out, "leaderboard.json")');
    const agentsAt = at('f"{addr}.json"');
    check("meta.json is written after leaderboard.json and the agent files",
      metaAt > boardAt && metaAt > agentsAt && boardAt > 0 && agentsAt > 0,
      `agents@${agentsAt} board@${boardAt} meta@${metaAt}`);
  }

  await rm(lockDir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ helpers
function parseEvents(receipt) {
  const out = [];
  for (const log of receipt.logs) {
    if (String(log.address).toLowerCase() !== MAINNET.contract.toLowerCase()) continue;
    try {
      const parsed = ledgerInterface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed) out.push(parsed);
    } catch {
      /* not one of ours */
    }
  }
  return out;
}

function names(events) {
  return events.map((e) => e.name).join(",") || "(none)";
}

function normalise(callId, c) {
  return {
    callId,
    status: Number(c.status),
    mode: Number(c.mode),
    expiryTime: Number(c.expiryTime),
  };
}

/** True if a staticCall from `from` reverts, and (when given) with the named custom error. */
async function reverts(ledger, from, fn, args, errorName) {
  try {
    await ledger[fn].staticCall(...args, { from });
    return false;
  } catch (e) {
    if (!errorName) return true;
    const name = e.revert?.name || e.shortMessage || e.message || "";
    if (String(name).includes(errorName)) return true;
    console.log(`        (reverted, but with ${name})`);
    return false;
  }
}

// ------------------------------------------------------------------ run
let exitCode = 0;
try {
  await main();
} catch (e) {
  console.error("\nFATAL:", e);
  failures.push(`fatal: ${e.message}`);
} finally {
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) console.log("FAILED: " + failures.join(", "));
  exitCode = failures.length ? 1 : 0;
  if (KEEP) {
    console.log(`anvil left running on ${RPC} (--keep). Kill it yourself.`);
  } else {
    stopAnvil();
  }
}
process.exit(exitCode);
