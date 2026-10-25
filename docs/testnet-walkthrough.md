# Trying Swarm v2 on testnet yourself

Everything here is Arc **testnet**: free test USDC and test passes, nothing of
value. The contracts are the exact bytecode mainnet will get.

## Setup (about 10 minutes, once)

1. **A wallet with fresh accounts.** MetaMask or Rabby, in a browser profile you
   use for testing. Make new accounts for this — not ones holding real funds. Two
   accounts lets you be two buyers; a third lets you be a supplier too.
2. **Arc Testnet** in the wallet: chain id `5042002`, RPC
   `https://rpc.testnet.arc.io`, currency `USDC` (18 decimals), explorer
   `https://explorer.testnet.arc.io`. Connecting no longer tries to switch you to
   mainnet.
3. **Test USDC** at https://faucet.circle.com — choose Arc Testnet. USDC is also
   the gas on Arc, so this one balance covers everything.
4. **If you tried the earlier version:** in MetaMask switch to Arc Testnet and
   remove `localhost:5173` under ⋮ → All permissions, then refresh.
5. App: http://localhost:5173 (Claude keeps it and the relayer running).

**Deal #5 is open until 26 October, 19:46 UTC:** fifty Swarm Passes at $0.30 each,
falling to $0.20 once 10 are ordered and $0.10 at 25, for everyone. Minimum 5,
at most 20 per buyer.

## As a buyer

- [ ] Logged out, you see the title, description, "1 unit = 1 PASS", the price,
      units sold out of 50, buyers, and a countdown.
- [ ] Pick a quantity. The total shown is the price **including your own order** —
      order 10 and it shows $0.20 each, because your order unlocks that tier.
- [ ] Join gaslessly: the wallet asks for a **signature**, no gas. Your USDC falls
      by exactly the total shown.
- [ ] From a second account, order the normal way (approve, then commit).
- [ ] Watch the price drop for both accounts when a tier is reached; the first
      account sees a refund waiting.
- [ ] Try ordering more than 20, or more than is left: the picker stops you with a
      reason.
- [ ] Order again after your first order: it **adds to** your order. The summary
      shows your total units, average price and the refund waiting; the picker
      stops at your remaining allowance.
- [ ] Withdraw: allowed normally; when it would push the price above what someone
      else paid, the button is disabled with an explanation.

## As a supplier (Post)

- [ ] Swarm Pass is pre-filled. Press **Get 100 test passes** (once a day per
      account).
- [ ] Fill in a title, description, stock, minimum, and a price curve in units;
      bad curves are rejected before you can sign.
- [ ] Post with a short duration (0.1 hours = 6 minutes): approve the passes, then
      post. Your passes leave your wallet into the deal.
- [ ] Order from another account, wait out the deadline, **Settle**, then on each
      account **Claim USDC** and **Claim PASS**. The supplier gets the USDC and
      any unsold passes back; buyers get their passes and refunds.
- [ ] Post one that misses its minimum: after the deadline, **Refund** returns
      every buyer's USDC and all the supplier's passes.

## Proof

- [ ] **Scan events** shows each finished deal with conservation verified in both
      USDC and passes.

## Already verified by script

[`tools/lifecycle-testnet.mjs`](../tools/lifecycle-testnet.mjs),
[`tools/gasless-testnet.mjs`](../tools/gasless-testnet.mjs) and
[`tools/finish-v2-runs.mjs`](../tools/finish-v2-runs.mjs) drove three deals
through this deployment: tier breaks including one by a single order, both limits,
the strand rule, a failed deal, every gasless case, and every claim — each balance
matched to the cent and the pass, and the contracts ended holding nothing.

## Not yet done

- Phones can connect only from inside a wallet app's browser; WalletConnect needs a
  free project ID from cloud.reown.com.
- Not hosted publicly yet — that waits on your choice of hosts.
