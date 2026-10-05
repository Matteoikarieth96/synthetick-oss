/**
 * 20-case full-flow report:
 * thesis extraction -> candidates -> select -> audit -> analysis.
 *
 * Produces docs/FLOW-REPORT.md with the investment thesis and assets shown for
 * each case, then autoevaluates whether direction, requirements, expected
 * assets, and result shape make sense.
 */
import { writeFileSync } from 'node:fs';
import { log } from '../ingest/lib/log.js';
import { supabase } from '../ingest/lib/supabase.js';
import { runResearch } from './pipeline.js';

interface FlowCase {
  id: number;
  segment: string;
  name: string;
  prompt: string;
  wantDir: 'long' | 'short' | 'both';
  kinds?: string[];
  regions?: string[];
  expectAny?: string[];
  emptyOk?: boolean;
  notes?: string;
}

let nextId = 0;
const tc = (
  segment: string,
  name: string,
  prompt: string,
  extra: Omit<FlowCase, 'id' | 'segment' | 'name' | 'prompt'>,
): FlowCase => ({ id: ++nextId, segment, name, prompt, ...extra });

const CASES: FlowCase[] = [
  tc('US stocks', 'AI chips', 'AI compute demand keeps exploding; chip designers capture the spend. Only US stocks.', {
    wantDir: 'long', kinds: ['stock'], regions: ['us'], expectAny: ['NVDA', 'AMD'],
  }),
  tc('US stocks', 'Megabanks', 'US megabanks win from higher-for-longer net interest margins. Only US stocks.', {
    wantDir: 'long', kinds: ['stock'], regions: ['us'], expectAny: ['JPM', 'BAC', 'GS', 'C', 'MS'],
  }),
  tc('US stocks', 'REIT income', 'I want durable rental income from US real estate. Only US stocks.', {
    wantDir: 'long', kinds: ['stock'], regions: ['us'],
  }),
  tc('US ETFs', 'Broad market ETF', 'Broad diversified US equity market exposure via index funds. Only US ETFs.', {
    wantDir: 'long', kinds: ['etf'], regions: ['us'], expectAny: ['IVV', 'ITOT', 'DIA', 'IWB', 'SPY'],
  }),
  tc('US bond ETFs', 'Treasuries', 'US Treasury exposure via funds. Only US bond ETFs.', {
    wantDir: 'long', kinds: ['bond'], regions: ['us'],
  }),
  tc('EU stocks', 'Semicap equipment', 'European semiconductor equipment champions. Only European stocks.', {
    wantDir: 'long', kinds: ['stock'], regions: ['eu'], expectAny: ['ASML.AS', 'ASM.AS', 'BESI.AS', 'ASML'],
  }),
  tc('EU stocks', 'Luxury', 'European luxury houses have global pricing power. Only European stocks.', {
    wantDir: 'long', kinds: ['stock'], regions: ['eu'],
  }),
  tc('EU stocks', 'Banks', 'European banks re-rate as rates normalize. Only European stocks.', {
    wantDir: 'long', kinds: ['stock'], regions: ['eu'],
  }),
  tc('EU ETFs', 'Broad UCITS', 'Broad European equity exposure via UCITS funds. Only European ETFs.', {
    wantDir: 'long', kinds: ['etf'], regions: ['eu'], emptyOk: true,
    notes: 'Empty is acceptable if the ETF backfill has not populated this slice.',
  }),
  tc('China stocks', 'E-commerce', 'Chinese e-commerce giants at depressed multiples. Only Chinese stocks.', {
    wantDir: 'long', kinds: ['stock'], regions: ['cn'], expectAny: ['BABA', 'JD'],
  }),
  tc('China stocks', 'EV makers', 'Chinese EV makers win on cost and technology. Only Chinese companies.', {
    wantDir: 'long', kinds: ['stock'], regions: ['cn'], expectAny: ['LI', 'NIO', 'XPEV'],
  }),
  tc('China stocks', 'State banks', 'Chinese state banks pay high dividends. Only Chinese stocks.', {
    wantDir: 'long', kinds: ['stock'], regions: ['cn'],
  }),
  tc('Crypto', 'Bitcoin macro', 'Bitcoin is digital gold for a fragmenting world. Only crypto.', {
    wantDir: 'long', kinds: ['crypto'], expectAny: ['BTC'],
  }),
  tc('Crypto', 'Ethereum ecosystem', 'Rollups and staking make ETH productive. Only crypto related to the Ethereum ecosystem.', {
    wantDir: 'long', kinds: ['crypto'], expectAny: ['ETH', 'ARB', 'OP'],
  }),
  tc('Crypto', 'Stablecoins', "Dollar stablecoins are crypto's killer app for payments. Only crypto.", {
    wantDir: 'long', kinds: ['crypto'], expectAny: ['USDT', 'USDC'],
  }),
  tc('Crypto', 'DePIN', 'Decentralized physical infrastructure bootstraps real networks. Only crypto.', {
    wantDir: 'long', kinds: ['crypto'], expectAny: ['FIL', 'HNT', 'AR'],
  }),
  tc('Mixed', 'Mega-cap AI stocks', 'The biggest AI winners globally, mega-cap only stocks.', {
    wantDir: 'long', kinds: ['stock'],
  }),
  tc('Mixed', 'Stocks and crypto AI', 'AI exposure across public equities and decentralized compute tokens. Only US stocks and crypto.', {
    wantDir: 'long', kinds: ['stock', 'crypto'], regions: ['us'],
  }),
  tc('Shorts', 'Short AI capex', 'AI capex is a bubble; the accelerator chain deflates when budgets get cut. What should I short? Only US stocks.', {
    wantDir: 'short', kinds: ['stock'], regions: ['us'],
  }),
  tc('Both sides', 'EV transition', 'The EV transition is unstoppable. Give me longs and shorts. Only US stocks.', {
    wantDir: 'both', kinds: ['stock'], regions: ['us'],
  }),
];

