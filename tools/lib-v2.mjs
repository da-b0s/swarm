// Shared helpers for the v2 testnet end-to-end scripts. Testnet only: addresses
// come from ../.env and everything refuses to run unless ARC_NETWORK=testnet.

import {
  createPublicClient, createWalletClient, http, defineChain, parseUnits, formatUnits,
  decodeEventLog, toHex, BaseError, ContractFunctionRevertedError,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

// FORK_RPC runs everything against a LOCAL fork of Arc mainnet (arc-anvil), using
// the addresses in FORK_ADDRESSES. It must be a localhost URL, so these scripts can
// never send to real mainnet.
export const FORK_RPC = process.env.FORK_RPC;
if (FORK_RPC && !['127.0.0.1', 'localhost'].includes(new URL(FORK_RPC).hostname)) throw new Error('FORK_RPC must be a localhost fork');
export const chain = FORK_RPC
  ? defineChain({ id: 5042, name: 'Arc mainnet (local fork)', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [FORK_RPC] } } })
  : defineChain({ id: 5042002, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.testnet.arc.io'] } } });
export const EXPLORER = FORK_RPC ? 'fork' : 'https://explorer.testnet.arc.io';
export const USDC = '0x3600000000000000000000000000000000000000';

export const ENV = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
if (!FORK_RPC && ENV.ARC_NETWORK !== 'testnet') throw new Error(`refusing: .env ARC_NETWORK is ${ENV.ARC_NETWORK}, not testnet`);
const EURC_MAINNET = '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1';
const FORK = FORK_RPC ? JSON.parse(readFileSync(process.env.FORK_ADDRESSES, 'utf8')) : null;
export const FACTORY = FORK?.factory ?? ENV.DEAL_FACTORY, POOL = FORK?.pool ?? ENV.DEMAND_POOL, SETTLER = FORK?.settler ?? ENV.SETTLER, PASS = FORK ? EURC_MAINNET : ENV.SWARM_PASS;
// Goods per unit, in base units: 1 Swarm Pass on testnet (0 decimals), 1 EURC on the mainnet fork (6 decimals).
export const TPU = FORK ? 10n ** 6n : 1n;
export const GOODS = FORK ? 'EURC' : 'PASS';
for (const [k, v] of Object.entries({ FACTORY, POOL, SETTLER, PASS })) if (!/^0x[0-9a-fA-F]{40}$/.test(v ?? '')) throw new Error(`${k} missing from .env`);

const abi = (n) => JSON.parse(readFileSync(new URL(`../onchain/contracts/out/${n}.sol/${n}.json`, import.meta.url), 'utf8')).abi;
export const FACTORY_ABI = abi('DealFactory'), POOL_ABI = abi('DemandPool'), SETTLER_ABI = abi('Settler'), PASS_ABI = abi('SwarmPass');
export const ERC20_ABI = [
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
];

export const usd = (n) => parseUnits(String(n), 6);
export const fmt = (v) => `$${formatUnits(BigInt(v), 6)}`;

export const supplier = privateKeyToAccount(ENV.DEPLOYER_KEY);
export const buyers = JSON.parse(readFileSync(new URL('../secrets/testnet-buyers.json', import.meta.url), 'utf8')).map((k) => privateKeyToAccount(k));

export const pub = createPublicClient({ chain, transport: http(undefined, { timeout: 30_000, retryCount: 3 }) });
const wallet = (account) => createWalletClient({ account, chain, transport: http(undefined, { timeout: 30_000, retryCount: 3 }) });
export const read = (address, a, functionName, args = []) => pub.readContract({ address, abi: a, functionName, args });
export const usdcOf = (a) => read(USDC, ERC20_ABI, 'balanceOf', [a.address ?? a]);
export const passOf = (a) => read(PASS, ERC20_ABI, 'balanceOf', [a.address ?? a]);
export const chainNow = async () => Number((await pub.getBlock()).timestamp);

export function makeRecorder(name) {
  const record = { startedAt: new Date().toISOString(), steps: [] };
  let failures = 0;
  const save = () => writeFileSync(new URL(`../secrets/${name}.json`, import.meta.url), JSON.stringify(record, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  return {
    record, save,
    check(label, ok, detail = '') {
      console.log(`${ok ? 'pass' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
      if (!ok) failures++;
      record.steps.push({ check: label, ok, detail }); save();
    },
    async send(label, account, params) {
      const hash = await wallet(account).writeContract({ ...params, account });
      const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      console.log(`${r.status === 'success' ? 'tx  ' : 'FAIL'}  ${label.padEnd(48)} ${EXPLORER}/tx/${hash}`);
      record.steps.push({ tx: label, hash, status: r.status }); save();
      if (r.status !== 'success') throw new Error(`${label} reverted`);
      return r;
    },
    async expectRevert(label, account, params, errorName) {
      try {
        await pub.simulateContract({ ...params, account });
        this.check(label, false, 'simulation succeeded; expected ' + errorName);
      } catch (e) {
        const rev = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
        const got = rev?.data?.errorName ?? rev?.reason ?? e.shortMessage;
        this.check(label, got === errorName, `reverts with ${got}`);
      }
    },
    done() {
      record.finishedAt = new Date().toISOString(); record.failures = failures; save();
      console.log(failures === 0 ? '\nverified from chain\n' : `\n${failures} check(s) failed\n`);
      process.exit(failures === 0 ? 0 : 1);
    },
  };
}

export const events = (receipt, a) => receipt.logs.flatMap((l) => { try { return [decodeEventLog({ abi: a, data: l.data, topics: l.topics })]; } catch { return []; } });

// Make sure the supplier holds at least `need` passes, using the faucet once if not.
export async function ensurePasses(rec, need) {
  let have = await passOf(supplier);
  if (FORK) {   // EURC cannot be minted: the fork setup gives the supplier EURC from a real holder
    rec.check(`supplier holds at least ${need} EURC`, have >= BigInt(need) * TPU, `${Number(have) / 1e6} EURC`);
    return;
  }
  if (have < BigInt(need)) {
    const faucetOn = await pub.readContract({ address: PASS, abi: PASS_ABI, functionName: 'faucetEnabled' });
    if (faucetOn) await rec.send('supplier takes 100 passes from the faucet', supplier, { address: PASS, abi: PASS_ABI, functionName: 'faucet' });
    else await rec.send(`owner mints ${need} passes (faucet is off)`, supplier, { address: PASS, abi: PASS_ABI, functionName: 'mint', args: [supplier.address, BigInt(need)] });
    have = await passOf(supplier);
  }
  rec.check(`supplier holds at least ${need} passes`, have >= BigInt(need), `${have} PASS`);
}

// Post a pass deal; returns its id. `tiers` are [minUnits, priceUsd] pairs.
export async function postPassDeal(rec, label, { tiers, minUnits, maxUnits, maxUnitsPerBuyer = 0, maxBuyers = 10, minutes = 10, title, description = '' }) {
  await rec.send(`${label}: approve factory for ${maxUnits} passes`, supplier, { address: PASS, abi: ERC20_ABI, functionName: 'approve', args: [FACTORY, BigInt(maxUnits) * TPU] });
  const deadline = BigInt((await chainNow()) + minutes * 60);
  const r = await rec.send(`${label}: post`, supplier, {
    address: FACTORY, abi: FACTORY_ABI, functionName: 'postDeal',
    args: [
      { goodsToken: PASS, tokensPerUnit: TPU, minUnits, maxUnits, maxUnitsPerBuyer, maxBuyers, deadline, title, description },
      tiers.map(([u, p]) => ({ minUnits: u, pricePerUnit: usd(p) })),
    ],
  });
  const ev = events(r, FACTORY_ABI).find((e) => e.eventName === 'DealPosted');
  return { dealId: ev.args.dealId, deadline };
}

export async function waitForDeadline(deadline) {
  process.stdout.write('\nwaiting for the deadline (chain time)');
  if (FORK_RPC) {   // local fork only: jump the fork's clock instead of waiting
    await pub.request({ method: 'evm_setNextBlockTimestamp', params: [Number(deadline) + 1] });
    await pub.request({ method: 'evm_mine', params: [] });
  }
  while ((await chainNow()) < Number(deadline)) { process.stdout.write('.'); await new Promise((r) => setTimeout(r, 15_000)); }
  console.log(' reached\n');
}

// Sign a v2 ReceiveWithAuthorization exactly as the frontend does.
export async function signOrder(buyer, dealId, units, amount) {
  const salt = toHex(randomBytes(32));
  const nonce = await read(POOL, POOL_ABI, 'authorizationNonce', [dealId, buyer.address, units, salt]);
  const validBefore = BigInt((await chainNow()) + 600);
  const signature = await buyer.signTypedData({
    domain: { name: 'USDC', version: '2', chainId: chain.id, verifyingContract: USDC },
    types: { ReceiveWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ] },
    primaryType: 'ReceiveWithAuthorization',
    message: { from: buyer.address, to: POOL, value: amount, validAfter: 0n, validBefore, nonce },
  });
  return { dealId: dealId.toString(), buyer: buyer.address, units, authorizedAmount: amount.toString(), validAfter: '0', validBefore: validBefore.toString(), salt, signature };
}

// Claim everything an account is owed, checking each balance moves by exactly that.
export async function claimAll(rec, label, account, expectUsdc, expectPass) {
  const owedUsdc = await read(SETTLER, SETTLER_ABI, 'claimable', [account.address]);
  const owedPass = await read(SETTLER, SETTLER_ABI, 'goodsClaimable', [PASS, account.address]);
  rec.check(`${label} is owed ${fmt(expectUsdc)} and ${expectPass} ${GOODS}`, owedUsdc === expectUsdc && owedPass === BigInt(expectPass) * TPU, `${fmt(owedUsdc)}, ${owedPass} base units`);
  if (owedUsdc > 0n) {
    const before = await usdcOf(account);
    const r = await rec.send(`${label} claims USDC`, account, { address: SETTLER, abi: SETTLER_ABI, functionName: 'claim' });
    const gas = (r.gasUsed * r.effectiveGasPrice) / 10n ** 12n;
    const delta = (await usdcOf(account)) - before + gas;
    rec.check(`  ${label} received the full USDC claim`, delta >= owedUsdc - 1n && delta <= owedUsdc + 1n, `${fmt(owedUsdc)} owed`);
  }
  if (owedPass > 0n) {
    const before = await passOf(account);
    await rec.send(`${label} claims passes`, account, { address: SETTLER, abi: SETTLER_ABI, functionName: 'claimGoods', args: [PASS] });
    rec.check(`  ${label} received exactly ${owedPass} PASS`, (await passOf(account)) - before === owedPass);
  }
}

// Every contract empty: no USDC in pool or settler, no passes in factory or settler.
export async function checkEmpty(rec) {
  const left = { pool: await usdcOf(POOL), settlerUsdc: await usdcOf(SETTLER), settlerPass: await passOf(SETTLER), factoryPass: await passOf(FACTORY) };
  rec.check('contracts hold no USDC and no passes after every claim',
    Object.values(left).every((v) => v === 0n),
    `pool ${fmt(left.pool)}, settler ${fmt(left.settlerUsdc)} + ${left.settlerPass} PASS, factory ${left.factoryPass} PASS`);
}
