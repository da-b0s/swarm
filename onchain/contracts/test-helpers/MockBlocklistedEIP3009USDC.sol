// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MockEIP3009USDC} from "./MockEIP3009USDC.sol";

/**
 * @dev MockEIP3009USDC with a configurable blocklist for testing the
 *      Blocklisted() guard in commitWithAuthorization.
 */
contract MockBlocklistedEIP3009USDC is MockEIP3009USDC {
    mapping(address => bool) private _blocked;

    function setBlacklisted(address account, bool blocked) external {
        _blocked[account] = blocked;
    }

    function isBlacklisted(address account) external view override returns (bool) {
        return _blocked[account];
    }
}
