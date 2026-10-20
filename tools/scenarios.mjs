#!/usr/bin/env node
// Edge-case scenarios the Solidity must survive, and the record of how the
// brief's own specification was made solvent.
//
//   node scenarios.mjs
//
// The brief asks for two things that cannot both hold unconditionally:
//
//   commit(dealId)   escrows the CURRENT tier price
//   withdraw(dealId) ... a tier must be able to un-break
//
// Any un-break raises the clearing price above what the newest buyer escrowed,
// so settlement would ask them for money they never locked up. The resolution
// keeps BOTH sentences and adds a precondition to withdrawal: a buyer may not
// exit if their exit would leave someone still in the deal below the new
// clearing price. Everything else in the brief stays exactly as written,
// including `claimable[supplier] += clearing * buyers.length`.

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
const wd = (who) => ({ type: 'withdraw', who });

console.log('\n— the brief\'s mechanism, as specified ——————————————————\n');

{
  const r = run(CURVE, MIN, commits(51));
  const c = conservation(r);
  const groups = new Map();
  for (const w of r.order) groups.set(r.paidBy.get(w), (groups.get(r.paidBy.get(w)) ?? 0) + 1);
  check('51 buyers clear at the lowest tier', r.clearing === 500_000n, `clearing ${usd(r.clearing)}`);
  check('a buyer escrows the tier live when they commit', groups.size === 3,
    [...groups].map(([p, n]) => `${n}@${usd(p)}`).join(', '));
  check('supplier credited exactly clearing x buyerCount',
    r.supplierCredit === r.clearing * BigInt(r.committed), usd(r.supplierCredit));
  check('conservation exact', c.ok, `${usd(c.lhs)} == ${usd(c.rhs)}`);
  console.log(`      supplier ${usd(r.supplierCredit)}, refunds ${usd(c.refundTotal)}, commits ${usd(r.totalIn)}`);
}

