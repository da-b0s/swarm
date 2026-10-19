#!/usr/bin/env node
// Generate PROOF.md tables and the commits-over-time series from chain events.
//
// Reads nothing by hand: every number below comes from logs on Arc. Run it after
// each proof phase and paste the output into ../PROOF.md, or redirect it there.
//
//   node proof.mjs --network testnet --from 0
//   node proof.mjs --network mainnet --addresses 0xpool,0xsettler > ../PROOF.generated.md
//   node proof.mjs --network mainnet --chart > ../docs/commits.json
//
// Addresses come from --addresses, or from DEMAND_POOL / SETTLER / DEAL_FACTORY /
// COMMIT_RELAYER in ../.env (gitignored - never commit addresses alongside keys).

import { createPublicClient, http, parseAbi, formatUnits, getAddress } from 'viem';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { SWARM_EVENTS, ARC } from './events.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i === -1 ? d : argv[i + 1]; };
const has = (k) => argv.includes(k);

const net = ARC[arg('--network', 'mainnet')];
if (!net) { console.error('--network must be mainnet or testnet'); process.exit(1); }

// ---- addresses -------------------------------------------------------------
function fromEnvFile() {
  const p = '../.env';
  if (!existsSync(p)) return [];
  const keys = ['DEAL_FACTORY', 'DEMAND_POOL', 'SETTLER', 'COMMIT_RELAYER'];
  return readFileSync(p, 'utf8').split('\n')
    .map((l) => l.trim())
    .filter((l) => keys.some((k) => l.startsWith(k + '=')))
    .map((l) => l.split('=')[1]?.trim())
    .filter((v) => /^0x[0-9a-fA-F]{40}$/.test(v));
}

const addresses = [...new Set(
  arg('--addresses', '').split(',').filter(Boolean).concat(fromEnvFile()).map(getAddress)
)];

if (addresses.length === 0) {
  console.error('No contract addresses. Pass --addresses 0x..,0x.. or fill ../.env.');
  console.error('Nothing is deployed yet, so this is expected before the first deploy.');
  process.exit(2);
}

// ---- abi: prefer the real one pulled from Studio ---------------------------
function discoverAbi(dir) {
  if (!existsSync(dir)) return null;
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = d + '/' + e.name;
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.json')) {
        try {
          const j = JSON.parse(readFileSync(p, 'utf8'));
          const abi = Array.isArray(j) ? j : j.abi;
          if (Array.isArray(abi)) out.push(...abi.filter((x) => x.type === 'event'));
        } catch { /* not a contract artifact */ }
      }
    }
  };
  try { walk(dir); } catch { return null; }
  return out.length ? out : null;
}

const discovered = discoverAbi('../onchain');
const abi = discovered ?? parseAbi(SWARM_EVENTS);
if (!discovered) {
  console.error('note: using declared event signatures; no ABIs found under ../onchain yet');
}

const chain = {
  id: net.id,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [net.rpc] } },
};
const client = createPublicClient({ chain, transport: http(net.rpc) });

// ---- fetch -----------------------------------------------------------------
const toBlock = await client.getBlockNumber();

// Arc produces a block every ~0.5s, so the chain is tens of millions of blocks
// deep. Never scan from genesis: start at the block the contracts were deployed
// in. Put DEPLOY_BLOCK in ../.env once deployed, or pass --from.
function deployBlockFromEnv() {
  const p = '../.env';
  if (!existsSync(p)) return null;
  const line = readFileSync(p, 'utf8').split('\n')
    .map((l) => l.trim()).find((l) => l.startsWith('DEPLOY_BLOCK='));
  const v = line?.split('=')[1]?.trim();
  return v && /^\d+$/.test(v) ? BigInt(v) : null;
}

const fromArg = arg('--from', null);
const fromBlock = fromArg !== null ? BigInt(fromArg) : (deployBlockFromEnv() ?? null);
if (fromBlock === null) {
  console.error('No start block. Pass --from <deployBlock> or set DEPLOY_BLOCK in ../.env.');
  console.error('Head is block ' + toBlock + ' at ~0.5s/block; scanning from 0 would be tens of');
  console.error('thousands of requests. Record the deploy block when you deploy.');
  process.exit(2);
}

const span = toBlock - fromBlock;
if (span > 5_000_000n) {
  console.error('warning: ' + span + ' blocks to scan (~' +
    (Number(span) * 0.506 / 86400).toFixed(1) + ' days of chain). Narrow --from if this is wrong.');
}

