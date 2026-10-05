import { log } from '../ingest/lib/log.js';
import { verifyPicks } from './audit.js';
import type { Candidate } from './candidates.js';
import { runResearch } from './pipeline.js';
import type { Pick } from './select.js';

interface Case {
  name: string;
  text: string;
  excluded: string;
}

const CASES: Case[] = [
  {
    name: 'Nvidia',
    text: 'Find companies similar to Nvidia, but do not give me Nvidia itself. Only US stocks.',
    excluded: 'NVDA',
  },
  {
    name: 'Ethereum',
    text: 'Show me crypto assets comparable to Ethereum, not ETH itself. Only crypto.',
    excluded: 'ETH',
  },
  {
    name: 'Bitcoin',
    text: 'I want alternatives to Bitcoin for a digital-gold thesis. Only crypto.',
    excluded: 'BTC',
  },
  {
    name: 'Solana',
    text: 'Give me tokens like Solana for high-throughput consumer crypto apps. Only crypto.',
    excluded: 'SOL',
  },
  {
    name: 'Apple',
    text: 'Which US companies are analogous to Apple in brand power and hardware ecosystems?',
    excluded: 'AAPL',
  },
  {
    name: 'Tesla',
    text: 'Find peers of Tesla exposed to EV adoption. Only US stocks.',
    excluded: 'TSLA',
  },
  {
    name: 'Microsoft',
    text: 'Give me businesses comparable to Microsoft for enterprise software and cloud. Only US stocks.',
    excluded: 'MSFT',
  },
  {
    name: 'Amazon',
    text: 'Show me stocks that are like Amazon in e-commerce and cloud scale. Only US stocks.',
    excluded: 'AMZN',
  },
  {
    name: 'Meta',
    text: 'Find competitors to Meta in digital advertising and social platforms. Only US stocks.',
    excluded: 'META',
  },
  {
    name: 'ASML',
    text: 'I want European semiconductor equipment companies similar to ASML. Only European stocks.',
    excluded: 'ASML.AS',
  },
];

let failures = 0;

const pick = (ticker: string, name: string, categories: string[]): Pick => ({
  a: {
    id: 0,
    ticker,
    name,
    kind: 'crypto',
    region: 'global',
    cap_class: null,
    exchange: null,
    cex_venues: [],
    dex_venues: [],
    sector: categories[0] ?? null,
    categories,
    etf_portfolio: null,
    volume_24h_usd: null,
    blurb: null,
    sim: 0,
  } as Candidate,
  score: 80,
  why: 'Comparable Ethereum ecosystem asset.',
  rel: 'complement',
});

async function auditLiteralTickerExclusion() {
  const { drop } = await verifyPicks(
    'Show me crypto assets comparable to Ethereum, not ETH itself. Only crypto.',
    [
      pick('ARB', 'Arbitrum', ['Layer 2', 'Ethereum Ecosystem']),
      pick('OP', 'Optimism', ['Layer 2', 'Ethereum Ecosystem']),
    ],
    'asset classes: ONLY crypto; never include exact tickers only: ETH',
  );
  const dropped = Object.keys(drop);
  const ok = dropped.length === 0;
  if (!ok) failures++;
  log.info(`${ok ? 'PASS' : 'FAIL'} — literal ETH exclusion audit: dropped=${dropped.join(', ') || '(none)'}`);
}

async function main() {
  log.step(`Similar-to exclusion suite — ${CASES.length} full-pipeline cases`);
  await auditLiteralTickerExclusion();
  for (const cs of CASES) {
    const result = await runResearch(cs.text);
    const excluded = cs.excluded.toUpperCase();
    const docExcludes = (result.thesis.docCrit.exclude_tickers ?? []).map((t) => t.toUpperCase());
    const picks = result.picks.map((p) => p.a.ticker.toUpperCase());
    const inferred = docExcludes.includes(excluded);
    const leaked = picks.includes(excluded);
    const ok = inferred && !leaked;
    if (!ok) failures++;
    log.info(
      `${ok ? 'PASS' : 'FAIL'} — ${cs.name}: exclude=${excluded}, inferred=${inferred}, leaked=${leaked}, picks=${picks.join(', ') || '(none)'}`,
    );
  }
  if (failures) {
    log.error(`${failures}/${CASES.length} similar-to cases failed`);
    process.exit(1);
  }
  log.step('ALL SIMILAR-TO CHECKS PASSED');
}

main().catch((err) => {
  log.error('test-similar failed', err);
  process.exit(1);
});
