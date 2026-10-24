// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title SwarmPass
/// @notice Demo good for Swarm v2. 0 decimals, so one token = one pass and tokensPerUnit = 1.
///         Constructor takes `bool faucetEnabled`. When enabled, anyone can call faucet() to mint
///         100 passes, at most once per address per day — useful for testnet demos.
///         On mainnet, deploy with faucetEnabled = false; passes are minted by the owner.
contract SwarmPass is ERC20 {
    bool    public immutable faucetEnabled;
    address public owner;

    /// @dev Tracks the last day (block.timestamp / 86400) a given address used the faucet.
    mapping(address => uint256) private _lastFaucetDay;

    uint256 public constant FAUCET_AMOUNT = 100;
    uint256 private constant SECONDS_PER_DAY = 86400;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event FaucetUsed(address indexed recipient, uint256 amount);

    error FaucetDisabled();
    error FaucetAlreadyUsedToday();
    error Unauthorized();
    error InvalidAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(bool _faucetEnabled) ERC20("Swarm Pass", "PASS") {
        faucetEnabled = _faucetEnabled;
        owner = msg.sender;
    }

    /// @inheritdoc ERC20
    /// @dev 0 decimals: one token = one pass.
    function decimals() public pure override returns (uint8) {
        return 0;
    }

    /// @notice Mint 100 passes to the caller. Callable at most once per address per day.
    ///         Reverts FaucetDisabled when faucetEnabled is false.
    function faucet() external {
        if (!faucetEnabled) revert FaucetDisabled();
        uint256 today = block.timestamp / SECONDS_PER_DAY;
        if (_lastFaucetDay[msg.sender] == today) revert FaucetAlreadyUsedToday();
        _lastFaucetDay[msg.sender] = today;
        _mint(msg.sender, FAUCET_AMOUNT);
        emit FaucetUsed(msg.sender, FAUCET_AMOUNT);
    }

    /// @notice Owner minting (for mainnet distribution or testnet bootstrapping).
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }
}
