// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPermission, Context} from "@sail/interfaces/IPermission.sol";
import {SailCalldata} from "./SailCalldata.sol";

/// @title  BoundedErc20Approve — allowlisted ERC-20 approve() for the swap mandate
/// @notice Model-A approve coverage (sailor-mandates/references/approvals.md): the agent
///         may grant a router allowance on an allowlisted token, and nothing else.
///         Multi-token variant of the skill's worked example: one deployment covers the
///         whole trading universe approving the single venue router.
///           - target  must be an allowlisted token (USDG + the tradable stock tokens)
///           - selector must be approve(address,uint256)
///           - spender must be an allowlisted router
///           - value   must be 0
///           - amount  capped by MAX_APPROVAL (0 = uncapped standing approvals)
///         Allowance size cannot widen what a swap dispatch may do — the swap permission
///         bounds amountIn/recipient/minOut on every call regardless of allowance.
contract BoundedErc20Approve is IPermission {
    bytes32 private constant DISCRIMINATOR = keccak256("BoundedErc20Approve.v1");
    bytes4 private constant APPROVE_SELECTOR = 0x095ea7b3; // approve(address,uint256)

    uint256 public immutable MAX_APPROVAL; // 0 == uncapped
    mapping(address => bool) public isAllowedToken;
    mapping(address => bool) public isAllowedSpender;

    constructor(address[] memory tokens, address[] memory spenders, uint256 maxApproval) {
        MAX_APPROVAL = maxApproval;
        for (uint256 i = 0; i < tokens.length; i++) isAllowedToken[tokens[i]] = true;
        for (uint256 i = 0; i < spenders.length; i++) isAllowedSpender[spenders[i]] = true;
    }

    function evaluate(bytes calldata txData, Context calldata ctx) external view returns (bool) {
        if (!isAllowedToken[ctx.target]) return false;
        if (ctx.selector != APPROVE_SELECTOR) return false;
        if (ctx.value != 0) return false;
        if (!SailCalldata.hasParams(txData, 2)) return false;
        address spender = SailCalldata.asAddress(txData, 0);
        uint256 amount = SailCalldata.asUint256(txData, 1);
        if (!isAllowedSpender[spender]) return false;
        if (MAX_APPROVAL != 0 && amount > MAX_APPROVAL) return false;
        return true;
    }

    function discriminator() external pure returns (bytes32) {
        return DISCRIMINATOR;
    }
}
