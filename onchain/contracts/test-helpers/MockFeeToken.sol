// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev ERC-20 that deducts a 1-unit fee on every transferFrom, making it a fee-on-transfer token.
contract MockFeeToken is ERC20 {
    constructor() ERC20("Fee Token", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) { return 0; }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        // Deduct 1 unit fee: actually move amount-1 to recipient, burn 1.
        _burn(from, 1);
        _transfer(from, to, amount - 1);
        // Update allowance.
        uint256 allowed = allowance(from, msg.sender);
        if (allowed != type(uint256).max) {
            _approve(from, msg.sender, allowed - amount);
        }
        return true;
    }
}
