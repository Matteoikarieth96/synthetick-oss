// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title  IPermissionIntrospection
/// @notice Optional interface that permission templates implement alongside IPermission
///         to expose stable identity and capability metadata to off-chain consumers.
///
/// @dev    This interface is OPTIONAL. Templates that implement it provide richer
///         indexing and UI support, but templates that do not implement it continue
///         to work unchanged — the kernel never calls these functions.
///
/// @dev    This is introspection only — NOT authorization. IPermission.evaluate()
///         remains the sole authorization gate. None of the functions here have any
///         effect on whether a dispatch is permitted.
///
/// @dev    permissionId identifies the template TYPE, not the deployment instance.
///         Two separate deployments of the same template (e.g. SwapPermission) return
///         the same permissionId. Use the contract address to distinguish instances.
///
/// @dev    Indexers and UIs can combine PermissionRegistered events emitted by the
///         kernel with permissionId() lookups to group accounts by template type,
///         track adoption, and reconstruct per-template dispatch metrics without any
///         per-dispatch on-chain overhead. See docs/off-chain-attribution.md for the
///         canonical derivation patterns.
interface IPermissionIntrospection {
    /// @notice Stable identifier for this template type.
    /// @dev    Same value across all deployments of the same template version.
    ///         Derived by convention as keccak256("sail.permission.<ContractName>.v1").
    ///         Must not change between deployments of the same template version.
    ///         Use a new version suffix (v2, v3, …) for breaking logic changes.
    /// @return A non-zero stable type identifier for this template.
    function permissionId() external view returns (bytes32);

    /// @notice Version hash of this specific implementation.
    /// @dev    Changes when the template logic changes in a breaking way.
    ///         Derived by convention as keccak256("v1"), keccak256("v2"), etc.
    ///         Consumers can detect when an account's registered permission has been
    ///         upgraded to a new version by comparing this value at registration time
    ///         against a stored baseline.
    /// @return A non-zero version hash for this implementation.
    function permissionVersion() external view returns (bytes32);

    /// @notice URI pointing to off-chain metadata JSON for this template.
    /// @dev    Format: IPFS URI (ipfs://…), Arweave URI (ar://…), or HTTPS URL.
    ///         May return an empty string if metadata has not yet been published.
    ///         Metadata JSON should contain at minimum: name, description, author,
    ///         documentation URL, and human-readable capability descriptions.
    /// @return A URI string, or empty string if metadata is not yet published.
    function metadataURI() external view returns (string memory);

    /// @notice Capability identifiers declared by this template.
    /// @dev    Each entry is a keccak256 hash from SailCapabilities (or a third-party
    ///         convention following the same format). Consumers use this list to filter
    ///         templates by capability without needing to know each template's ABI.
    ///         A template SHOULD declare all capabilities it meaningfully supports.
    ///         A template that composes multiple domains (e.g. a swap-and-borrow bundle)
    ///         SHOULD declare all composed capabilities.
    /// @return ids An array of capability identifiers; must be non-empty.
    function capabilityIds() external view returns (bytes32[] memory ids);
}
