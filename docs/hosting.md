# Hosting Swarm

Two pieces go public: the frontend, which is static files, and the relayer, a
small always-on Node service holding a hot-wallet key. Neither needs anything
custom from the host.

Do mainnet in this order: deploy and verify the contracts
([deploy.md](deploy.md)), record the addresses in
[`web/src/swarm/config.ts`](../web/src/swarm/config.ts) with `deployed: true`,
start the relayer, and only then build and publish the frontend. The app refuses
to offer a commit on a network whose addresses are not recorded, so publishing it
early shows a banner rather than doing harm, but it is still the wrong order.

## Relayer

Any host that runs a Dockerfile: Render (Web Service), Railway, or Fly.io.

- **Root directory:** `relayer/`. It builds from [`relayer/Dockerfile`](../relayer/Dockerfile).
- **Health check path:** `/health`.
- **Instances:** exactly one. The relayer tracks its nonce in memory, so two
  instances sharing a key would race for nonces.

Environment, set in the host's dashboard:

| Variable | Testnet | Mainnet |
|---|---|---|
| `RELAYER_KEY` | **secret** — from `.env` | **secret** — from `.env` |
| `RPC_URL` | `https://rpc.testnet.arc.io` | `https://rpc.mainnet.arc.io` |
| `CHAIN_ID` | `5042002` | `5042` |
| `POOL_ADDRESS` | `0xc9f1D52E835Fa42d2BB271167f7B1855dDAbb524` | the mainnet DemandPool, once verified |
| `ALLOWED_ORIGIN` | the frontend's URL, e.g. `https://swarm.example.app` | same |
| `PORT` | leave unset if the host injects it; otherwise `8787` | same |

The relayer refuses to start if `CHAIN_ID` does not match what `RPC_URL` reports,
or if `RELAYER_KEY` looks like a placeholder. `ALLOWED_ORIGIN` must be the exact
origin of the published frontend — scheme and host, no trailing slash — or browsers
will refuse its responses.

Check it after deploying: `GET /health` should return the chain id, pool address,
relayer address and USDC balance, and no key.

Its relay log is written to `relay-log.jsonl` in the container and is lost on
redeploy. That is fine for operation; for the proof page the same facts are on
chain.

The relayer wallet is `0x1316d10F1e972A8a560de8F26ce3D2c07382aB19`. Keep its float
small — $10 — and top it up rather than holding more.

## Frontend

Any static host: Vercel, Netlify or Cloudflare Pages.

- **Root directory:** `web/`
- **Install command:** `npm install --legacy-peer-deps` (see the README for why)
- **Build command:** `npm run build`
- **Output directory:** `dist`
- **Node:** 22 or later

Environment, set at build time (Vite bakes these into the bundle, so a change
needs a rebuild):

| Variable | Value |
|---|---|
| `VITE_SWARM_NETWORK` | `mainnet` for the submission; `testnet` for a preview |
| `VITE_RELAYER_URL` | the relayer's public URL, no trailing slash. Leave unset to hide gasless commits and use approve-then-commit only |

No rewrite rules are needed: the app routes with a `?deal=` query parameter on a
single page.

After publishing, open it logged out and on a phone: the live price, buyer count
and countdown must show with no wallet connected, and the nav must fit at 375px.
