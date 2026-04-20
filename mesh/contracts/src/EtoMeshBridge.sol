// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ETO Mesh Bridge — Lock/Release on Ethereum side
/// @notice No mint/burn. ETH locked here, credited on ETO via validator attestation.
contract EtoMeshBridge {
    address public validator;
    uint256 public totalLocked;
    uint256 public nonce;

    // Minimal hand-rolled reentrancy guard (avoid OpenZeppelin dep for a 3-line
    // guard). Locked = 2 so we pay a single SSTORE refund on release.
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _reentrancyStatus = _NOT_ENTERED;

    modifier nonReentrant() {
        require(_reentrancyStatus != _ENTERED, "Reentrant call");
        _reentrancyStatus = _ENTERED;
        _;
        _reentrancyStatus = _NOT_ENTERED;
    }

    event Locked(
        address indexed sender,
        bytes32 indexed etoRecipient,
        uint256 amount,
        uint256 nonce,
        uint256 timestamp
    );

    event Released(
        address indexed recipient,
        uint256 amount,
        uint256 nonce,
        bytes32 attestationId
    );

    mapping(bytes32 => bool) public usedAttestations;

    constructor(address _validator) {
        require(_validator != address(0), "Invalid validator");
        validator = _validator;
    }

    /// @notice Lock ETH for bridging to ETO
    /// @param etoRecipient The base58-decoded ETO address as bytes32
    function lock(bytes32 etoRecipient) external payable {
        require(msg.value > 0, "Must send ETH");
        nonce++;
        totalLocked += msg.value;
        emit Locked(msg.sender, etoRecipient, msg.value, nonce, block.timestamp);
    }

    /// @notice Release ETH back (for ETO→ETH bridge)
    /// @dev In production, verify validator's Ed25519 signature on-chain
    ///      For testnet, we trust the validator address as msg.sender
    function release(address payable recipient, uint256 amount, bytes32 attestationId) external nonReentrant {
        require(msg.sender == validator, "Only validator");
        require(!usedAttestations[attestationId], "Already used");
        require(address(this).balance >= amount, "Insufficient balance");

        // Checks-Effects-Interactions: mark the attestation consumed and bump
        // accounting before the external call. Cap the totalLocked decrement
        // so force-sent ETH (selfdestruct beneficiary, coinbase tip, pre-
        // deployed address) can't brick legitimate releases.
        usedAttestations[attestationId] = true;
        if (amount <= totalLocked) {
            totalLocked -= amount;
        } else {
            totalLocked = 0;
        }
        nonce++;
        emit Released(recipient, amount, nonce, attestationId);

        // Use .call{value:} instead of .transfer to avoid the 2300-gas stipend
        // breaking releases to contract wallets (multisigs, AA wallets, proxies
        // with non-trivial receive/fallback).
        (bool ok, ) = recipient.call{value: amount}("");
        require(ok, "ETH transfer failed");
    }

    function getBalance() external view returns (uint256) {
        return address(this).balance;
    }
}
