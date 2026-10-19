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
commit(dealId)        buyer escrows the TOP tier price as collateral
        │             live price recomputed → everyone sees the tier break
        │
withdraw(dealId)      exit before deadline; a tier can UN-break
        │
   at deadline:
     committed <  minBuyers  →  refundAll()   every buyer whole, nothing ships
     committed >= minBuyers  →  settle()
        │
settle(dealId)   clearing = lowest tier price unlocked by final volume
                 every buyer: claimable[b] += collateral − clearing
                 claimable[supplier] += clearing × buyerCount
                 ── ALL IN ONE TRANSACTION ──
        │
claim()          buyers pull refunds, supplier pulls proceeds
```

Every buyer locks up the **same** collateral — the highest price on the curve —
whenever they commit. Everyone settles at the clearing price the **final** volume
unlocked, and the difference comes back. One price for everybody,
unconditionally; see [why collateral](#why-collateral-and-not-pay-as-you-commit).

### Worked example

Curve: **$10 each at 10 buyers, $8 at 25, $6 at 50**. Minimum 10, deadline 48h.
51 buyers commit.

- Every buyer escrows **$10**, the top of the curve, whenever they join
- At 25 buyers the price breaks to **$8**; at 50 it breaks to **$6**
- Clearing price: **$6**
- Every buyer refunded **$4** — the same amount for all 51
- Supplier credited 51 × $6 = **$306**
- Commits in: $510. Refunds out: $204. Supplier: $306. **$306 + $204 = $510.**

Nobody had to trust anybody, and nobody paid a different price from anybody else.

> v1 caps unit price at 5 USDC, so the live campaign runs a curve of the same shape
> inside that cap ($1.00 / $0.75 / $0.50). The $10/$8/$6 numbers above are easier to
> read; the mechanism is identical. See [docs/mechanism.md](docs/mechanism.md).

## The invariant

```
supplier credit + sum(all refunds) == sum(all commits)
```

Exactly, to the wei, for any sequence of commits and withdrawals. It is a Foundry
fuzz test, and it is independently verified outside Solidity:

```
$ node tools/curve.mjs --fuzz 20000
conservation failures: 0
invariant holds: supplier credit + refunds == sum of commits, exactly
```

## Why collateral, and not pay-as-you-commit

The obvious design is to escrow whatever the price is when you commit. It does not
survive contact with the withdrawal rule.

A withdrawal lowers volume, so the live price goes back **up**. A buyer who
committed while volume was high escrowed a **low** price — and can end up owing
more at settlement than they ever escrowed. Nothing can compel them to top up
after the fact, so settlement has no solvent move: the natural `paid − clearing`
refund underflows, `settle()` reverts permanently, and `refundAll()` also reverts
because the deal is still above its minimum. Every participant's funds are stuck.
Fuzzing random commit/withdraw sequences, that state arises in about **0.5%** of
them.

Patching it per-buyer (`min(escrowed, clearing)`) is solvent but means different
buyers pay different amounts, which forfeits the single-clearing-price property
this whole design rests on. Clamping the clearing price down to the lowest escrow
keeps one price but hands a coalition a lever: commit at the bottom tier,
mass-withdraw, and drag settlement to the bottom for everyone at the supplier's
expense.

Uniform top-tier collateral removes the failure instead of handling it. Nobody can
be underwater, so the clearing price is always affordable, every refund is
identical, withdrawals need no restrictions, and the invariant is trivially exact:

```
collateral × n  ==  clearing × n  +  (collateral − clearing) × n
```

It also removes a race in gasless commits: an EIP-3009 authorization is signed for
a fixed amount, so a commit price that moves between signing and relaying would
invalidate it. Fixed collateral cannot race.

The reasoning and all three rejected alternatives are reproducible:
`node tools/scenarios.mjs`.

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
| `DealFactory` | _pending_ | _pending_ |
| `DemandPool` | _pending_ | _pending_ |
| `Settler` | _pending_ | _pending_ |
| `CommitRelayer` | _pending_ | _pending_ |

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
