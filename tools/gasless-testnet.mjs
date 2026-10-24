#!/usr/bin/env node
// End-to-end test of gasless commits on TESTNET, through the real relayer.
//
// Needs the relayer running locally against the current testnet pool:
//   cd relayer && RELAYER_KEY=... RPC_URL=https://rpc.testnet.arc.io CHAIN_ID=5042002 \
//     POOL_ADDRESS=0xe7860112eF7fF7a375b33fA703D3B3A38CC7A70d PORT=8787 \
//     node --experimental-strip-types server.ts
//
// Curve: $1.00 at 1 buyer, $0.75 at 2, $0.50 at 3. Each scenario is forced by
// the order of events, not left to timing:
//
//   A  plain gasless commit: the buyer's balance falls by exactly the price,
//      which is the proof they paid no gas.
//   B  price falls after signing: buyer 2 signs at $1.00, buyer 3 commits
//      normally, buyer 2 lands at $0.50 and $0.50 is credited back.
//      Replay of the same request is refused.
//   C  price rises after signing: buyer 4 signs at $0.50, two withdrawals push
//      the price to $0.75, the relayer answers 409 with $0.75 before
//      broadcasting, buyer 4's balance does not move; buyer 4 re-signs and lands.
//   Then settle, everyone claims, the pool ends at $0.
//
// Buyer keys are the throwaway testnet wallets in ../secrets/testnet-buyers.json.

import {
  createPublicClient, createWalletClient, http, defineChain, parseUnits, formatUnits,
  decodeEventLog, toHex, BaseError, ContractFunctionRevertedError,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const chain = defineChain({
  id: 5042002, name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.io'] } },
});
const EXPLORER = 'https://explorer.testnet.arc.io';
const RELAYER_URL = process.env.RELAYER_URL ?? 'http://localhost:8787';
const USDC = '0x3600000000000000000000000000000000000000';
const FACTORY = '0x97e7B6431Ad839580A06B1CC5717d68be27D2212';
const POOL = '0xe7860112eF7fF7a375b33fA703D3B3A38CC7A70d';
const SETTLER = '0x2deDA8Fa1101C42Bc6f36AEEd898A583366816E8';

const abi = (n) => JSON.parse(readFileSync(new URL(`../onchain/contracts/out/${n}.sol/${n}.json`, import.meta.url), 'utf8')).abi;
const FACTORY_ABI = abi('DealFactory'), POOL_ABI = abi('DemandPool'), SETTLER_ABI = abi('Settler');
const ERC20_ABI = [
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
];
const usd = (n) => parseUnits(String(n), 6);
const fmt = (v) => `$${formatUnits(BigInt(v), 6)}`;

const envKey = (name) => readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith(name + '='))?.slice(name.length + 1).trim();
const supplier = privateKeyToAccount(envKey('DEPLOYER_KEY'));
const buyers = JSON.parse(readFileSync(new URL('../secrets/testnet-buyers.json', import.meta.url), 'utf8')).map((k) => privateKeyToAccount(k));
const [b1, b2, b3, b4] = buyers;

const pub = createPublicClient({ chain, transport: http() });
const wallet = (account) => createWalletClient({ account, chain, transport: http() });
const read = (address, a, functionName, args = []) => pub.readContract({ address, abi: a, functionName, args });
const bal = (a) => read(USDC, ERC20_ABI, 'balanceOf', [a.address]);
const claimable = (a) => read(SETTLER, SETTLER_ABI, 'claimable', [a.address]);

const record = { startedAt: new Date().toISOString(), steps: [] };
let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
  record.steps.push({ check: label, ok, detail });
}
async function send(label, account, params) {
  const hash = await wallet(account).writeContract({ ...params, account });
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(`${r.status === 'success' ? 'tx  ' : 'FAIL'}  ${label.padEnd(40)} ${EXPLORER}/tx/${hash}`);
  record.steps.push({ tx: label, hash, status: r.status });
  if (r.status !== 'success') throw new Error(`${label} reverted`);
  return r;
}

