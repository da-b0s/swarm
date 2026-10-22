# Swarm

**Pooled demand where the price falls as more buyers commit.**

A supplier posts a price curve instead of a price. Buyers commit USDC into escrow
at whatever tier is live. As volume builds, tiers break and the price falls — for
everyone, including people who already committed. At the deadline a single
transaction settles every buyer at one clearing price, refunds every earlier buyer
the difference, and pays the supplier. If the minimum is never reached, everyone is
refunded in full and nothing ships.

Nobody holds anybody's money. The contract does.

Built on [Arc](https://docs.arc.io) with USDC as both the unit of account and the gas.

> Status: in development for Arc Microgrants Round 2. Not yet deployed to mainnet.

---

## The problem

Buying together is how price actually gets negotiated, and online it barely works.
Someone has to collect the money, everyone has to trust them, and if the group
falls short there is no clean way to unwind.

Every onchain payment splitter sends **one payment to many recipients**. Swarm does
the opposite: it aggregates **many buyers into one price**.

## How it works

```
postDeal(tiers[], minBuyers, deadline, cap)   supplier posts the curve
        │
commit(dealId)        buyer escrows the CURRENT tier price
        │             live price recomputed → everyone sees the tier break
        │
withdraw(dealId)      exit before deadline; a tier can UN-break
        │             (refused only if your exit would strand another buyer)
        │
   at deadline:
     committed <  minBuyers  →  refundAll()   every buyer whole, nothing ships
     committed >= minBuyers  →  settle()
        │
settle(dealId)   clearing = lowest tier price unlocked by final volume
                 for each buyer: claimable[b] += escrowed − clearing
                 claimable[supplier] += clearing × buyerCount
                 ── ALL IN ONE TRANSACTION ──
        │
claim()          buyers pull refunds, supplier pulls proceeds
```

A buyer escrows the tier price live at the moment **they** commit. Everyone settles
at the clearing price the **final** volume unlocked, and the difference comes back.
One price for everybody, and you never pay more than the price you saw.

### Worked example

Curve: **$10 each at 10 buyers, $8 at 25, $6 at 50**. Minimum 10, deadline 48h.
51 buyers commit.

- At 25 buyers the price breaks to **$8**; at 50 it breaks to **$6**
- Clearing price: **$6**
- Buyers 1–25 escrowed $10 → refunded **$4** each
- Buyers 26–50 escrowed $8 → refunded **$2** each
- Buyer 51 escrowed $6 → refunded nothing
- Supplier credited 51 × $6 = **$306**
- Commits in: $510. Refunds out: $204. Supplier: $306. **$306 + $204 = $510.**

Nobody had to trust anybody, and everybody ended up paying the same $6.

> v1 caps unit price at 5 USDC, so the live campaign runs a curve of the same shape
> inside that cap ($1.00 / $0.75 / $0.50). The $10/$8/$6 numbers above are easier to
> read; the mechanism is identical. See [docs/mechanism.md](docs/mechanism.md).

## Tests

19 Foundry tests, all passing, including three fuzz properties at 256 runs each:

```
testFuzz_Conservation   256 runs   supplier credit + refunds == commits, exactly
testFuzz_UniformPrice   256 runs   supplier credit == clearing x buyerCount
testFuzz_NoDeadEnd      256 runs   exactly one of settle/refundAll always succeeds

settle(100 buyers)            1,475,504 gas
withdraw(buyer 50 of 60)         58,088 gas
```

The settlement figure matters because it is the design's one real constraint: v1
caps a deal at 100 buyers so the loop fits in a block, and 1.48M gas shows the cap
has room to spare. The withdrawal figure matters because the strand check walks
tiers rather than buyers — it is flat in buyer count, not linear.

Run them:

```bash
cd onchain && arc-forge test --remappings "@openzeppelin/=node_modules/@openzeppelin/" -vv
```

## The invariant

```
supplier credit + sum(all refunds) == sum(all commits)
supplier credit == clearingPrice(finalCount) * buyerCount
```

Both exactly, to the wei, for any sequence of commits and withdrawals. The first is
solvency; the second is what makes "every buyer settles at one clearing price"
literally true rather than nearly true. They are Foundry fuzz tests, and they are
independently verified outside Solidity:

```
$ node tools/scenarios.mjs
pass  conservation holds over 50000 random sequences  — 0 failures
pass  no sequence strands a buyer  — 0 found
pass  supplier is always credited clearing x buyerCount  — 0 deviations
```

## The one place the spec needed help

The design asks for two things that cannot both hold unconditionally: a buyer
escrows the price live when they commit, *and* a tier can un-break when someone
withdraws. A withdrawal pushes the price back **up**, and the newest buyer escrowed
the *lowest* price — so any un-break leaves them owing more than they ever escrowed.
Settlement then has no solvent move: the refund underflows, `settle()` reverts
permanently, and `refundAll()` also reverts because the deal is still above its
minimum. Every participant's funds are stuck. Fuzzed, that arises in about 0.5% of
random commit/withdraw sequences.

The fix is one precondition, not a redesign: **a withdrawal is refused if it would
leave someone still in the deal below the resulting clearing price.** It binds only
when the buyer count sits exactly on a tier threshold — 1.8% of withdrawal attempts
in fuzzing — and one further commit clears it. Everything else stays as specified,
including `claimable[supplier] += clearing * buyers.length`, so every buyer really
does settle at one shared price.

Three alternatives were weighed and rejected: clamping the clearing price to the
lowest escrow is sybil-exploitable (commit sybils, commit for real at the bottom
tier, withdraw the sybils, and everyone settles at the bottom — the supplier takes
$12.50 instead of $18.75); per-buyer `min(escrowed, clearing)` abandons the
`clearing × buyerCount` formula and the single shared price; uniform top-tier
collateral works but changes what `commit` pulls, which is a bigger change than the
problem requires. All four are reproducible side by side:

```
node tools/scenarios.mjs
```

## Why this needs Arc

| Requirement | On a 12-second chain | On Arc |
|---|---|---|
| Live price as commits land | the displayed price is stale by the time you sign | updates within a second; you watch the tier break happen |
| N-party settlement at one clearing price | a multi-block scramble; partial states are visible and exploitable | 50 buyers settle, overpayments refund and the supplier is paid in **one atomic transaction** |
| All-or-nothing guarantee | partial execution risk if the batch spans blocks | either the whole deal closes or nothing moves |
| Buyer holds one asset | needs a gas token **and** USDC | **USDC is gas** |

Fifty buyers settling at one clearing price with every overpayment refunded has to
be a single atomic transaction. Deterministic sub-second finality is what makes the
mechanism honest rather than merely plausible.

Swarm needs no randomness, which is just as well: `block.prevrandao` is always 0 on
Arc.

## Not a group-buying app

This is **programmable procurement**. Collective purchasing is how small buyers
reach wholesale pricing, and it is almost entirely offline.

**How it differs from Kitty** (the closest round-1 project): Kitty is all-or-nothing
threshold escrow for fundraising — hit the target and the beneficiary is paid, miss
it and everyone is refunded. It has **no price curve, no supplier, and no clearing
price**. Swarm's product *is* the price curve: the amount you pay is determined by
how many other people showed up, and settling the difference across N buyers in one
transaction is the whole mechanism.

## Running the frontend

```bash
cd web
npm install --legacy-peer-deps
npm run dev
```

`--legacy-peer-deps` is required: `vite-plugin-node-polyfills@0.22.0` declares a
peer range of vite ≤5 while this project is on vite 6. The plugin works fine under
vite 6 — the metadata is stale — and the Arc Studio sandbox never hit it because
bun does not enforce peer ranges.

The app reads `VITE_SWARM_NETWORK`, which defaults to `testnet`. It flips to
mainnet only once a verified mainnet deployment is recorded in
[`web/src/swarm/config.ts`](web/src/swarm/config.ts); until then the mainnet
addresses are explicitly zero and the UI refuses to offer a commit against them.

## Contracts

| Contract | Responsibility |
|---|---|
| `DealFactory` | Supplier posts a deal: price curve, minimum, deadline, caps |
| `DemandPool` | Commits, withdrawals, live price, clearing-price calculation |
| `Settler` | Atomic N-party settlement and difference refunds |
| `CommitRelayer` | EIP-3009 gasless commits |

### Deployed addresses

| Contract | Arc Mainnet (5042) | Arc Testnet (5042002) |
|---|---|---|
| `DealFactory` | _pending_ | [`0x97e7B643…7D2212`](https://explorer.testnet.arc.io/address/0x97e7B6431Ad839580A06B1CC5717d68be27D2212) |
| `DemandPool` | _pending_ | [`0xe7860112…C7A70d`](https://explorer.testnet.arc.io/address/0xe7860112eF7fF7a375b33fA703D3B3A38CC7A70d) |
| `Settler` | _pending_ | [`0x2deDA8Fa…6816E8`](https://explorer.testnet.arc.io/address/0x2deDA8Fa1101C42Bc6f36AEEd898A583366816E8) |
| `CommitRelayer` | _pending_ | _pending_ |

Testnet redeployed at block 68,495,162 on 22 October for gasless commits, and wired. The first set (`0x5b646D21…`), which ran the lifecycle in [docs/testnet-lifecycle.md](docs/testnet-lifecycle.md), is retired. Every claim above is checked from
chain rather than taken from a deploy log — `node tools/verify-deploy.mjs` confirms
bytecode, all three owner wiring calls, the constructor links in both directions,
the USDC predeploy address and that the factory is unpaused holding zero escrow.

Chain facts, predeploys and gotchas: [docs/arc-facts.md](docs/arc-facts.md).

## Repo layout

```
docs/arc-facts.md        chain IDs, predeploys, gotchas - verified against live docs
docs/mechanism.md        the spec Studio implements, and defects found in the brief
studio/prompts/          the exact prompts driving each Arc Studio turn
studio/runs/             Studio result documents, kept as provenance
tools/model.mjs          the mechanism as pure integer arithmetic
tools/curve.mjs          economics checker: clearing price, refunds, conservation
tools/scenarios.mjs      edge cases, and why the escrow design changed
tools/proof.mjs          reads chain events into the PROOF.md tables
onchain/                 contracts pulled from Studio
web/                     frontend pulled from Studio
STUDIO.md                how this was built in Arc Studio, turn by turn
PROOF.md                 every mainnet transaction, with hashes
```

## Built with Arc Studio

Contracts, tests and frontend were written in [Arc Studio](https://docs.arc.io/ai/arc-studio).
Turn-by-turn prompts, what Studio got right, and what it got wrong:
[STUDIO.md](STUDIO.md).

## Known limitations

- **Settlement loops over buyers**, so v1 caps a deal at 100. Beyond that
  settlement must page, marking the deal settled only on the final page.
- **Digital goods only.** Nothing onchain can force a supplier to deliver a
  physical item. Supplier reputation via ERC-8004 is the roadmap, not v1.
- The relayer is a hot wallet with a small float, held in env only.

## Roadmap

Paged settlement for large deals · supplier reputation via ERC-8004 · recurring
deals for consumables · opening `DemandPool` as a primitive other Arc apps can call.
