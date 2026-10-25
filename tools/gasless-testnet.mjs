#!/usr/bin/env node
// Swarm v2 gasless orders on TESTNET, through the real relayer, checked from chain.
// Needs the relayer running locally against the pool in ../.env (see docs/hosting.md).
//
// Curve: $0.30/unit from 1 unit, $0.20 from 4, $0.10 from 8; stock 20.
//   A  b1 orders 2 gaslessly at $0.30: balance falls by exactly $0.60, no gas paid
//   B  b2 signs 2 at $0.20 (quoted at 4 units); b3 orders 4 normally first (6 units);
//      b2 lands at 8 units: $0.10 x 2 escrowed, $0.20 credited back. Replay refused.
//   C  b4 signs 1 at $0.10 (quoted at 9 units); submitting it as 2 units is refused
//   D  b2 withdraws (8 -> 6 units, $0.20); b4's $0.10 order would land at $0.20:
//      409 with the new total, balance unchanged; b4 re-signs at $0.20 and lands
//   Settle at $0.20 on 7 units, everyone claims, the contracts end empty.

import {
  POOL, SETTLER, USDC, POOL_ABI, SETTLER_ABI, ERC20_ABI,
  usd, fmt, supplier, buyers, usdcOf, makeRecorder, events, ensurePasses,
  postPassDeal, waitForDeadline, signOrder, claimAll, checkEmpty, pub,
} from './lib-v2.mjs';

