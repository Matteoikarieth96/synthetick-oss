/**
 * Twenty complex edge-case matching tests. Expected assets are declared before
 * execution and compared with the full-pipeline result. The suite validates
 * relevance, hard constraints, mixed-universe coverage, and long/short sides.
 *
 * Run all: npx tsx runtime/test-complex-edge-cases.ts
 * Run selected cases: npx tsx runtime/test-complex-edge-cases.ts 3 8 20
 */
import { writeFileSync } from 'node:fs';
import { log } from '../ingest/lib/log.js';
import { passesFilters } from './audit.js';
import { runResearch, type RunResult } from './pipeline.js';
import type { Crit } from './requirements.js';

type Direction = 'long' | 'short' | 'both';

interface ComplexCase {
  name: string;
  prompt: string;
  crit: Crit;
  expectedAny: string[];
  expectedReason: string;
  direction?: Direction;
  requiredKinds?: string[];
  expectedLong?: string[];
  expectedShort?: string[];
}

const CASES: ComplexCase[] = [
  {
    name: 'Italian merchant-payments infrastructure',
    prompt: 'Cashless adoption and merchant acquiring consolidation should benefit scaled Italian payment processors. Screen only Italian stocks directly exposed to digital merchant payments.',
    crit: { asset_set: ['stock'], region_set: ['it'], asset_exclusive: true, region_exclusive: true, constraint_note: 'only Italian digital merchant-payment processors' },
    expectedAny: ['NEXI.MI'],
    expectedReason: 'Nexi is the primary listed Italian merchant-acquiring and payments-infrastructure pure play.',
  },
  {
    name: 'European hearing-aid manufacturers',
    prompt: 'Ageing populations and better miniaturized devices support long-term hearing-aid penetration. Screen only European stocks that manufacture hearing aids or hearing-care devices.',
    crit: { asset_set: ['stock'], region_set: ['eu'], asset_exclusive: true, region_exclusive: true, constraint_note: 'only European hearing-aid or hearing-care-device manufacturers' },
    expectedAny: ['DEMANT.CO', 'GN.CO', 'SOON.SW'],
    expectedReason: 'Demant, GN Store Nord and Sonova are the core listed European hearing-device manufacturers.',
  },
  {
    name: 'European commercial-aircraft engines',
    prompt: 'A decade of commercial aircraft backlog should support engine deliveries and high-margin aftermarket service. Screen only European stocks that manufacture large commercial-aircraft engines.',
    crit: { asset_set: ['stock'], region_set: ['eu'], asset_exclusive: true, region_exclusive: true, constraint_note: 'only European manufacturers of large commercial-aircraft engines' },
    expectedAny: ['SAF.PA', 'MTX.DE', 'RR.L'],
    expectedReason: 'Safran, MTU Aero Engines and Rolls-Royce are the main listed European commercial-engine exposures.',
  },
  {
    name: 'European securities-exchange operators',
    prompt: 'Higher market volatility and expanding derivatives volumes should benefit trading venues. Screen only European stocks that directly operate securities exchanges or clearing venues.',
    crit: { asset_set: ['stock'], region_set: ['eu'], asset_exclusive: true, region_exclusive: true, constraint_note: 'only European securities-exchange or clearing-venue operators' },
    expectedAny: ['DB1.DE', 'LSEG.L', 'ENX.PA'],
    expectedReason: 'Deutsche Börse, London Stock Exchange Group and Euronext are the direct European exchange operators.',
  },
  {
    name: 'US electronic-design-automation duopoly',
    prompt: 'Chip complexity makes verification and electronic design automation software increasingly indispensable. Screen only US stocks whose core business is semiconductor EDA software.',
    crit: { asset_set: ['stock'], region_set: ['us'], asset_exclusive: true, region_exclusive: true, constraint_note: 'only semiconductor electronic-design-automation software companies' },
    expectedAny: ['CDNS', 'SNPS'],
    expectedReason: 'Cadence and Synopsys form the dominant listed EDA software duopoly.',
  },
  {
    name: 'US next-generation gene sequencing',
    prompt: 'Long-read sequencing and lower per-genome costs should expand research and clinical genomics. Screen only US stocks that manufacture gene-sequencing instruments or platforms.',
    crit: { asset_set: ['stock'], region_set: ['us'], asset_exclusive: true, region_exclusive: true, constraint_note: 'only gene-sequencing instrument or platform manufacturers' },
    expectedAny: ['ILMN', 'PACB', 'TXG'],
    expectedReason: 'Illumina, Pacific Biosciences and 10x Genomics are direct listed sequencing-platform exposures.',
  },
  {
    name: 'Short US packaged snacks after GLP-1 adoption',
    prompt: 'GLP-1 adoption will structurally reduce calorie intake and impulse snacking. Give me short candidates only among US-listed packaged-snack manufacturers, not retailers or restaurants.',
    crit: { asset_set: ['stock'], region_set: ['us'], asset_exclusive: true, region_exclusive: true, constraint_note: 'only US-listed packaged-snack manufacturers' },
    expectedAny: ['MDLZ', 'HSY', 'KHC', 'SJM'],
    expectedReason: 'Mondelez, Hershey, Kraft Heinz and J.M. Smucker have direct packaged-snack exposure.',
    direction: 'short',
  },
  {
    name: 'HKEX Chinese online-travel platforms',
    prompt: 'Chinese outbound tourism and domestic hotel bookings should normalize upward. Screen only HKEX-listed Chinese online-travel booking platforms.',
    crit: { asset_set: ['stock'], region_set: ['cn'], asset_exclusive: true, region_exclusive: true, cn_hkex_only: true, constraint_note: 'only HKEX-listed Chinese online-travel booking platforms' },
    expectedAny: ['9961.HK', '0780.HK', '780.HK'],
    expectedReason: 'Trip.com and Tongcheng Travel are the main HKEX-listed Chinese online-travel platforms.',
  },
  {
    name: 'HKEX Chinese EV-battery manufacturers',
    prompt: 'Battery cost declines and vertical integration should strengthen leading Chinese EV-battery suppliers. Screen only HKEX-listed Chinese companies that manufacture EV batteries or battery cells.',
    crit: { asset_set: ['stock'], region_set: ['cn'], asset_exclusive: true, region_exclusive: true, cn_hkex_only: true, constraint_note: 'only HKEX-listed Chinese EV-battery or battery-cell manufacturers' },
    expectedAny: ['1211.HK', '3750.HK'],
    expectedReason: 'BYD and CATL are the clearest HKEX-listed Chinese battery-manufacturing exposures.',
  },
  {
    name: 'US managed-futures ETFs',
    prompt: 'Persistent macro dispersion should reward systematic trend following across commodities, rates, currencies and equities. Screen only US-listed managed-futures ETFs.',
    crit: { asset_set: ['etf'], region_set: ['us'], asset_exclusive: true, region_exclusive: true, constraint_note: 'only US-listed managed-futures or trend-following ETFs' },
    expectedAny: ['DBMF', 'KMLM', 'CTA', 'FMF'],
    expectedReason: 'DBMF, KMLM, CTA and FMF are established US-listed managed-futures ETFs.',
  },
  {
    name: 'US short-duration inflation-linked bond ETFs',
    prompt: 'Inflation may stay sticky, but I want minimal interest-rate duration. Screen only US bond ETFs holding short-maturity Treasury Inflation-Protected Securities.',
    crit: { asset_set: ['bond'], region_set: ['us'], asset_exclusive: true, region_exclusive: true, constraint_note: 'only short-duration US TIPS bond ETFs' },
    expectedAny: ['VTIP', 'STIP'],
    expectedReason: 'VTIP and STIP are the primary short-duration US TIPS ETFs.',
  },
  {
    name: 'US cybersecurity ETFs only',
    prompt: 'AI-driven attacks should keep enterprise cybersecurity spending resilient. Screen only US-listed cybersecurity ETFs, with no individual stocks.',
    crit: { asset_set: ['etf'], region_set: ['us'], asset_exclusive: true, region_exclusive: true, constraint_note: 'only US-listed cybersecurity ETFs' },
    expectedAny: ['CIBR', 'HACK', 'IHAK', 'BUG'],
    expectedReason: 'CIBR, HACK, IHAK and BUG are direct US-listed cybersecurity ETFs.',
  },
  {
    name: 'Decentralized storage excluding Filecoin',
    prompt: 'Decentralized storage networks can undercut centralized cloud archives. Screen only crypto storage-network tokens available on centralized exchanges, but exclude Filecoin.',
    crit: { asset_set: ['crypto'], asset_exclusive: true, cex_only: true, exclude_tickers: ['FIL'], constraint_note: 'only decentralized-storage network tokens other than Filecoin' },
    expectedAny: ['AR', 'STORJ', 'SC'],
    expectedReason: 'Arweave, Storj and Siacoin are the main non-Filecoin decentralized-storage tokens.',
  },
  {
    name: 'Bitcoin scaling networks excluding BTC',
    prompt: 'Applications and faster settlement layers can expand the Bitcoin economy. Screen only crypto tokens for Bitcoin layer-2 or Bitcoin scaling networks, excluding BTC itself, and require centralized-exchange access.',
    crit: { asset_set: ['crypto'], asset_exclusive: true, cex_only: true, exclude_tickers: ['BTC'], constraint_note: 'only Bitcoin layer-2 or scaling-network tokens other than BTC' },
    expectedAny: ['STX', 'CORE', 'MERL'],
    expectedReason: 'Stacks, Core and Merlin Chain are prominent tradable Bitcoin-scaling network tokens.',
  },
  {
    name: 'Privacy-preserving payment coins',
    prompt: 'Demand for censorship-resistant private payments will persist. Screen only privacy-focused crypto payment coins available on centralized exchanges.',
    crit: { asset_set: ['crypto'], asset_exclusive: true, cex_only: true, constraint_note: 'only privacy-focused crypto payment coins' },
    expectedAny: ['XMR', 'ZEC', 'DASH'],
    expectedReason: 'Monero, Zcash and Dash are the established listed privacy-payment coins.',
  },
  {
    name: 'Solana liquid-staking ecosystem excluding SOL',
    prompt: 'Liquid staking can turn Solana staking positions into composable collateral. Screen only crypto tokens directly tied to Solana liquid-staking protocols, exclude SOL, and require centralized-exchange access.',
    crit: { asset_set: ['crypto'], asset_exclusive: true, cex_only: true, exclude_tickers: ['SOL'], constraint_note: 'only Solana liquid-staking protocol tokens other than SOL' },
    expectedAny: ['JTO', 'MNDE', 'INF'],
    expectedReason: 'Jito and Marinade are the main tokenized Solana liquid-staking protocol exposures.',
  },
  {
    name: 'Private AI-inference chip companies',
    prompt: 'Low-latency inference will create demand for specialized accelerators beyond GPUs. Screen only pre-IPO private companies whose core product is AI inference hardware.',
    crit: { asset_set: ['private'], asset_exclusive: true, constraint_note: 'only pre-IPO AI-inference hardware companies' },
    expectedAny: ['GROQ'],
    expectedReason: 'Groq is the directly covered private AI-inference accelerator company in the watchlist.',
  },
  {
    name: 'US alternatives to Nvidia excluding NVDA',
    prompt: 'Find US-listed semiconductor companies similar to Nvidia that can benefit from AI accelerator and networking demand, but exclude Nvidia itself.',
    crit: { asset_set: ['stock'], region_set: ['us'], asset_exclusive: true, region_exclusive: true, exclude_tickers: ['NVDA'] },
    expectedAny: ['AMD', 'AVGO', 'MRVL', 'ARM'],
    expectedReason: 'AMD, Broadcom, Marvell and Arm are the most direct listed alternatives across accelerators, networking and architectures.',
  },
  {
    name: 'Mixed AI data-center stocks and crypto',
    prompt: 'AI data-center buildout should reward physical cooling and networking suppliers as well as decentralized compute networks. Screen only US stocks and crypto, and include both asset classes.',
    crit: { asset_set: ['stock', 'crypto'], region_set: ['us'], asset_exclusive: true, region_exclusive: true },
    expectedAny: ['VRT', 'MOD', 'AVGO', 'RENDER', 'TAO', 'AKT'],
    expectedReason: 'VRT/MOD/AVGO are direct US infrastructure exposures; RENDER/TAO/AKT are direct crypto compute-network exposures.',
    requiredKinds: ['stock', 'crypto'],
  },
  {
    name: 'Streaming disruption long-and-short book',
    prompt: 'Streaming subscriptions and ad-supported streaming will keep taking viewing time from linear television. Give me both long positions in streaming winners and short candidates among US-listed legacy cable or linear-TV companies. Only US stocks.',
    crit: { asset_set: ['stock'], region_set: ['us'], asset_exclusive: true, region_exclusive: true },
    expectedAny: ['NFLX', 'ROKU', 'SPOT', 'CHTR', 'PARA', 'WBD'],
    expectedLong: ['NFLX', 'ROKU', 'SPOT'],
    expectedShort: ['CHTR', 'PARA', 'WBD', 'CMCSA'],
    expectedReason: 'NFLX/ROKU/SPOT express streaming growth; CHTR/PARA/WBD/CMCSA carry legacy distribution or linear-TV exposure.',
    direction: 'both',
  },
];

