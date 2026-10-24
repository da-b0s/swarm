# Swarm v2 — quantities and token delivery

Decided 24 October 2026. Supersedes the one-unit-per-buyer, off-chain-delivery
design in [mechanism.md](mechanism.md) wherever they differ. Everything not
mentioned here — pull payments, the strand rule's purpose, conservation, the
gasless design — carries over unchanged in spirit.

## What changes, in one paragraph

A supplier sells an ERC-20 token. Posting a deal **deposits the stock** into the
contract. Buyers order a **quantity of units**, and the price tiers count **total
units ordered**, not buyers. At settlement, in one transaction, every buyer is
credited their tokens and their refund, the supplier is credited the USDC and any
unsold stock. If the minimum is missed, buyers get their USDC back and the supplier
gets all the stock back. Nobody has to trust anybody to deliver.

## Deal

| Field | Type | Meaning |
|---|---|---|
| `supplier` | address | poster |
| `goodsToken` | address | the ERC-20 being sold |
| `tokensPerUnit` | uint256 | token base units delivered per unit bought (1 for a 0-decimal pass; 1e6 for one EURC) |
| `tiers` | `(uint32 minUnits, uint64 pricePerUnit)[]` | the curve, in units and 6-decimal USDC per unit |
| `minUnits` | uint32 | deal minimum, in units; below this at the deadline, everyone is refunded |
| `maxUnits` | uint32 | stock: units deposited and the most that can be sold |
| `maxUnitsPerBuyer` | uint32 | 0 = no limit |
| `maxBuyers` | uint32 | 1–100; bounds the settlement loop |
| `deadline` | uint64 | unix seconds, compared with `block.timestamp` |
| `state` | uint8 | 0 open, 1 settled, 2 refunded |
| `title` | string | at most 80 bytes |
| `description` | string | at most 500 bytes |

## Posting — `postDeal(...)`

Validation, every rule as a named error:

- at least one tier and at most 10;
- `pricePerUnit` > 0 and ≤ 5 USDC (5_000_000) on every tier;
- `minUnits` strictly ascending across tiers, `pricePerUnit` strictly descending;
- `tiers[0].minUnits` ≤ `minUnits`; `minUnits` ≥ 1; `minUnits` ≤ `maxUnits`;
- last tier's `minUnits` ≤ `maxUnits` (the cheapest tier is reachable);
- `maxBuyers` between 1 and 100; `maxUnitsPerBuyer` is 0 or ≤ `maxUnits`;
- `tokensPerUnit` > 0; `goodsToken` is not zero and not USDC;
- `deadline` in the future; title ≤ 80 bytes, description ≤ 500 bytes, title non-empty.

Then the stock is deposited: `maxUnits × tokensPerUnit` of `goodsToken` is pulled
from the supplier with `transferFrom` into the contract that holds the goods. The
contract **measures its balance before and after** and reverts `UnsupportedToken`
unless it received exactly that amount — this rejects fee-on-transfer and rebasing
tokens, whose accounting would otherwise be wrong. Goods custody is tracked per
deal.

## Price

`priceAt(units)` = the `pricePerUnit` of the highest tier whose `minUnits` ≤
`units`, or `tiers[0].pricePerUnit` below the first threshold. This is the same
function as v1 with buyers replaced by units. The live price is
`priceAt(totalUnits)`.

## Ordering — `commit(dealId, units)`

Preconditions as v1 (settler wired, deal open, before deadline, not paused, not
already ordered), plus: `units` ≥ 1; `units` ≤ `maxUnitsPerBuyer` when set;
`totalUnits + units` ≤ `maxUnits`; buyers < `maxBuyers`.

The buyer pays the price **including their own order**:

    paidPerUnit = priceAt(totalUnits + units)
    escrow      = paidPerUnit × units

so an order large enough to break a tier is charged the lower price it unlocks.
Record `unitsOf[buyer]`, `paidPerUnit[buyer]`, and the per-price buyer tally used by
the strand check. Emit `Committed(dealId, buyer, units, paidPerUnit, escrow,
livePrice, totalUnits, buyerCount)`, and `TierBroken` when the live price moves.

One order per buyer. No adding to an order in v2.

## Withdrawing — `withdraw(dealId)`

Removes the whole order. The strand rule is unchanged in meaning: **refuse if,
after this order leaves, any remaining buyer's `paidPerUnit` would be below the new
live price** `priceAt(totalUnits − unitsOf[caller])`. The per-price tally works as
before, because it counts buyers by the per-unit price they paid; only the argument
to `priceAt` is now units. The full escrow is credited back to claimable.

## Settlement — `settle(dealId)`

After the deadline, if `totalUnits` ≥ `minUnits`:

    cp = priceAt(totalUnits)
    for each buyer:
        usdc claimable  += unitsOf × (paidPerUnit − cp)        refund
        goods claimable += unitsOf × tokensPerUnit              delivery
    supplier usdc claimable  += cp × totalUnits
    supplier goods claimable += (maxUnits − totalUnits) × tokensPerUnit   unsold stock

Conservation, checked in the transaction with a named error, in both assets:

    Σ escrow                       == cp × totalUnits + Σ refunds
    maxUnits × tokensPerUnit       == Σ delivered + unsold

`paidPerUnit ≥ cp` always holds, because prices only fall with volume and the strand
rule stops a withdrawal from raising the price above anyone's paid price — so the
refund subtraction cannot underflow. Emit `Settled(dealId, cp, totalUnits,
buyerCount, totalRefunds, unitsDelivered)`.

## Refund — `refundAll(dealId)`

After the deadline, if `totalUnits` < `minUnits`: every buyer's full escrow to USDC
claimable, and the supplier's whole stock `maxUnits × tokensPerUnit` to goods
claimable. A deal nobody ordered from also ends here, returning the stock.

## Claims

`claim()` pulls USDC as now. `claimGoods(token)` pulls a token balance. Both are pull
payments, so a blocklisted or reverting recipient cannot block anyone else.

## Gasless — `commitWithAuthorization`

As v1, with `units` added. The buyer authorizes `priceAt(totalUnits + units) ×
units` as seen on screen. The authorization nonce binds the quantity too:

    nonce = keccak256(abi.encode(pool, dealId, buyer, units, salt))

so a relayer cannot change how many units a signature buys. If the price has
fallen, the excess is credited back exactly as in v1; if it has risen,
`PriceRoseBeyondAuthorization(newTotal)` carries the new **total**, not the per-unit
price.

## Swarm Pass

`SwarmPass` is the demo good: an OpenZeppelin ERC-20, name "Swarm Pass", symbol
"PASS", **0 decimals**, so one token is one pass and `tokensPerUnit` is 1. Its
constructor takes `bool faucetEnabled`. When enabled, `faucet()` mints 100 passes to
the caller, at most once per address per day, so anyone can try being a supplier on
testnet. Deployed with the faucet **on** for testnet and **off** for mainnet, where
passes are minted by the owner. No `block.chainid` checks.

## Bounds

`maxBuyers` ≤ 100 keeps settlement's loop inside a block, as in v1; the goods credit
adds one storage write per buyer, so `settle` at 100 buyers must be measured again
and stay well below the block gas limit.