// Sign a ReceiveWithAuthorization exactly as the frontend does.
async function signCommit(buyer, dealId, amount) {
  const salt = toHex(randomBytes(32));
  const nonce = await read(POOL, POOL_ABI, 'authorizationNonce', [dealId, buyer.address, salt]);
  const validBefore = BigInt(Number((await pub.getBlock()).timestamp) + 600);
  const signature = await buyer.signTypedData({
    domain: { name: 'USDC', version: '2', chainId: 5042002, verifyingContract: USDC },
    types: { ReceiveWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ] },
    primaryType: 'ReceiveWithAuthorization',
    message: { from: buyer.address, to: POOL, value: amount, validAfter: 0n, validBefore, nonce },
  });
  return { dealId: dealId.toString(), buyer: buyer.address, authorizedAmount: amount.toString(), validAfter: '0', validBefore: validBefore.toString(), salt, signature };
}
async function relay(body) {
  const r = await fetch(`${RELAYER_URL}/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

// ── preflight ────────────────────────────────────────────────────────────────────
const health = await (await fetch(`${RELAYER_URL}/health`)).json();
check('relayer is on testnet and pointed at the current pool', health.chainId === 5042002 && health.poolAddress.toLowerCase() === POOL.toLowerCase(), `${health.chainId} ${health.poolAddress}`);
check('/health does not expose a key', !JSON.stringify(health).match(/[0-9a-f]{64}/i));
const relayerStart = BigInt(parseUnits(String(health.usdcBalance), 6));

for (const [i, b] of [b1, b2, b3, b4].entries()) {
  const have = await bal(b);
  if (have < usd(2)) await send(`top up buyer ${i + 1}`, supplier, { address: USDC, abi: ERC20_ABI, functionName: 'transfer', args: [b.address, usd(2) - have] });
}
await send('buyer 3 approves the new pool', b3, { address: USDC, abi: ERC20_ABI, functionName: 'approve', args: [POOL, usd(5)] });

const deadline = BigInt(Number((await pub.getBlock()).timestamp) + 10 * 60);
const posted = await send('post deal ($1.00/1, $0.75/2, $0.50/3)', supplier, {
  address: FACTORY, abi: FACTORY_ABI, functionName: 'postDeal',
  args: [[{ minBuyers: 1, pricePerUnit: usd(1) }, { minBuyers: 2, pricePerUnit: usd(0.75) }, { minBuyers: 3, pricePerUnit: usd(0.5) }], 1, deadline, 10],
});
const dealId = posted.logs.map((l) => { try { return decodeEventLog({ abi: FACTORY_ABI, data: l.data, topics: l.topics }); } catch { return null; } })
  .find((e) => e?.eventName === 'DealPosted').args.dealId;
console.log(`\ndeal #${dealId} on the new pool, deadline ${new Date(Number(deadline) * 1000).toISOString()}\n`);
record.dealId = dealId;

// ── A: plain gasless commit ──────────────────────────────────────────────────────
console.log('A  plain gasless commit');
let before = await bal(b1);
const a = await relay(await signCommit(b1, dealId, usd(1)));
check('relayer accepted it', a.status === 200, `${a.status} ${a.body.txHash ? EXPLORER + '/tx/' + a.body.txHash : JSON.stringify(a.body)}`);
check('buyer 1 escrowed $1.00 with nothing credited back', a.body.pricePaid === usd(1).toString() && a.body.excessCredited === '0', `paid ${fmt(a.body.pricePaid ?? 0)}, excess ${fmt(a.body.excessCredited ?? 0)}`);
let delta = before - (await bal(b1));
check('buyer 1 balance fell by exactly $1.00 — no gas paid by the buyer', delta === usd(1), `fell by ${fmt(delta)}`);
record.relayGasA = a.body.gasUsdcCost;

// ── B: price falls after signing ─────────────────────────────────────────────────
console.log('\nB  price falls between signing and landing');
const sigB = await signCommit(b2, dealId, usd(1)); // signed at $1.00 (1 buyer in)
await send('buyer 3 commits normally first', b3, { address: POOL, abi: POOL_ABI, functionName: 'commit', args: [dealId] }); // 2 buyers: $0.75
before = await bal(b2);
const claimB = await claimable(b2);
const bRes = await relay(sigB); // lands as buyer 3: $0.50
check('relayer accepted it', bRes.status === 200, `${bRes.status} ${bRes.body.txHash ? EXPLORER + '/tx/' + bRes.body.txHash : JSON.stringify(bRes.body)}`);
check('buyer 2 escrowed the live $0.50, not the $1.00 signed', bRes.body.pricePaid === usd(0.5).toString(), fmt(bRes.body.pricePaid ?? 0));
check('$0.50 excess reported by the relayer', bRes.body.excessCredited === usd(0.5).toString(), fmt(bRes.body.excessCredited ?? 0));
check('$0.50 is in buyer 2\'s claimable balance', (await claimable(b2)) - claimB === usd(0.5));
delta = before - (await bal(b2));
check('buyer 2 balance fell by exactly the $1.00 signed', delta === usd(1), `fell by ${fmt(delta)}`);

const replay = await relay(sigB);
check('replaying the same authorization is refused with its name only', replay.status === 400 && replay.body.error === 'AuthorizationAlreadyUsed' && Object.keys(replay.body).length === 1, `${replay.status} ${JSON.stringify(replay.body).slice(0, 90)}`);

// ── C: price rises after signing ─────────────────────────────────────────────────
console.log('\nC  price rises between signing and landing');
const sigC = await signCommit(b4, dealId, usd(0.5)); // signed at $0.50 (3 buyers in)
await send('buyer 2 withdraws', b2, { address: POOL, abi: POOL_ABI, functionName: 'withdraw', args: [dealId] }); // 2 buyers: $0.75
await send('buyer 3 withdraws', b3, { address: POOL, abi: POOL_ABI, functionName: 'withdraw', args: [dealId] }); // 1 buyer: $1.00
before = await bal(b4);
const c409 = await relay(sigC); // would land as buyer 2: $0.75 > $0.50
check('relayer answers 409 with the new price', c409.status === 409 && c409.body.requiredPrice === usd(0.75).toString(), `${c409.status} ${JSON.stringify(c409.body)}`);
check('the 409 carries no viem text or signature', !/viem|0x[0-9a-f]{64}/i.test(JSON.stringify(c409.body)));
check('buyer 4 balance did not move', (await bal(b4)) === before);

// Sent with validAfter as the number 0, not the string "0": a client doing that
// was once rejected as "Missing field".
const cRes = await relay({ ...(await signCommit(b4, dealId, usd(0.75))), validAfter: 0 });
check('re-signed at $0.75, accepted', cRes.status === 200 && cRes.body.pricePaid === usd(0.75).toString(), `${cRes.status} ${fmt(cRes.body.pricePaid ?? 0)}`);
delta = before - (await bal(b4));
check('buyer 4 balance fell by exactly $0.75', delta === usd(0.75), `fell by ${fmt(delta)}`);

// ── settle, claim, conservation ──────────────────────────────────────────────────
process.stdout.write('\nwaiting for the deadline (chain time)');
while (Number((await pub.getBlock()).timestamp) < Number(deadline)) { process.stdout.write('.'); await new Promise((r) => setTimeout(r, 15_000)); }
console.log(' reached');

const s = await send('settle', supplier, { address: SETTLER, abi: SETTLER_ABI, functionName: 'settle', args: [dealId] });
const ev = s.logs.map((l) => { try { return decodeEventLog({ abi: SETTLER_ABI, data: l.data, topics: l.topics }); } catch { return null; } }).find((e) => e?.eventName === 'Settled');
// Remaining: buyer 1 ($1.00), buyer 4 ($0.75). Two buyers clear at $0.75.
check('clears at $0.75 with 2 buyers', ev.args.clearingPrice === usd(0.75) && ev.args.buyerCount === 2, `${fmt(ev.args.clearingPrice)}, ${ev.args.buyerCount}`);
const commitsIn = usd(1) + usd(0.75);
check('conservation: commits in == supplier + refunds', commitsIn === usd(0.75) * 2n + ev.args.totalRefunds, `${fmt(commitsIn)} == ${fmt(usd(0.75) * 2n)} + ${fmt(ev.args.totalRefunds)}`);

for (const [label, acct, owed] of [['supplier', supplier, usd(1.5)], ['buyer 1', b1, usd(0.25)], ['buyer 2', b2, usd(1)], ['buyer 3', b3, usd(0.75)]]) {
  const c = await claimable(acct);
  check(`${label} is owed ${fmt(owed)}`, c === owed, fmt(c));
  if (c > 0n) await send(`${label} claims`, acct, { address: SETTLER, abi: SETTLER_ABI, functionName: 'claim' });
}
const poolLeft = await bal({ address: POOL });
check('pool holds nothing once everyone has claimed', poolLeft === 0n, fmt(poolLeft));

const relayerEnd = BigInt(parseUnits(String((await (await fetch(`${RELAYER_URL}/health`)).json()).usdcBalance), 6));
console.log(`\nrelayer spent ${fmt(relayerStart - relayerEnd)} on gas for 3 relayed commits`);
record.relayerSpent = (relayerStart - relayerEnd).toString();
record.failures = failures;
writeFileSync(new URL('../secrets/gasless-run.json', import.meta.url), JSON.stringify(record, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
console.log(failures === 0 ? '\ngasless flow verified from chain\n' : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
