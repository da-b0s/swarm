#!/usr/bin/env node
// Swarm economics sanity checker.
//
// Models the clearing-price mechanism in integer 6-decimal USDC units, exactly
// as the contract must, and asserts the conservation invariant:
//
//     supplier credit + all refunds == sum of all commits
//
// Use it to (a) pin the expected numbers for Foundry test 1 before Studio
// writes it, and (b) prove a curve is sane before posting a real deal.
//
//   node tools/curve.mjs                          # the real campaign curve
//   node tools/curve.mjs --fuzz 20000             # random sequences, conservation
//   node tools/curve.mjs --curve 10:10,25:8,50:6 --cap 10   # the blueprint's illustration
//
// NOTE: the blueprint's worked example ($10/$8/$6) cannot be posted under the
// blueprint's own v1 rules - it caps unit price at 5 USDC, and 51 buyers at $10
// is $510 of escrow against a $15-25 working-capital budget. Treat $10/$8/$6 as
// an illustration for the write-up and run the campaign on a curve inside the cap.

const UNIT = 1_000_000n; // 6 decimals
const usd = (n) => `$${(Number(n) / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;

/** tiers: [{minBuyers, price}] ascending minBuyers, descending price */
function clearingPrice(tiers, n) {
  let price = tiers[0].price; // highest price, lowest volume
  for (const t of tiers) if (n >= t.minBuyers) price = t.price;
  return price;
}

function validateCurve(tiers, minBuyers, capPrice = 5n * UNIT, capBuyers = 100) {
  if (tiers.length === 0) throw new Error('curve: no tiers');
  for (let i = 1; i < tiers.length; i++) {
    if (tiers[i].minBuyers <= tiers[i - 1].minBuyers)
      throw new Error(`curve: minBuyers must strictly ascend (tier ${i})`);
    if (tiers[i].price >= tiers[i - 1].price)
      throw new Error(`curve: price must strictly descend (tier ${i})`);
  }
  if (tiers[0].price > capPrice) throw new Error(`curve: tier 0 price above the ${usd(capPrice)} v1 cap`);
  if (tiers[0].minBuyers > minBuyers) throw new Error('curve: tier 0 unreachable at minBuyers');
  if (tiers.at(-1).minBuyers > capBuyers) throw new Error(`curve: last tier needs more than the ${capBuyers}-buyer v1 cap`);
}

/**
 * Replay a commit/withdraw sequence and settle.
 * ops: array of {type:'commit'|'withdraw', who:string}
 */
function run(tiers, minBuyers, ops) {
  const paidBy = new Map();   // who -> price paid at commit time
  const order = [];           // buyer array, as the contract keeps it
  const breaks = [];
  let live = clearingPrice(tiers, 0);

  for (const op of ops) {
    if (op.type === 'commit') {
      if (paidBy.has(op.who)) continue;            // one commit per address
      if (order.length >= 100) continue;           // v1 cap
      const price = clearingPrice(tiers, order.length); // CURRENT tier price
      paidBy.set(op.who, price);
      order.push(op.who);
    } else {
      if (!paidBy.has(op.who)) continue;
      paidBy.delete(op.who);
      order.splice(order.indexOf(op.who), 1);      // swap-and-pop in Solidity
    }
    const next = clearingPrice(tiers, order.length);
    if (next !== live) breaks.push({ at: order.length, from: live, to: next });
    live = next;
  }

  const committed = order.length;
  const totalIn = [...paidBy.values()].reduce((a, b) => a + b, 0n);

  if (committed < minBuyers) {
    const refunds = new Map([...paidBy]);          // full refund
    return { outcome: 'refundAll', committed, totalIn, clearing: null,
             supplierCredit: 0n, refunds, breaks, order, paidBy };
  }

  const clearing = clearingPrice(tiers, committed);
  const refunds = new Map();
  for (const who of order) {
    const paid = paidBy.get(who);
    if (paid > clearing) refunds.set(who, paid - clearing);
  }
  const supplierCredit = clearing * BigInt(committed);
  return { outcome: 'settle', committed, totalIn, clearing, supplierCredit,
           refunds, breaks, order, paidBy };
}

function conservation(r) {
  const refundTotal = [...r.refunds.values()].reduce((a, b) => a + b, 0n);
  return { ok: r.supplierCredit + refundTotal === r.totalIn,
           refundTotal, lhs: r.supplierCredit + refundTotal, rhs: r.totalIn };
}

// ---------- CLI ----------
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i === -1 ? d : argv[i + 1]; };

const parseCurve = (s) => s.split(',').map((part) => {
  const [n, p] = part.split(':');
  return { minBuyers: Number(n), price: BigInt(Math.round(Number(p) * 1e6)) };
});

const tiers = parseCurve(arg('--curve', '10:1,25:0.75,50:0.5'));
const minBuyers = Number(arg('--min', '10'));
const capPrice = BigInt(Math.round(Number(arg('--cap', '5')) * 1e6));
const capBuyers = Number(arg('--cap-buyers', '100'));
validateCurve(tiers, minBuyers, capPrice, capBuyers);

if (argv.includes('--fuzz')) {
  const runs = Number(arg('--fuzz', '10000'));
  let worst = null, failures = 0;
  for (let i = 0; i < runs; i++) {
    const ops = [];
    const n = 1 + Math.floor(Math.random() * 100);
    for (let b = 0; b < n; b++) {
      ops.push({ type: 'commit', who: `b${b}` });
      // ~12% chance of a withdrawal somewhere behind us
      if (Math.random() < 0.12 && b > 0)
        ops.push({ type: 'withdraw', who: `b${Math.floor(Math.random() * b)}` });
    }
    const r = run(tiers, minBuyers, ops);
    const c = conservation(r);
    if (!c.ok) { failures++; worst = { r, c, ops }; }
  }
  console.log(`fuzz: ${runs} random sequences (commits interleaved with withdrawals)`);
  console.log(`conservation failures: ${failures}`);
  if (failures) { console.error('INVARIANT BROKEN', worst.c); process.exit(1); }
  console.log('invariant holds: supplier credit + refunds == sum of commits, exactly');
  process.exit(0);
}

const buyers = Number(arg('--buyers', '51'));
const ops = Array.from({ length: buyers }, (_, i) => ({ type: 'commit', who: `b${i}` }));
const r = run(tiers, minBuyers, ops);
const c = conservation(r);

console.log(`curve      ${tiers.map((t) => `${t.minBuyers}@${usd(t.price)}`).join('  ')}`);
console.log(`min buyers ${minBuyers}`);
console.log(`committed  ${r.committed}`);
console.log(`outcome    ${r.outcome}`);
if (r.clearing !== null) console.log(`clearing   ${usd(r.clearing)}`);
console.log(`tier breaks ${r.breaks.map((b) => `@${b.at}: ${usd(b.from)}->${usd(b.to)}`).join('  ') || 'none'}`);
console.log('');

// group buyers by refund size - this is the table that goes in the write-up
const groups = new Map();
for (const who of r.order) {
  const amt = r.refunds.get(who) ?? 0n;
  groups.set(amt, (groups.get(amt) ?? 0) + 1);
}
console.log('refund distribution');
for (const [amt, count] of [...groups].sort((a, b) => Number(b[0] - a[0])))
  console.log(`  ${String(count).padStart(3)} buyers  refunded ${usd(amt)}`);

console.log('');
console.log(`supplier credit  ${usd(r.supplierCredit)}  (${usd(r.clearing ?? 0n)} x ${r.committed})`);
console.log(`refunds total    ${usd(c.refundTotal)}`);
console.log(`commits total    ${usd(r.totalIn)}`);
console.log(`conservation     ${c.ok ? 'OK, exact' : 'BROKEN'}  ${usd(c.lhs)} == ${usd(c.rhs)}`);
console.log('');
console.log(`peak escrow      ${usd(r.totalIn)}  <- working capital the deal must absorb`);
console.log(`mainnet txs from this deal  ~${r.committed} commits + ${r.refunds.size} refund claims + 1 settle + 1 supplier claim = ${r.committed + r.refunds.size + 2}`);
if (!c.ok) process.exit(1);
