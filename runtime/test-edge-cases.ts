/**
 * Ten deliberately sparse, constraint-heavy end-to-end matching cases.
 * These are not broad sector smoke tests: each prompt targets a niche where
 * only a handful of credible assets should survive.
 *
 * Run: npx tsx runtime/test-edge-cases.ts
 */
import { writeFileSync } from 'node:fs';
import { log } from '../ingest/lib/log.js';
import { passesFilters } from './audit.js';
import { runResearch } from './pipeline.js';
import type { Crit } from './requirements.js';

interface EdgeCase {
  name: string;
  prompt: string;
  crit: Crit;
  relevance: RegExp;
  expected: string;
}

const CASES: EdgeCase[] = [
  {
    name: 'Italian ultra-luxury sports cars',
    prompt:
      'Ultra-luxury sports-car makers can preserve margins through scarcity, brand heritage and long waitlists. Screen only Italian stocks.',
    crit: { asset_set: ['stock'], region_set: ['it'], asset_exclusive: true, region_exclusive: true },
    relevance: /ferrari|\brace\b|luxury|sports car|automotive/i,
    expected: 'Ferrari or another directly relevant Italian luxury-auto company',
  },
  {
    name: 'European semiconductor equipment',
    prompt:
      'Advanced chip nodes require increasingly complex lithography, deposition and packaging equipment. Screen only European stocks that sell semiconductor manufacturing equipment.',
    crit: {
      asset_set: ['stock'], region_set: ['eu'], asset_exclusive: true, region_exclusive: true,
      constraint_note: 'only semiconductor manufacturing equipment companies',
    },
    relevance: /asml|asm international|besi|lithograph|semiconductor equipment|wafer/i,
    expected: 'ASML, ASM International, BESI, or a comparable European equipment supplier',
  },
  {
    name: 'HKEX food-delivery platforms',
    prompt:
      'Local-commerce platforms in China can improve margins as food-delivery competition rationalizes. Screen only HKEX-listed Chinese stocks directly exposed to food delivery.',
    crit: {
      asset_set: ['stock'], region_set: ['cn'], asset_exclusive: true, region_exclusive: true,
      cn_hkex_only: true, constraint_note: 'only HKEX-listed Chinese food-delivery platforms',
    },
    relevance: /meituan|3690|food delivery|local commerce|local services/i,
    expected: 'Meituan or another HKEX-listed Chinese food-delivery platform',
  },
  {
    name: 'US orbital launch pure plays',
    prompt:
      'Falling launch costs and rising satellite demand benefit companies that build launch vehicles and orbital systems. Screen only US-listed stocks with direct space-launch exposure.',
    crit: {
      asset_set: ['stock'], region_set: ['us'], asset_exclusive: true, region_exclusive: true,
      constraint_note: 'only companies with direct space-launch or orbital-systems exposure',
    },
    relevance: /rocket lab|\brklb\b|launch vehicle|space launch|orbital|rocket/i,
    expected: 'Rocket Lab or another directly exposed US-listed launch company',
  },
  {
    name: 'US uranium enrichment',
    prompt:
      'Western nuclear expansion creates a bottleneck in domestic uranium enrichment and nuclear-fuel services. Screen only US stocks directly exposed to enrichment or the nuclear fuel cycle.',
    crit: {
      asset_set: ['stock'], region_set: ['us'], asset_exclusive: true, region_exclusive: true,
      constraint_note: 'only uranium enrichment or nuclear-fuel-cycle companies',
    },
    relevance: /centrus|\bleu\b|uranium enrich|nuclear fuel|uranium processing/i,
    expected: 'Centrus Energy or another direct US nuclear-fuel-cycle company',
  },
  {
    name: 'European subsea power cables',
    prompt:
      'Grid interconnectors and offshore wind create a multiyear shortage of high-voltage subsea power cables. Screen only European stocks that manufacture power cables.',
    crit: {
      asset_set: ['stock'], region_set: ['eu'], asset_exclusive: true, region_exclusive: true,
      constraint_note: 'only manufacturers of high-voltage or subsea power cables',
    },
    relevance: /prysmian|nexans|\bnkt\b|subsea|high.?voltage|power cable/i,
    expected: 'Prysmian, Nexans, NKT, or another European power-cable manufacturer',
  },
  {
    name: 'US ultra-short Treasury ETFs',
    prompt:
      'I want cash-like exposure to US Treasury bills with minimal duration risk. Screen only US bond ETFs focused on bills maturing within roughly one year.',
    crit: {
      asset_set: ['bond'], region_set: ['us'], asset_exclusive: true, region_exclusive: true,
      constraint_note: 'only ultra-short US Treasury-bill ETFs',
    },
    relevance: /\bsgov\b|\bbil\b|\bshv\b|treasury bill|ultra.?short|0.?3 month|short treasury/i,
    expected: 'SGOV, BIL, SHV, or another ultra-short US Treasury-bill ETF',
  },
  {
    name: 'Crypto oracles excluding Chainlink',
    prompt:
      'On-chain applications need independent real-time data feeds. Screen only crypto oracle networks listed on a centralized exchange, but exclude Chainlink.',
    crit: {
      asset_set: ['crypto'], asset_exclusive: true, cex_only: true,
      exclude_tickers: ['LINK'], constraint_note: 'only crypto oracle networks other than Chainlink',
    },
    relevance: /pyth|band protocol|\bapi3\b|oracle|data feed/i,
    expected: 'PYTH, BAND, API3, or another non-LINK oracle network',
  },
  {
    name: 'Liquid-staking tokens excluding ETH',
    prompt:
      'Liquid-staking protocols turn staked assets into reusable collateral. Screen only crypto protocol tokens with centralized-exchange access, excluding ETH itself.',
    crit: {
      asset_set: ['crypto'], asset_exclusive: true, cex_only: true,
      exclude_tickers: ['ETH'], constraint_note: 'only liquid-staking protocol tokens other than ETH',
    },
    relevance: /lido|\bldo\b|rocket pool|\brpl\b|ether\.?fi|\bethfi\b|liquid staking/i,
    expected: 'LDO, RPL, ETHFI, or another liquid-staking protocol token',
  },
  {
    name: 'Private defense-autonomy companies',
    prompt:
      'Autonomous systems and software-defined defense will take procurement share from legacy hardware. Screen only pre-IPO private companies directly focused on defense autonomy.',
    crit: {
      asset_set: ['private'], asset_exclusive: true,
      constraint_note: 'only pre-IPO defense-autonomy companies',
    },
    relevance: /anduril|helsing|defen[cs]e|autonom|drone|military/i,
    expected: 'Anduril, Helsing, or another private defense-autonomy company',
  },
];

