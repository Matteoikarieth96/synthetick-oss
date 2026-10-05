/**
 * 100-case coverage matrix — stocks/ETFs/crypto × US/EU/China × long/short.
 * Retrieval-level for all cases (hard filters + candidate quality; 1 Voyage
 * embed each), plus full-pipeline runs for cases flagged `full` (direction
 * detection, rerank, audits). Produces a markdown report.
 *
 *   npm run test:matrix              # all 100 retrieval + flagged full runs
 *   MATRIX_FULL=false npm run test:matrix   # retrieval only (cheap/fast)
 */
import { writeFileSync } from 'node:fs';
import { log } from '../ingest/lib/log.js';
import { supabase } from '../ingest/lib/supabase.js';
import { getCandidates, type Requirements } from './candidates.js';
import { runResearch } from './pipeline.js';

interface Case {
  id: number;
  seg: string; // report segment
  name: string;
  text: string; // the user prompt
  req: Requirements; // hard filters as /thesis+box would derive
  expectAny?: string[]; // at least one must be in the candidate set
  emptyOk?: boolean; // honest empty acceptable (e.g. EU ETFs pre-backfill)
  full?: 'long' | 'short' | 'both'; // also run the full pipeline, expect this direction
}

const S = (regionSet: Requirements['regionSet']): Requirements => ({ assetSet: ['stock'], regionSet });
const E = (regionSet: Requirements['regionSet']): Requirements => ({ assetSet: ['etf'], regionSet });
const C = (semantic?: string): Requirements => ({ assetSet: ['crypto'], semantic: semantic ?? null });

let n = 0;
const c = (seg: string, name: string, text: string, req: Requirements, extra: Partial<Case> = {}): Case =>
  ({ id: ++n, seg, name, text, req, ...extra });

