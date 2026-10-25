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

    /// @dev Blocked addresses cannot receive tokens via transfer().
    ///      Returns false instead of transferring, matching real USDC behaviour.
    function transfer(address to, uint256 amount) public virtual override returns (bool) {
        if (_blocked[to]) return false;
        _transfer(msg.sender, to, amount);
        return true;
    }
}
