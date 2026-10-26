#!/usr/bin/env node
// Checks the relayer's settlement keeper on TESTNET: two short deals, one that
// meets its minimum and one that does not. Nobody calls settle or refundAll;
// the running relayer must close both by itself after the deadline.
import { POOL, USDC, POOL_ABI, ERC20_ABI, FACTORY, FACTORY_ABI, usd, buyers, read, makeRecorder, ensurePasses, postPassDeal, waitForDeadline, pub } from './lib-v2.mjs';


const rec = makeRecorder('keeper-run');
if ((await pub.getChainId()) !== 5042002) throw new Error('not testnet');
await ensurePasses(rec, 6);
const A = await postPassDeal(rec, 'deal A', { tiers: [[1, 0.10]], minUnits: 1, maxUnits: 3, minutes: 2, title: 'Keeper test A' });
const B = await postPassDeal(rec, 'deal B', { tiers: [[1, 0.10]], minUnits: 2, maxUnits: 3, minutes: 2, title: 'Keeper test B' });
await rec.send('buyer approves the pool', buyers[0], { address: USDC, abi: ERC20_ABI, functionName: 'approve', args: [POOL, usd(1)] });
await rec.send('buyer orders 1 on deal A', buyers[0], { address: POOL, abi: POOL_ABI, functionName: 'commit', args: [A.dealId, 1] });
await waitForDeadline(B.deadline > A.deadline ? B.deadline : A.deadline);
const state = async (id) => (await read(FACTORY, FACTORY_ABI, 'getDeal', [id])).state;
const until = Date.now() + 180_000;
let a = 0, b = 0;
while (Date.now() < until && (a === 0 || b === 0)) {
  await new Promise((r) => setTimeout(r, 10_000));
  [a, b] = [await state(A.dealId), await state(B.dealId)];
}
rec.check(`deal A #${A.dealId} settled by the keeper`, a === 1, `state ${a}`);
rec.check(`deal B #${B.dealId} refunded by the keeper`, b === 2, `state ${b}`);
rec.done();
