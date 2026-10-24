// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

library SwarmTypes {
    /// @dev Price tier: a volume threshold in units and the per-unit price it unlocks.
    struct Tier {
        uint32 minUnits;      // total-units threshold at which this price activates
        uint64 pricePerUnit;  // USDC micro-units (6 decimals) per unit ordered
    }

    struct Deal {
        address supplier;
        address goodsToken;         // ERC-20 being sold
        uint256 tokensPerUnit;      // token base units delivered per unit bought
        Tier[]  tiers;
        uint32  minUnits;           // deal minimum; below this at deadline → refundAll
        uint32  maxUnits;           // stock: deposited and cap on units sold
        uint32  maxUnitsPerBuyer;   // 0 = no per-buyer limit
        uint32  maxBuyers;          // 1–100; bounds the settlement loop
        uint64  deadline;           // unix seconds
        uint8   state;              // 0=Open, 1=Settled, 2=Refunded
        string  title;              // ≤ 80 bytes
        string  description;        // ≤ 500 bytes
    }
}
