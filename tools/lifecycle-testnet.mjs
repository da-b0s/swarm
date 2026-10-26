#!/usr/bin/env node
// Swarm v2 lifecycle on TESTNET, checked from chain at every step.
//
// Deal A — $0.30/unit from 1 unit, $0.20 from 5, $0.10 from 10; minimum 3,
// stock 20, at most 8 per buyer:
//   b1 orders 2   total 2   $0.30   escrow $0.60
//   b2 orders 3   total 5   $0.20   (breaks a tier with its own order) $0.60
//   b1 withdraws  REFUSED   would lift the price to $0.30 above b2's $0.20
//   b3 orders 1   total 6   $0.20   $0.20
//   b4 orders 1   total 7   $0.20   $0.20
//   b1 withdraws  allowed   total 5, price stays $0.20; $0.60 credited back
//   b5 orders 9   REFUSED   per-buyer limit 8
//   b5 orders 5   total 10  $0.10   (breaks a tier) $0.50
//   b6 orders 2   total 12  $0.10   $0.20
//   settle at $0.10 on 12 units: commits in $1.70 = supplier $1.20 + refunds $0.50
//   passes: b2 3, b3 1, b4 1, b5 5, b6 2; supplier 8 unsold back
//
// Deal B — $0.25/unit, minimum 5, stock 10: b5 orders 2, b6 orders 1, an order
// for 8 is refused by the stock limit, then refundAll: buyers get $0.50 and $0.25 back, the supplier all 10 passes.
//
//   node lifecycle-testnet.mjs        (~15 minutes; waits out the deadline)

import { chain,
  POOL, SETTLER, FACTORY, USDC, POOL_ABI, SETTLER_ABI, FACTORY_ABI, ERC20_ABI,
  usd, fmt, supplier, buyers, read, usdcOf, makeRecorder, events, ensurePasses,
  postPassDeal, waitForDeadline, claimAll, checkEmpty, pub,
} from './lib-v2.mjs';

const rec = makeRecorder('lifecycle-v2-run');
const [b1, b2, b3, b4, b5, b6] = buyers;
if ((await pub.getChainId()) !== chain.id) throw new Error('wrong chain');
console.log(`\nSwarm v2 lifecycle on Arc testnet — supplier ${supplier.address}\n`);

// ── setup ────────────────────────────────────────────────────────────────────────
for (const [i, b] of buyers.entries()) {
  const have = await usdcOf(b);
  if (have < usd(2)) await rec.send(`top up buyer ${i + 1}`, supplier, { address: USDC, abi: ERC20_ABI, functionName: 'transfer', args: [b.address, usd(2) - have] });
  await rec.send(`buyer ${i + 1} approves the pool`, b, { address: USDC, abi: ERC20_ABI, functionName: 'approve', args: [POOL, usd(5)] });
}
await ensurePasses(rec, 30);

const A = await postPassDeal(rec, 'deal A', { tiers: [[1, 0.30], [5, 0.20], [10, 0.10]], minUnits: 3, maxUnits: 20, maxUnitsPerBuyer: 8, title: 'Lifecycle test A', description: 'Quantities, tier breaks, limits, the strand rule, settlement.' });
const B = await postPassDeal(rec, 'deal B', { tiers: [[1, 0.25]], minUnits: 5, maxUnits: 10, title: 'Lifecycle test B', description: 'Misses its minimum on purpose.' });
console.log(`\ndeal A = #${A.dealId}, deal B = #${B.dealId}\n`);

const order = async (b, n, deal, units, wantPerUnit, label = '') => {
  const r = await rec.send(`${label || 'deal'}: buyer ${n} orders ${units}`, b, { address: POOL, abi: POOL_ABI, functionName: 'commit', args: [deal, units] });
  const ev = events(r, POOL_ABI).find((e) => e.eventName === 'Committed');
  rec.check(`  buyer ${n} pays ${fmt(wantPerUnit)}/unit, escrow ${fmt(wantPerUnit * BigInt(units))}`,
    ev.args.paidPerUnit === wantPerUnit && ev.args.escrow === wantPerUnit * BigInt(units),
    `${fmt(ev.args.paidPerUnit)}/unit, ${fmt(ev.args.escrow)}; ${ev.args.totalUnits} units sold`);
  const broke = events(r, POOL_ABI).find((e) => e.eventName === 'TierBroken');
  if (broke) console.log(`      TierBroken -> ${fmt(broke.args.newPrice ?? broke.args[2])}`);
};

