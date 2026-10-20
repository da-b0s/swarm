// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MockERC20} from "./MockERC20.sol";

interface ISettlerClaim {
    function claim() external;
}

/// @dev ERC-20 that re-enters Settler.claim() when transferring to `reentrantAddr`.
///      Used in Test 16 to verify the reentrancy guard / NothingToClaim protection.
contract MockReentrantERC20 is MockERC20 {
    address public reentrantAddr;
    address public settlerAddr;
    bool    private _inCallback;

    constructor()
        MockERC20("Reentrant USDC", "rUSDC", 6)
    {}

    function setReentrant(address _reentrantAddr, address _settlerAddr) external {
        reentrantAddr = _reentrantAddr;
        settlerAddr   = _settlerAddr;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        // Do the actual balance update first (like a normal ERC-20 would).
        super._transfer(from, to, amount);

        // Then, if the recipient is the reentrant address, call claim() again.
        // This simulates an ERC-777 / callback-capable token re-entering.
        if (to == reentrantAddr && settlerAddr != address(0) && !_inCallback) {
            _inCallback = true;
            // This second claim() call must either revert with NothingToClaim or
            // be blocked by ReentrancyGuard — either way the invariant holds.
            try ISettlerClaim(settlerAddr).claim() {} catch {}
            _inCallback = false;
        }
    }
}
