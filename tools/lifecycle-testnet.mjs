#!/usr/bin/env node
// Run Swarm's whole lifecycle against the verified TESTNET deployment and check
// every step from chain.
//
//   Deal A (happy path)   commits break two tiers; a withdrawal the contract must
//                         refuse is checked by simulation; one more commit clears
//                         it and the same withdrawal succeeds; settle; everyone
//                         claims.
//   Deal B (failed deal)  two buyers against a minimum of three; refundAll; claims.
//
// Buyer wallets are throwaway testnet keys written to ../secrets/ (gitignored) and
// funded from the deployer, which also acts as the supplier. Testnet only: the
// script refuses any other chain.
//
//   node lifecycle-testnet.mjs            # full run, ~15 minutes (waits for deadline)
//
// Writes a JSON record of every transaction to ../secrets/lifecycle-run.json.

import {
  createPublicClient, createWalletClient, http, defineChain, parseUnits, formatUnits,
  decodeEventLog, BaseError, ContractFunctionRevertedError,
} from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

// ── network: testnet only, addresses verified by verify-deploy.mjs ──────────────
const chain = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.io'] } },
});
const EXPLORER = 'https://explorer.testnet.arc.io';
const USDC = '0x3600000000000000000000000000000000000000';
// Addresses come from ../.env, which verify-deploy.mjs output is recorded into,
// so a redeploy needs no edit here. Testnet only.
const ENV = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
if (ENV.ARC_NETWORK !== 'testnet') throw new Error(`refusing: .env ARC_NETWORK is ${ENV.ARC_NETWORK}, not testnet`);
const FACTORY = ENV.DEAL_FACTORY;
const POOL = ENV.DEMAND_POOL;
const SETTLER = ENV.SETTLER;
for (const [k, v] of Object.entries({ FACTORY, POOL, SETTLER })) if (!/^0x[0-9a-fA-F]{40}$/.test(v ?? '')) throw new Error(`${k} missing from .env`);

const abi = (name) => JSON.parse(
  readFileSync(new URL(`../onchain/contracts/out/${name}.sol/${name}.json`, import.meta.url), 'utf8'),
).abi;
const FACTORY_ABI = abi('DealFactory');
const POOL_ABI = abi('DemandPool');
const SETTLER_ABI = abi('Settler');
const ERC20_ABI = [
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
];

const usd = (n) => parseUnits(String(n), 6);
const fmt = (v) => `$${formatUnits(BigInt(v), 6)}`;

// ── keys ─────────────────────────────────────────────────────────────────────────
function envKey(name) {
  const line = readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/).find((l) => l.startsWith(name + '='));
  const v = line?.slice(name.length + 1).trim();
  if (!v || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`${name} missing from .env`);
  return v;
}

const SECRETS = new URL('../secrets/', import.meta.url);
if (!existsSync(SECRETS)) mkdirSync(SECRETS);
const BUYERS_FILE = new URL('testnet-buyers.json', SECRETS);
const buyerKeys = existsSync(BUYERS_FILE)
  ? JSON.parse(readFileSync(BUYERS_FILE, 'utf8'))
  : Array.from({ length: 6 }, () => generatePrivateKey());
writeFileSync(BUYERS_FILE, JSON.stringify(buyerKeys, null, 2));

const supplier = privateKeyToAccount(envKey('DEPLOYER_KEY'));
const buyers = buyerKeys.map((k) => privateKeyToAccount(k));

const pub = createPublicClient({ chain, transport: http() });
const wallet = (account) => createWalletClient({ account, chain, transport: http() });

