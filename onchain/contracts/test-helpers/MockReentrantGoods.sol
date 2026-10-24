// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface ISettlerClaim {
    function claimGoods(address token) external;
}

/// @dev ERC-20 that re-enters claimGoods on the first transfer, then completes normally.
contract MockReentrantGoods is ERC20 {
    address public settler;
    bool public reentryDone;

    constructor() ERC20("Reentrant Goods", "REENT") {}

    function decimals() public pure override returns (uint8) { return 0; }

    function setSettler(address _settler) external { settler = _settler; }

    function mint(address to, uint256 amount) external { _mint(to, amount); }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (!reentryDone && settler != address(0)) {
            reentryDone = true;
            // Attempt re-entry — must be blocked by ReentrancyGuard.
            ISettlerClaim(settler).claimGoods(address(this));
        }
        return super.transfer(to, amount);
    }
}