interface TestResult {
  case_: EdgeCase;
  status: 'PASS' | 'FAIL';
  picks: string[];
  violations: string[];
  relevanceHit: boolean;
  direction: string;
  path: string;
  issue?: string;
  elapsedSeconds: number;
}

function searchableText(pick: Awaited<ReturnType<typeof runResearch>>['picks'][number], analysis: Record<string, string>): string {
  return [
    pick.a.ticker,
    pick.a.name,
    pick.a.sector ?? '',
    ...(pick.a.categories ?? []),
    pick.why,
    analysis[pick.a.ticker] ?? '',
  ].join(' ');
}

async function runCase(case_: EdgeCase): Promise<TestResult> {
  const started = Date.now();
  try {
    const result = await runResearch(case_.prompt, case_.crit);
    const violations = result.picks
      .filter((pick) => !passesFilters(pick.a, case_.crit))
      .map((pick) => pick.a.ticker);
    const relevanceHit = result.picks.some((pick) => case_.relevance.test(searchableText(pick, result.analysis)));
    const issues: string[] = [];
    if (!result.picks.length) issues.push('unexpected empty result');
    if (violations.length) issues.push(`hard-filter leaks: ${violations.join(', ')}`);
    if (!relevanceHit) issues.push(`no result matched the expected niche: ${case_.expected}`);
    return {
      case_, status: issues.length ? 'FAIL' : 'PASS',
      picks: result.picks.map((pick) => `${pick.a.ticker} (${pick.a.name})`),
      violations, relevanceHit, direction: result.thesis.direction, path: result.path,
      issue: issues.join('; ') || undefined,
      elapsedSeconds: (Date.now() - started) / 1000,
    };
  } catch (error) {
    return {
      case_, status: 'FAIL', picks: [], violations: [], relevanceHit: false,
      direction: '—', path: 'error', issue: (error as Error).message,
      elapsedSeconds: (Date.now() - started) / 1000,
    };
  }
}

async function main(): Promise<void> {
  const started = Date.now();
  const requestedIds = process.argv.slice(2).map(Number).filter((id) => Number.isInteger(id) && id >= 1 && id <= CASES.length);
  const selectedCases = requestedIds.length ? requestedIds.map((id) => CASES[id - 1]!) : CASES;
  const results: TestResult[] = [];
  log.step(`Running ${selectedCases.length} full-pipeline edge cases`);
  for (let i = 0; i < selectedCases.length; i++) {
    const case_ = selectedCases[i]!;
    log.step(`[${i + 1}/${selectedCases.length}] ${case_.name}`);
    const result = await runCase(case_);
    results.push(result);
    log.info(
      `${result.status} — ${case_.name} — ${result.picks.length} picks — ` +
      `${result.picks.slice(0, 5).join(', ') || 'empty'}${result.issue ? ` — ${result.issue}` : ''}`,
    );
  }

  const passed = results.filter((result) => result.status === 'PASS').length;
  const lines = [
    '# SyntheTick — Edge-case matching report',
    '',
    `Generated: ${new Date().toISOString()} · Full-pipeline cases: ${results.length} · Passed: ${passed} · Failed: ${results.length - passed}`,
    '',
    '| # | Edge case | Status | Picks | Direction | Hard-filter leaks | Time |',
    '|---|---|---|---:|---|---:|---:|',
    ...results.map((result, index) =>
      `| ${index + 1} | ${result.case_.name} | ${result.status} | ${result.picks.length} | ${result.direction} | ${result.violations.length} | ${result.elapsedSeconds.toFixed(1)}s |`,
    ),
    '',
    ...results.flatMap((result, index) => [
      `## ${index + 1}. ${result.case_.name} — ${result.status}`,
      '',
      `**Prompt:** ${result.case_.prompt}`,
      '',
      `**Expected niche:** ${result.case_.expected}`,
      '',
      `**Returned:** ${result.picks.join(', ') || 'No assets'}`,
      '',
      `**Checks:** relevance ${result.relevanceHit ? 'PASS' : 'FAIL'} · hard filters ${result.violations.length ? `FAIL (${result.violations.join(', ')})` : 'PASS'} · path ${result.path}`,
      ...(result.issue ? ['', `**Issue:** ${result.issue}`] : []),
      '',
    ]),
    `Total runtime: ${((Date.now() - started) / 60000).toFixed(1)} minutes.`,
  ];
  const reportPath = requestedIds.length
    ? 'docs/EDGE-CASE-TEST-RETRY.md'
    : 'docs/EDGE-CASE-TEST-REPORT.md';
  writeFileSync(reportPath, `${lines.join('\n')}\n`);
  log.step(`${passed}/${results.length} edge cases passed → ${reportPath}`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((error) => {
  log.error('edge-case test runner failed', error);
  process.exit(1);
});