const CASES: Case[] = [
  // ───────────────────────── US stocks (15) ─────────────────────────
  c('US stocks', 'AI chips', 'AI compute demand keeps exploding; chip designers capture the spend. Only US stocks.', S(['us']), { expectAny: ['NVDA', 'AMD'], full: 'long' }),
  c('US stocks', 'Semicap equipment', 'Semiconductor equipment is the picks and shovels of AI. Only US stocks.', S(['us']), { expectAny: ['AMAT', 'KLAC', 'LRCX'] }),
  c('US stocks', 'Megabanks', 'US megabanks win from higher-for-longer net interest margins. Only US stocks.', S(['us']), { expectAny: ['JPM', 'BAC', 'GS'] }),
  c('US stocks', 'Defense primes', 'Rearmament cycles drive multiyear defense backlogs. Only US stocks.', S(['us']), { expectAny: ['LMT', 'GD', 'NOC'] }),
  c('US stocks', 'GLP-1 pharma', 'GLP-1 drugs reshape healthcare economics. Only US stocks.', S(['us']), { expectAny: ['LLY'] }),
  c('US stocks', 'Cybersecurity', 'AI-powered attacks make security spend non-discretionary. Only US stocks.', S(['us']), { expectAny: ['CRWD', 'FTNT', 'NET'] }),
  c('US stocks', 'Streaming', 'Streaming with ad tiers wins the living room. Only US stocks.', S(['us']), { expectAny: ['NFLX'] }),
  c('US stocks', 'Cloud software', 'Enterprise workloads keep shifting to hyperscale cloud platforms. Only US stocks.', S(['us']), { expectAny: ['MSFT', 'GOOGL', 'AMZN'] }),
  c('US stocks', 'EV & charging', 'US EV adoption compounds with charging infrastructure. Only US stocks.', S(['us']), { expectAny: ['GM', 'F', 'CHPT', 'EVGO'] }),
  c('US stocks', 'REITs / income', 'I want durable rental income from US real estate. Only US stocks.', S(['us']), { expectAny: ['O', 'EQR', 'MAA', 'AMH'] }),
  c('US stocks', 'Energy majors', 'Oil and gas majors gush free cash flow at these prices. Only US stocks.', S(['us']), { expectAny: ['CVX', 'COP', 'XOM', 'EOG', 'HES'] }),
  c('US stocks', 'Digital ads', 'Digital advertising rebounds with AI targeting. Only US stocks.', S(['us']), { expectAny: ['META', 'GOOGL', 'APP'] }),
  c('US stocks', 'Retail giants', 'Scale retailers with logistics moats keep taking share. Only US stocks.', S(['us']), { expectAny: ['AMZN', 'COST', 'HD'] }),
  c('US stocks', 'Industrial automation', 'Reshoring drives factory automation and electrification. Only US stocks.', S(['us']), { expectAny: ['EMR', 'ETN', 'HON', 'AME'] }),
  c('US stocks', 'Obesity-econ mega caps only', 'GLP-1 winners, but I only want mega caps. Only US stocks.', { ...S(['us']), capSet: ['mega'] }, { expectAny: ['LLY'] }),
  // ───────────────────────── US ETFs (10) ─────────────────────────
  c('US ETFs', 'Broad market', 'Broad diversified US equity market exposure via index funds. Only US ETFs.', E(['us']), { expectAny: ['IVV', 'ITOT', 'DIA', 'IWB'] }),
  c('US ETFs', 'Semiconductor sector', 'Semiconductor sector exposure via an ETF. Only US ETFs.', E(['us']) ),
  c('US ETFs', 'Tech sector', 'Technology sector fund for long-term growth. Only US ETFs.', E(['us']) ),
  c('US ETFs', 'Energy sector', 'Energy sector ETF to ride oil strength. Only US ETFs.', E(['us']) ),
  c('US ETFs', 'Dividend income', 'High dividend income equity funds. Only US ETFs.', E(['us']) ),
  c('US ETFs', 'Small caps', 'US small-cap exposure through a fund. Only US ETFs.', E(['us']) ),
  c('US ETFs', 'Gold', 'Physical gold exposure via an ETF. Only US ETFs.', E(['us']), { expectAny: ['AAAU', 'IAU', 'GLDM'] }),
  c('US ETFs', 'Healthcare sector', 'Healthcare and biotech sector funds. Only US ETFs.', E(['us']) ),
  c('US ETFs', 'Treasury bonds', 'US Treasury exposure via funds. Only US bond ETFs.', { assetSet: ['bond'], regionSet: ['us'] } ),
  c('US ETFs', 'Corporate bonds', 'Investment-grade corporate bond funds. Only US bond ETFs.', { assetSet: ['bond'], regionSet: ['us'] } ),
  // ───────────────────────── EU stocks (15) ─────────────────────────
  c('EU stocks', 'Semis (ASML)', 'European semiconductor equipment champions. Only European stocks.', S(['eu']), { expectAny: ['ASML.AS', 'ASM.AS', 'BESI.AS'], full: 'long' }),
  c('EU stocks', 'Luxury', 'European luxury houses have pricing power with global wealth. Only European stocks.', S(['eu']) ),
  c('EU stocks', 'Pharma', 'European pharma pipelines are undervalued. Only European stocks.', S(['eu']) ),
  c('EU stocks', 'Banks', 'European banks re-rate as rates normalize. Only European stocks.', S(['eu']) ),
  c('EU stocks', 'Defense', 'European rearmament lifts defense contractors. Only European stocks.', S(['eu']) ),
  c('EU stocks', 'Autos', 'European carmakers navigate the EV transition. Only European stocks.', S(['eu']) ),
  c('EU stocks', 'Energy majors', 'European integrated energy majors return cash. Only European stocks.', S(['eu']) ),
  c('EU stocks', 'Industrials', 'European industrial automation and electrification. Only European stocks.', S(['eu']) ),
  c('EU stocks', 'Software', 'European enterprise software champions. Only European stocks.', S(['eu']) ),
  c('EU stocks', 'Renewables', 'European wind and renewable developers. Only European stocks.', S(['eu']) ),
  c('EU stocks', 'Food & beverage', 'European food and beverage staples compound quietly. Only European stocks.', S(['eu']) ),
  c('EU stocks', 'Aerospace', 'European commercial aerospace has a decade of backlog. Only European stocks.', S(['eu']) ),
  c('EU stocks', 'Telecom', 'European telecom consolidation improves returns. Only European stocks.', S(['eu']) ),
  c('EU stocks', 'Chemicals', 'European specialty chemicals rebound with industry. Only European stocks.', S(['eu']) ),
  c('EU stocks', 'Insurance', 'European insurers benefit from higher yields. Only European stocks.', S(['eu']) ),
  // ───────────────────────── EU ETFs (5) — pre-backfill: honest empty OK ─────────────────────────
  c('EU ETFs', 'Broad UCITS', 'Broad European equity exposure via UCITS index funds. Only European ETFs.', E(['eu']), { emptyOk: true }),
  c('EU ETFs', 'DAX / Germany', 'German large-cap index fund. Only European ETFs.', E(['eu']), { emptyOk: true }),
  c('EU ETFs', 'EU dividend', 'European dividend equity funds. Only European ETFs.', E(['eu']), { emptyOk: true }),
  c('EU ETFs', 'EU bonds', 'European government bond funds. Only European bond ETFs.', { assetSet: ['bond'], regionSet: ['eu'] }, { emptyOk: true }),
  c('EU ETFs', 'EU sector', 'European bank sector fund. Only European ETFs.', E(['eu']), { emptyOk: true }),
  // ───────────────────────── China stocks (15) ─────────────────────────
  c('CN stocks', 'E-commerce', 'Chinese e-commerce giants at depressed multiples. Only Chinese stocks.', S(['cn']), { expectAny: ['BABA', 'JD'], full: 'long' }),
  c('CN stocks', 'EV makers', 'Chinese EV makers win on cost and tech. Only Chinese companies.', S(['cn']), { expectAny: ['LI', 'NIO'] }),
  c('CN stocks', 'State banks', 'Chinese state banks pay high dividends. Only Chinese stocks.', S(['cn']), { expectAny: ['IDCBY', 'ACGBY'] }),
  c('CN stocks', 'Internet platforms', 'Chinese internet platforms monetize gaming and social. Only Chinese stocks.', S(['cn']), { expectAny: ['NTES', 'TCEHY', 'BIDU'] }),
  c('CN stocks', 'Consumer recovery', 'The Chinese consumer recovery lifts retail and travel. Only Chinese stocks.', S(['cn']) ),
  c('CN stocks', 'Property developers', 'Chinese property policy easing helps surviving developers. Only Chinese stocks.', S(['cn']) ),
  c('CN stocks', 'Energy', 'Chinese oil and coal producers are cash machines. Only Chinese stocks.', S(['cn']) ),
  c('CN stocks', 'Telecom', 'Chinese telecom carriers yield well. Only Chinese stocks.', S(['cn']) ),
  c('CN stocks', 'Biotech', 'Chinese biotech innovates at lower cost. Only Chinese stocks.', S(['cn']) ),
  c('CN stocks', 'Semiconductors', 'China domesticates its semiconductor supply chain. Only Chinese stocks.', S(['cn']) ),
  c('CN stocks', 'Insurance', 'Chinese life insurers trade below embedded value. Only Chinese stocks.', S(['cn']) ),
  c('CN stocks', 'Appliances', 'Chinese appliance makers dominate globally. Only Chinese stocks.', S(['cn']) ),
  c('CN stocks', 'Logistics', 'Chinese logistics and delivery scale with e-commerce. Only Chinese stocks.', S(['cn']) ),
  c('CN stocks', 'Travel', 'Chinese outbound travel recovery. Only Chinese stocks.', S(['cn']) ),
  c('CN stocks', 'Food delivery', 'Chinese food delivery platforms rationalize competition. Only Chinese stocks.', S(['cn']), { expectAny: ['MPNGF', 'MPNGY'] }),
  // ───────────────────────── Crypto (20) ─────────────────────────
  c('Crypto', 'Bitcoin macro', 'Bitcoin is digital gold for a fragmenting world. Only crypto.', C(), { expectAny: ['BTC'], full: 'long' }),
  c('Crypto', 'Ethereum ecosystem', 'Rollups make ETH productive. Only crypto related to the Ethereum ecosystem.', C('Ethereum ecosystem'), { expectAny: ['ETH'] }),
  c('Crypto', 'Layer 2', 'L2 rollups capture sequencer revenue. Only crypto.', C('Layer 2'), { expectAny: ['ARB', 'OP'] }),
  c('Crypto', 'DeFi lending', 'On-chain lending eats bank margins. Only crypto.', C() ),
  c('Crypto', 'DEXs', 'Decentralized exchanges take spot volume from CEXes. Only crypto.', C() ),
  c('Crypto', 'Stablecoins', 'Dollar stablecoins are crypto’s killer app. Only crypto.', C(), { expectAny: ['USDT', 'USDC'] }),
  c('Crypto', 'Decentralized AI', 'Decentralized GPU and AI-model markets monetize compute. Only crypto.', C(), { expectAny: ['RENDER', 'TAO'] }),
  c('Crypto', 'Solana ecosystem', 'Consumer apps live on Solana. Only crypto in the Solana ecosystem.', C('Solana ecosystem'), { expectAny: ['SOL'] }),
  c('Crypto', 'Liquid staking', 'Liquid staking turns stake into collateral. Only crypto.', C(), { expectAny: ['LDO', 'ETHFI', 'RPL'] }),
  c('Crypto', 'DePIN', 'Decentralized physical infrastructure bootstraps real networks. Only crypto.', C(), { expectAny: ['FIL', 'HNT', 'AR'] }),
  c('Crypto', 'Gaming', 'On-chain gaming economies monetize ownership. Only crypto.', C('Gaming') ),
  c('Crypto', 'Oracles', 'Oracles are the data layer every chain needs. Only crypto.', C(), { expectAny: ['LINK', 'PYTH'] }),
  c('Crypto', 'RWA tokenization', 'Real-world asset tokenization brings bonds on-chain. Only crypto.', C() ),
  c('Crypto', 'Payments', 'Crypto payment rails beat remittance fees. Only crypto.', C(), { expectAny: ['XRP', 'XLM'] }),
  c('Crypto', 'Privacy', 'Privacy-preserving transactions have durable demand. Only crypto.', C() ),
  c('Crypto', 'Interoperability', 'Cross-chain interoperability protocols connect liquidity. Only crypto.', C() ),
  c('Crypto', 'Exchange tokens', 'Exchange tokens accrue fee value. Only crypto.', C(), { expectAny: ['BNB', 'OKB', 'BGB'] }),
  c('Crypto', 'Storage', 'Decentralized storage undercuts cloud pricing. Only crypto.', C(), { expectAny: ['FIL', 'AR'] }),
  c('Crypto', 'Bitcoin ecosystem', 'Bitcoin L2s and ordinals expand BTC utility. Only crypto.', C('Bitcoin ecosystem') ),
  c('Crypto', 'CEX-only constraint', 'Major-exchange-listed crypto for easy access. Only crypto on major exchanges.', { ...C(), cexOnly: true } ),
  // ───────────────────────── Cross-region / mixed filters (10) ─────────────────────────
  c('Mixed filters', 'US+EU stocks', 'Transatlantic industrial champions. Only US or European stocks.', S(['us', 'eu']) ),
  c('Mixed filters', 'Mega caps only', 'The biggest AI winners globally, mega-cap only stocks.', { assetSet: ['stock'], capSet: ['mega'] } ),
  c('Mixed filters', 'Small caps US', 'Hidden small-cap US gems in defense. Only US small-cap stocks.', { ...S(['us']), capSet: ['small', 'micro'] } ),
  c('Mixed filters', 'Exclude defense', 'Industrial automation but exclude anything defense-related. Only US stocks.', { ...S(['us']), excludeTickers: [] } ),
  c('Mixed filters', 'Stocks+crypto AI', 'AI exposure across stocks and crypto. Only US stocks and crypto.', { assetSet: ['stock', 'crypto'], regionSet: ['us'] } ),
  c('Mixed filters', 'Exclude ticker', 'Semiconductor winners but never NVDA. Only US stocks.', { ...S(['us']), excludeTickers: ['NVDA'] } ),
  c('Mixed filters', 'EU large caps', 'European large-cap quality compounders. Only European large-cap stocks.', { ...S(['eu']), capSet: ['mega', 'large'] } ),
  c('Mixed filters', 'CN mega caps', 'Chinese mega-cap platforms. Only Chinese mega-cap stocks.', { ...S(['cn']), capSet: ['mega', 'large'] } ),
  c('Mixed filters', 'Global bonds', 'Fixed income exposure via bond funds, any market.', { assetSet: ['bond'] } ),
  c('Mixed filters', 'Crypto mid caps', 'Established but not giant crypto projects. Only mid-cap crypto.', { ...C(), capSet: ['mid', 'small'] } ),
  // ───────────────────────── Shorts across the matrix (10) ─────────────────────────
  c('Shorts', 'Short AI capex (US)', 'AI capex is a bubble; the accelerator chain deflates. What should I short? Only US stocks.', S(['us']), { full: 'short' }),
  c('Shorts', 'Short US offices', 'Remote work guts office demand; landlords refinance into a wall. Short? Only US stocks.', S(['us']), { full: 'short' }),
  c('Shorts', 'Short EU autos', 'Chinese EVs undercut European carmakers at home. What to short? Only European stocks.', S(['eu']), { full: 'short' }),
  c('Shorts', 'Short EU luxury', 'Chinese consumer weakness breaks European luxury growth. Short? Only European stocks.', S(['eu']) ),
  c('Shorts', 'Short CN property', 'Chinese developers are insolvent. What should I short? Only Chinese stocks.', S(['cn']), { full: 'short' }),
  c('Shorts', 'Short CN banks', 'Chinese bank NPLs are understated; margins compress. Short? Only Chinese stocks.', S(['cn']) ),
  c('Shorts', 'Short memecoins', 'Memecoins die when liquidity tightens. I want to short the froth. Only crypto.', C(), { full: 'short' }),
  c('Shorts', 'Short L1 alts', 'Ghost-town alt L1s bleed to Ethereum and Solana. Short? Only crypto.', C() ),
  c('Shorts', 'Short snacks (GLP-1)', 'GLP-1 shrinks snacking structurally. What do I short? Only US stocks.', S(['us']), { full: 'short' }),
  c('Shorts', 'Both sides EV (US)', 'EV transition is unstoppable. Give me longs and shorts. Only US stocks.', S(['us']), { full: 'both' }),
];

