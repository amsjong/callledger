// CallLedger web app configuration.
//
// Everything the site needs to reach the chain. No build step: edit this file and reload.
// `?env=local` points the app at a local anvil fork (same contract address) for testing.

export const MAINNET = {
  name: "BSC",
  chainId: 56,
  chainHex: "0x38",
  nativeSymbol: "BNB",
  rpcUrls: [
    "https://bsc-dataseed.bnbchain.org",
    "https://bsc-rpc.publicnode.com",
    "https://bsc-mainnet.public.blastapi.io",
  ],
  contract: "0x286eBa3895fdcb3534E2F7c28a36d622650A2528",
  agentId: "0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F",
  deployBlock: 134548883,
  explorer: "https://bscscan.com",
  githubUrl: "https://github.com/amsjong/callledger",
  // quick presets on the commit page
  presets: [
    {
      label: "WBNB / USDT — Pancake v2",
      token: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
      tokenSymbol: "WBNB",
      pool: "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE",
    },
    {
      label: "WBNB / USDT — Pancake v3 (0.05%)",
      token: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
      tokenSymbol: "WBNB",
      pool: "0x36696169C63e42cd08ce11f5deeBbCeBae652050",
    },
  ],
};

// A local `anvil --fork-url <bsc>` keeps every mainnet address, so only the chain id and RPC change.
export const LOCAL = {
  ...MAINNET,
  name: "Local fork",
  chainId: 31337,
  chainHex: "0x7a69",
  rpcUrls: ["http://127.0.0.1:8545"],
  explorer: "https://bscscan.com",
};

function pickEnv() {
  try {
    const q = new URLSearchParams(globalThis.location?.search || "");
    if (q.get("env") !== "local") return MAINNET;
    const cfg = { ...LOCAL };
    // `?rpc=` is honoured only in local mode and only for loopback, so a crafted link can never
    // repoint the app at someone else's node.
    const rpc = q.get("rpc");
    if (rpc && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(rpc)) cfg.rpcUrls = [rpc];
    return cfg;
  } catch {
    return MAINNET; // no location (node) -> mainnet
  }
}

export const CONFIG = pickEnv();
export default CONFIG;
