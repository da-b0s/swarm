#!/usr/bin/env node
// Swarm v2.1 top-ups on TESTNET, checked from chain. Needs the relayer running
// against the pool in ../.env for the gasless top-up.
//
// Curve $0.30/unit from 1, $0.20 from 5, $0.10 from 10; stock 20, 6 per buyer.
//   b1 orders 2            total 2   $0.30   $0.60
//   b2 orders 3            total 5   $0.20   $0.60   (breaks a tier)
//   b1 tops up 2           total 7   $0.20   $0.40   b1: 4 units, $1.00, cheapest $0.20
//   b1 tops up 3           REFUSED   7 > 6 per buyer
//   b3 orders 3            total 10  $0.10   $0.30   (breaks a tier)
//   b2 tops up 1           total 11  $0.10   $0.10   b2: 4 units, $0.70, cheapest $0.10
//   b3 withdraws           REFUSED   price would return to $0.20, above b2's $0.10 lot
//   b3 tops up 1 gasless   total 12  $0.10   $0.10   b3: 4 units, $0.40
//   settle at $0.10 on 12: in $2.10 = supplier $1.20 + refunds $0.90
//   refunds b1 $0.60, b2 $0.30, b3 $0; passes 4, 4, 4; supplier 8 unsold back

import { chain,
  POOL, SETTLER, USDC, POOL_ABI, SETTLER_ABI, ERC20_ABI, usd, fmt, supplier, buyers,
  usdcOf, read, makeRecorder, events, ensurePasses, postPassDeal, waitForDeadline,
  signOrder, claimAll, checkEmpty, pub,
} from './lib-v2.mjs';

const RELAYER_URL = process.env.RELAYER_URL ?? 'http://localhost:8787';
const rec = makeRecorder('topup-run');
const [b1, b2, b3] = buyers;
if ((await pub.getChainId()) !== chain.id) throw new Error('wrong chain');
const health = await (await fetch(`${RELAYER_URL}/health`)).json();
rec.check('relayer points at the current pool', health.poolAddress.toLowerCase() === POOL.toLowerCase(), health.poolAddress);

for (const [i, b] of [b1, b2, b3].entries()) {
  const have = await usdcOf(b);
  if (have < usd(2)) await rec.send(`top up buyer ${i + 1} USDC`, supplier, { address: USDC, abi: ERC20_ABI, functionName: 'transfer', args: [b.address, usd(2) - have] });
  await rec.send(`buyer ${i + 1} approves the pool`, b, { address: USDC, abi: ERC20_ABI, functionName: 'approve', args: [POOL, usd(5)] });
}
await ensurePasses(rec, 20);
const { dealId, deadline } = await postPassDeal(rec, 'top-up deal', { tiers: [[1, 0.30], [5, 0.20], [10, 0.10]], minUnits: 2, maxUnits: 20, maxUnitsPerBuyer: 6, minutes: 8, title: 'Top-up test', description: 'Buyers adding to their orders.' });
console.log(`\ndeal #${dealId}\n`);

const order = async (b, n, units, wantPrice, what) => {
  const r = await rec.send(`buyer ${n} ${what} ${units}`, b, { address: POOL, abi: POOL_ABI, functionName: 'commit', args: [dealId, units] });
  const e = events(r, POOL_ABI).find((x) => x.eventName === 'Committed').args;
  rec.check(`  lot priced ${fmt(wantPrice)}/unit, ${fmt(wantPrice * BigInt(units))}`, e.paidPerUnit === wantPrice && e.escrow === wantPrice * BigInt(units),
    `${fmt(e.paidPerUnit)}/unit, ${fmt(e.escrow)}; ${e.totalUnits} units, ${e.buyerCount} buyers`);
};
const state = async (b) => ({ units: Number(await read(POOL, POOL_ABI, 'unitsOf', [dealId, b.address])), escrow: await read(POOL, POOL_ABI, 'escrowed', [dealId, b.address]), cheapest: await read(POOL, POOL_ABI, 'paidPerUnit', [dealId, b.address]) });