interface Result {
  case_: Case;
  status: 'PASS' | 'FAIL' | 'EMPTY-OK';
  rows: number;
  violations: number;
  hits: string[];
  top: string[];
  fullStatus?: string;
  issue?: string;
}

const RUN_FULL = (process.env.MATRIX_FULL ?? 'true') !== 'false';

async function retrievalCheck(cs: Case): Promise<Result> {
  const rows = await getCandidates(cs.text, cs.req);
  const tickers = rows.map((r) => r.ticker);
  const violations = rows.filter(
    (r) =>
      (cs.req.assetSet && !cs.req.assetSet.includes(r.kind as never)) ||
      (cs.req.regionSet && r.kind !== 'crypto' && !cs.req.regionSet.includes(r.region as never)) ||
      (cs.req.capSet && r.cap_class && !cs.req.capSet.includes(r.cap_class as never)) ||
      (cs.req.excludeTickers ?? []).includes(r.ticker),
  ).length;
  const hits = (cs.expectAny ?? []).filter((t) => tickers.includes(t));
  let status: Result['status'] = 'PASS';
  let issue: string | undefined;
  if (violations > 0) { status = 'FAIL'; issue = `${violations} hard-filter violations`; }
  else if (rows.length === 0) {
    if (cs.emptyOk) status = 'EMPTY-OK';
    else { status = 'FAIL'; issue = 'no candidates (unexpected empty)'; }
  } else if (cs.expectAny && hits.length === 0) { status = 'FAIL'; issue = `expected any of [${cs.expectAny.join(',')}] in candidates`; }
  return { case_: cs, status, rows: rows.length, violations, hits, top: tickers.slice(0, 5), issue };
}

