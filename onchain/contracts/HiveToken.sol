// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title  HiveToken
 * @notice Fixed-supply ERC-20 for the Hive demo token launch on Swarm.
 *
 * This is the simplest possible honest token:
 *   - Name "Hive", symbol "HIVE", 18 decimals.
 *   - 1,000,000 HIVE minted once at construction to `recipient`.
 *   - No owner, no mint function, no burn, no pause, no blocklist, no fees,
 *     no transfer hooks that alter amounts.
 *
 * Total supply is permanently fixed at deployment and publicly verifiable.
 */
contract HiveToken is ERC20 {
    /// @dev Reverts when the constructor receives the zero address as recipient.
    error ZeroAddressRecipient();

    uint256 public constant TOTAL_SUPPLY = 1_000_000 * 10 ** 18;

    /**
     * @param recipient Address that receives the entire fixed supply.
     *                  Must not be the zero address.
     */
    constructor(address recipient) ERC20("Hive", "HIVE") {
        if (recipient == address(0)) revert ZeroAddressRecipient();
        _mint(recipient, TOTAL_SUPPLY);
    }
}
