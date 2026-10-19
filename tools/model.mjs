// The Swarm mechanism as pure integer arithmetic, in 6-decimal USDC units.
//
// This is the reference the Solidity must agree with. It is deliberately
// independent of any contract so it can be used to (a) pin expected numbers for
// Foundry tests, (b) fuzz the conservation invariant, and (c) prove or disprove a
// suspected bug before asking Studio to change anything.

export const UNIT = 1_000_000n; // 6 decimals

export const usd = (n) =>
  '$' + (Number(n ?? 0n) / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');

/**
 * Lowest tier price unlocked by a buyer count.
 * tiers: [{minBuyers, price}] — minBuyers strictly ascending, price strictly descending.
 */
export function clearingPrice(tiers, n) {
  let price = tiers[0].price; // highest price, lowest volume
  for (const t of tiers) if (n >= t.minBuyers) price = t.price;
  return price;
}

export function validateCurve(tiers, minBuyers, capPrice = 5n * UNIT, capBuyers = 100) {
  if (tiers.length === 0) throw new Error('curve: no tiers');
  for (let i = 1; i < tiers.length; i++) {
    if (tiers[i].minBuyers <= tiers[i - 1].minBuyers)
      throw new Error(`curve: minBuyers must strictly ascend (tier ${i})`);
    if (tiers[i].price >= tiers[i - 1].price)
      throw new Error(`curve: price must strictly descend (tier ${i})`);
  }
  if (tiers[0].price > capPrice)
    throw new Error(`curve: tier 0 price above the ${usd(capPrice)} v1 cap`);
  if (tiers[0].minBuyers > minBuyers)
    throw new Error('curve: tier 0 unreachable at minBuyers');
  if (tiers.at(-1).minBuyers > capBuyers)
    throw new Error(`curve: last tier needs more than the ${capBuyers}-buyer v1 cap`);
}

/**
 * Replay a commit/withdraw sequence, then settle.
 *
 * ops: [{type:'commit'|'withdraw', who}]
 * opts.pricingPoint:
 *   'after'  — the buyer pays clearingPrice(countIncludingThem).   <- chosen
 *   'before' — the buyer pays clearingPrice(countBeforeThem).
 * opts.clampClearing:
 *   true  — clearing price may not exceed the lowest price actually escrowed.
 *   false — reproduce the unclamped behaviour, to demonstrate the failure.
 */
export function run(tiers, minBuyers, ops, opts = {}) {
  const { pricingPoint = 'after', clampClearing = true, capBuyers = 100 } = opts;

  const paidBy = new Map(); // who -> price escrowed
  const order = [];         // buyer array, as the contract keeps it
  const breaks = [];
  let live = clearingPrice(tiers, 0);

  for (const op of ops) {
    if (op.type === 'commit') {
      if (paidBy.has(op.who)) continue;      // one commit per address
      if (order.length >= capBuyers) continue;
      order.push(op.who);
      const n = pricingPoint === 'after' ? order.length : order.length - 1;
      paidBy.set(op.who, clearingPrice(tiers, n));
    } else {
      if (!paidBy.has(op.who)) continue;
      paidBy.delete(op.who);
      order.splice(order.indexOf(op.who), 1); // swap-and-pop in Solidity
    }
    const next = clearingPrice(tiers, order.length);
    if (next !== live) breaks.push({ at: order.length, from: live, to: next });
    live = next;
  }

  const committed = order.length;
  const totalIn = [...paidBy.values()].reduce((a, b) => a + b, 0n);

  if (committed < minBuyers) {
    return {
      outcome: 'refundAll', committed, totalIn, clearing: null, clamped: false,
      supplierCredit: 0n, refunds: new Map(paidBy), breaks, order, paidBy,
    };
  }

  const tierPrice = clearingPrice(tiers, committed);
  const lowestEscrowed = [...paidBy.values()].reduce((a, b) => (b < a ? b : a));

  // A withdrawal can push the volume-unlocked price back UP, above what a late
  // buyer escrowed. The contract cannot charge a buyer more after the fact, so
  // settlement can never clear above the lowest price actually escrowed.
  const clearing = clampClearing && lowestEscrowed < tierPrice ? lowestEscrowed : tierPrice;
  const clamped = clearing !== tierPrice;

  const refunds = new Map();
  let underwater = null;
  for (const who of order) {
    const paid = paidBy.get(who);
    if (paid < clearing) underwater = { who, paid, clearing }; // would underflow in Solidity
    if (paid > clearing) refunds.set(who, paid - clearing);
  }

  return {
    outcome: 'settle', committed, totalIn, clearing, clamped, tierPrice, underwater,
    supplierCredit: clearing * BigInt(committed), refunds, breaks, order, paidBy,
  };
}

export function conservation(r) {
  const refundTotal = [...r.refunds.values()].reduce((a, b) => a + b, 0n);
  return {
    ok: r.supplierCredit + refundTotal === r.totalIn,
    refundTotal,
    lhs: r.supplierCredit + refundTotal,
    rhs: r.totalIn,
  };
}

export const parseCurve = (s) =>
  s.split(',').map((part) => {
    const [n, p] = part.split(':');
    return { minBuyers: Number(n), price: BigInt(Math.round(Number(p) * 1e6)) };
  });