await order(b1, 1, 2, usd(0.30), 'orders');
await order(b2, 2, 3, usd(0.20), 'orders');
await order(b1, 1, 2, usd(0.20), 'tops up');
let s1 = await state(b1);
rec.check('buyer 1 now holds 4 units, $1.00 escrowed, cheapest lot $0.20', s1.units === 4 && s1.escrow === usd(1.00) && s1.cheapest === usd(0.20), `${s1.units} units, ${fmt(s1.escrow)}, ${fmt(s1.cheapest)}`);
await rec.expectRevert('buyer 1 topping up 3 more is refused (7 > 6 per buyer)', b1, { address: POOL, abi: POOL_ABI, functionName: 'commit', args: [dealId, 3] }, 'UnitsPerBuyerExceeded');
await order(b3, 3, 3, usd(0.10), 'orders');
await order(b2, 2, 1, usd(0.10), 'tops up');
const s2 = await state(b2);
rec.check('buyer 2 now holds 4 units, $0.70 escrowed, cheapest lot $0.10', s2.units === 4 && s2.escrow === usd(0.70) && s2.cheapest === usd(0.10), `${s2.units} units, ${fmt(s2.escrow)}, ${fmt(s2.cheapest)}`);
const buyerCount = Number(await read(POOL, POOL_ABI, 'getBuyerCount', [dealId]));
rec.check('top-ups did not add buyers: still 3', buyerCount === 3, String(buyerCount));
await rec.expectRevert('buyer 3 withdrawing is refused (would strand buyer 2\'s $0.10 lot)', b3, { address: POOL, abi: POOL_ABI, functionName: 'withdraw', args: [dealId, 3] }, 'WouldStrandBuyer');

// gasless top-up: 1 unit at priceAt(11 + 1) = $0.10
const before = await usdcOf(b3);
const r = await fetch(`${RELAYER_URL}/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(await signOrder(b3, dealId, 1, usd(0.10))) });
const body = await r.json();
rec.check('buyer 3 tops up 1 gaslessly at $0.10', r.status === 200 && body.escrow === usd(0.10).toString(), `${r.status} ${JSON.stringify(body).slice(0, 100)}`);
rec.check('  buyer 3 balance fell by exactly $0.10', before - (await usdcOf(b3)) === usd(0.10));
const s3 = await state(b3);
rec.check('buyer 3 now holds 4 units, $0.40 escrowed', s3.units === 4 && s3.escrow === usd(0.40), `${s3.units} units, ${fmt(s3.escrow)}`);

// partial withdrawal: buyer 1 removes 1 of 4 units and gets the average back
// ($1.00 x 1 / 4 = $0.25) straight to the wallet; 11 units still clear at $0.10.
const pwBefore = await pub.getBalance({ address: b1.address });   // native, 18 decimals: exact
const pw = await rec.send('buyer 1 withdraws 1 of 4 units', b1, { address: POOL, abi: POOL_ABI, functionName: 'withdraw', args: [dealId, 1] });
const pwe = events(pw, POOL_ABI).find((x) => x.eventName === 'Withdrawn').args;
const pwGas = pw.gasUsed * pw.effectiveGasPrice;
rec.check('  returns the $0.25 average, paid directly', pwe.amountReturned === usd(0.25) && pwe.paidDirectly === true && Number(pwe.units) === 1, `${fmt(pwe.amountReturned)}, paidDirectly ${pwe.paidDirectly}`);
rec.check('  buyer 1 wallet rose by $0.25 (net of gas)', (await pub.getBalance({ address: b1.address })) - pwBefore + pwGas === usd(0.25) * 10n ** 12n);
s1 = await state(b1);
rec.check('  buyer 1 keeps 3 units with $0.75 escrowed', s1.units === 3 && s1.escrow === usd(0.75), `${s1.units} units, ${fmt(s1.escrow)}`);

await waitForDeadline(deadline);
const st = await rec.send('settle', supplier, { address: SETTLER, abi: SETTLER_ABI, functionName: 'settle', args: [dealId] });
const e = events(st, SETTLER_ABI).find((x) => x.eventName === 'Settled').args;
rec.check('clears at $0.10 on 11 units from 3 buyers', e.clearingPrice === usd(0.10) && Number(e.totalUnits) === 11 && Number(e.buyerCount) === 3, `${fmt(e.clearingPrice)}, ${e.totalUnits}, ${e.buyerCount}`);
rec.check('conservation: $1.85 in (net) = $1.10 supplier + $0.75 refunds', e.totalRefunds === usd(0.75) && usd(0.10) * 11n + e.totalRefunds === usd(1.85), `refunds ${fmt(e.totalRefunds)}`);
console.log('');
await claimAll(rec, 'supplier', supplier, usd(1.10), 9);
await claimAll(rec, 'buyer 1', b1, usd(0.45), 3);   // $0.75 - 3 x $0.10
await claimAll(rec, 'buyer 2', b2, usd(0.30), 4);   // $0.70 - 4 x $0.10
await claimAll(rec, 'buyer 3', b3, 0n, 4);          // $0.40 - 4 x $0.10
await checkEmpty(rec);
rec.done();
