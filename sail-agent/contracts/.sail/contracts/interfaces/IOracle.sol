// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title  IOracle
/// @notice Minimal price oracle interface consumed by the oracle-gated permission templates.
/// @dev    Price is expressed as: 1 unit of `base` = `price / 10^decimals` units of `quote`.
///         Both amounts use the token's own native units (no normalisation required here).
///
///         STALENESS: `getPrice` returns an `updatedAt` timestamp. Oracle-consuming
///         permissions enforce freshness against a configured `maxPriceAgeSec` and deny
///         when the price is older than that bound (or when `updatedAt == 0`). Adapters
///         MUST therefore return a meaningful `updatedAt` for every price; returning 0 or a
///         constant timestamp disables freshness protection downstream. On L2s, adapters
///         should additionally gate on sequencer-uptime before returning a price.
interface IOracle {
    /// @notice Fetch the current price of `base` in terms of `quote`.
    /// @param  base      Address of the base token (the token being sold in a swap).
    /// @param  quote     Address of the quote token (the token being bought).
    /// @return price     Raw price mantissa: 1 base unit = `price / 10^decimals` quote units.
    /// @return decimals  Decimal precision of `price`. Values above 77 are not supported by
    ///                   the consuming permissions and cause the operation to be denied
    ///                   (10^78 overflows uint256).
    /// @return updatedAt Unix timestamp of the last oracle update. Consumers validate
    ///                   freshness; a value of 0 is treated as stale and denied.
    function getPrice(address base, address quote)
        external
        view
        returns (uint256 price, uint8 decimals, uint256 updatedAt);
}
