/**
 * Regenerate runtime/universe/robinhood-chain.json (spec §16).
 *
 * Source of truth: Robinhood's public Stock Token API (GET /rhj/assets —
 * unauthenticated, 15s cache), which lists every active token with its
 * canonical contract address per chain. Each address is then verified against
 * the chain's Blockscout (symbol must match, decimals read from chain, holder
 * count captured as a coarse liquidity prior). Any disagreement is fatal:
 * a registry that cannot be verified must not ship.
 *
 * Deliberately NOT stored: prices and corporate-action multipliers — both are
 * live values consumers must read from /rhj/prices/{symbol} and /rhj/assets
 * at execution time, not from a checked-in file.
 *
 *   npm run universe:robinhood
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { log } from './lib/log.js';

const RHJ_ASSETS = 'https://api.robinhood.com/rhj/assets';
const CHAIN_ID = 4663;
const BLOCKSCOUT = 'https://robinhoodchain.blockscout.com';
const OUT = fileURLToPath(new URL('../runtime/universe/robinhood-chain.json', import.meta.url));

// Robinhood Chain core tokens (docs.robinhood.com/chain/contracts) — the swap
// counter-assets an execution agent needs alongside the stock tokens.
const CORE = [
  { symbol: 'WETH', name: 'Wrapped Ether', address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', decimals: 18 },
  { symbol: 'USDG', name: 'Global Dollar', address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', decimals: 6 },
];

const FUND_RE = /iShares|Invesco|SPDR|ETF|Trust\b|Fund\b/i;

interface RhjAsset {
  tokenSymbol: string;
  tokenName: string;
  deployments: { contractAddress: string; chainId: number }[];
  status: string;
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx] as T);
      }
    }),
  );
  return out;
}

async function main() {
  const rhj = (await getJson(RHJ_ASSETS)) as unknown as { assets: RhjAsset[] };
  const active = (rhj.assets ?? []).filter((a) => a.status === 'ASSET_STATUS_ACTIVE');
  if (active.length < 50) throw new Error(`suspiciously small asset list (${active.length}) — refusing to regenerate`);
  log.step(`rhj/assets: ${active.length} active tokens`);

  const assets = await mapLimit(active, 8, async (a) => {
    const dep = (a.deployments ?? []).find((d) => d.chainId === CHAIN_ID);
    if (!dep) throw new Error(`${a.tokenSymbol}: no deployment on chain ${CHAIN_ID}`);
    const chain = (await getJson(`${BLOCKSCOUT}/api/v2/tokens/${dep.contractAddress}`)) as {
      symbol?: string;
      decimals?: string;
      holders_count?: string;
      holders?: string;
    };
    if ((chain.symbol ?? '').toUpperCase() !== a.tokenSymbol.toUpperCase())
      throw new Error(`${a.tokenSymbol}: onchain symbol "${chain.symbol}" disagrees at ${dep.contractAddress}`);
    if (chain.decimals == null) throw new Error(`${a.tokenSymbol}: no decimals on chain`);
    const holdersRaw = chain.holders_count ?? chain.holders;
    // Docs name style: "Apple • Robinhood Token" — keep the plain company part.
    const name = a.tokenName.replace(/\s*•\s*Robinhood Token\s*$/i, '');
    return {
      symbol: a.tokenSymbol,
      name,
      address: dep.contractAddress,
      decimals: Number(chain.decimals),
      kind: FUND_RE.test(name) ? 'etf' : 'stock',
      holders: holdersRaw != null ? Number(holdersRaw) : null,
      // No logoUrl: vendor-hosted brand artwork is deliberately not copied into the registry.
    };
  });
  assets.sort((x, y) => x.symbol.localeCompare(y.symbol));

  const registry = {
    version: 1,
    chain: 'robinhood',
    chainId: CHAIN_ID,
    explorerBase: `${BLOCKSCOUT}/token/`,
    source: RHJ_ASSETS,
    generatedAt: new Date().toISOString(),
    core: CORE,
    assets,
  };
  writeFileSync(OUT, JSON.stringify(registry, null, 2) + '\n');
  log.step(`wrote ${assets.length} assets → ${OUT}`);
}

main().catch((err) => {
  log.error('universe regeneration failed', err);
  process.exit(1);
});
