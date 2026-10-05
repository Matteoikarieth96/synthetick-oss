#!/usr/bin/env node
/**
 * Build the SwapPermissionNoOracle config blobs for the two-direction USDG-hub
 * mandate (config-schemas.md tuple):
 *
 *   abi.encode(address[] routers, address[] tokensIn, address[] tokensOut,
 *              uint256 maxAmountPerTx, ReferencePool[] referencePools)
 *   ReferencePool { tokenIn, tokenOut, pool, kind (1=V3), toleranceBps }
 *
 *   node scripts/build-mandate-blob.mjs buy    # USDG -> stock tokens
 *   node scripts/build-mandate-blob.mjs sell   # stock tokens -> USDG
 *
 * Reads src/universe.ts (generated) + agent.config.json. Prints the 0x blob
 * on stdout; pass it to `sailor mandate configure --params`.
 *
 * Caps:
 *  - buy  maxAmountPerTx = hardCapUsdPerTrade in USDG base units (6 decimals).
 *  - sell maxAmountPerTx is in TOKEN base units and one number covers every
 *    stock token, so it is sized as hardCapUsdPerTrade / SELL_MIN_PRICE_USD
 *    (worst-case cheap token). A pricier token can therefore move more USD in
 *    one tx than the buy cap — the off-chain engine enforces the exact %; this
 *    cap is the blast-radius ceiling. Tighten SELL_MIN_PRICE_USD if your
 *    universe's cheapest token changes.
 *
 * toleranceBps = 600 (6%) per pair: must exceed pool fee (up to 100 bps) +
 * agent slippage (150 bps) + price-movement headroom, else every legitimate
 * trade fails the band (sailor-template-swap-no-oracle's arithmetic).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters } from "viem";

const mode = process.argv[2];
if (mode !== "buy" && mode !== "sell") {
  console.error("usage: node scripts/build-mandate-blob.mjs <buy|sell>");
  process.exit(1);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const cfg = JSON.parse(readFileSync(`${root}/agent.config.json`, "utf-8"));
const universeTs = readFileSync(`${root}/src/universe.ts`, "utf-8");

const grab = (name) => {
  const m = universeTs.match(new RegExp(`export const ${name}[^=]*= "(0x[0-9a-fA-F]{40})"`));
  if (!m) throw new Error(`cannot find ${name} in src/universe.ts`);
  return m[1];
};
const USDG = grab("USDG");
const ROUTER = grab("SWAP_ROUTER_02");
const tradableJson = universeTs.match(/export const TRADABLE[^=]*= (\[[\s\S]*?\]);/)?.[1];
if (!tradableJson) throw new Error("cannot find TRADABLE in src/universe.ts");
const TRADABLE = JSON.parse(tradableJson.replace(/" as Address/g, '"'));

const TOLERANCE_BPS = 600n;
const SELL_MIN_PRICE_USD = 20;

const stockTokens = TRADABLE.map((t) => t.token);
// All registry stock tokens are 18-decimals; refuse to size a shared cap otherwise.
if (TRADABLE.some((t) => t.decimals !== 18)) throw new Error("non-18-decimal token in universe — resize sell cap logic");

const buy = mode === "buy";
const tokensIn = buy ? [USDG] : stockTokens;
const tokensOut = buy ? stockTokens : [USDG];
const maxAmountPerTx = buy
  ? BigInt(Math.floor(cfg.hardCapUsdPerTrade * 1e6))
  : BigInt(Math.ceil(cfg.hardCapUsdPerTrade / SELL_MIN_PRICE_USD)) * 10n ** 18n;

const referencePools = TRADABLE.map((t) => ({
  tokenIn: buy ? USDG : t.token,
  tokenOut: buy ? t.token : USDG,
  pool: t.pool,
  kind: 1, // V3
  toleranceBps: TOLERANCE_BPS,
}));

const blob = encodeAbiParameters(
  [
    { type: "address[]" },
    { type: "address[]" },
    { type: "address[]" },
    { type: "uint256" },
    {
      type: "tuple[]",
      components: [
        { name: "tokenIn", type: "address" },
        { name: "tokenOut", type: "address" },
        { name: "pool", type: "address" },
        { name: "kind", type: "uint8" },
        { name: "toleranceBps", type: "uint256" },
      ],
    },
  ],
  [[ROUTER], tokensIn, tokensOut, maxAmountPerTx, referencePools],
);

console.error(
  `${mode} blob: router=${ROUTER}, ${tokensIn.length} tokensIn, ${tokensOut.length} tokensOut, ` +
    `maxAmountPerTx=${maxAmountPerTx} (${buy ? "USDG base units" : "token base units"}), ` +
    `${referencePools.length} reference pools @ ${TOLERANCE_BPS} bps tolerance`,
);
console.log(blob);
