#!/usr/bin/env node
// Finishes the 24 October v2 testnet runs, which were cut off while waiting for
// their deadlines: a DNS failure stopped the lifecycle script, and the gasless
// script ended with the session. Every check before the deadlines had passed.
//
// Settles deal #1, refunds deal #2, settles deal #3, then claims everything with
// the totals each account is owed across all three deals, and checks the
// contracts end empty.

import { chain,
  SETTLER, SETTLER_ABI, usd, fmt, supplier, buyers, makeRecorder, events, claimAll, checkEmpty, pub, chainNow, read, FACTORY, FACTORY_ABI, waitForDeadline,
} from './lib-v2.mjs';

const rec = makeRecorder('finish-v2-run');
const [b1, b2, b3, b4, b5, b6] = buyers;
if ((await pub.getChainId()) !== chain.id) throw new Error('wrong chain');

const state = async (id) => Number((await read(FACTORY, FACTORY_ABI, 'getDeal', [id])).state);
const deal3 = await read(FACTORY, FACTORY_ABI, 'getDeal', [3n]);
await waitForDeadline(deal3.deadline);

const settle = async (id, cp, units, refunds, delivered) => {
  const r = await rec.send(`deal #${id}: settle`, supplier, { address: SETTLER, abi: SETTLER_ABI, functionName: 'settle', args: [id] });
  const e = events(r, SETTLER_ABI).find((x) => x.eventName === 'Settled').args;
  rec.check(`  #${id} clears at ${fmt(cp)} on ${units} units, refunds ${fmt(refunds)}, ${delivered} passes delivered`,
    e.clearingPrice === cp && Number(e.totalUnits) === units && e.totalRefunds === refunds && Number(e.unitsDelivered) === delivered,
    `${fmt(e.clearingPrice)}, ${e.totalUnits} units, refunds ${fmt(e.totalRefunds)}, ${e.unitsDelivered} delivered`);
  rec.check(`  #${id} conservation: in = supplier + refunds`, cp * BigInt(units) + e.totalRefunds === (id === 1n ? usd(1.70) : usd(1.60)));
};

if ((await state(1n)) === 0) await settle(1n, usd(0.10), 12, usd(0.50), 12); else console.log('deal #1 already settled');
if ((await state(2n)) === 0) {
const rb = await rec.send('deal #2: refundAll', supplier, { address: SETTLER, abi: SETTLER_ABI, functionName: 'refundAll', args: [2n] });
const refunds = events(rb, SETTLER_ABI).filter((x) => x.eventName === 'Refunded').map((x) => x.args.usdcAmount).sort();
rec.check('  #2 refunds $0.25 and $0.50 in full', refunds.length === 2 && refunds[0] === usd(0.25) && refunds[1] === usd(0.50), refunds.map(fmt).join(', '));
} else console.log('deal #2 already refunded');
await settle(3n, usd(0.20), 7, usd(0.20), 7);
await rec.expectRevert('settling #1 again is refused', supplier, { address: SETTLER, abi: SETTLER_ABI, functionName: 'settle', args: [1n] }, 'AlreadySettled');

console.log('');
await claimAll(rec, 'supplier', supplier, usd(2.60), 31);
await claimAll(rec, 'buyer 1', b1, usd(0.80), 2);
await claimAll(rec, 'buyer 2', b2, usd(0.70), 3);
await claimAll(rec, 'buyer 3', b3, usd(0.10), 5);
await claimAll(rec, 'buyer 4', b4, usd(0.10), 2);
await claimAll(rec, 'buyer 5', b5, usd(0.50), 5);
await claimAll(rec, 'buyer 6', b6, usd(0.25), 2);
await checkEmpty(rec);
rec.done();
