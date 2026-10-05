// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPermission} from "./IPermission.sol";

/// @notice Extension of IPermission that supports multi-account, per-account configuration.
///         A single deployed template can serve unlimited accounts; each account gets its
///         own isolated config slot keyed by `account`.
///
///         Auth model: configure() verifies an EIP-712 signature from the account's
///         registered permissionSigner (read from the SailKernel reference). No on-chain
///         caller restriction — anyone may submit the call if they hold a valid sig.
interface IConfigurablePermission is IPermission {
    /// @notice Apply config for `account`. Signature must be from the permissionSigner
    ///         registered for `account` in the kernel.
    /// @param account  The Safe account whose config slot is being written.
    /// @param params   ABI-encoded config blob — structure defined by each template.
    /// @param deadline Unix timestamp past which the signature is rejected.
    /// @param sig      EIP-712 sig over (account, keccak256(params), nonce, deadline).
    function configure(
        address account,
        bytes calldata params,
        uint256 deadline,
        bytes calldata sig
    ) external;

    /// @notice Direct caller variant — msg.sender must equal kernel.configs(account).permissionSigner.
    ///         Useful when the permissionSigner is an EOA submitting the tx itself.
    function configureDirect(address account, bytes calldata params) external;

    /// @notice Replay-protection nonce; incremented on every successful configure().
    function configNonces(address account) external view returns (uint256);

    /// @notice True once any config has been applied for `account`.
    function isConfigured(address account) external view returns (bool);

    /// @notice The kernel registration epoch at which `account`'s config bounds were last applied.
    ///         Evaluate paths fail closed unless this equals the kernel's current registration epoch
    ///         for the permission, so a config surviving a revoke → re-register cycle is not honoured.
    function configuredEpoch(address account) external view returns (uint256);
}
