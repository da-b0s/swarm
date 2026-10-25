#!/usr/bin/env node
// Post an open Swarm Pass deal on TESTNET for hands-on testing, then check the
// relayer names a mismatched signature (simulation only — nothing is sent).

import { makeRecorder, ensurePasses, postPassDeal, signOrder, buyers, usd, pub } from './lib-v2.mjs';

const rec = makeRecorder('open-deal');
if ((await pub.getChainId()) !== 5042002) throw new Error('not testnet');
await ensurePasses(rec, 50);
const { dealId, deadline } = await postPassDeal(rec, 'open deal', {
  tiers: [[1, 0.30], [10, 0.20], [25, 0.10]],
  minUnits: 5, maxUnits: 50, maxUnitsPerBuyer: 20, maxBuyers: 50, minutes: 24 * 60,
  title: 'Swarm Pass — community drop',
  description: 'Fifty Swarm Passes. $0.30 each, falling to $0.20 once 10 are ordered and $0.10 at 25 — for everyone, including earlier buyers. Passes are delivered when the deal settles.',
});
console.log(`\nopen deal #${dealId}, closes ${new Date(Number(deadline) * 1000).toISOString()}`);

// A signature for 1 unit at $0.30, submitted as 2 units at the same amount: the
// relayer must refuse it in simulation and name the error.
const sig = await signOrder(buyers[0], dealId, 1, usd(0.60));
const r = await fetch('http://localhost:8787/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...sig, units: 2 }) });
const body = await r.json();
rec.check('a mismatched signature is refused as InvalidAuthorization', r.status === 400 && body.error === 'InvalidAuthorization', `${r.status} ${JSON.stringify(body)}`);
rec.done();