interface CaseResult {
  id: number;
  case_: ComplexCase;
  status: 'PASS' | 'FAIL';
  picks: { ticker: string; name: string; kind: string; side: string; score: number }[];
  expectedHits: string[];
  longHits: string[];
  shortHits: string[];
  violations: string[];
  missingKinds: string[];
  direction: string;
  path: string;
  issues: string[];
  elapsedSeconds: number;
}

const baseTicker = (ticker: string): string => ticker.toUpperCase().replace(/\.[A-Z0-9]+$/, '').replace(/^0+/, '');

function matchesTicker(actual: string, expected: string): boolean {
  const a = actual.toUpperCase();
  const e = expected.toUpperCase();
  return a === e || baseTicker(a) === baseTicker(e);
}

function expectedHits(picks: RunResult['picks'], expected: string[], side?: 'long' | 'short'): string[] {
  return expected.filter((ticker) => picks.some((pick) =>
    (!side || pick.dir === side) && matchesTicker(pick.a.ticker, ticker),
  ));
}

async function runCase(case_: ComplexCase, id: number): Promise<CaseResult> {
  const started = Date.now();
  try {
    const result = await runResearch(case_.prompt, case_.crit);
    const hits = expectedHits(result.picks, case_.expectedAny);
    const longHits = expectedHits(result.picks, case_.expectedLong ?? [], 'long');
    const shortHits = expectedHits(result.picks, case_.expectedShort ?? [], 'short');
    const violations = result.picks.filter((pick) => !passesFilters(pick.a, case_.crit)).map((pick) => pick.a.ticker);
    const actualKinds = new Set(result.picks.map((pick) => pick.a.kind));
    const missingKinds = (case_.requiredKinds ?? []).filter((kind) => !actualKinds.has(kind));
    const issues: string[] = [];
    if (!result.picks.length) issues.push('unexpected empty result');
    if (!hits.length) issues.push(`none of the expected assets appeared: ${case_.expectedAny.join(', ')}`);
    if (violations.length) issues.push(`hard-filter leaks: ${violations.join(', ')}`);
    if (missingKinds.length) issues.push(`missing required asset kinds: ${missingKinds.join(', ')}`);
    if (case_.direction && result.thesis.direction !== case_.direction) {
      issues.push(`direction was ${result.thesis.direction}, expected ${case_.direction}`);
    }
    if (case_.expectedLong?.length && !longHits.length) issues.push(`no expected long appeared: ${case_.expectedLong.join(', ')}`);
    if (case_.expectedShort?.length && !shortHits.length) issues.push(`no expected short appeared: ${case_.expectedShort.join(', ')}`);
    return {
      id, case_, status: issues.length ? 'FAIL' : 'PASS',
      picks: result.picks.map((pick) => ({ ticker: pick.a.ticker, name: pick.a.name, kind: pick.a.kind, side: pick.dir ?? result.thesis.direction, score: pick.score })),
      expectedHits: hits, longHits, shortHits, violations, missingKinds,
      direction: result.thesis.direction, path: result.path, issues,
      elapsedSeconds: (Date.now() - started) / 1000,
    };
  } catch (error) {
    return {
      id, case_, status: 'FAIL', picks: [], expectedHits: [], longHits: [], shortHits: [],
      violations: [], missingKinds: case_.requiredKinds ?? [], direction: '—', path: 'error',
      issues: [(error as Error).message], elapsedSeconds: (Date.now() - started) / 1000,
    };
  }
}

