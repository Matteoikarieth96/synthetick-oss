/**
 * Short-direction validation — 10 sector-level bearish theses through the FULL
 * pipeline (thesis → candidates → short-rerank → audits → analysis). Checks:
 * direction auto-detected, hard filters respected, expected casualties surface,
 * and beneficiaries/winners never appear on the short list.
 */
import { log } from '../ingest/lib/log.js';
import { runResearch } from './pipeline.js';

interface ShortCase {
  name: string;
  text: string;
  expectKinds?: string[]; // every pick must be one of these
  expectRegions?: string[]; // non-crypto picks must be in these
  expectAny?: string[]; // at least one of these should appear
  neverShort?: string[]; // beneficiaries that must NOT appear
}

const CASES: ShortCase[] = [
  { name: 'AI capex bubble',
    text: 'AI capex is a bubble: model quality is plateauing while GPU spend compounds — when training budgets get cut, the whole accelerator supply chain deflates. What should I short? Only US stocks.',
    expectKinds: ['stock'], expectRegions: ['us'], expectAny: ['NVDA', 'AMD', 'AMAT', 'KLAC', 'LRCX', 'MRVL'] },
  { name: 'Office real estate collapse',
    text: 'Remote work has permanently gutted office demand and the commercial real-estate refinancing wall will crush leveraged landlords. What do I short? Only US stocks.',
    expectKinds: ['stock'], expectRegions: ['us'], neverShort: ['NVDA', 'MSFT'] },
  { name: 'Crypto speculative bubble',
    text: 'Most of crypto is a speculative bubble: no cash flows, circular leverage, and meme valuations that die when liquidity tightens. I want to short the froth. Only crypto.',
    expectKinds: ['crypto'], neverShort: [] },
  { name: 'Legacy autos vs EVs',
    text: 'The EV transition strands legacy combustion carmakers: dealer networks, engine plants and ICE supply chains become liabilities. Short candidates? Only US stocks.',
    expectKinds: ['stock'], expectRegions: ['us'], expectAny: ['F', 'GM'] },
  { name: 'Stablecoins vs payment rails',
    text: 'Dollar stablecoins and on-chain settlement will erode card interchange and cross-border remittance fees. Who loses? I want shorts. Only US stocks.',
    expectKinds: ['stock'], expectRegions: ['us'], expectAny: ['MA', 'FI', 'FIS', 'GPN'] },
  { name: 'GLP-1 vs snacks & soda',
    text: 'GLP-1 obesity drugs structurally shrink consumption of snacks, candy and sugary drinks. What packaged-food names should I short? Only US stocks.',
    expectKinds: ['stock'], expectRegions: ['us'], expectAny: ['KO', 'HSY', 'MDLZ', 'GIS', 'KHC', 'K'], neverShort: ['LLY'] },
  { name: 'Linear TV terminal decline',
    text: 'Cord-cutting is terminal: linear TV, cable bundles and broadcast ad dollars decline every quarter with no floor. Short ideas? Only US stocks.',
    expectKinds: ['stock'], expectRegions: ['us'], expectAny: ['AMCX', 'CMCSA', 'CHTR', 'FOX', 'FOXA'], neverShort: ['NFLX'] },
  { name: 'China property insolvency',
    text: 'Chinese property developers are functionally insolvent — presales collapsed and the land-finance model is broken. What should I short? Only Chinese stocks.',
    expectKinds: ['stock'], expectRegions: ['cn'] },
  { name: 'Residential solar squeeze',
    text: 'High rates broke residential solar economics: installers and inverter makers burn cash as demand craters. What to short? Only US stocks.',
    expectKinds: ['stock'], expectRegions: ['us'], expectAny: ['ENPH', 'FSLR', 'CSIQ', 'NOVA'] },
  { name: 'Ethereum L2 fragmentation (crypto short)',
    text: 'Layer 2 fragmentation destroys value accrual: every new rollup dilutes fees and no single token captures the activity. I want to short — only crypto related to the Ethereum ecosystem.',
    expectKinds: ['crypto'] },
];

async function main() {
  let pass = 0;
  const failures: string[] = [];
  for (const c of CASES) {
    try {
      const r = await runResearch(c.text);
      const checks: string[] = [];
      if (r.thesis.direction !== 'short') checks.push(`direction=${r.thesis.direction}`);
      const kindViol = c.expectKinds ? r.picks.filter((p) => !c.expectKinds!.includes(p.a.kind)) : [];
      if (kindViol.length) checks.push(`kind violations: ${kindViol.map((p) => p.a.ticker).join(',')}`);
      const regViol = c.expectRegions
        ? r.picks.filter((p) => p.a.kind !== 'crypto' && !c.expectRegions!.includes(p.a.region))
        : [];
      if (regViol.length) checks.push(`region violations: ${regViol.map((p) => p.a.ticker).join(',')}`);
      const tickers = r.picks.map((p) => p.a.ticker);
      if (c.expectAny && r.picks.length > 0 && !c.expectAny.some((t) => tickers.includes(t))) {
        checks.push(`expected any of [${c.expectAny.join(',')}] — none present`);
      }
      const leaked = (c.neverShort ?? []).filter((t) => tickers.includes(t));
      if (leaked.length) checks.push(`beneficiaries on short list: ${leaked.join(',')}`);
      if (r.picks.length === 0 && r.path !== 'empty') checks.push('no picks but path not empty');

      const ok = checks.length === 0;
      if (ok) pass++;
      else failures.push(`${c.name}: ${checks.join('; ')}`);
      log.info(
        `${ok ? 'PASS' : 'FAIL'} — ${c.name} · ${r.picks.length} shorts: ` +
          r.picks.slice(0, 6).map((p) => `${p.a.ticker}(${p.score})`).join(', ') +
          (ok ? '' : ` · ISSUES: ${checks.join('; ')}`),
      );
    } catch (err) {
      failures.push(`${c.name}: ${(err as Error).message}`);
      log.error(`FAIL — ${c.name}: ${(err as Error).message}`);
    }
  }
  log.step(`${pass}/${CASES.length} short-thesis tests passed`);
  if (failures.length) {
    failures.forEach((f) => log.warn('  ' + f));
    process.exit(1);
  }
}

main().catch((e) => {
  log.error('test-shorts failed', e);
  process.exit(1);
});
