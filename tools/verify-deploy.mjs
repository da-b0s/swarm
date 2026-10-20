#!/usr/bin/env node
// Verify a Swarm deployment from chain, independently of what Studio reported.
//
// Studio's result document lists addresses it believes it deployed. That is its
// own prose, not attested fact, and in one turn it deployed two complete sets of
// contracts and left the wiring undone while reporting success. So nothing goes
// into README.md or PROOF.md until this script agrees.
//
//   node verify-deploy.mjs --network testnet --factory 0x.. --pool 0x.. --settler 0x..
//   node verify-deploy.mjs --network mainnet          # reads ../.env
//
// Exit 0 only when every check passes.

import { createPublicClient, http, getAddress, formatUnits } from 'viem';
import { readFileSync, existsSync } from 'node:fs';
import { ARC } from './events.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i === -1 ? d : argv[i + 1]; };

const net = ARC[arg('--network', 'testnet')];
if (!net) { console.error('--network must be mainnet or testnet'); process.exit(1); }

function fromEnv(key) {
  const p = '../.env';
  if (!existsSync(p)) return null;
  const line = readFileSync(p, 'utf8').split('\n')
    .map((l) => l.trim()).find((l) => l.startsWith(key + '='));
  const v = line?.split('=')[1]?.trim();
  return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? v : null;
}

const addr = {
  factory: arg('--factory', null) ?? fromEnv('DEAL_FACTORY'),
  pool: arg('--pool', null) ?? fromEnv('DEMAND_POOL'),
  settler: arg('--settler', null) ?? fromEnv('SETTLER'),
};

for (const [k, v] of Object.entries(addr)) {
  if (!v) {
    console.error(`missing ${k}: pass --${k} 0x.. or set it in ../.env`);
    process.exit(2);
  }
}

const chain = {
  id: net.id, name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [net.rpc] } },
};
const client = createPublicClient({ chain, transport: http(net.rpc) });

const view = (name, outputs) => [{
  name, type: 'function', stateMutability: 'view', inputs: [], outputs,
}];
const A = (t) => [{ type: t }];

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

console.log(`\nArc ${arg('--network', 'testnet')} (chain ${net.id}) — ${net.explorer}\n`);

// ---- 1. code is actually there -------------------------------------------
const sizes = {};
for (const [name, a] of Object.entries(addr)) {
  const code = await client.getCode({ address: getAddress(a) });
  const bytes = code && code !== '0x' ? (code.length - 2) / 2 : 0;
  sizes[name] = bytes;
  check(`${name} has bytecode`, bytes > 0, `${a} — ${bytes} bytes`);
}

// ---- 2. the three wiring calls landed ------------------------------------
let wiredPool = null, wiredSettler = null, settlerSet = null;
try {
  [wiredPool, wiredSettler, settlerSet] = await Promise.all([
    client.readContract({ address: getAddress(addr.factory), abi: view('demandPool', A('address')), functionName: 'demandPool' }),
    client.readContract({ address: getAddress(addr.factory), abi: view('settler', A('address')), functionName: 'settler' }),
    client.readContract({ address: getAddress(addr.pool), abi: view('settlerSet', A('bool')), functionName: 'settlerSet' }),
  ]);
} catch (e) {
  check('wiring is readable', false, (e.shortMessage || e.message).slice(0, 90));
}

const eq = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();
check('DealFactory.demandPool -> DemandPool', eq(wiredPool, addr.pool),
  wiredPool ?? 'unreadable');
check('DealFactory.settler -> Settler', eq(wiredSettler, addr.settler),
  wiredSettler ?? 'unreadable');
check('DemandPool.settlerSet', settlerSet === true, String(settlerSet));

// ---- 3. the pool agrees about the factory, and the settler about both ----
for (const [label, at, fn, expect] of [
  ['DemandPool.factory -> DealFactory', addr.pool, 'factory', addr.factory],
  ['DemandPool.settler -> Settler', addr.pool, 'settler', addr.settler],
  ['Settler.factory -> DealFactory', addr.settler, 'factory', addr.factory],
  ['Settler.pool -> DemandPool', addr.settler, 'pool', addr.pool],
]) {
  try {
    const got = await client.readContract({
      address: getAddress(at), abi: view(fn, A('address')), functionName: fn,
    });
    check(label, eq(got, expect), got);
  } catch (e) {
    check(label, false, (e.shortMessage || e.message).slice(0, 60));
  }
}

// ---- 4. USDC is the predeploy we expect ----------------------------------
for (const [label, at] of [['DemandPool', addr.pool], ['Settler', addr.settler]]) {
  try {
    const usdc = await client.readContract({
      address: getAddress(at), abi: view('USDC', A('address')), functionName: 'USDC',
    });
    check(`${label}.USDC -> Arc predeploy`, eq(usdc, net.usdc), usdc);
  } catch (e) {
    check(`${label}.USDC readable`, false, (e.shortMessage || e.message).slice(0, 60));
  }
}

// ---- 5. state sanity ------------------------------------------------------
try {
  const count = await client.readContract({
    address: getAddress(addr.factory), abi: view('dealCount', A('uint256')), functionName: 'dealCount',
  });
  console.log(`\n      dealCount ${count}`);
  const paused = await client.readContract({
    address: getAddress(addr.factory), abi: view('paused', A('bool')), functionName: 'paused',
  });
  check('DealFactory is not paused', paused === false, String(paused));

  // Escrow held by the pool should be zero on a fresh deployment.
  const bal = await client.readContract({
    address: getAddress(net.usdc),
    abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
    functionName: 'balanceOf', args: [getAddress(addr.pool)],
  });
  console.log(`      pool USDC balance $${Number(formatUnits(bal, 6)).toFixed(6)}`);
} catch (e) {
  check('factory state readable', false, (e.shortMessage || e.message).slice(0, 80));
}

console.log('');
if (failures) {
  console.error(`${failures} check(s) failed — do not record these addresses anywhere yet`);
  process.exit(1);
}
console.log('deployment verified from chain');
console.log('\nrecord in ../.env:');
console.log(`DEAL_FACTORY=${addr.factory}`);
console.log(`DEMAND_POOL=${addr.pool}`);
console.log(`SETTLER=${addr.settler}`);