async function fullCheck(cs: Case, res: Result): Promise<void> {
  try {
    const r = await runResearch(cs.text);
    const dirOk = r.thesis.direction === cs.full;
    const picksOk = r.picks.length > 0 || r.path === 'empty';
    const viol = r.picks.filter(
      (p) =>
        (cs.req.assetSet && !cs.req.assetSet.includes(p.a.kind as never)) ||
        (cs.req.regionSet && p.a.kind !== 'crypto' && !cs.req.regionSet.includes(p.a.region as never)),
    ).length;
    const bothOk = cs.full !== 'both' || (r.picks.some((p) => p.dir === 'long') && r.picks.some((p) => p.dir === 'short'));
    res.fullStatus =
      dirOk && picksOk && viol === 0 && bothOk
        ? `full ✓ (${r.picks.length} picks, dir=${r.thesis.direction})`
        : `full ✗ (dir=${r.thesis.direction} want=${cs.full}, picks=${r.picks.length}, viol=${viol}${cs.full === 'both' ? `, both=${bothOk}` : ''})`;
    if (res.fullStatus.includes('✗') && res.status === 'PASS') { res.status = 'FAIL'; res.issue = res.fullStatus; }
  } catch (err) {
    res.fullStatus = `full ✗ error: ${(err as Error).message.slice(0, 80)}`;
    res.status = 'FAIL';
    res.issue = res.fullStatus;
  }
}