{
  const r = run(CURVE, MIN, commits(25));
  check('buyer 25 exactly triggers tier 2', r.paidBy.get('b24') === 750_000n,
    `buyer 25 escrowed ${usd(r.paidBy.get('b24'))}`);
  check('buyer 24 is still tier 1', r.paidBy.get('b23') === 1_000_000n,
    `buyer 24 escrowed ${usd(r.paidBy.get('b23'))}`);
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

console.log('\n— the brief\'s test 6: a tier un-breaks —————————————————\n');

{
  const r = run(CURVE, MIN, [...commits(25), wd('b24')]);
  check('the marginal buyer withdraws and the tier un-breaks',
    r.blockedWithdrawals === 0 && clearingPrice(CURVE, r.committed) === 1_000_000n,
    `24 remain, live price back to ${usd(clearingPrice(CURVE, r.committed))}`);

  const r2 = run(CURVE, MIN, [...commits(25), wd('b24'), { type: 'commit', who: 'bX' }]);
  check('a new buyer re-breaks it', clearingPrice(CURVE, r2.committed) === 750_000n,
    `25 again, live price ${usd(clearingPrice(CURVE, r2.committed))}`);
  check('conservation holds across the un-break', conservation(r2).ok);
}

console.log('\n— when the withdrawal precondition binds ———————————————\n');

{
  // It binds only when the buyer count sits exactly ON a tier threshold, where
  // one exit would strand the newest buyer. One more commit clears it.
  for (const n of [24, 25, 26, 30, 50, 51]) {
    const r = run(CURVE, MIN, [...commits(n), wd('b0')]);
    const refused = r.blockedWithdrawals > 0;
    const onThreshold = CURVE.some((t) => t.minBuyers === n);
    check(`count ${n}: earliest buyer's exit is ${refused ? 'refused' : 'allowed'}`,
      refused === onThreshold,
      onThreshold ? 'count is exactly on a tier threshold' : 'off-threshold, exit is free');
  }
}

console.log('\n— the squeeze is now unreachable ———————————————————————\n');

{
  const r = run(CURVE, MIN, [...commits(50), ...Array.from({ length: 25 }, (_, i) => wd(`b${i}`))]);
  const c = conservation(r);
  check('mass withdrawal cannot strand a buyer', r.underwater === null,
    `${r.blockedWithdrawals} exits refused, ${r.committed} remain`);
  check('supplier still gets clearing x buyerCount',
    r.supplierCredit === r.clearing * BigInt(r.committed), usd(r.supplierCredit));
  check('conservation exact', c.ok, `${usd(c.lhs)} == ${usd(c.rhs)}`);
}

console.log('\n— what was weighed and rejected ————————————————————————\n');

{
  const ops = [...commits(50), ...Array.from({ length: 25 }, (_, i) => wd(`b${i}`))];

  const unguarded = run(CURVE, MIN, ops, { withdrawGuard: false, clampClearing: false });
  check('no guard at all — a buyer is stranded', unguarded.underwater !== null,
    unguarded.underwater
      ? `${unguarded.underwater.who} escrowed ${usd(unguarded.underwater.paid)}, clearing ${usd(unguarded.underwater.clearing)}`
      : 'none');
  check('no guard at all — settlement is insolvent', !conservation(unguarded).ok,
    `short by ${usd(conservation(unguarded).lhs - conservation(unguarded).rhs)}`);
  console.log('      `paid - clearing` underflows, settle() reverts forever, and');
  console.log('      refundAll() also reverts for being above the minimum: funds locked.');

  const clampd = run(CURVE, MIN, ops, { withdrawGuard: false, clampClearing: true });
  const honest = run(CURVE, MIN, commits(25), { withdrawGuard: false });
  check('clamping the clearing price — solvent but sybil-exploitable',
    clampd.supplierCredit < honest.supplierCredit,
    `25 honest buyers pay the supplier ${usd(honest.supplierCredit)}; the same 25 ` +
    `reached by sybil-and-withdraw pay ${usd(clampd.supplierCredit)}`);
  console.log('      commit 50 sybils to unlock the bottom tier, commit for real, then');
  console.log('      withdraw the sybils: the clamp drags everyone to the bottom tier.');

  console.log('      per-buyer min(escrowed, clearing) — solvent, but the supplier no');
  console.log('      longer receives clearing x buyerCount, which the brief writes out');
  console.log('      as code, and buyers stop paying one shared price.');
  console.log('      uniform top-tier collateral — solvent, but it changes what the');
  console.log('      brief says commit() pulls, which is a bigger change than this one.');
}

console.log('\n— fuzz ————————————————————————————————————————————————\n');

{
  let broke = 0, under = 0, nonUniform = 0, blocked = 0, attempted = 0;
  const runs = 50_000;
  for (let i = 0; i < runs; i++) {
    const ops = [];
    const n = 1 + Math.floor(Math.random() * 100);
    for (let b = 0; b < n; b++) {
      ops.push({ type: 'commit', who: `b${b}` });
      if (Math.random() < 0.25 && b > 0) ops.push(wd(`b${Math.floor(Math.random() * b)}`));
    }
    const r = run(CURVE, MIN, ops);
    attempted += ops.filter((o) => o.type === 'withdraw').length;
    blocked += r.blockedWithdrawals;
    if (r.underwater) under++;
    if (!conservation(r).ok) broke++;
    if (r.outcome === 'settle' && r.supplierCredit !== r.clearing * BigInt(r.committed)) nonUniform++;
  }
  check(`conservation holds over ${runs} random sequences`, broke === 0, `${broke} failures`);
  check('no sequence strands a buyer', under === 0, `${under} found`);
  check('supplier is always credited clearing x buyerCount', nonUniform === 0, `${nonUniform} deviations`);
  console.log(`      ${blocked} of ${attempted} withdrawals refused ` +
    `(${(blocked / attempted * 100).toFixed(1)}%), always on a tier threshold`);
}

console.log('');
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('all scenarios pass');
