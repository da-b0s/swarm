// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

library SwarmTypes {
    struct Tier {
        uint32 minBuyers;
        uint64 pricePerUnit;
    }

    struct Deal {
        address supplier;
        Tier[] tiers;
        uint32 minBuyers;
        uint64 deadline;
        uint64 cap;
        uint8 state; // 0=Open, 1=Settled, 2=Refunded
    }
}