// ── bookkeeping ──────────────────────────────────────────────────────────────────
const record = { startedAt: new Date().toISOString(), supplier: supplier.address, buyers: buyers.map((b) => b.address), steps: [] };
const save = () => writeFileSync(new URL('lifecycle-run.json', SECRETS), JSON.stringify(record, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
  record.steps.push({ check: label, ok, detail });
}

async function send(label, account, params) {
  const hash = await wallet(account).writeContract({ ...params, account });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  const gasUsdc = (receipt.gasUsed * receipt.effectiveGasPrice) / 10n ** 12n;
  const ok = receipt.status === 'success';
  console.log(`${ok ? 'tx  ' : 'FAIL'}  ${label.padEnd(44)} ${EXPLORER}/tx/${hash}  gas ${fmt(gasUsdc)}`);
  record.steps.push({ tx: label, hash, status: receipt.status, gasUsdc, block: receipt.blockNumber });
  save();
  if (!ok) throw new Error(`${label} reverted`);
  return receipt;
}

const logsOf = (receipt, eventAbi) => receipt.logs.flatMap((l) => {
  try { return [decodeEventLog({ abi: eventAbi, data: l.data, topics: l.topics })]; } catch { return []; }
});

const read = (address, theAbi, functionName, args = []) => pub.readContract({ address, abi: theAbi, functionName, args });
const chainNow = async () => Number((await pub.getBlock()).timestamp);

async function expectRevert(label, account, params, errorName) {
  try {
    await pub.simulateContract({ ...params, account });
    check(label, false, 'simulation succeeded; expected ' + errorName);
  } catch (e) {
    const rev = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
    const got = rev?.data?.errorName ?? rev?.reason ?? e.shortMessage;
    check(label, got === errorName, `reverts with ${got}`);
  }
}

// ── preflight ────────────────────────────────────────────────────────────────────
const chainId = await pub.getChainId();
if (chainId !== 5042002) throw new Error(`refusing: chain ${chainId} is not Arc testnet`);
if (!(await read(POOL, POOL_ABI, 'settlerSet'))) throw new Error('refusing: pool not wired');

console.log(`\nSwarm lifecycle on Arc testnet — supplier ${supplier.address}\n`);
const supplierStart = await read(USDC, ERC20_ABI, 'balanceOf', [supplier.address]);
console.log(`supplier balance ${fmt(supplierStart)}\n`);

// ── fund buyers ($2 each covers $1 escrow in A, $0.50 in B, and gas) ──────────────
for (const [i, b] of buyers.entries()) {
  const bal = await read(USDC, ERC20_ABI, 'balanceOf', [b.address]);
  if (bal < usd(2)) {
    await send(`fund buyer ${i + 1}`, supplier, { address: USDC, abi: ERC20_ABI, functionName: 'transfer', args: [b.address, usd(2) - bal] });
  }
}
for (const [i, b] of buyers.entries()) {
  await send(`approve pool, buyer ${i + 1}`, b, { address: USDC, abi: ERC20_ABI, functionName: 'approve', args: [POOL, usd(5)] });
}

// ── post both deals ──────────────────────────────────────────────────────────────
const deadline = BigInt((await chainNow()) + 15 * 60);

async function postDeal(label, tiers, minBuyers, cap) {
  const r = await send(label, supplier, {
    address: FACTORY, abi: FACTORY_ABI, functionName: 'postDeal', args: [tiers, minBuyers, deadline, cap],
  });
  const ev = logsOf(r, FACTORY_ABI).find((l) => l.eventName === 'DealPosted');
  return ev.args.dealId;
}

const A = await postDeal('post deal A ($1.00/1, $0.75/3, $0.50/5)', [
  { minBuyers: 1, pricePerUnit: usd(1) },
  { minBuyers: 3, pricePerUnit: usd(0.75) },
  { minBuyers: 5, pricePerUnit: usd(0.5) },
], 2, 10);
const B = await postDeal('post deal B ($0.50/1, minimum 3)', [{ minBuyers: 1, pricePerUnit: usd(0.5) }], 3, 5);
record.deals = { A, B, deadline };
console.log(`\ndeal A = #${A}, deal B = #${B}, deadline ${new Date(Number(deadline) * 1000).toISOString()}\n`);

// ── deal A: commits, the refused withdrawal, the cleared one ─────────────────────
const commit = async (i, deal, expectPrice) => {
  const r = await send(`deal ${deal === A ? 'A' : 'B'}: buyer ${i + 1} commits`, buyers[i], { address: POOL, abi: POOL_ABI, functionName: 'commit', args: [deal] });
  const ev = logsOf(r, POOL_ABI).find((l) => l.eventName === 'Committed');
  check(`  buyer ${i + 1} escrowed ${fmt(expectPrice)}`, ev.args.pricePaid === expectPrice, `pricePaid ${fmt(ev.args.pricePaid)}, ${ev.args.buyerCount} buyers`);
  const broke = logsOf(r, POOL_ABI).find((l) => l.eventName === 'TierBroken');
  if (broke) console.log(`      TierBroken -> ${fmt(broke.args.newPrice)} at ${broke.args.newBuyerCount} buyers`);
  return r;
};

await commit(0, A, usd(1));
await commit(1, A, usd(1));
await commit(2, A, usd(0.75)); // 3 buyers: tier breaks to $0.75

// Buyer 1 escrowed $1.00. Leaving would drop the count to 2 and the price back to
// $1.00, above buyer 3's $0.75 — the contract must refuse.
const withdrawB1 = { address: POOL, abi: POOL_ABI, functionName: 'withdraw', args: [A] };
await expectRevert('withdrawal at a tier threshold is refused', buyers[0], withdrawB1, 'WouldStrandBuyer');

await commit(3, A, usd(0.75)); // 4 buyers: one more and buyer 1 is free

const w = await send('deal A: buyer 1 withdraws (now permitted)', buyers[0], withdrawB1);
const wev = logsOf(w, POOL_ABI).find((l) => l.eventName === 'Withdrawn');
check('  withdrawal returns the full $1.00 escrow', wev.args.amountReturned === usd(1), `${fmt(wev.args.amountReturned)}, ${wev.args.buyerCount} buyers left`);

await commit(4, A, usd(0.75)); // 4 buyers
await commit(5, A, usd(0.5));  // 5 buyers: tier breaks to $0.50

// ── deal B: below its minimum ────────────────────────────────────────────────────
await commit(4, B, usd(0.5));
await commit(5, B, usd(0.5));

await expectRevert('settle before the deadline is refused', supplier, { address: SETTLER, abi: SETTLER_ABI, functionName: 'settle', args: [A] }, 'DeadlineNotReached');

// ── wait for the deadline, by chain time ─────────────────────────────────────────
process.stdout.write('\nwaiting for the deadline (chain time)');
while ((await chainNow()) < Number(deadline)) {
  process.stdout.write('.');
  await new Promise((r) => setTimeout(r, 15_000));
}
console.log(' reached\n');

await expectRevert('refundAll on a deal that met its minimum is refused', supplier, { address: SETTLER, abi: SETTLER_ABI, functionName: 'refundAll', args: [A] }, 'MinBuyersMet');
await expectRevert('settle on a deal below its minimum is refused', supplier, { address: SETTLER, abi: SETTLER_ABI, functionName: 'settle', args: [B] }, 'MinBuyersNotMet');

// ── settle A, refund B ───────────────────────────────────────────────────────────
const claimBefore = {};
for (const a of [supplier, ...buyers]) claimBefore[a.address] = await read(SETTLER, SETTLER_ABI, 'claimable', [a.address]);

const s = await send('deal A: settle', supplier, { address: SETTLER, abi: SETTLER_ABI, functionName: 'settle', args: [A] });
const sev = logsOf(s, SETTLER_ABI).find((l) => l.eventName === 'Settled');
check('clearing price is $0.50', sev.args.clearingPrice === usd(0.5), fmt(sev.args.clearingPrice));
check('5 buyers settled', sev.args.buyerCount === 5, String(sev.args.buyerCount));

// Remaining in A: buyers 2 ($1.00), 3, 4, 5 ($0.75), 6 ($0.50).
const expectedRefund = { 1: usd(0.5), 2: usd(0.25), 3: usd(0.25), 4: usd(0.25), 5: 0n };
const commitsIn = usd(1) + usd(0.75) * 3n + usd(0.5);
const supplierCredit = usd(0.5) * 5n;
check('total refunds $1.25', sev.args.totalRefunds === usd(1.25), fmt(sev.args.totalRefunds));
check('conservation: commits in == supplier credit + refunds', commitsIn === supplierCredit + sev.args.totalRefunds,
  `${fmt(commitsIn)} == ${fmt(supplierCredit)} + ${fmt(sev.args.totalRefunds)}`);

const supplierAfterSettle = await read(SETTLER, SETTLER_ABI, 'claimable', [supplier.address]);
check('supplier credited clearing x buyers = $2.50', supplierAfterSettle - claimBefore[supplier.address] === supplierCredit, fmt(supplierAfterSettle - claimBefore[supplier.address]));
for (const [i, want] of Object.entries(expectedRefund)) {
  const b = buyers[i];
  const got = (await read(SETTLER, SETTLER_ABI, 'claimable', [b.address])) - claimBefore[b.address];
  check(`  buyer ${+i + 1} refunded ${fmt(want)}`, got === want, fmt(got));
}

const rb = await send('deal B: refundAll', supplier, { address: SETTLER, abi: SETTLER_ABI, functionName: 'refundAll', args: [B] });
const refunded = logsOf(rb, SETTLER_ABI).filter((l) => l.eventName === 'Refunded');
check('deal B refunds both buyers in full', refunded.length === 2 && refunded.every((l) => l.args.amount === usd(0.5)),
  refunded.map((l) => fmt(l.args.amount)).join(', '));

await expectRevert('a settled deal cannot be settled twice', supplier, { address: SETTLER, abi: SETTLER_ABI, functionName: 'settle', args: [A] }, 'AlreadySettled');

// ── everyone claims ──────────────────────────────────────────────────────────────
console.log('');
for (const [label, a] of [['supplier', supplier], ...buyers.map((b, i) => [`buyer ${i + 1}`, b])]) {
  const owed = await read(SETTLER, SETTLER_ABI, 'claimable', [a.address]);
  if (owed === 0n) { console.log(`      ${label} has nothing to claim`); continue; }
  const before = await read(USDC, ERC20_ABI, 'balanceOf', [a.address]);
  const r = await send(`${label} claims ${fmt(owed)}`, a, { address: SETTLER, abi: SETTLER_ABI, functionName: 'claim' });
  const after = await read(USDC, ERC20_ABI, 'balanceOf', [a.address]);
  const gas = (r.gasUsed * r.effectiveGasPrice) / 10n ** 12n;
  // gas is paid in the same USDC, so the ERC-20 view moves by owed minus gas (to 6dp)
  const delta = after - before + gas;
  check(`  ${label} received the full claim`, delta >= owed - 1n && delta <= owed + 1n, `${fmt(owed)} owed, balance moved ${fmt(after - before)} after ${fmt(gas)} gas`);
}

const poolLeft = await read(USDC, ERC20_ABI, 'balanceOf', [POOL]);
check('pool holds nothing once everyone has claimed', poolLeft === 0n, fmt(poolLeft));

record.finishedAt = new Date().toISOString();
record.failures = failures;
save();
console.log(`\n${failures === 0 ? 'lifecycle verified from chain' : failures + ' check(s) failed'}\n`);
process.exit(failures === 0 ? 0 : 1);
