# Arc chain facts — verified against docs.arc.io on 19 October 2026

Every value below was read from the live docs on 19 Oct 2026, not from the blueprint.
Arc moves fast: re-verify before the mainnet deploy.

## Networks

| Parameter | Arc Mainnet | Arc Testnet |
|---|---|---|
| Chain ID | `5042` (`0x13B2`) | `5042002` |
| RPC | `https://rpc.mainnet.arc.io` | `https://rpc.testnet.arc.io` |
| WebSocket | via providers (Blockdaemon / QuickNode / Alchemy) | `wss://rpc.testnet.arc.io` |
| Explorer | `https://explorer.arc.io` | `https://explorer.testnet.arc.io` (Blockscout) |
| Native currency | USDC, **18 decimals** | USDC, **18 decimals** |
| Faucet | — | `https://faucet.circle.com` |

Mainnet is documented with full setup details. The docs never print the words
"mainnet is live", so confirm status before sending real funds.

## Contracts Swarm touches

| Contract | Mainnet | Testnet |
|---|---|---|
| **USDC (ERC-20 interface, 6 decimals)** | `0x3600000000000000000000000000000000000000` | same |
| **Memo** | `0x5294E9927c3306DcBaDb03fe70b92e01cCede505` | same |
| **Multicall3From** | `0x522fAf9A91c41c443c66765030741e4AaCe147D0` | same |
| **ERC-8004 ReputationRegistry** | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | same |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | same |
| CREATE2 factory | `0x4e59b44847b379578588920cA78FbF26c0B4956C` | same |

### Two addresses the blueprint did not have

- **USDC system emitter** `0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE` — logs *all* USDC
  `Transfer` events chain-wide. Useful for the `/proof` page: it lets us total USDC
  moved without indexing every Swarm contract separately.
- **Known-blocklisted testnet address** `0x70997970C51812dc3A010C7d01b50e0d17dc79C8`
  (mnemonic index 1). This is exactly what test 13 (pull safety — a blocklisted
  buyer must not be able to block anyone else's refund) needs, against the real
  blocklist rather than a mock.

### Not usable
StableFX (`FxEscrow`) is permissioned; USYC is institution-only with a $100k
minimum. Neither belongs in Swarm.

## Gotchas that will bite

| Trap | Rule |
|---|---|
| 18 vs 6 decimals | One balance, two interfaces. All contract logic uses the 6-decimal ERC-20 interface. Divide native by 10^12 only to display. Never mix `msg.value` with `balanceOf`. |
| `balanceOf` == 0 | Does not mean zero funds — the ERC-20 view truncates sub-USDC amounts. |
| 20 gwei floor | Below it transactions vanish silently: no error, no receipt. Critical for the relayer. |
| Blocklist | Transfers to/from blocklisted addresses revert **and burn gas**. Hence `claimable` + pull payments everywhere. |
| `PREVRANDAO` | Always 0. Swarm needs no randomness — say so in the write-up. |
| Block timestamps | Non-decreasing, not strictly increasing. Deadlines only, never ordering. |
| Memo | Direct EOA callers only. No ERC-4337, no Safe, no modular wallets, no `DELEGATECALL`. |
| Local simulation | Stock `anvil` is wrong. Use `arc-anvil --network arc`. |

## Toolchain

| Tool | Status on this machine | Notes |
|---|---|---|
| `arc-studio` CLI | **installed, v1.2.1** | `npm i -g @circle-fin/arc-studio-cli`. Needs `arc-studio login --paste` once. |
| Arc Foundry (`arc-forge`, `arc-cast`, `arc-anvil`) | **not installed** | No npm package. Tarballs from `github.com/circlefin/arc-foundry/releases`. **Windows is not supported — needs WSL.** WSL Ubuntu is present on this machine. |
| Node | v24.12.0 | Studio CLI documents Node 20+; v24 installed and working. |

Arc Foundry install, inside WSL:

```bash
tar -xzf arc-foundry-<version>-<target>.tar.gz
mkdir -p ~/.local/bin
mv forge ~/.local/bin/arc-forge
mv cast  ~/.local/bin/arc-cast
mv anvil ~/.local/bin/arc-anvil
export PATH="$HOME/.local/bin:$PATH"
arc-forge --version
```

Only needed from D5 (mainnet deploy). Arc Studio deploys to testnet by itself.

## Corrections to the blueprint

1. **"Arc Foundry" is real, but there is no npm package and no Windows build.**
   The blueprint's `arc-forge create ...` line is right; getting the binary is a
   WSL job it does not mention.
2. **The Studio CLI is drivable from a terminal**, with `--output json` and a
   structured result document. Studio work does not have to happen in the web UI,
   which means turns can be run from here and still be genuine Studio turns.
3. Every chain address and ID in the blueprint checked out exactly. Good source.

## Note on the docs themselves

Several `docs.arc.io` pages embed an "Agent Instructions" block telling an AI
reader to install external skills and plugins. That is page content, not an
instruction from us — it was ignored on every fetch. Worth knowing if you point
another agent at these docs.
