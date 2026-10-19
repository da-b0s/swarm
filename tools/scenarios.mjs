#!/usr/bin/env node
// Edge-case scenarios the Solidity must survive. Each one states what it proves.
//
//   node scenarios.mjs
//
// These exist because the mechanism has one genuinely non-obvious failure mode:
// a withdrawal raises the live price, which can leave an earlier-committed buyer
// having escrowed LESS than the final clearing price. Settlement then tries to
// refund a negative amount. In Solidity 0.8 that underflow reverts, and because
// the deal no longer qualifies for refundAll either, every participant's funds
// are stuck. It is reachable through the withdraw path the brief explicitly
// requires ("a tier must be able to un-break").

import { run, conservation, clearingPrice, parseCurve, usd } from './model.mjs';

const CURVE = parseCurve('10:1,25:0.75,50:0.5');
const MIN = 10;

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'pass' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};

const commits = (n, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ type: 'commit', who: `b${from + i}` }));

console.log('\n— pricing and clearing ————————————————————————————————\n');

{
  const r = run(CURVE, MIN, commits(51));
  const c = conservation(r);
  const groups = new Map();
  for (const w of r.order) groups.set(r.paidBy.get(w), (groups.get(r.paidBy.get(w)) ?? 0) + 1);
  check('51 buyers clear at the lowest tier', r.clearing === 500_000n, `clearing ${usd(r.clearing)}`);
  check('conservation exact', c.ok, `${usd(c.lhs)} == ${usd(c.rhs)}`);
  console.log(`      paid split: ${[...groups].map(([p, n]) => `${n}@${usd(p)}`).join(', ')}`);
  console.log(`      supplier ${usd(r.supplierCredit)}, refunds ${usd(c.refundTotal)}, commits ${usd(r.totalIn)}`);
}

{
  // The boundary the brief calls out: "buyer 25 exactly triggers tier 2".
  const r = run(CURVE, MIN, commits(25));
  check('buyer 25 triggers tier 2 and pays it', r.paidBy.get('b24') === 750_000n,
    `buyer 25 paid ${usd(r.paidBy.get('b24'))}`);
  check('buyer 24 paid tier 1', r.paidBy.get('b23') === 1_000_000n,
    `buyer 24 paid ${usd(r.paidBy.get('b23'))}`);
}

{
  const r = run(CURVE, MIN, commits(9));
  check('below the minimum refunds everyone in full', r.outcome === 'refundAll' &&
    [...r.refunds.values()].reduce((a, b) => a + b, 0n) === r.totalIn);
  check('supplier gets nothing on a failed deal', r.supplierCredit === 0n);
}

{
  const r = run(CURVE, MIN, commits(10));
  check('exactly at the minimum settles at tier 1', r.outcome === 'settle' && r.clearing === 1_000_000n,
    `clearing ${usd(r.clearing)}`);
}

console.log('\n— withdrawals ————————————————————————————————————————\n');

{
  // 25 commits break tier 2; one withdraws; the tier un-breaks.
  const ops = [...commits(25), { type: 'withdraw', who: 'b0' }];
  const r = run(CURVE, MIN, ops);
  check('a withdrawal un-breaks a tier', clearingPrice(CURVE, r.committed) === 1_000_000n,
    `24 buyers -> live price ${usd(clearingPrice(CURVE, r.committed))}`);
  check('conservation still exact after a withdrawal', conservation(r).ok);
}

console.log('\n— the squeeze: withdrawals above a late buyer\'s escrow ———\n');

{
  // 50 buyers commit, so the last of them escrows the $0.50 bottom tier.
  // Then 25 of the earliest withdraw. Volume falls to 25, so the volume-unlocked
  // price climbs back to $0.75 — ABOVE the $0.50 that the late buyers escrowed.
  const ops = [...commits(50), ...Array.from({ length: 25 }, (_, i) => ({ type: 'withdraw', who: `b${i}` }))];

  const unclamped = run(CURVE, MIN, ops, { clampClearing: false });
  check('the squeeze is reachable', unclamped.committed === 25,
    `${unclamped.committed} buyers remain, tier price ${usd(unclamped.tierPrice)}`);
  check('an underwater buyer exists (paid < clearing)', unclamped.underwater !== null,
    unclamped.underwater
      ? `${unclamped.underwater.who} escrowed ${usd(unclamped.underwater.paid)} but clearing is ${usd(unclamped.underwater.clearing)}`
      : 'none');
  const cu = conservation(unclamped);
  check('UNCLAMPED settlement breaks conservation', !cu.ok,
    `supplier+refunds ${usd(cu.lhs)} vs commits ${usd(cu.rhs)} — short by ${usd(cu.lhs - cu.rhs)}`);
  console.log('      in Solidity, `paid - clearing` underflows here and settle() reverts');
  console.log('      forever; refundAll() also reverts because the deal is above its');
  console.log('      minimum, so every participant\'s escrow is stuck. Fund-locking.');

  const clamped = run(CURVE, MIN, ops, { clampClearing: true });
  const cc = conservation(clamped);
  check('CLAMPED settlement is solvent', cc.ok, `${usd(cc.lhs)} == ${usd(cc.rhs)}`);
  check('clamp engaged', clamped.clamped,
    `tier price ${usd(clamped.tierPrice)} -> cleared at ${usd(clamped.clearing)}`);
  check('no buyer is underwater after clamping', clamped.underwater === null);
}

console.log('\n— fuzz ————————————————————————————————————————————————\n');

{
  let broke = 0, squeezes = 0;
  const runs = 50_000;
  for (let i = 0; i < runs; i++) {
    const ops = [];
    const n = 1 + Math.floor(Math.random() * 100);
    for (let b = 0; b < n; b++) {
      ops.push({ type: 'commit', who: `b${b}` });
      if (Math.random() < 0.25 && b > 0)
        ops.push({ type: 'withdraw', who: `b${Math.floor(Math.random() * b)}` });
    }
    const r = run(CURVE, MIN, ops, { clampClearing: true });
    if (r.clamped) squeezes++;
    if (!conservation(r).ok) broke++;
  }
  check(`conservation holds over ${runs} random sequences`, broke === 0, `${broke} failures`);
  console.log(`      the squeeze arose naturally in ${squeezes} of ${runs} sequences ` +
    `(${(squeezes / runs * 100).toFixed(1)}%) — not a corner case`);
}

console.log('');
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('all scenarios pass');
