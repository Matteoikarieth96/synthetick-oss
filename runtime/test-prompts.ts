/**
 * Documentation prompt validation — runs every example prompt from
 * docs/DOCUMENTATION.md §8 at the retrieval level (embedding + SQL hard
 * filter + semantic boost) and checks: non-empty results, zero hard-filter
 * violations, and (where given) that expected tickers surface in the top 15.
 * Retrieval-level keeps this affordable (1 Voyage call per prompt, no LLM);
 * the full pipeline is exercised by test-regression.ts.
 */
import { log } from '../ingest/lib/log.js';
import { getCandidates, type Requirements } from './candidates.js';

interface PromptCase {
  cat: 'us-stock' | 'cn-stock' | 'crypto';
  name: string;
  text: string;
  req: Requirements;
  expect?: string[]; // any of these in top-15 = pass
}

const CASES: PromptCase[] = [
  // ---- US stocks ----
  { cat: 'us-stock', name: 'AI chips & hyperscalers', expect: ['NVDA', 'AMD', 'MSFT', 'GOOGL'],
    text: 'AI compute demand keeps exploding; chip designers and hyperscale cloud platforms capture the spend. Only US stocks.',
    req: { assetSet: ['stock'], regionSet: ['us'] } },
  { cat: 'us-stock', name: 'Semicap equipment', expect: ['AMAT', 'KLAC', 'LRCX'],
    text: 'Semiconductor equipment makers are the picks and shovels of the AI buildout: deposition, etch, metrology. Only US stocks.',
    req: { assetSet: ['stock'], regionSet: ['us'] } },
  { cat: 'us-stock', name: 'Digital advertising', expect: ['META', 'GOOGL'],
    text: 'Digital advertising rebounds as AI improves targeting and creative automation. Only US stocks.',
    req: { assetSet: ['stock'], regionSet: ['us'] } },
  { cat: 'us-stock', name: 'Devices + services', expect: ['AAPL'],
    text: 'Premium hardware ecosystems like Apple’s — devices with attached subscription services are sticky cash machines. Only US stocks.',
    req: { assetSet: ['stock'], regionSet: ['us'] } },
  { cat: 'us-stock', name: 'Banks & rates', expect: ['JPM', 'BAC', 'GS'],
    text: 'Large US banks earn more in a higher-for-longer rate environment through net interest margins. Only US stocks.',
    req: { assetSet: ['stock'], regionSet: ['us'] } },
  { cat: 'us-stock', name: 'Obesity drugs', expect: ['LLY'],
    text: 'GLP-1 obesity and diabetes drugs are reshaping healthcare economics. Only US stocks.',
    req: { assetSet: ['stock'], regionSet: ['us'] } },
  { cat: 'us-stock', name: 'EVs & charging', expect: ['GM', 'F'],
    text: 'Electric vehicles and charging infrastructure keep scaling in the US market. Only US stocks.',
    req: { assetSet: ['stock'], regionSet: ['us'] } },
  { cat: 'us-stock', name: 'Defense budgets', expect: ['GD', 'LMT', 'NOC', 'LHX'],
    text: 'Rising geopolitical tension drives sustained growth in defense procurement and munitions. Only US stocks.',
    req: { assetSet: ['stock'], regionSet: ['us'] } },
  { cat: 'us-stock', name: 'Streaming winners', expect: ['NFLX'],
    text: 'Streaming platforms with pricing power and ad tiers win the living room. Only US stocks.',
    req: { assetSet: ['stock'], regionSet: ['us'] } },
  { cat: 'us-stock', name: 'Cybersecurity', expect: ['CRWD', 'FTNT', 'NET'],
    text: 'Ransomware and AI-powered attacks make cybersecurity spend non-discretionary. Only US stocks.',
    req: { assetSet: ['stock'], regionSet: ['us'] } },
  // ---- Chinese stocks (ADRs today; HKEX joins as the backfill completes) ----
  { cat: 'cn-stock', name: 'China e-commerce', expect: ['BABA', 'JD'],
    text: 'Chinese e-commerce giants trade at depressed multiples despite dominant market share. Only Chinese stocks.',
    req: { assetSet: ['stock'], regionSet: ['cn'] } },
  { cat: 'cn-stock', name: 'China EVs', expect: ['LI', 'NIO'],
    text: 'Chinese EV makers are winning on cost and technology at home and abroad. Only Chinese companies.',
    req: { assetSet: ['stock'], regionSet: ['cn'] } },
  { cat: 'cn-stock', name: 'China banks', expect: ['IDCBY', 'ACGBY'],
    text: 'Chinese state banks offer high dividend yields backed by deposits. Only Chinese stocks.',
    req: { assetSet: ['stock'], regionSet: ['cn'] } },
  { cat: 'cn-stock', name: 'China internet platforms',
    text: 'Chinese internet platforms monetize search, gaming and social traffic. Only Chinese stocks.',
    req: { assetSet: ['stock'], regionSet: ['cn'] } },
  { cat: 'cn-stock', name: 'China consumer',
    text: 'The Chinese consumer recovery lifts retail, travel and food delivery. Only Chinese stocks.',
    req: { assetSet: ['stock'], regionSet: ['cn'] } },
  // ---- Crypto ----
  { cat: 'crypto', name: 'Ethereum ecosystem', expect: ['ETH', 'ARB', 'OP'],
    text: 'Rollups and staking make ETH productive capital. Only crypto related to the Ethereum ecosystem.',
    req: { assetSet: ['crypto'], semantic: 'Ethereum ecosystem' } },
  // No expected majors: in the current market AAVE/UNI are small-caps among
  // hundreds of DeFi tokens — the pool is legitimately DeFi either way, and
  // naming them in a thesis pins them via the anchors path (pipeline-level).
  { cat: 'crypto', name: 'DeFi lending & DEXs',
    text: 'On-chain lending and decentralized exchanges eat traditional finance fees. Only crypto.',
    req: { assetSet: ['crypto'] } },
  { cat: 'crypto', name: 'Layer 2 scaling', expect: ['ARB', 'OP', 'POL'],
    text: 'Layer 2 rollups scale Ethereum and capture sequencer revenue. Only crypto.',
    req: { assetSet: ['crypto'], semantic: 'Layer 2' } },
  { cat: 'crypto', name: 'Bitcoin macro hedge', expect: ['BTC'],
    text: 'Bitcoin is digital gold: a scarce, neutral reserve asset for a fragmenting world. Only crypto.',
    req: { assetSet: ['crypto'] } },
  { cat: 'crypto', name: 'Stablecoins & payments', expect: ['USDT', 'USDC'],
    text: 'Dollar stablecoins are the killer app of crypto payments and settlement. Only crypto.',
    req: { assetSet: ['crypto'] } },
  { cat: 'crypto', name: 'Decentralized AI & GPU', expect: ['RENDER', 'TAO'],
    text: 'Decentralized GPU networks and AI-model markets monetize idle compute. Only crypto.',
    req: { assetSet: ['crypto'] } },
  { cat: 'crypto', name: 'Solana ecosystem', expect: ['SOL'],
    text: 'High-throughput consumer apps live on Solana. Only crypto in the Solana ecosystem.',
    req: { assetSet: ['crypto'], semantic: 'Solana ecosystem' } },
  { cat: 'crypto', name: 'Liquid staking & restaking', expect: ['LDO', 'ETHFI'],
    text: 'Liquid staking and restaking protocols turn locked stake into productive collateral. Only crypto.',
    req: { assetSet: ['crypto'] } },
  { cat: 'crypto', name: 'Gaming & metaverse',
    text: 'On-chain gaming economies and metaverse land monetize player ownership. Only crypto.',
    req: { assetSet: ['crypto'], semantic: 'Gaming' } },
  { cat: 'crypto', name: 'DePIN infrastructure', expect: ['FIL', 'HNT', 'AR'],
    text: 'Decentralized physical infrastructure — storage, wireless, sensors — bootstraps real networks with tokens. Only crypto.',
    req: { assetSet: ['crypto'] } },
];

