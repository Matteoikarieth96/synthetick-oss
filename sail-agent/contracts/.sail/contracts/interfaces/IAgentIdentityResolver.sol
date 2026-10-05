// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title  Agent Identity Interfaces for Sail Protocol Templates
///
/// @notice These interfaces are for metadata and introspection ONLY.
///         The SailKernel does not read, verify, or depend on agent identity at any
///         point during dispatch, registration, or any other kernel operation.
///
/// @dev    Templates that want to enforce identity-based constraints — for example,
///         requiring that ctx.manager equals a specific agent's signing wallet — must
///         implement that logic inside their own evaluate() function. These interfaces
///         are a standardised way to expose that identity data to off-chain consumers
///         and to other contracts that choose to read it; they carry no enforcement weight.
///
/// @dev    Reputation scoring, validation requirements, and curation-registry integration
///         are explicitly out of scope. These interfaces expose identity; they do not
///         validate, rank, or certify it.
///
/// @dev    ERC-8004 live registry resolution (resolving agentId → current wallet via an
///         external on-chain registry at call time) is a separate future extension.
///         The interfaces in this file return data the template itself supplies; there is
///         no external registry call in the base interface.

// ─────────────────────────────────────────────────────────────────────────────
// Structs
// ─────────────────────────────────────────────────────────────────────────────

/// @notice A reference to an external agent identity — typically an ERC-8004 agent token.
/// @dev    All fields are informational. The kernel never reads this struct.
struct AgentIdentityRef {
    /// @dev Namespace identifier for the identity scheme.
    ///      Convention: keccak256("eip155") for EIP-155 chain-scoped identities,
    ///      keccak256("erc8004") for ERC-8004 agent tokens, bytes32(0) if unset.
    bytes32 namespaceHash;

    /// @dev Chain ID where the identity registry is deployed.
    ///      Matches the EIP-155 chain ID (e.g. 1 for Ethereum mainnet, 8453 for Base).
    uint256 chainId;

    /// @dev Address of the external agent-identity registry (e.g. an ERC-8004 contract).
    ///      address(0) if no registry is associated.
    address identityRegistry;

    /// @dev Token or agent ID within the registry.
    ///      0 if not applicable or not yet assigned.
    uint256 agentId;

    /// @dev The signing wallet address associated with this agent.
    ///      Templates enforcing identity-based authorization compare ctx.manager
    ///      against this field inside their evaluate() implementation.
    address agentWallet;
}

// ─────────────────────────────────────────────────────────────────────────────
// Interfaces
// ─────────────────────────────────────────────────────────────────────────────

/// @title  IAgentIdentityResolver
/// @notice Global agent identity — same identity for all accounts that use this template.
/// @dev    Implement this on single-account or fixed-agent templates where one specific
///         agent manages every account that deploys the template.
///         Use IAccountAgentIdentityResolver for shared multi-account templates where
///         different accounts may be managed by different agents.
interface IAgentIdentityResolver {
    /// @notice Returns the agent identity reference for this template or manager.
    /// @dev    This is metadata only. The kernel does not read or verify it.
    ///         Identity-based authorization (e.g. requiring ctx.manager == agentWallet)
    ///         must be implemented inside evaluate() by the template itself.
    /// @return The AgentIdentityRef for the agent associated with this contract.
    function agentIdentity() external view returns (AgentIdentityRef memory);
}

/// @title  IAgentWalletVerifier
/// @notice Optional interface for verifying wallet-to-agent binding at evaluation time.
/// @dev    Templates or adapters that need to confirm that a signer is the authorised
///         wallet for a given agent may implement or call this interface.
///         This is NOT called by the kernel. Templates call it at their own discretion,
///         typically inside evaluate() alongside or instead of a direct agentWallet
///         comparison.
///         Implementations may call external registries for live resolution, or use
///         cached / pre-configured data. Live registry calls consume gas from the
///         PERMISSION_GAS_CAP budget.
interface IAgentWalletVerifier {
    /// @notice Returns true if `signer` is the currently authorised wallet for the
    ///         given agent in the given registry.
    /// @param  signer            The wallet address to verify.
    /// @param  identityRegistry  The agent-identity registry to query.
    /// @param  agentId           The agent token / ID within that registry.
    /// @return True if `signer` is authorised; false otherwise.
    function isAuthorizedAgentWallet(
        address signer,
        address identityRegistry,
        uint256 agentId
    ) external view returns (bool);
}

/// @title  IAccountAgentIdentityResolver
/// @notice Per-account agent identity — for shared templates where different accounts
///         may be managed by different agents.
/// @dev    Implement this on shared multi-account templates (those that inherit
///         ConfigurablePermission) where each Safe account may have its own agent identity
///         configured independently of other accounts on the same template deployment.
///         Consumers pass the Safe address; the implementation returns the identity
///         stored for that account, or a zero-filled AgentIdentityRef if not configured.
interface IAccountAgentIdentityResolver {
    /// @notice Returns the agent identity reference for a specific Safe account.
    /// @dev    Returns a zero-filled AgentIdentityRef (all fields zero/address(0)) for
    ///         accounts that have not configured an identity. Must not revert.
    /// @param  account  The Safe account address to look up.
    /// @return The AgentIdentityRef configured for `account`, or a zero struct if absent.
    function agentIdentityFor(address account) external view returns (AgentIdentityRef memory);
}