const RELAYER_URL = process.env.RELAYER_URL ?? 'http://localhost:8787';
const rec = makeRecorder('gasless-v2-run');
const [b1, b2, b3, b4] = buyers;
const relay = async (body) => { const r = await fetch(`${RELAYER_URL}/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

const health = await (await fetch(`${RELAYER_URL}/health`)).json();
rec.check('relayer is on testnet and pointed at the current pool', health.chainId === 5042002 && health.poolAddress.toLowerCase() === POOL.toLowerCase(), `${health.chainId} ${health.poolAddress}`);
rec.check('/health does not expose a key', !JSON.stringify(health).match(/[0-9a-f]{64}/i));
if ((await pub.getChainId()) !== 5042002) throw new Error('not testnet');

for (const [i, b] of [b1, b2, b3, b4].entries()) {
  const have = await usdcOf(b);
  if (have < usd(2)) await rec.send(`top up buyer ${i + 1}`, supplier, { address: USDC, abi: ERC20_ABI, functionName: 'transfer', args: [b.address, usd(2) - have] });
}
await rec.send('buyer 3 approves the pool', b3, { address: USDC, abi: ERC20_ABI, functionName: 'approve', args: [POOL, usd(5)] });
await ensurePasses(rec, 20);
const { dealId, deadline } = await postPassDeal(rec, 'gasless deal', { tiers: [[1, 0.30], [4, 0.20], [8, 0.10]], minUnits: 1, maxUnits: 20, title: 'Gasless test', description: 'Orders signed once and relayed.' });
console.log(`\ndeal #${dealId}\n`);

// ── A ────────────────────────────────────────────────────────────────────────────
console.log('A  plain gasless order');
let before = await usdcOf(b1);
const a = await relay(await signOrder(b1, dealId, 2, usd(0.60)));
rec.check('relayer accepted it', a.status === 200, `${a.status} ${a.body.txHash ?? JSON.stringify(a.body)}`);
rec.check('relayer reports 2 units at $0.30, $0.60 escrowed, nothing back',
  a.body.units === 2 && a.body.paidPerUnit === usd(0.30).toString() && a.body.escrow === usd(0.60).toString() && a.body.excessCredited === '0',
  `${a.body.units} units, ${fmt(a.body.paidPerUnit ?? 0)}/unit, ${fmt(a.body.escrow ?? 0)}`);
let fell = before - (await usdcOf(b1));
rec.check('buyer 1 balance fell by exactly $0.60 — no gas paid', fell === usd(0.60), fmt(fell));

// ── B ────────────────────────────────────────────────────────────────────────────
console.log('\nB  price falls between signing and landing');
const sigB = await signOrder(b2, dealId, 2, usd(0.40));
await rec.send('buyer 3 orders 4 normally first', b3, { address: POOL, abi: POOL_ABI, functionName: 'commit', args: [dealId, 4] });
before = await usdcOf(b2);
const b = await relay(sigB);
rec.check('relayer accepted it', b.status === 200, `${b.status} ${b.body.txHash ?? JSON.stringify(b.body)}`);
rec.check('buyer 2 escrowed the live $0.10 x 2, with $0.20 credited back',
  b.body.escrow === usd(0.20).toString() && b.body.excessCredited === usd(0.20).toString(),
  `escrow ${fmt(b.body.escrow ?? 0)}, excess ${fmt(b.body.excessCredited ?? 0)}`);
fell = before - (await usdcOf(b2));
rec.check('buyer 2 balance fell by exactly the $0.40 signed', fell === usd(0.40), fmt(fell));
const replay = await relay(sigB);
rec.check('replay refused with its name only', replay.status === 400 && replay.body.error === 'AuthorizationAlreadyUsed' && Object.keys(replay.body).length === 1, `${replay.status} ${JSON.stringify(replay.body)}`);

// ── C ────────────────────────────────────────────────────────────────────────────
console.log('\nC  the quantity is bound to the signature');
// Signed for 1 unit at $0.20 — enough to pay for 2 units at $0.10 — so the price
// check passes and only the quantity bound into the nonce can reject the swap.
const sigBind = await signOrder(b4, dealId, 1, usd(0.20));
before = await usdcOf(b4);
const swapped = await relay({ ...sigBind, units: 2 });
rec.check('the same signature sent as 2 units is refused', swapped.status !== 200, `${swapped.status} ${JSON.stringify(swapped.body)}`);
rec.check('the refusal carries no viem text or signature', !/viem|0x[0-9a-f]{64}/i.test(JSON.stringify(swapped.body)));
rec.check('buyer 4 balance did not move', (await usdcOf(b4)) === before);

// ── D ────────────────────────────────────────────────────────────────────────────
console.log('\nD  price rises between signing and landing');
const sigC = await signOrder(b4, dealId, 1, usd(0.10));   // quoted at 8+1 = 9 units: $0.10
await rec.send('buyer 2 withdraws', b2, { address: POOL, abi: POOL_ABI, functionName: 'withdraw', args: [dealId, 2] });
const d409 = await relay(sigC);                             // would land at 7 units: $0.20
rec.check('relayer answers 409 with the new total, $0.20', d409.status === 409 && d409.body.requiredTotal === usd(0.20).toString(), `${d409.status} ${JSON.stringify(d409.body)}`);
rec.check('the 409 carries no viem text or signature', !/viem|0x[0-9a-f]{64}/i.test(JSON.stringify(d409.body)));
rec.check('buyer 4 balance did not move', (await usdcOf(b4)) === before);
const d = await relay(await signOrder(b4, dealId, 1, usd(0.20)));
rec.check('re-signed at $0.20, accepted', d.status === 200 && d.body.escrow === usd(0.20).toString(), `${d.status} ${fmt(d.body.escrow ?? 0)}`);
fell = before - (await usdcOf(b4));
rec.check('buyer 4 balance fell by exactly $0.20', fell === usd(0.20), fmt(fell));

// ── settle and claim ─────────────────────────────────────────────────────────────
// In: b1 2 @ $0.30, b3 4 @ $0.20, b4 1 @ $0.20 = 7 units, clears at $0.20.
await waitForDeadline(deadline);
const s = await rec.send('settle', supplier, { address: SETTLER, abi: SETTLER_ABI, functionName: 'settle', args: [dealId] });
const sev = events(s, SETTLER_ABI).find((e) => e.eventName === 'Settled');
rec.check('clears at $0.20 on 7 units', sev.args.clearingPrice === usd(0.20) && Number(sev.args.totalUnits) === 7, `${fmt(sev.args.clearingPrice)}, ${sev.args.totalUnits} units`);
rec.check('conservation: $1.60 in = $1.40 supplier + $0.20 refunds', sev.args.totalRefunds === usd(0.20) && usd(1.60) === usd(0.20) * 7n + sev.args.totalRefunds, `refunds ${fmt(sev.args.totalRefunds)}`);
console.log('');
await claimAll(rec, 'supplier', supplier, usd(1.40), 13);
await claimAll(rec, 'buyer 1', b1, usd(0.20), 2);
await claimAll(rec, 'buyer 2', b2, usd(0.20), 0);          // the $0.20 excess; the withdrawn $0.20 was paid directly
await claimAll(rec, 'buyer 3', b3, 0n, 4);
await claimAll(rec, 'buyer 4', b4, 0n, 1);
await checkEmpty(rec);

const end = await (await fetch(`${RELAYER_URL}/health`)).json();
console.log(`\nrelayer spent ${fmt(usd(health.usdcBalance) - usd(end.usdcBalance))} on gas for 3 relayed orders`);
rec.done();
