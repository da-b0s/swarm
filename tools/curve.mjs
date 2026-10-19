#!/usr/bin/env node
// Swarm economics checker — the model lives in model.mjs; this is the CLI.
//
//   node curve.mjs                                        # the real campaign curve
//   node curve.mjs --fuzz 20000                           # conservation under fuzz
//   node curve.mjs --curve 10:10,25:8,50:6 --cap 10       # the brief's illustration
//
// NOTE: the brief's worked example ($10/$8/$6) cannot be posted under the brief's
// own v1 rules — it caps unit price at 5 USDC, and 51 buyers at $10 is $456 of
// escrow against a $15-25 working-capital budget. Treat $10/$8/$6 as an
// illustration for the write-up and run the campaign on a curve inside the cap.

import { run, conservation, validateCurve, parseCurve, usd, UNIT } from './model.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i === -1 ? d : argv[i + 1]; };

const tiers = parseCurve(arg('--curve', '10:1,25:0.75,50:0.5'));
const minBuyers = Number(arg('--min', '10'));
const capPrice = BigInt(Math.round(Number(arg('--cap', '5')) * 1e6));
const capBuyers = Number(arg('--cap-buyers', '100'));
validateCurve(tiers, minBuyers, capPrice, capBuyers);

if (argv.includes('--fuzz')) {
  const runs = Number(arg('--fuzz', '10000'));
  let failures = 0, clamped = 0, worst = null;
  for (let i = 0; i < runs; i++) {
    const ops = [];
    const n = 1 + Math.floor(Math.random() * capBuyers);
    for (let b = 0; b < n; b++) {
      ops.push({ type: 'commit', who: `b${b}` });
      if (Math.random() < 0.12 && b > 0)
        ops.push({ type: 'withdraw', who: `b${Math.floor(Math.random() * b)}` });
    }
    const r = run(tiers, minBuyers, ops, { capBuyers });
    if (r.clamped) clamped++;
    const c = conservation(r);
    if (!c.ok) { failures++; worst = { r, c }; }
  }
  console.log(`fuzz: ${runs} random sequences (commits interleaved with withdrawals)`);
  console.log(`clearing-price clamp engaged in ${clamped} of them`);
  console.log(`conservation failures: ${failures}`);
  if (failures) { console.error('INVARIANT BROKEN', worst.c); process.exit(1); }
  console.log('invariant holds: supplier credit + refunds == sum of commits, exactly');
  process.exit(0);
}

const buyers = Number(arg('--buyers', '51'));
const ops = Array.from({ length: buyers }, (_, i) => ({ type: 'commit', who: `b${i}` }));
const r = run(tiers, minBuyers, ops, { capBuyers });
const c = conservation(r);

console.log(`curve      ${tiers.map((t) => `${t.minBuyers}@${usd(t.price)}`).join('  ')}`);
console.log(`min buyers ${minBuyers}`);
console.log(`committed  ${r.committed}`);
console.log(`outcome    ${r.outcome}`);
if (r.clearing !== null) console.log(`clearing   ${usd(r.clearing)}`);
console.log(`tier breaks ${r.breaks.map((b) => `@${b.at}: ${usd(b.from)}->${usd(b.to)}`).join('  ') || 'none'}`);
console.log('');

// grouped by refund size — this is the table that goes in the write-up
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