interface FlowResult {
  case_: FlowCase;
  ok: boolean;
  issues: string[];
  warnings: string[];
  ms: number;
  summary: string;
  thesisDir: string;
  requirements: string;
  themes: string[];
  picks: {
    ticker: string;
    name: string;
    kind: string;
    region: string;
    dir: string;
    score: number;
    why: string;
    analysis: string;
  }[];
  candidates: number;
  path: string;
}

function esc(s: string | null | undefined): string {
  return (s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

function reqLabel(c: FlowCase): string {
  return [
    c.kinds?.length ? `kind=${c.kinds.join('/')}` : '',
    c.regions?.length ? `region=${c.regions.join('/')}` : '',
    c.expectAny?.length ? `expect any=${c.expectAny.join('/')}` : '',
    c.emptyOk ? 'empty ok' : '',
  ].filter(Boolean).join('; ') || 'none';
}

function evaluate(c: FlowCase, r: Awaited<ReturnType<typeof runResearch>>): string[] {
  const issues: string[] = [];
  if (r.thesis.direction !== c.wantDir) issues.push(`direction ${r.thesis.direction}, expected ${c.wantDir}`);
  const violations = r.picks.filter(
    (p) =>
      (c.kinds && !c.kinds.includes(p.a.kind)) ||
      (c.regions && p.a.kind !== 'crypto' && !c.regions.includes(p.a.region)),
  );
  if (violations.length) {
    issues.push(`filter violations: ${violations.map((p) => `${p.a.ticker}(${p.a.kind}/${p.a.region})`).join(', ')}`);
  }
  const tickers = r.picks.map((p) => p.a.ticker.toUpperCase());
  if (c.expectAny && !c.expectAny.some((t) => tickers.includes(t.toUpperCase()))) {
    issues.push(`expected asset missing: ${c.expectAny.join('/')}`);
  }
  if (!c.emptyOk && r.picks.length === 0) issues.push(`no assets shown (${r.path})`);
  if (c.wantDir === 'both') {
    const hasLong = r.picks.some((p) => p.dir !== 'short');
    const hasShort = r.picks.some((p) => p.dir === 'short');
    if (!hasLong || !hasShort) issues.push(`both-sides request did not show both sides`);
  }
  return issues;
}

function warningsFor(r: Awaited<ReturnType<typeof runResearch>>): string[] {
  const warnings: string[] = [];
  if (r.picks.length > 10) {
    warnings.push(`more than 10 rows displayed (${r.picks.length}) because sibling listings expanded after selection`);
  }
  return warnings;
}

async function runOne(c: FlowCase): Promise<FlowResult> {
  const started = Date.now();
  const r = await runResearch(c.prompt);
  const issues = evaluate(c, r);
  const warnings = warningsFor(r);
  const emptyOk = Boolean(c.emptyOk && r.picks.length === 0 && r.path === 'empty');
  return {
    case_: c,
    ok: issues.length === 0 || emptyOk,
    issues,
    warnings,
    ms: Date.now() - started,
    summary: r.thesis.summary,
    thesisDir: r.thesis.direction,
    requirements: reqLabel(c),
    themes: r.thesis.themes,
    candidates: r.candidates.length,
    path: r.path,
    picks: r.picks.map((p) => ({
      ticker: p.a.ticker,
      name: p.a.name,
      kind: p.a.kind,
      region: p.a.region,
      dir: p.dir ?? r.thesis.direction,
      score: p.score,
      why: p.why,
      analysis: r.analysis[p.a.ticker] ?? '',
    })),
  };
}

function buildReport(results: FlowResult[], activeAssets: number | null): string {
  const pass = results.filter((r) => r.ok).length;
  const lines: string[] = [
    '# SyntheTick - 20 full-flow test report',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Universe: ${activeAssets ?? 'unknown'} active assets`,
    `Pipeline: runResearch() full flow (thesis, candidates, select, audit, analysis)`,
    '',
    '## Summary',
    '',
    `Result: ${pass}/${results.length} cases passed autoevaluation.`,
    '',
    '| # | Segment | Case | Status | Assets shown | Time | Main issue |',
    '|---|---|---|---|---:|---:|---|',
  ];
  for (const r of results) {
    lines.push(`| ${r.case_.id} | ${esc(r.case_.segment)} | ${esc(r.case_.name)} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.picks.length} | ${(r.ms / 1000).toFixed(0)}s | ${esc(r.issues.join('; ') || r.warnings.join('; ') || r.case_.notes || '')} |`);
  }

  lines.push('', '## Cases', '');
  for (const r of results) {
    lines.push(`### ${r.case_.id}. ${r.case_.segment} - ${r.case_.name}`);
    lines.push('');
    lines.push(`Prompt: ${r.case_.prompt}`);
    lines.push('');
    lines.push(`Investment thesis: ${r.summary || '(empty summary)'}`);
    lines.push('');
    lines.push(`Extracted direction: ${r.thesisDir} (expected ${r.case_.wantDir})`);
    lines.push(`Expected requirements: ${r.requirements}`);
    lines.push(`Themes: ${r.themes.join(', ') || 'n/a'}`);
    lines.push(`Candidate count after filtering/dedupe: ${r.candidates}; path=${r.path}`);
    lines.push('');
    if (r.picks.length) {
      lines.push('| Asset | Name | Kind | Region | Side | Score | Why | Analysis |');
      lines.push('|---|---|---|---|---|---:|---|---|');
      for (const p of r.picks) {
        lines.push(`| ${esc(p.ticker)} | ${esc(p.name)} | ${esc(p.kind)} | ${esc(p.region)} | ${esc(p.dir)} | ${p.score} | ${esc(p.why)} | ${esc(p.analysis)} |`);
      }
    } else {
      lines.push('Assets showed: none.');
    }
    lines.push('');
    lines.push(`Autoevaluation: ${r.ok ? 'PASS' : 'FAIL'}${r.issues.length ? ` - ${r.issues.join('; ')}` : ''}`);
    if (r.warnings.length) lines.push(`Warnings: ${r.warnings.join('; ')}`);
    if (r.case_.notes) lines.push(`Note: ${r.case_.notes}`);
    lines.push('');
  }

  const failures = results.filter((r) => !r.ok);
  lines.push('## Autoevaluation of the flow', '');
  lines.push(`- Coverage: The set spans US stocks, US ETFs, US bond ETFs, European stocks, European ETFs, Chinese stocks, crypto, mixed stock/crypto, short-only, and long/short combined requests.`);
  lines.push(`- Requirement enforcement: ${results.reduce((n, r) => n + (r.issues.some((i) => i.includes('filter violations')) ? 1 : 0), 0)} cases had hard-filter violations in displayed assets.`);
  lines.push(`- Direction handling: ${results.reduce((n, r) => n + (r.issues.some((i) => i.includes('direction')) ? 1 : 0), 0)} cases had extracted direction mismatches.`);
  lines.push(`- Expected named/theme assets: ${results.reduce((n, r) => n + (r.issues.some((i) => i.includes('expected asset missing')) ? 1 : 0), 0)} cases missed the expected anchor or representative asset.`);
  lines.push(`- Empty states: ${results.filter((r) => r.picks.length === 0).length} cases showed no assets; empty is only expected for thin or missing universe slices such as EU ETFs before backfill.`);
  lines.push(`- Display shape: ${results.filter((r) => r.warnings.some((w) => w.includes('more than 10'))).length} cases expanded beyond 10 rows because same-company sibling listings were appended after selection.`);
  lines.push('');
  if (failures.length) {
    lines.push('### What looks off', '');
    for (const r of failures) lines.push(`- #${r.case_.id} ${r.case_.segment} / ${r.case_.name}: ${r.issues.join('; ')}`);
  } else {
    lines.push('### What looks off', '', '- No automatic failures. Manual review should still inspect whether the prose rationales are specific enough, whether asset identity is consistent across the short rationale and long analysis, and whether sibling listings make the UI feel noisy.');
  }
  lines.push('', '### Missing or worth adding next', '');
  lines.push('- Quote/market-data join is not tested here; this script verifies assets selected, not live prices or chart availability.');
  lines.push('- Add an asset-identity consistency check: one manual finding in this run was the mixed AI case where ticker AI/Sleepless AI was justified as if it were Gensyn, while the analysis correctly questioned the mismatch.');
  lines.push('- The report checks tickers and filters mechanically, but not portfolio suitability, valuation, liquidity, tax wrapper availability, or jurisdiction-specific trading access.');
  lines.push('- Some expected assets are representative, not exhaustive; a strong alternative pick can still be marked as a miss if the expected list is too narrow.');
  lines.push('- Short recommendations need extra human scrutiny because availability to borrow, borrow cost, and inverse/put alternatives are outside this flow.');
  return lines.join('\n') + '\n';
}

async function main() {
  const { count } = await supabase.from('assets').select('id', { count: 'exact', head: true }).eq('is_active', true);
  log.step(`Running ${CASES.length} full-flow cases against ${count ?? 'unknown'} active assets`);
  const results: FlowResult[] = [];
  for (const c of CASES) {
    try {
      const result = await runOne(c);
      results.push(result);
      log.info(`${result.ok ? 'PASS' : 'FAIL'} #${c.id} ${c.segment} / ${c.name} - ${result.picks.length} assets, ${(result.ms / 1000).toFixed(0)}s${result.issues.length ? ` - ${result.issues.join('; ')}` : result.warnings.length ? ` - ${result.warnings.join('; ')}` : ''}`);
    } catch (err) {
      const msg = (err as Error).message.slice(0, 220);
      results.push({
        case_: c,
        ok: false,
        issues: [`runtime error: ${msg}`],
        warnings: [],
        ms: 0,
        summary: '',
        thesisDir: '',
        requirements: reqLabel(c),
        themes: [],
        picks: [],
        candidates: 0,
        path: 'error',
      });
      log.error(`FAIL #${c.id} ${c.name}: ${msg}`);
    }
  }
  const report = buildReport(results, count ?? null);
  writeFileSync('docs/FLOW-REPORT.md', report);
  const pass = results.filter((r) => r.ok).length;
  log.step(`${pass}/${results.length} full-flow cases passed autoevaluation -> docs/FLOW-REPORT.md`);
  if (pass !== results.length) process.exit(1);
}

main().catch((err) => {
  log.error('flow report failed', err);
  process.exit(1);
});
