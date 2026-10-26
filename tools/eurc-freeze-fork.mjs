#!/usr/bin/env node
// LOCAL MAINNET FORK ONLY. What happens when Circle freezes a buyer in EURC mid-deal?
// Uses EURC's real blacklist() by impersonating its blacklister on the fork.
//   Expected: settlement still succeeds for everyone; other buyers and the seller
//   collect normally; the frozen buyer's USDC refund still pays; only the frozen
//   buyer's own EURC claim fails, and it stays safely in the Settler.
import {
  chain, FORK_RPC, POOL, SETTLER, PASS as EURC, USDC, POOL_ABI, SETTLER_ABI, ERC20_ABI, TPU,
  usd, fmt, supplier, buyers, read, usdcOf, makeRecorder, ensurePasses, postPassDeal, waitForDeadline, pub,
} from './lib-v2.mjs';

if (!FORK_RPC) throw new Error('fork only: set FORK_RPC');
if ((await pub.getChainId()) !== chain.id) throw new Error('wrong chain');
const rec = makeRecorder('eurc-freeze-run');
const [b1, b2] = buyers;
const BLACKLISTER = '0x24584e31AdA775628f72DFea5829122Cf65a5C01';
const EURC_ABI = [
  { type: 'function', name: 'blacklist', stateMutability: 'nonpayable', inputs: [{ type: 'address' }], outputs: [] },
  { type: 'function', name: 'isBlacklisted', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
];

await ensurePasses(rec, 10);
const { dealId, deadline } = await postPassDeal(rec, 'freeze deal', { tiers: [[1, 1.20], [3, 1.15]], minUnits: 2, maxUnits: 10, minutes: 5, title: 'Freeze test' });
for (const [i, b] of [b1, b2].entries()) {
  await rec.send(`buyer ${i + 1} approves`, b, { address: USDC, abi: ERC20_ABI, functionName: 'approve', args: [POOL, usd(5)] });
}
await rec.send('buyer 1 orders 2', b1, { address: POOL, abi: POOL_ABI, functionName: 'commit', args: [dealId, 2] });   // $1.20 each
await rec.send('buyer 2 orders 1', b2, { address: POOL, abi: POOL_ABI, functionName: 'commit', args: [dealId, 1] });   // breaks to $1.15

// Circle freezes buyer 1 in EURC.
await pub.request({ method: 'anvil_setBalance', params: [BLACKLISTER, '0x8AC7230489E80000'] });
await pub.request({ method: 'anvil_impersonateAccount', params: [BLACKLISTER] });
const h = await pub.request({ method: 'eth_sendTransaction', params: [{ from: BLACKLISTER, to: EURC, data: (await import('viem')).encodeFunctionData({ abi: EURC_ABI, functionName: 'blacklist', args: [b1.address] }) }] });
await pub.waitForTransactionReceipt({ hash: h });
await pub.request({ method: 'anvil_stopImpersonatingAccount', params: [BLACKLISTER] });
rec.check('buyer 1 is now frozen in EURC', await read(EURC, EURC_ABI, 'isBlacklisted', [b1.address]));

const heldBefore = await read(SETTLER, SETTLER_ABI, 'goodsClaimable', [EURC, b1.address]);   // earlier runs may have left some
await waitForDeadline(deadline);
const st = await rec.send('settle (anyone can call it)', supplier, { address: SETTLER, abi: SETTLER_ABI, functionName: 'settle', args: [dealId] });
rec.check('settlement succeeds despite the frozen buyer', st.status === 'success');

// Buyer 2 and the seller collect normally.
const b2Before = await read(EURC, ERC20_ABI, 'balanceOf', [b2.address]);
await rec.send('buyer 2 collects EURC', b2, { address: SETTLER, abi: SETTLER_ABI, functionName: 'claimGoods', args: [EURC] });
rec.check('  buyer 2 received exactly 1 EURC', (await read(EURC, ERC20_ABI, 'balanceOf', [b2.address])) - b2Before === TPU);
await rec.send('seller collects unsold EURC', supplier, { address: SETTLER, abi: SETTLER_ABI, functionName: 'claimGoods', args: [EURC] });
await rec.send('seller collects USDC', supplier, { address: SETTLER, abi: SETTLER_ABI, functionName: 'claim' });

// Frozen buyer: USDC refund still pays; their own EURC claim is refused by EURC and stays in the Settler.
const owedUsdc = await read(SETTLER, SETTLER_ABI, 'claimable', [b1.address]);
rec.check('frozen buyer is owed the $0.10 refund ($2.40 paid - 2 x $1.15)', owedUsdc === usd(0.10), fmt(owedUsdc));
const u = await usdcOf(b1);
await rec.send('frozen buyer collects the USDC refund', b1, { address: SETTLER, abi: SETTLER_ABI, functionName: 'claim' });
rec.check('  frozen buyer received the $0.10', (await usdcOf(b1)) - u > usd(0.09));
let reason = 'did not revert';
try { await pub.simulateContract({ account: b1, address: SETTLER, abi: SETTLER_ABI, functionName: 'claimGoods', args: [EURC] }); }
catch (e) { reason = e.walk?.((x) => x.reason)?.reason ?? e.shortMessage; }
rec.check('frozen buyer cannot collect EURC while frozen (refused by EURC itself)', /blacklist/i.test(reason), reason);
const held = await read(SETTLER, SETTLER_ABI, 'goodsClaimable', [EURC, b1.address]);
rec.check('their 2 EURC from this deal stay credited to them', held - heldBefore === 2n * TPU, `${held - heldBefore} base units added`);
rec.check('  and the Settler really holds them', (await read(EURC, ERC20_ABI, 'balanceOf', [SETTLER])) >= held);
rec.done();
