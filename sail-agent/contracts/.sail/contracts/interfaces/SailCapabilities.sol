// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title  SailCapabilities
/// @notice Canonical capability identifiers for the Sail template set.
///
/// @dev    Each constant is a keccak256 hash encoding a unique, versioned capability name.
///         These IDs are stable — they MUST NOT change meaning after publication.
///         For breaking changes to a capability's semantics, introduce a new constant
///         with a bumped version suffix (e.g. "sail.capability.bounded-swap.v2").
///
/// @dev    Third parties may define their own capability IDs following the same convention:
///             keccak256("sail.capability.<name>.v<n>")
///         Capability IDs from different namespaces can coexist because the hash space
///         is sufficiently collision-resistant for practical purposes.
///
/// @dev    These IDs form a stable namespace. Some name capabilities of templates in
///         contracts/templates/; others are reserved for forthcoming or experimental
///         templates. A capability ID is decoupled from any specific template — any
///         template that declares it may use it. Retire an ID (by NatSpec deprecation)
///         only when its capability is permanently withdrawn from the protocol.
library SailCapabilities {
    /// @notice Capability id for oracle-gated token swaps.
    ///         Gates token-swap operations with amount caps, slippage bounds, and oracle checks.
    bytes32 internal constant BOUNDED_SWAP =
        keccak256("sail.capability.bounded-swap.v1");

    /// @notice Capability id for token swaps without an on-chain oracle price band.
    ///         Gates token-swap operations with amount caps, allowlists, and recipient pinning,
    ///         but NO on-chain price band — price protection rides on the manager's amountOutMin.
    bytes32 internal constant SWAP_NO_ORACLE =
        keccak256("sail.capability.swap-no-oracle.v1");

    /// @notice Capability id for borrow operations with LTV enforcement.
    ///         Gates borrow operations on Aave V3, Morpho, and Compound with LTV enforcement.
    bytes32 internal constant BOUNDED_BORROW =
        keccak256("sail.capability.bounded-borrow.v1");

    /// @notice Capability id for ERC-20 transfers to an allowlisted set of recipients.
    ///         Gates ERC-20 transfer / transferFrom to an allowlisted set of recipients.
    bytes32 internal constant TRANSFER_TARGET =
        keccak256("sail.capability.transfer-target.v1");

    /// @notice Capability id for a composite swap / borrow / transfer permission.
    ///         Gates swap, borrow, and transfer operations through a single composite permission.
    bytes32 internal constant DEFI_BUNDLE =
        keccak256("sail.capability.defi-bundle.v1");

    /// @notice Capability id for yield-protocol (Pendle-style) operations.
    ///         Gates Pendle V2 Router V4 operations: liquidity, PT/YT swaps, mint/redeem, yield claim.
    bytes32 internal constant PENDLE_YIELD =
        keccak256("sail.capability.pendle-yield.v1");

    /// @notice Capability id for AMM liquidity operations.
    ///         Gates AMM liquidity operations on Uniswap V3, Aerodrome Slipstream, and Aerodrome Router.
    bytes32 internal constant AMM_LIQUIDITY =
        keccak256("sail.capability.amm-liquidity.v1");

    /// @notice Capability id for kernel-native batch dispatch (approve / consume / reset).
    ///         Authorises kernel-native batch dispatch using the approve/consume/reset pattern.
    bytes32 internal constant BATCH_DISPATCH =
        keccak256("sail.capability.batch-dispatch.v1");

    /// @notice Capability id for vault / lending-pool deposits credited to the account.
    ///         Gates ERC-4626 / Aave-style deposits, pinning the receiver to the account
    ///         with target + token allowlists and a per-tx amount cap.
    bytes32 internal constant DEPOSIT =
        keccak256("sail.capability.deposit.v1");

    /// @notice Capability id for ERC-20 movements pinned to the account's configured recipient.
    ///         Gates ERC-20 transfer / transferFrom so funds only reach the account's
    ///         configured recipient, within a per-tx amount cap.
    bytes32 internal constant WITHDRAW =
        keccak256("sail.capability.withdraw.v1");

    /// @dev Declared by templates that implement IAgentIdentityResolver or
    ///      IAccountAgentIdentityResolver. Signals to consumers that this template
    ///      can surface agent identity metadata for off-chain discovery and indexing.
    ///      Presence of this capability does NOT imply any on-chain identity enforcement
    ///      — check the template's evaluate() logic for that.
    bytes32 internal constant AGENT_IDENTITY =
        keccak256("sail.capability.agent-identity.v1");
}