async function main() {
  const t0 = Date.now();
  const { count } = await supabase.from('assets').select('id', { count: 'exact', head: true }).eq('is_active', true);
  log.step(`Matrix: ${CASES.length} cases against ${count} active assets (full runs: ${RUN_FULL})`);

  const results: Result[] = [];
  for (const cs of CASES) {
    try {
      const res = await retrievalCheck(cs);
      if (RUN_FULL && cs.full) await fullCheck(cs, res);
      results.push(res);
      log.info(`${res.status.padEnd(8)} #${cs.id} [${cs.seg}] ${cs.name} — ${res.rows} rows${res.hits.length ? `, hit: ${res.hits.join(',')}` : ''}${res.fullStatus ? ` · ${res.fullStatus}` : ''}${res.issue ? ` · ${res.issue}` : ''}`);
    } catch (err) {
      results.push({ case_: cs, status: 'FAIL', rows: 0, violations: 0, hits: [], top: [], issue: (err as Error).message.slice(0, 100) });
      log.error(`FAIL #${cs.id} ${cs.name}: ${(err as Error).message}`);
    }
  }

  // ---- report ----
  const segs = [...new Set(results.map((r) => r.case_.seg))];
  const lines: string[] = [
    `# SyntheTick — 100-case coverage report`,
    ``,
    `Generated: ${new Date().toISOString()} · Universe: ${count} active assets · Full-pipeline runs: ${RUN_FULL ? 'yes (flagged cases)' : 'no'}`,
    ``,
    `| Segment | Pass | Empty-OK | Fail | Total |`,
    `|---|---|---|---|---|`,
  ];
  for (const seg of segs) {
    const rs = results.filter((r) => r.case_.seg === seg);
    lines.push(`| ${seg} | ${rs.filter((r) => r.status === 'PASS').length} | ${rs.filter((r) => r.status === 'EMPTY-OK').length} | ${rs.filter((r) => r.status === 'FAIL').length} | ${rs.length} |`);
  }
  const totalPass = results.filter((r) => r.status !== 'FAIL').length;
  lines.push(`| **Total** | **${results.filter((r) => r.status === 'PASS').length}** | **${results.filter((r) => r.status === 'EMPTY-OK').length}** | **${results.filter((r) => r.status === 'FAIL').length}** | **${results.length}** |`, ``);

  for (const seg of segs) {
    lines.push(`## ${seg}`, ``, `| # | Case | Status | Rows | Expected hit | Top candidates | Notes |`, `|---|---|---|---|---|---|---|`);
    for (const r of results.filter((x) => x.case_.seg === seg)) {
      lines.push(`| ${r.case_.id} | ${r.case_.name} | ${r.status} | ${r.rows} | ${r.hits.join(', ') || (r.case_.expectAny ? '—' : 'n/a')} | ${r.top.join(', ')} | ${[r.fullStatus, r.issue].filter(Boolean).join(' · ')} |`);
    }
    lines.push(``);
  }
  const failing = results.filter((r) => r.status === 'FAIL');
  lines.push(`## What is not working`, ``);
  if (!failing.length) lines.push(`Nothing — all ${results.length} cases pass (or are honest empties where the backfill hasn't landed).`);
  failing.forEach((r) => lines.push(`- **#${r.case_.id} ${r.case_.seg} / ${r.case_.name}** — ${r.issue}`));

  const path = 'docs/TEST-REPORT.md';
  writeFileSync(path, lines.join('\n') + '\n');
  log.step(`${totalPass}/${results.length} cases OK in ${((Date.now() - t0) / 60000).toFixed(1)} min → report at ${path}`);
  if (failing.length) process.exit(1);
}

main().catch((e) => { log.error('matrix failed', e); process.exit(1); });