// Adaptive windowing: start wide, halve on a provider range/limit error.
const logs = [];
for (const address of addresses) {
  let step = BigInt(arg('--step', '5000'));
  let b = fromBlock;
  while (b <= toBlock) {
    const last = b + step - 1n > toBlock ? toBlock : b + step - 1n;
    try {
      logs.push(...await client.getLogs({ address, events: abi, fromBlock: b, toBlock: last }));
      b = last + 1n;
    } catch (e) {
      if (step <= 1000n) throw e;
      step /= 2n;
      console.error('window too wide at block ' + b + ', retrying with ' + step + ' blocks');
    }
  }
}
logs.sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);

const by = (name) => logs.filter((l) => l.eventName === name);
const usd = (v) => '$' + Number(formatUnits(v ?? 0n, 6)).toFixed(2);
const txLink = (h) => '[`' + h.slice(0, 10) + '...`](' + net.explorer + '/tx/' + h + ')';

const commits = by('Committed');
const settles = by('Settled');
const refunds = by('Refunded');
const claims = by('Claimed');
const breaks = by('TierBroken');
const withdrawals = by('Withdrawn');

const sumOf = (rows, key) => rows.reduce((a, l) => a + (l.args[key] ?? 0n), 0n);
const forDeal = (rows, id) => rows.filter((l) => String(l.args.dealId) === id);

// ---- chart mode ------------------------------------------------------------
if (has('--chart')) {
  const series = commits.map((l) => ({
    block: Number(l.blockNumber),
    dealId: String(l.args.dealId),
    buyerCount: Number(l.args.buyerCount ?? 0),
    livePrice: Number(formatUnits(l.args.livePrice ?? 0n, 6)),
  }));
  const tierBreaks = breaks.map((l) => ({
    block: Number(l.blockNumber),
    dealId: String(l.args.dealId),
    buyerCount: Number(l.args.buyerCount ?? 0),
    newPrice: Number(formatUnits(l.args.newPrice ?? 0n, 6)),
  }));
  console.log(JSON.stringify({ network: net.id, series, tierBreaks }, null, 2));
  process.exit(0);
}

// ---- report ----------------------------------------------------------------
const wallets = new Set(
  [...commits.map((l) => l.args.buyer), ...claims.map((l) => l.args.account)]
    .filter(Boolean).map((a) => a.toLowerCase())
);
const moved = sumOf(commits, 'pricePaid') + sumOf(claims, 'amount');

console.log('# Proof - read from chain ' + new Date().toISOString().slice(0, 10) + '\n');
console.log('Chain ' + net.id + ' - blocks ' + fromBlock + '-' + toBlock + ' - explorer: ' + net.explorer + '\n');

console.log('## Totals\n');
console.log('| Metric | Value |');
console.log('|---|---|');
console.log('| USDC moved | ' + usd(moved) + ' |');
console.log('| Distinct wallets | ' + wallets.size + ' |');
console.log('| Commits | ' + commits.length + ' |');
console.log('| Withdrawals | ' + withdrawals.length + ' |');
console.log('| Tier breaks | ' + breaks.length + ' |');
console.log('| Deals settled | ' + settles.length + ' |');
console.log('| Refund legs | ' + refunds.length + ' |');
console.log('| Claims | ' + claims.length + ' |');
console.log('| Total events | ' + logs.length + ' |');

console.log('\n## Settlements\n');
console.log('| Deal | Clearing | Buyers | Supplier credited | Settlement tx |');
console.log('|---|---|---|---|---|');
for (const s of settles) {
  const credited = (s.args.clearingPrice ?? 0n) * BigInt(s.args.buyerCount ?? 0);
  console.log('| ' + s.args.dealId + ' | ' + usd(s.args.clearingPrice) + ' | ' +
    s.args.buyerCount + ' | ' + usd(credited) + ' | ' + txLink(s.transactionHash) + ' |');
}

console.log('\n## Conservation, checked on chain\n');
console.log('For each settled deal: supplier credit + all refunds == sum of commits.\n');
console.log('| Deal | Commits in | Supplier credited | Refunds | Exact |');
console.log('|---|---|---|---|---|');

let broken = false;
for (const s of settles) {
  const id = String(s.args.dealId);
  const inSum = sumOf(forDeal(commits, id), 'pricePaid');
  const refSum = sumOf(forDeal(refunds, id), 'amount');
  const supplier = (s.args.clearingPrice ?? 0n) * BigInt(s.args.buyerCount ?? 0);
  const ok = supplier + refSum === inSum;
  if (!ok) broken = true;
  console.log('| ' + id + ' | ' + usd(inSum) + ' | ' + usd(supplier) + ' | ' + usd(refSum) +
    ' | ' + (ok ? '**yes**' : 'NO (off by ' + usd(inSum - supplier - refSum) + ')') + ' |');
}

if (broken) {
  console.error('\nCONSERVATION BROKEN ON CHAIN - do not submit until this is understood');
  process.exit(1);
}
