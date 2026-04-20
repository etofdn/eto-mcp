// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ETO Mesh Bridge — Lock/Release on Ethereum side
/// @notice No mint/burn. ETH locked here, credited on ETO via validator attestation.
contract EtoMeshBridge {
    address public validator;
    uint256 public totalLocked;
    uint256 public nonce;

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
    function release(address payable recipient, uint256 amount, bytes32 attestationId) external {
        require(msg.sender == validator, "Only validator");
        require(!usedAttestations[attestationId], "Already used");
        require(address(this).balance >= amount, "Insufficient balance");

        usedAttestations[attestationId] = true;
        totalLocked -= amount;
        recipient.transfer(amount);

        nonce++;
        emit Released(recipient, amount, nonce, attestationId);
    }

    function getBalance() external view returns (uint256) {
        return address(this).balance;
    }
}
