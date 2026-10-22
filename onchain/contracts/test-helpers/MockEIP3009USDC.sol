// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MockERC20} from "./MockERC20.sol";

/**
 * @dev EIP-3009 USDC mock for Foundry tests.
 *
 * Implements receiveWithAuthorization with real EIP-712 signature verification
 * and the payee check (`to == msg.sender`). Also implements
 * transferWithAuthorization and cancelAuthorization, plus isBlacklisted.
 *
 * Domain: { name: "USDC", version: "2", chainId, verifyingContract }
 * — matching the verified on-chain USDC on both Arc mainnet and testnet.
 *
 * The authorization nonce is a bytes32 value chosen by the signer; the contract
 * tracks which nonces have been used per authorizer.
 */
contract MockEIP3009USDC is MockERC20 {
    // ── EIP-712 Domain ────────────────────────────────────────────────────────

    // Mutable (not immutable) so that after vm.etch the etched code at the USDC
    // address can call initialize() to rebuild the separator with the correct
    // verifyingContract == address(this) == 0x3600...
    bytes32 private DOMAIN_SEPARATOR;

    bytes32 private constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        keccak256(
            "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
        );

    bytes32 private constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
        keccak256(
            "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
        );

    bytes32 private constant CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");

    // ── Nonce tracking ────────────────────────────────────────────────────────

    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    // ── Errors ────────────────────────────────────────────────────────────────

    error AuthorizationExpired();
    error AuthorizationNotYetValid();
    error AuthorizationAlreadyUsed();
    error CallerMustBePayee();
    error InvalidSignature();

    // ── Events ────────────────────────────────────────────────────────────────

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    // ── Constructor / initializer ─────────────────────────────────────────────

    constructor() MockERC20("USDC", "USDC", 6) {
        // The domain separator is set here for use when the mock is deployed
        // at its own address. After vm.etch (which copies bytecode but not
        // constructor-set storage), call initialize() at the etched address
        // to recompute it with the correct verifyingContract.
        _buildDomainSeparator();
    }

    /**
     * @dev Recompute and store the EIP-712 domain separator using the current
     *      address(this). Call this once after vm.etch to fix the verifyingContract.
     */
    function initialize() external {
        _buildDomainSeparator();
    }

    function _buildDomainSeparator() internal {
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("USDC")),
            keccak256(bytes("2")),
            block.chainid,
            address(this)
        ));
    }

    // ── EIP-3009 ──────────────────────────────────────────────────────────────

    /**
     * @dev Execute a transfer with a signed authorization (anyone can submit).
     */
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _requireValidAuthorization(from, validAfter, validBefore, nonce);

        bytes32 digest = _hashTypedData(keccak256(abi.encode(
            TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
            from, to, value, validAfter, validBefore, nonce
        )));
        _requireValidSignature(from, digest, v, r, s);

        _markAuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    /**
     * @dev Execute a transfer with a signed authorization where msg.sender must
     * be the designated recipient. This prevents anyone other than the payee from
     * executing the transfer, which means the authorization cannot be redirected
     * to a different deal or contract.
     */
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (to != msg.sender) revert CallerMustBePayee();
        _requireValidAuthorization(from, validAfter, validBefore, nonce);

        bytes32 digest = _hashTypedData(keccak256(abi.encode(
            RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
            from, to, value, validAfter, validBefore, nonce
        )));
        _requireValidSignature(from, digest, v, r, s);

        _markAuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    /**
     * @dev Cancel an authorization.
     */
    function cancelAuthorization(
        address authorizer,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (authorizationState[authorizer][nonce]) revert AuthorizationAlreadyUsed();

        bytes32 digest = _hashTypedData(keccak256(abi.encode(
            CANCEL_AUTHORIZATION_TYPEHASH,
            authorizer, nonce
        )));
        _requireValidSignature(authorizer, digest, v, r, s);

        authorizationState[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    /** @dev Stub: no addresses are blocklisted in this test mock. Override to test blocklist paths. */
    function isBlacklisted(address) external view virtual returns (bool) {
        return false;
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    function _hashTypedData(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function _requireValidAuthorization(
        address from,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (authorizationState[from][nonce]) revert AuthorizationAlreadyUsed();
    }

    function _requireValidSignature(
        address signer,
        bytes32 digest,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal pure {
        address recovered = ecrecover(digest, v, r, s);
        if (recovered == address(0) || recovered != signer) revert InvalidSignature();
    }

    function _markAuthorizationUsed(address from, bytes32 nonce) internal {
        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
    }
}
