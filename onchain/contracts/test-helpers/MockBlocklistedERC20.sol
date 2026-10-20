// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MockERC20} from "./MockERC20.sol";

/// @dev ERC-20 where transfers TO `blocked` always revert.
///      Used in Test 15 to prove pull-payment safety.
contract MockBlocklistedERC20 is MockERC20 {
    address public blocked;

    error Blocklisted();

    constructor(address _blocked)
        MockERC20("Blocklisted USDC", "bUSDC", 6)
    {
        blocked = _blocked;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        if (to == blocked) revert Blocklisted();
        super._transfer(from, to, amount);
    }
}
