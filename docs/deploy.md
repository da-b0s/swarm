# Deploying Swarm

Arc Studio writes the contracts. **We deploy them**, from a wallet we control.

That split is not a preference, it is forced. Studio deploys from a Circle-managed
SCP deployer wallet whose key the sandbox does not hold, so it can deploy but cannot
send the three follow-up owner transactions that wire the contracts together. In
Turn 1c it reported a successful deploy with the wiring undone; in Turn 1d it asked
to provision a Standard Developer API Key on the Circle account to get around that,
which was declined. Deploying ourselves removes the problem and is what the project
plan prescribes for mainnet anyway.

## Toolchain

Arc Foundry — `arc-forge`, `arc-cast`, `arc-anvil` — has no Windows build, so it
lives in WSL.

| | |
|---|---|
| Version | `v0.8.0-2` (reports `1.7.1-dev`) |
| Installed at | `~/.local/bin/` inside WSL Ubuntu 24.04 |
| Archive | `arc-foundry-v0.8.0-2-x86_64-unknown-linux-gnu.tar.gz`, 82,602,629 bytes |
| sha256 | `088bdb96…a79556`, verified against the published digest before extracting |

Confirmed working against both networks:

```
testnet  chain-id 5042002   block 68,159,464
mainnet  chain-id 5042      block 26,921,861   gas-price 25 gwei
mainnet  USDC symbol "USDC" decimals 6   at 0x3600…0000
```

Two things worth noting from that. **Mainnet is live and reachable** — the docs never
quite say so. And the **current mainnet gas price is 25 gwei, just above the
documented 20 gwei floor**, so the floor is not theoretical headroom: a relayer that
estimates downward will silently lose transactions.

Run anything through a script file rather than `wsl -- bash -lc "…"`. Git Bash
rewrites `/mnt/...` and bare URLs as Windows paths, and PowerShell expands `$VAR`
before WSL sees it. Both corrupt inline commands. Write a `.sh` and run
`wsl -d Ubuntu -- bash /mnt/c/…/script.sh` from PowerShell.

## Wallets

Generated locally with `arc-cast wallet new`; private keys live only in `.env`,
which is gitignored and mode 600. Verified: `.env` is untracked, and the only
64-hex strings anywhere in git history are deployment transaction hashes.

| Role | Address | Needs |
|---|---|---|
| Deployer | `0x3CF9D6ca7118431810D6D9Cc7DE8f9acAe9A829f` | $20–30 USDC on mainnet; this is also its gas |
| Relayer | `0x1316d10F1e972A8a560de8F26ce3D2c07382aB19` | $10 float, EIP-3009 only |

Testnet USDC comes from `https://faucet.circle.com`. Mainnet USDC can be withdrawn
to Arc from OKX, Kraken, Gate, Bitget or KuCoin.

## Deploy order

Constructor arguments chain, so the order is fixed:

```
DealFactory(owner)
DemandPool(dealFactory, owner)
Settler(dealFactory, demandPool, owner)
```

Then three owner transactions, which must all land before `commit()` works:

```
DealFactory.setDemandPool(demandPool)
DealFactory.setSettler(settler)
DemandPool.setSettler(settler)
```

Each is one-time and guarded, so a second attempt reverts with `AlreadySet` or
`SettlerAlreadySet`. `DemandPool.commit` and `withdraw` revert with
`SettlerNotConfigured` until the third one confirms.

## Commands

From WSL, with `RPC` and `KEY` set from `.env`. Testnet first, always.

```bash
export PATH="$HOME/.local/bin:$PATH"
export RPC=https://rpc.testnet.arc.io     # then https://rpc.mainnet.arc.io
export KEY=<DEPLOYER_KEY from .env>
export OWNER=0x3CF9D6ca7118431810D6D9Cc7DE8f9acAe9A829f

cd onchain

FACTORY=$(arc-forge create contracts/DealFactory.sol:DealFactory \
  --rpc-url $RPC --private-key $KEY --broadcast \
  --constructor-args $OWNER | grep -oiE 'Deployed to: 0x[0-9a-f]{40}' | grep -oiE '0x[0-9a-f]{40}')

POOL=$(arc-forge create contracts/DemandPool.sol:DemandPool \
  --rpc-url $RPC --private-key $KEY --broadcast \
  --constructor-args $FACTORY $OWNER | grep -oiE 'Deployed to: 0x[0-9a-f]{40}' | grep -oiE '0x[0-9a-f]{40}')

SETTLER=$(arc-forge create contracts/Settler.sol:Settler \
  --rpc-url $RPC --private-key $KEY --broadcast \
  --constructor-args $FACTORY $POOL $OWNER | grep -oiE 'Deployed to: 0x[0-9a-f]{40}' | grep -oiE '0x[0-9a-f]{40}')

# wiring - all three must succeed
arc-cast send $FACTORY 'setDemandPool(address)' $POOL    --rpc-url $RPC --private-key $KEY
arc-cast send $FACTORY 'setSettler(address)'    $SETTLER --rpc-url $RPC --private-key $KEY
arc-cast send $POOL    'setSettler(address)'    $SETTLER --rpc-url $RPC --private-key $KEY
```

On mainnet add `--gas-price 25gwei` or higher. Never below 20 gwei: beneath the floor
a transaction vanishes with no error and no receipt.

## Verify before recording anything

Nothing goes into `README.md`, `.env` or `PROOF.md` until this agrees:

```bash
node tools/verify-deploy.mjs --network testnet \
  --factory 0x.. --pool 0x.. --settler 0x..
```

It checks bytecode at all three addresses, the three owner wiring calls, the
constructor-time links in both directions, that both contracts point at the Arc USDC
predeploy, and that the factory is unpaused holding zero escrow. It exits non-zero
otherwise, and it is the reason the unwired Turn 1c deployment never got written down
as real.

Record the **deployment block number** as `DEPLOY_BLOCK` in `.env` at the same time.
Arc produces a block roughly every 0.5 seconds and the chain is tens of millions of
blocks deep, so `tools/proof.mjs` refuses to run without it rather than attempting a
scan from genesis.

## Contract verification

Verify on the explorer after deploying, so a reviewer reads source rather than
bytecode:

```bash
arc-forge verify-contract $FACTORY contracts/DealFactory.sol:DealFactory \
  --rpc-url $RPC --verifier blockscout \
  --verifier-url https://explorer.arc.io/api
```

Testnet uses `https://explorer.testnet.arc.io/api`.
