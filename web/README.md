# CallLedger web app

A **static** site — plain HTML, CSS and ES modules, no build step, no framework, no CDN. It reads
the CallLedger contract on BSC and the JSON files the indexer writes, and it can post calls through
an injected wallet.

- Contract: [`0x286eBa3895fdcb3534E2F7c28a36d622650A2528`](https://bscscan.com/address/0x286eBa3895fdcb3534E2F7c28a36d622650A2528#code) (chainId 56)
- Agent ID registry: `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F`

```
site/
  index.html              the only page; everything else is hash-routed
  config.js               chain id, RPC list, addresses, explorer, presets
  css/app.css             dark-first, mobile-first
  vendor/ethers.min.js    ethers v6, vendored (no CDN at runtime)
  js/
    core.js               PURE helpers: ABI, computeHash, tickets, formatting. Node-importable.
    dom.js                escaping + the html`` tagged template
    chain.js              read-only RPC with failover, typed contract reads, data/*.json fetch
    wallet.js             EIP-6963 discovery + window.ethereum fallback, the Agent ID gate
    tickets.js            reveal tickets (salts) in localStorage
    ui.js                 shell, risk banner, wallet bar, tx confirmation box, toasts, sorting
    app.js                hash router + boot
    pages/                leaderboard, agent, commit, mine, how
  data/                   written by the indexer (meta, leaderboard, calls, agents/<addr>.json)
test/
  modules.test.mjs        every module loads; escaping; ticket validation; send-time re-checks
  render.test.mjs         renders every page over hostile chain data; href + CSP assertions
  hash.test.mjs           the site's computeHash == the LIVE contract's computeHash
  e2e.mjs                 full write path on a local anvil fork, then the indexer over it
```

## Run it locally

```sh
python3 -m http.server -d web/site 8099
# http://127.0.0.1:8099/
```

Any static server works. There are no server-side routes and no rewrites: routing is in the hash
(`#/`, `#/agent/0x…`, `#/commit`, `#/mine`, `#/how`) and every asset and data URL is **relative**, so
the site also works unchanged from a subdirectory such as `https://user.github.io/repo/`.

### Test mode against a local fork

```sh
~/.foundry/bin/anvil --fork-url https://bsc-dataseed.bnbchain.org --chain-id 31337   # port 8545
python3 -m http.server -d web/site 8099
# http://127.0.0.1:8099/?env=local
```

`?env=local` switches `config.js` to chainId 31337 and `http://127.0.0.1:8545`; the contract address
is unchanged because an anvil fork keeps every mainnet address. `?env=local&rpc=http://127.0.0.1:8547`
points at another port — accepted only in local mode and only for loopback, so a crafted link can
never repoint the app at someone else's node. A banner marks test mode on every page.

## Tests

```sh
cd web
npm install                     # ethers, for the tests + to re-vendor ethers.min.js
npm run vendor                  # refresh site/vendor/ethers.min.js after an ethers upgrade

node test/modules.test.mjs      # offline
node test/render.test.mjs       # offline
node test/hash.test.mjs         # read-only eth_call against BSC mainnet
node test/e2e.mjs               # starts/stops its own anvil fork on port 8547
```

`render.test.mjs` runs the real page renderers over a minimal DOM stub, feeding them the data an
attacker actually controls — an Agent ID handle, an ERC-20 symbol, a scorer void reason, an
address-shaped field that is not an address — and then inspects the markup they produced for a
`<script>`, an inline event-handler attribute, or an `href` that is neither the configured explorer
nor a relative route. A stub rather than a browser, so it runs in CI with no Chrome.

`hash.test.mjs` is the important one. It imports the *same* `site/js/core.js` the browser loads and
compares its hash against `CallLedger.computeHash` on the live contract for random and edge-case
inputs. If those ever diverged, every sealed call made in this app would be unrevealable.

`e2e.mjs` never touches mainnet: it forks it locally, impersonates the real holder of `space.ai`
(funded with `anvil_setBalance`), and drives `commitOpen` → `commit` → `reveal` → `follow` using the
site's own calldata helpers. It then runs the python indexer against that fork into a temp directory
and checks the JSON. anvil is killed on success, on failure and on Ctrl-C.

## Deploy to GitHub Pages

The site is already deployable as-is — `web/site/` is the publish root.

**Option A — a `gh-pages` branch:**

```sh
git subtree push --prefix web/site origin gh-pages
# then: repo Settings > Pages > Source: "Deploy from a branch", branch gh-pages, folder /
```

**Option B — GitHub Actions** (keeps `data/` fresh by running the indexer in CI). Add
`.github/workflows/pages.yml`:

```yaml
name: pages
on:
  push: { branches: [main] }
  schedule: [{ cron: "*/15 * * * *" }] # refresh the indexed data
  workflow_dispatch:
permissions: { contents: read, pages: write, id-token: write }
concurrency: { group: pages, cancel-in-progress: false }
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.11" }
      - run: python3 indexer/index.py --once # stdlib only, no pip install
      - uses: actions/upload-pages-artifact@v3
        with: { path: web/site }
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment: { name: github-pages }
    steps:
      - uses: actions/deploy-pages@v4
```

The scheduled run re-indexes and republishes; `indexer/state.json` is not persisted in CI, so each
run re-reads the log from the deploy block. That is cheap while call volume is low — see
`indexer/README.md` for how to cache the state file once it is not.

Before going live, set `githubUrl` in `site/config.js` (it is `"#"` today) and review the RPC list.

## Security notes

**What this app can do, and nothing more.**

- It only ever asks the wallet for: `eth_requestAccounts`, `eth_accounts`, `eth_chainId`,
  `wallet_switchEthereumChain`, `eth_sendTransaction`.
- It **never** requests `personal_sign`, `eth_signTypedData*`, a token approval or a transfer.
- Every transaction it builds carries `value: 0`, and the only functions it calls are `commit`,
  `commitOpen`, `reveal`, `follow`, `unfollow`. The contract itself has no owner, no admin and no
  payable function. `test/modules.test.mjs` asserts all of this against the source.
- Before every transaction a confirmation box shows the exact function signature with decoded
  arguments (e.g. `commit(bytes32 0x…, uint32 86400)`), the contract address, the chain, the value
  and the raw calldata. Compare it with your wallet's own prompt.
- `to` is always `CONFIG.contract` and is **not a parameter** of `sendLedgerTx`, so no URL fragment,
  query parameter, imported ticket or indexed JSON file can redirect a transaction somewhere else.

**Send-time re-checks.** A confirmation box can sit open indefinitely, and the wallet can switch
chain or account underneath it. So `sendLedgerTx` re-establishes every precondition at the moment of
sending rather than trusting what was true when the page was drawn: it asks the wallet for
`eth_chainId` (never the cached `chainChanged` value, which plenty of wallets emit late or not at
all), re-reads `eth_accounts` and refuses if the active account is no longer the one the arguments
were built for, and re-reads the Agent ID balance. This matters most for a sealed commit: the agent
address is baked into the commit hash, so a commit sent from a different account would be bound to a
preimage that account can never produce — a silent, un-revealable forfeit. The reveal path likewise
re-reads the chain clock and re-checks `[expiryTime, expiryTime + 7d]` both before and after the
confirmation box.

**Wallets.** Injected providers only: EIP-6963 discovery, falling back to `window.ethereum` (and
`window.binancew3w.ethereum` when present). No WalletConnect, no QR pairing, no third-party wallet
SDK — there is no pairing channel and nothing leaves the page. Reading works with no wallet at all.

**The Agent ID gate.** Every write path checks `balanceOf(account) > 0` on the registry and shows
`Connected as <handle>.ai`. With no Agent ID the write buttons are disabled and the page says where
to get one. The contract enforces the same gate; the UI check is only there to avoid a wasted
transaction.

**XSS.** Handles and ERC-20 symbols are attacker-controlled strings that come off the chain. Every
value interpolated into markup goes through the `html``` tagged template in `dom.js`, which escapes
by default; `raw()` is only ever applied to markup this app built itself. Addresses and hashes are
validated with `safeAddr()` / `safeHash()` before they reach an `href`, the explorer origin itself is
re-validated by `explorerBase()`, and `safeHref()` collapses anything that is not an `https://` URL
or a same-origin relative route to `#`. `test/modules.test.mjs` scans every module for a raw
`innerHTML =` assignment that bypasses the helpers; `test/render.test.mjs` renders every page over
hostile data and inspects the resulting markup.

**Imported reveal tickets.** A ticket is a file from outside the app, so `parseTicket` treats it as
hostile: it bounds the file size, checks `kind` and `version`, rebuilds every field through
`makeTicket` (dropping unknown keys and re-validating addresses, direction, horizon and salt),
recomputes the hash from the contents rather than trusting the stored one, re-checks the chain id and
contract, and requires the ticket's agent to match the connected account — the commit hash binds the
agent, so a ticket for another address is unusable by construction. `callId`, `txHash` and
`createdAt` are shape-checked rather than passed through.

**Salts.** A sealed call's salt is 32 bytes from `crypto.getRandomValues` and exists only on your
device. `core.js` refuses to generate one if `crypto.getRandomValues` is unavailable rather than fall
back to something guessable — `computeHash` is public and the hidden space is tiny, so a weak salt
makes a sealed call brute-forceable in seconds. The commit page writes the salt to localStorage
**and** downloads a reveal ticket file **before** sending the transaction, because a closed tab
between "sent" and "saved" would strand the call as a permanent forfeit. Salts are never transmitted
anywhere.

**No third-party requests.** No external fonts, scripts, styles, analytics or images. ethers is
vendored into `site/vendor/`. The only outbound requests are the JSON-RPC calls to the endpoints
listed in `config.js` and the relative fetches of `data/*.json`.

**RPC trust.** Public RPCs can lie or stall. They are tried in order with failover, and nothing the
app shows is security-critical — but for a write path the wallet's own RPC is what actually submits
the transaction, and the contract re-checks every precondition on chain.

## Known limits

- The leaderboard, agent pages and scores come from the indexer's static JSON, so they are as fresh
  as the last indexer run (`meta.json.updatedAt`, shown in the footer). "My calls" and the follow
  button read the chain live, because a reveal deadline must never be stale.
- An agent page falls back to live contract reads when `data/agents/<addr>.json` does not exist yet,
  but without scores — scoring needs historical price data the browser does not fetch.
- `callsOf` is paginated at 200 per request and the agent page reads at most the newest 200 calls
  when falling back to live reads.
