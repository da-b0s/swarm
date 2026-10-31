Two homepage changes in `src/swarm/HomePage.tsx` only. Edit in place.

1. In "How it works", remove the example figures: drop the `value` field from `HOW_STEPS` ("50 EURC deposited", "25 units: $1.17", "Everyone pays $1.15") and the large accent line that renders it. Each card keeps its step number, label and body. Make the label the card's heading (text-base, bold, ink colour) now that it is the first thing after the number.

2. Bring back the questions section under "How it works", as it was before Turn 17b: a heading "Questions" and an accordion (one open at a time, all closed at first, smooth expand, chevron that rotates; button with aria-expanded and aria-controls) styled to match the new page: inside one large rounded container like "How it works", rows separated by thin dividers. Use exactly these questions and answers (plain hyphen-free wording, no em dashes):

- What can I buy? / Deals sell assets on Arc, including EURC, GBPA, MXNB, cirBTC and WETH, paid for in USDC. Every buyer pays the same final price.
- How is the final price decided? / Each deal has price levels set by the seller, for example $1.20 each, then $1.17 once 25 are ordered. When the deal closes, the price is set by the total ordered, and everyone pays that same price. If you paid more when you joined, the difference comes back to you.
- What do I need to order? / A crypto wallet with USDC on Arc. Ordering takes one signature in your wallet. There is no separate network fee to pay.
- Can I change my mind? / Yes. While a deal is open you can add more, remove some units or cancel your whole order, and the money goes straight back to your wallet. The one exception: you cannot cancel if it would push the price back up above what another buyer has already paid.
- What happens if not enough people join? / Every deal has a minimum. If it is not reached by the deadline, the deal is cancelled and everyone is refunded in full. The seller gets their tokens back.
- When do I get my tokens? / As soon as the deal closes, usually within a minute of the deadline. A banner at the top of the site shows anything waiting for you, with a button to collect it.
- How do I sell on Swarm? / Go to Sell, choose the token you are offering, set your price levels, minimum and deadline, and post the deal. Your stock is held by the contract and anything unsold comes back to you. Your earnings are ready to collect when the deal closes.

Same spacing between sections as the rest of the page. Run the type check and the linter and paste the actual output.
