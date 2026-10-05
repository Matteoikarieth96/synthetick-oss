// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BoundedErc20Approve} from "../mandates/BoundedErc20Approve.sol";
import {Context} from "@sail/interfaces/IPermission.sol";

contract BoundedErc20ApproveTest is Test {
    BoundedErc20Approve perm;

    address constant USDG = address(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    address constant AAPL = address(0xaF3d76f1834A1D425780CC36C87bc4a56aBBF41f); // placeholder value; identity irrelevant to the checks
    address constant ROUTER = address(0xCaf681a66D020601342297493863E78C959E5cb2);
    address constant SMA = address(0xABCD);
    address constant EVIL = address(0xBEEF);

    function setUp() public {
        address[] memory tokens = new address[](2);
        tokens[0] = USDG;
        tokens[1] = AAPL;
        address[] memory spenders = new address[](1);
        spenders[0] = ROUTER;
        perm = new BoundedErc20Approve(tokens, spenders, 0); // 0 = uncapped standing approvals
    }

    function _ctx(address target) internal pure returns (Context memory) {
        return Context({
            account: SMA,
            manager: address(0x1),
            submitter: address(0x1),
            target: target,
            selector: 0x095ea7b3,
            value: 0,
            blockTimestamp: 0,
            blockNumber: 0,
            configEpoch: 0
        });
    }

    function _approveData(address spender, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(0x095ea7b3, spender, amount);
    }

    function test_allows_router_approve_on_allowlisted_token() public view {
        assertTrue(perm.evaluate(_approveData(ROUTER, type(uint256).max), _ctx(USDG)));
        assertTrue(perm.evaluate(_approveData(ROUTER, 1e6), _ctx(AAPL)));
    }

    function test_rejects_unlisted_token() public view {
        assertFalse(perm.evaluate(_approveData(ROUTER, 1e6), _ctx(EVIL)));
    }

    function test_rejects_unlisted_spender() public view {
        assertFalse(perm.evaluate(_approveData(EVIL, 1e6), _ctx(USDG)));
    }

    function test_rejects_wrong_selector() public view {
        Context memory ctx = _ctx(USDG);
        ctx.selector = 0xa9059cbb; // transfer(address,uint256)
        assertFalse(perm.evaluate(abi.encodeWithSelector(bytes4(0xa9059cbb), EVIL, 1e6), ctx));
    }

    function test_rejects_nonzero_value() public view {
        Context memory ctx = _ctx(USDG);
        ctx.value = 1;
        assertFalse(perm.evaluate(_approveData(ROUTER, 1e6), ctx));
    }

    function test_rejects_short_calldata() public view {
        assertFalse(perm.evaluate(abi.encodePacked(bytes4(0x095ea7b3), bytes32(0)), _ctx(USDG)));
    }

    function test_cap_enforced_when_set() public {
        address[] memory tokens = new address[](1);
        tokens[0] = USDG;
        address[] memory spenders = new address[](1);
        spenders[0] = ROUTER;
        BoundedErc20Approve capped = new BoundedErc20Approve(tokens, spenders, 1000e6);
        assertTrue(capped.evaluate(_approveData(ROUTER, 1000e6), _ctx(USDG)));
        assertFalse(capped.evaluate(_approveData(ROUTER, 1000e6 + 1), _ctx(USDG)));
        // re-approving a smaller amount later still passes — the self-top-up path
        assertTrue(capped.evaluate(_approveData(ROUTER, 1e6), _ctx(USDG)));
    }
}
