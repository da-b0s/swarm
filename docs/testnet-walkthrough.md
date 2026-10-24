# Trying Swarm on testnet yourself

Everything here is Arc **testnet**: free test USDC, nothing of value. The
contracts are the exact bytecode mainnet will get.

## Setup (about 10 minutes, once)

1. **A wallet with a fresh account.** MetaMask or Rabby, in a browser profile you
   use for testing. Make a new account for this — do not use one that holds real
   funds. For the full test you want **two** accounts, so you can be two buyers.
2. **Add Arc Testnet.** The app has an add-network button; or add it by hand:
   chain id `5042002`, RPC `https://rpc.testnet.arc.io`, currency `USDC` with 18
   decimals, explorer `https://explorer.testnet.arc.io`.
3. **Get test USDC** at https://faucet.circle.com — choose Arc Testnet and paste
   your account address. Do this for both accounts. On Arc, USDC is also the gas,
   so this one balance covers everything.
4. **Run it** (Claude can start these for you):
   - relayer, from `relayer/`, with the testnet settings in [hosting.md](hosting.md)
   - frontend: `cd web && npm run dev`, then open http://localhost:5173

**Deal #4** is open on testnet for you to join until 25 October, 15:50 UTC:
$0.30 at 1 buyer, $0.20 at 2, $0.10 at 3, minimum 2. Its tiers are close together
so two accounts are enough to see the price drop. You can also post your own from
**Post**.

## What to check

Tick each one. Anything that looks wrong, note it — that is the point of this.

**Logged out**
- [ ] With no wallet connected you see the live price, the buyer count, and a
      countdown. Nothing asks you to connect until you try to commit.

**Joining without gas** (account 1)
- [ ] The commit panel offers joining gaslessly, showing the exact price.
- [ ] Your wallet asks for a **signature**, not a transaction — no gas fee shown.
- [ ] Afterwards your USDC balance fell by **exactly the price**, nothing more.
- [ ] You appear at the top of **Activity**, at the price you paid.

**Joining the normal way** (account 2, using the fallback link)
- [ ] It asks you to approve, then to commit — two wallet steps, with progress shown.
- [ ] If your commit takes the deal past a tier, the big price **drops** with an
      animation, for everyone, including account 1.
- [ ] Account 1's panel now shows a refund waiting at the new price.

**Withdrawing**
- [ ] When the buyer count sits exactly on a tier threshold, the withdraw button
      is **disabled with a plain explanation** rather than letting you sign a
      transaction that would fail.
- [ ] Off a threshold, withdrawing works and returns your full escrow to claim.

**Posting a deal** (Post)
- [ ] The tier builder rejects bad curves before you can post: prices not
      falling, a price above $5, a cap above 100.
- [ ] The curve chart updates as you type.
- [ ] Post one with a short duration (0.1 hours = 6 minutes), join it, wait it
      out, then **Settle** and **Claim** from the deal room.

**Proof**
- [ ] **Scan events** finishes in well under a minute and shows each settled deal
      with "Conservation verified": commits in = supplier + refunds.

**Phone**
- [ ] Open it at phone width (or on your phone, on the same network): nothing is
      cut off, the wallet button fits.

## Already verified by script

So you can focus on how it feels rather than whether the sums are right:
[`tools/lifecycle-testnet.mjs`](../tools/lifecycle-testnet.mjs) and
[`tools/gasless-testnet.mjs`](../tools/gasless-testnet.mjs) drive every path
above against this deployment and check each balance, refund, event and the
pool's final $0 from chain.

## Known issues

Found while setting this up; to be fixed in one Studio turn together with
anything found in the walkthrough.

1. **The next-tier hint is wrong before the first tier is reached.** On a deal with
   no buyers yet, the progress line reads "1 more buyer and everyone pays $0.30"
   and the share line "your price drops to $0.30" — but the price is already
   $0.30. It picks the first tier rather than the next *cheaper* one. It should
   read "2 more buyers and everyone pays $0.20". Correct once past the first
   threshold.
