#!/usr/bin/env node
// Edge-case scenarios the Solidity must survive, and the record of why the
// escrow mechanism changed from the brief's wording.
//
//   node scenarios.mjs
//
// The brief says commit() "escrows the CURRENT tier price". That cannot coexist
// with withdrawals that un-break a tier, for three independent reasons proved
// below. Swarm therefore collateralizes every buyer at the TOP tier price and
// refunds down to the clearing price at settlement.

import { run, conservation, clearingPrice, parseCurve, usd } from './model.mjs';

const CURVE = parseCurve('10:1,25:0.75,50:0.5');
const MIN = 10;
const TOP = CURVE[0].price;

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'pass' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};

const commits = (n, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ type: 'commit', who: `b${from + i}` }));
const withdraws = (n, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ type: 'withdraw', who: `b${from + i}` }));

console.log('\n— the chosen mechanism: top-tier collateral —————————————\n');

{
  const r = run(CURVE, MIN, commits(51));
  const c = conservation(r);
  const refundSizes = new Set([...r.refunds.values()].map(String));
  check('51 buyers clear at the lowest tier', r.clearing === 500_000n, `clearing ${usd(r.clearing)}`);
  check('every buyer escrowed the top tier', [...r.paidBy.values()].every((p) => p === TOP),
    `all ${usd(TOP)}`);
  check('every refund is identical', refundSizes.size === 1,
    `all ${usd(r.refunds.values().next().value)}`);
  check('conservation exact', c.ok, `${usd(c.lhs)} == ${usd(c.rhs)}`);
  console.log(`      supplier ${usd(r.supplierCredit)}, refunds ${usd(c.refundTotal)}, commits ${usd(r.totalIn)}`);
  console.log(`      a single price for every buyer, unconditionally`);
}

{
  const r = run(CURVE, MIN, commits(25));
  check('buyer 25 breaks tier 2', clearingPrice(CURVE, 25) === 750_000n,
    `live price at 25 buyers ${usd(clearingPrice(CURVE, 25))}`);
  check('24 buyers is still tier 1', clearingPrice(CURVE, 24) === 1_000_000n,
    `live price at 24 buyers ${usd(clearingPrice(CURVE, 24))}`);
  check('escrow is unaffected by the boundary', [...r.paidBy.values()].every((p) => p === TOP));
}

{
  const r = run(CURVE, MIN, commits(9));
  check('below the minimum refunds everyone in full', r.outcome === 'refundAll' &&
    [...r.refunds.values()].reduce((a, b) => a + b, 0n) === r.totalIn);
  check('supplier gets nothing on a failed deal', r.supplierCredit === 0n);
}

{
  const r = run(CURVE, MIN, commits(10));
  check('exactly at the minimum settles at tier 1', r.outcome === 'settle' && r.clearing === TOP,
    `clearing ${usd(r.clearing)}`);
  check('refunds are zero when clearing is the top tier',
    [...r.refunds.values()].every((v) => v === 0n) || r.refunds.size === 0);
}

console.log('\n— withdrawals, which must stay unrestricted ————————————\n');

{
  const r = run(CURVE, MIN, [...commits(25), ...withdraws(1)]);
  check('a withdrawal un-breaks a tier', clearingPrice(CURVE, r.committed) === 1_000_000n,
    `24 buyers -> live price ${usd(clearingPrice(CURVE, r.committed))}`);
  check('conservation still exact', conservation(r).ok);
}

{
  // The sequence that bricks commit-time escrow. Under top-tier collateral it is
  // unremarkable: the price went up, everyone had already locked the top tier.
  const ops = [...commits(50), ...withdraws(25)];
  const r = run(CURVE, MIN, ops);
  const c = conservation(r);
  check('the squeeze sequence settles normally', r.outcome === 'settle' && !r.clamped,
    `25 buyers, cleared at ${usd(r.clearing)}`);
  check('nobody is underwater, by construction', r.underwater === null);
  check('conservation exact', c.ok, `${usd(c.lhs)} == ${usd(c.rhs)}`);
}

console.log('\n— why commit-time escrow was rejected ——————————————————\n');

{
  const ops = [...commits(50), ...withdraws(25)];

  // Reason 1: unclamped, it underflows and locks every participant's funds.
  const unclamped = run(CURVE, MIN, ops, { escrow: 'commitTime', clampClearing: false });
  check('reason 1 — an underwater buyer appears', unclamped.underwater !== null,
    unclamped.underwater
      ? `${unclamped.underwater.who} escrowed ${usd(unclamped.underwater.paid)}, clearing ${usd(unclamped.underwater.clearing)}`
      : 'none');
  check('reason 1 — settlement is insolvent', !conservation(unclamped).ok,
    `short by ${usd(conservation(unclamped).lhs - conservation(unclamped).rhs)}`);
  console.log('      in Solidity `paid - clearing` underflows, settle() reverts forever,');
  console.log('      refundAll() also reverts for being above the minimum: funds locked.');

  // Reason 2: clamping keeps one price but hands a coalition a lever.
  const clamped = run(CURVE, MIN, ops, { escrow: 'commitTime', clampClearing: true });
  const honest = run(CURVE, MIN, commits(25), { escrow: 'commitTime' });
  check('reason 2 — clamping is solvent', conservation(clamped).ok);
  check('reason 2 — but a coalition cuts the supplier\'s take',
    clamped.supplierCredit < honest.supplierCredit,
    `25 honest buyers pay the supplier ${usd(honest.supplierCredit)}; ` +
    `the same 25 after a mass withdrawal pay ${usd(clamped.supplierCredit)}`);
  console.log('      commit late at the bottom tier, mass-withdraw, and the clamp drags');
  console.log('      settlement to the bottom tier for everyone at the supplier\'s cost.');

  // Reason 3: the gasless race. Stated here because it is not expressible as a
  // sequence replay - an EIP-3009 authorization is signed for a fixed amount, so
  // a live price that moves between signing and relaying invalidates it.
  console.log('      reason 3 — an EIP-3009 authorization signed at one tier price goes');
  console.log('      stale when the price falls before the relayer submits. Fixed');
  console.log('      collateral cannot race; a moving commit price can.');
}

console.log('\n— fuzz ————————————————————————————————————————————————\n');

{
  let broke = 0, underwater = 0;
  const runs = 50_000;
  for (let i = 0; i < runs; i++) {
    const ops = [];
    const n = 1 + Math.floor(Math.random() * 100);
    for (let b = 0; b < n; b++) {
      ops.push({ type: 'commit', who: `b${b}` });
      if (Math.random() < 0.25 && b > 0)
        ops.push({ type: 'withdraw', who: `b${Math.floor(Math.random() * b)}` });
    }
    const r = run(CURVE, MIN, ops);
    if (r.underwater) underwater++;
    if (!conservation(r).ok) broke++;
  }
  check(`conservation holds over ${runs} random sequences`, broke === 0, `${broke} failures`);
  check('no sequence can produce an underwater buyer', underwater === 0, `${underwater} found`);
}

console.log('');
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('all scenarios pass');