async function main() {
  let pass = 0;
  let fail = 0;
  for (const c of CASES) {
    try {
      const rows = await getCandidates(c.text, c.req);
      const all = rows.map((r) => r.ticker);
      const top15 = all.slice(0, 15);
      const violations = rows.filter(
        (r) =>
          (c.req.assetSet && !c.req.assetSet.includes(r.kind as never)) ||
          (c.req.regionSet && r.kind !== 'crypto' && !c.req.regionSet.includes(r.region as never)),
      );
      // Retrieval's job is RECALL into the top-100 candidate set; /select
      // reranks within it. So expected names must be in the candidates, not
      // necessarily the raw-similarity top (conglomerate descriptions embed
      // diffusely vs pure-plays).
      const hit = c.expect ? c.expect.filter((t) => all.includes(t)) : null;
      const ok = rows.length > 0 && violations.length === 0 && (hit === null || hit.length > 0);
      if (ok) pass++; else fail++;
      log.info(
        `${ok ? 'PASS' : 'FAIL'} [${c.cat}] ${c.name} — ${rows.length} rows, ` +
          `viol ${violations.length}${hit ? `, in-candidates: ${hit.join(',') || 'NONE'}` : ''} · top: ${top15.slice(0, 6).join(', ')}`,
      );
    } catch (err) {
      fail++;
      log.error(`FAIL [${c.cat}] ${c.name} — ${(err as Error).message}`);
    }
  }
  log.step(`${pass}/${CASES.length} prompt checks passed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  log.error('test-prompts failed', e);
  process.exit(1);
});