function report(results: CaseResult[], totalSeconds: number, selected: boolean): string {
  const passed = results.filter((result) => result.status === 'PASS').length;
  const lines = [
    '# SyntheTick — 20 complex edge-case report',
    '',
    `Generated: ${new Date().toISOString()} · Cases run: ${results.length} · Passed: ${passed} · Failed: ${results.length - passed}`,
    '',
    '| # | Case | Status | Expected hits | Picks | Leaks | Time |',
    '|---:|---|---|---|---:|---:|---:|',
    ...results.map((result) => `| ${result.id} | ${result.case_.name} | ${result.status} | ${result.expectedHits.join(', ') || '—'} | ${result.picks.length} | ${result.violations.length} | ${result.elapsedSeconds.toFixed(1)}s |`),
    '',
    ...results.flatMap((result) => [
      `## ${result.id}. ${result.case_.name} — ${result.status}`,
      '',
      `**Prompt:** ${result.case_.prompt}`,
      '',
      `**Expected assets:** ${result.case_.expectedAny.join(', ')}`,
      '',
      `**Why expected:** ${result.case_.expectedReason}`,
      '',
      `**Returned:** ${result.picks.map((pick) => `${pick.ticker} (${pick.name}; ${pick.kind}; ${pick.side}; ${pick.score})`).join(', ') || 'No assets'}`,
      '',
      `**Expected hits:** ${result.expectedHits.join(', ') || 'None'}`,
      ...(result.case_.expectedLong?.length ? ['', `**Expected-side hits:** long ${result.longHits.join(', ') || 'none'} · short ${result.shortHits.join(', ') || 'none'}`] : []),
      '',
      `**Checks:** hard filters ${result.violations.length ? `FAIL (${result.violations.join(', ')})` : 'PASS'} · direction ${result.direction} · path ${result.path}`,
      ...(result.issues.length ? ['', `**Issues:** ${result.issues.join('; ')}`] : []),
      '',
    ]),
    `Total runtime: ${(totalSeconds / 60).toFixed(1)} minutes.${selected ? ' This was a selected-case rerun.' : ''}`,
  ];
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const started = Date.now();
  const requestedIds = process.argv.slice(2).map(Number).filter((id) => Number.isInteger(id) && id >= 1 && id <= CASES.length);
  const ids = requestedIds.length ? requestedIds : CASES.map((_, index) => index + 1);
  const results: CaseResult[] = [];
  log.step(`Running ${ids.length} complex full-pipeline edge cases`);
  for (let index = 0; index < ids.length; index++) {
    const id = ids[index]!;
    const case_ = CASES[id - 1]!;
    log.step(`[${index + 1}/${ids.length}] #${id} ${case_.name} — expected: ${case_.expectedAny.join(', ')}`);
    const result = await runCase(case_, id);
    results.push(result);
    log.info(`${result.status} — #${id} ${case_.name} — hits: ${result.expectedHits.join(', ') || 'none'} — returned: ${result.picks.slice(0, 6).map((pick) => pick.ticker).join(', ') || 'empty'}${result.issues.length ? ` — ${result.issues.join('; ')}` : ''}`);
  }
  const elapsedSeconds = (Date.now() - started) / 1000;
  const path = requestedIds.length
    ? 'docs/COMPLEX-EDGE-CASE-RETRY.md'
    : 'docs/COMPLEX-EDGE-CASE-TEST-REPORT.md';
  writeFileSync(path, report(results, elapsedSeconds, requestedIds.length > 0));
  const passed = results.filter((result) => result.status === 'PASS').length;
  log.step(`${passed}/${results.length} complex edge cases passed → ${path}`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((error) => {
  log.error('complex edge-case test runner failed', error);
  process.exit(1);
});