// ── deal A ───────────────────────────────────────────────────────────────────────
await order(b1, 1, A.dealId, 2, usd(0.30), 'A');
await order(b2, 2, A.dealId, 3, usd(0.20), 'A');
const withdrawB1 = { address: POOL, abi: POOL_ABI, functionName: 'withdraw', args: [A.dealId, 2] }; // all 2 units
await rec.expectRevert('A: buyer 1 withdrawing is refused (would strand buyer 2)', b1, withdrawB1, 'WouldStrandBuyer');
await order(b3, 3, A.dealId, 1, usd(0.20), 'A');
await order(b4, 4, A.dealId, 1, usd(0.20), 'A');
const b1Before = await pub.getBalance({ address: b1.address });   // native, 18 decimals: exact
const w = await rec.send('A: buyer 1 withdraws (now permitted)', b1, withdrawB1);
const wev = events(w, POOL_ABI).find((e) => e.eventName === 'Withdrawn');
const wGas = w.gasUsed * w.effectiveGasPrice;
rec.check('  buyer 1 gets the full $0.60 back, paid straight to the wallet', wev.args.amountReturned === usd(0.60) && wev.args.paidDirectly === true, `${fmt(wev.args.amountReturned)}, paidDirectly ${wev.args.paidDirectly}`);
rec.check('  buyer 1 wallet rose by $0.60 (net of gas)', (await pub.getBalance({ address: b1.address })) - b1Before + wGas === usd(0.60) * 10n ** 12n);
await rec.expectRevert('A: ordering 9 is refused (per-buyer limit 8)', b5, { address: POOL, abi: POOL_ABI, functionName: 'commit', args: [A.dealId, 9] }, 'UnitsPerBuyerExceeded');
await order(b5, 5, A.dealId, 5, usd(0.10), 'A');
await order(b6, 6, A.dealId, 2, usd(0.10), 'A');

// ── deal B ───────────────────────────────────────────────────────────────────────
await order(b5, 5, B.dealId, 2, usd(0.25), 'B');
await order(b6, 6, B.dealId, 1, usd(0.25), 'B');
// B has no per-buyer limit, so this exercises the stock limit alone: 3 in, 7 left.
await rec.expectRevert('B: ordering 8 is refused (7 left in stock)', b4, { address: POOL, abi: POOL_ABI, functionName: 'commit', args: [B.dealId, 8] }, 'UnitCapReached');
await rec.expectRevert('settling before the deadline is refused', supplier, { address: SETTLER, abi: SETTLER_ABI, functionName: 'settle', args: [A.dealId] }, 'DeadlineNotReached');

await waitForDeadline(B.deadline > A.deadline ? B.deadline : A.deadline);

await rec.expectRevert('refundAll on deal A (met its minimum) is refused', supplier, { address: SETTLER, abi: SETTLER_ABI, functionName: 'refundAll', args: [A.dealId] }, 'MinUnitsMet');
await rec.expectRevert('settling deal B (below its minimum) is refused', supplier, { address: SETTLER, abi: SETTLER_ABI, functionName: 'settle', args: [B.dealId] }, 'MinUnitsNotMet');

const s = await rec.send('A: settle', supplier, { address: SETTLER, abi: SETTLER_ABI, functionName: 'settle', args: [A.dealId] });
const sev = events(s, SETTLER_ABI).find((e) => e.eventName === 'Settled');
rec.check('A clears at $0.10 on 12 units from 5 buyers', sev.args.clearingPrice === usd(0.10) && Number(sev.args.totalUnits) === 12 && Number(sev.args.buyerCount) === 5,
  `${fmt(sev.args.clearingPrice)}, ${sev.args.totalUnits} units, ${sev.args.buyerCount} buyers`);
rec.check('A conservation: $1.70 in = $1.20 supplier + $0.50 refunds', sev.args.totalRefunds === usd(0.50) && usd(1.70) === usd(0.10) * 12n + sev.args.totalRefunds, `refunds ${fmt(sev.args.totalRefunds)}`);
rec.check('A delivers 12 passes', Number(sev.args.unitsDelivered) === 12, String(sev.args.unitsDelivered));
await rec.expectRevert('settling twice is refused', supplier, { address: SETTLER, abi: SETTLER_ABI, functionName: 'settle', args: [A.dealId] }, 'AlreadySettled');

const rb = await rec.send('B: refundAll', supplier, { address: SETTLER, abi: SETTLER_ABI, functionName: 'refundAll', args: [B.dealId] });
const refunds = events(rb, SETTLER_ABI).filter((e) => e.eventName === 'Refunded').map((e) => e.args.usdcAmount).sort();
rec.check('B refunds $0.25 and $0.50 in full', refunds.length === 2 && refunds[0] === usd(0.25) && refunds[1] === usd(0.50), refunds.map(fmt).join(', '));

// ── claims, with exact expectations ──────────────────────────────────────────────
console.log('');
await claimAll(rec, 'supplier', supplier, usd(1.20), 8 + 10);   // A proceeds; A unsold 8 + B stock 10
await claimAll(rec, 'buyer 1', b1, 0n, 0);                       // withdrawal was paid directly
await claimAll(rec, 'buyer 2', b2, usd(0.30), 3);                // 3 × ($0.20 − $0.10)
await claimAll(rec, 'buyer 3', b3, usd(0.10), 1);
await claimAll(rec, 'buyer 4', b4, usd(0.10), 1);
await claimAll(rec, 'buyer 5', b5, usd(0.50), 5);                // A refund 0 + B refund $0.50
await claimAll(rec, 'buyer 6', b6, usd(0.25), 2);                // A refund 0 + B refund $0.25
await checkEmpty(rec);
rec.done();
