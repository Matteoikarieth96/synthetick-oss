/**
 * Model-comparison suite — the SAME 20 prompts through the FULL pipeline on
 * 5 OpenRouter models, most → least powerful (100 runs). Retrieval never
 * touches the LLM, so differences isolate: thesis extraction (direction,
 * requirements), rerank quality, JSON discipline (repair/retry path), audits,
 * and latency. Produces docs/MODEL-REPORT.md.
 */
import { writeFileSync } from 'node:fs';
import { log } from '../ingest/lib/log.js';
import { runResearch } from './pipeline.js';
import { requireOpenRouterKey } from './llm.js';

interface Prompt {
  id: number;
  seg: string;
  name: string;
  text: string;
  dir: 'long' | 'short' | 'both';
  kinds?: string[]; // allowed pick kinds
  regions?: string[]; // allowed non-crypto pick regions
  expectAny?: string[];
  emptyOk?: boolean;
}

let n = 0;
const p = (seg: string, name: string, text: string, extra: Partial<Prompt> = {}): Prompt =>
  ({ id: ++n, seg, name, text, dir: 'long', ...extra });

const PROMPTS: Prompt[] = [
  p('US stocks', 'AI chips', 'AI compute demand keeps exploding; chip designers capture the spend. Only US stocks.', { kinds: ['stock'], regions: ['us'], expectAny: ['NVDA', 'AMD'] }),
  p('US stocks', 'Megabanks', 'US megabanks win from higher-for-longer net interest margins. Only US stocks.', { kinds: ['stock'], regions: ['us'], expectAny: ['JPM', 'BAC', 'GS', 'C', 'MS'] }),
  p('US stocks', 'Defense', 'Rearmament cycles drive multiyear defense backlogs. Only US stocks.', { kinds: ['stock'], regions: ['us'], expectAny: ['LMT', 'GD', 'NOC', 'LHX'] }),
  p('US stocks', 'REIT income', 'I want durable rental income from US real estate. Only US stocks.', { kinds: ['stock'], regions: ['us'] }),
  p('US ETFs', 'Broad market', 'Broad diversified US equity exposure via index funds. Only US ETFs.', { kinds: ['etf'], regions: ['us'] }),
  p('US ETFs', 'Treasuries', 'US Treasury exposure via funds. Only US bond ETFs.', { kinds: ['bond'], regions: ['us'] }),
  p('EU stocks', 'Semis', 'European semiconductor equipment champions. Only European stocks.', { kinds: ['stock'], regions: ['eu'], expectAny: ['ASML.AS', 'ASM.AS', 'BESI.AS'] }),
  p('EU stocks', 'Luxury', 'European luxury houses have global pricing power. Only European stocks.', { kinds: ['stock'], regions: ['eu'] }),
  p('EU stocks', 'Banks', 'European banks re-rate as rates normalize. Only European stocks.', { kinds: ['stock'], regions: ['eu'] }),
  p('EU ETFs', 'UCITS broad', 'Broad European equity exposure via UCITS funds. Only European ETFs.', { kinds: ['etf'], regions: ['eu'], emptyOk: true }),
  p('CN stocks', 'E-commerce', 'Chinese e-commerce giants at depressed multiples. Only Chinese stocks.', { kinds: ['stock'], regions: ['cn'], expectAny: ['BABA', 'JD'] }),
  p('CN stocks', 'EV makers', 'Chinese EV makers win on cost and technology. Only Chinese companies.', { kinds: ['stock'], regions: ['cn'], expectAny: ['LI', 'NIO', 'XPEV'] }),
  p('CN stocks', 'State banks', 'Chinese state banks pay high dividends. Only Chinese stocks.', { kinds: ['stock'], regions: ['cn'] }),
  p('Crypto', 'BTC macro', 'Bitcoin is digital gold for a fragmenting world. Only crypto.', { kinds: ['crypto'], expectAny: ['BTC'] }),
  p('Crypto', 'ETH ecosystem', 'Rollups and staking make ETH productive. Only crypto related to the Ethereum ecosystem.', { kinds: ['crypto'] }),
  p('Crypto', 'Stablecoins', 'Dollar stablecoins are crypto’s killer app for payments. Only crypto.', { kinds: ['crypto'], expectAny: ['USDT', 'USDC'] }),
  p('Crypto', 'DePIN', 'Decentralized physical infrastructure bootstraps real networks. Only crypto.', { kinds: ['crypto'] }),
  p('Mixed', 'Mega-cap AI', 'The biggest AI winners globally, mega-cap only stocks.', { kinds: ['stock'] }),
  p('Shorts', 'Short AI capex', 'AI capex is a bubble; the accelerator chain deflates when budgets cut. What should I short? Only US stocks.', { dir: 'short', kinds: ['stock'], regions: ['us'] }),
  p('Both', 'EV both sides', 'The EV transition is unstoppable. Give me longs and shorts. Only US stocks.', { dir: 'both', kinds: ['stock'], regions: ['us'] }),
];

/** Preference ladder, most → least powerful; first live match per rung wins. */
const RUNGS: { label: string; patterns: RegExp[] }[] = [
  { label: 'frontier (Anthropic Opus-class)', patterns: [/^anthropic\/claude-opus-4\.8$/, /^anthropic\/claude-opus-4\.8/, /^anthropic\/claude-opus-4\.5$/, /^anthropic\/claude-opus/] },
  { label: 'frontier (OpenAI GPT-class)', patterns: [/^openai\/gpt-5\.\d+$/, /^openai\/gpt-5$/, /^openai\/gpt-4\.1$/, /^openai\/gpt-4o$/] },
  { label: 'strong mid (Gemini Pro-class)', patterns: [/^google\/gemini-2\.5-pro/, /^google\/gemini-pro-1\.5/, /^google\/gemini.*pro/] },
  { label: 'fast small (Haiku/Flash-class)', patterns: [/^anthropic\/claude-haiku-4\.5/, /^anthropic\/claude-3\.5-haiku/, /^google\/gemini-2\.5-flash$/, /^google\/gemini.*flash/] },
  { label: 'small open-weights', patterns: [/^meta-llama\/llama-4/, /^meta-llama\/llama-3\.3-70b/, /^mistralai\/mistral-small/, /^qwen\/qwen-2\.5-72b/] },
];

async function pickModels(): Promise<{ label: string; slug: string }[]> {
  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { authorization: `Bearer ${requireOpenRouterKey()}` },
  });
  if (!res.ok) throw new Error(`models list HTTP ${res.status}`);
  const { data } = (await res.json()) as { data: { id: string }[] };
  const ids = data.map((m) => m.id);
  const chosen: { label: string; slug: string }[] = [];
  for (const rung of RUNGS) {
    let hit: string | undefined;
    for (const re of rung.patterns) {
      hit = ids.find((id) => re.test(id));
      if (hit) break;
    }
    if (hit && !chosen.some((c) => c.slug === hit)) chosen.push({ label: rung.label, slug: hit });
    else if (!hit) log.warn(`no live model for rung "${rung.label}"`);
  }
  return chosen;
}

interface RunRes {
  prompt: Prompt;
  ok: boolean;
  picks: number;
  dirOk: boolean;
  viol: number;
  hit: boolean | null;
  ms: number;
  issue?: string;
}

async function runOne(pr: Prompt): Promise<RunRes> {
  const t0 = Date.now();
  try {
    const r = await runResearch(pr.text);
    const dirOk = r.thesis.direction === pr.dir;
    const viol = r.picks.filter(
      (x) =>
        (pr.kinds && !pr.kinds.includes(x.a.kind)) ||
        (pr.regions && x.a.kind !== 'crypto' && !pr.regions.includes(x.a.region)),
    ).length;
    const tickers = r.picks.map((x) => x.a.ticker);
    const hit = pr.expectAny ? pr.expectAny.some((t) => tickers.includes(t)) : null;
    const emptyBad = r.picks.length === 0 && !pr.emptyOk && r.path !== 'empty';
    const bothOk = pr.dir !== 'both' || (r.picks.some((x) => x.dir === 'long') && r.picks.some((x) => x.dir === 'short'));
    const noResultsBad = r.picks.length === 0 && !pr.emptyOk && r.path === 'empty';
    const ok = dirOk && viol === 0 && hit !== false && !emptyBad && bothOk && !noResultsBad;
    const issues: string[] = [];
    if (!dirOk) issues.push(`dir=${r.thesis.direction}≠${pr.dir}`);
    if (viol) issues.push(`${viol} filter violations`);
    if (hit === false) issues.push(`missing ${pr.expectAny!.join('/')}`);
    if (noResultsBad) issues.push('unexpected empty');
    if (!bothOk) issues.push('missing one side');
    return { prompt: pr, ok, picks: r.picks.length, dirOk, viol, hit, ms: Date.now() - t0, issue: issues.join('; ') || undefined };
  } catch (err) {
    return { prompt: pr, ok: false, picks: 0, dirOk: false, viol: 0, hit: null, ms: Date.now() - t0, issue: `ERROR: ${(err as Error).message.slice(0, 90)}` };
  }
}

async function main() {
  let models = await pickModels();
  // MODELS_ONLY=slug[,slug] re-runs specific tranches (e.g. after a fix);
  // REPORT_PATH redirects output so the main report isn't clobbered.
  const only = (process.env.MODELS_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (only.length) models = models.filter((m) => only.includes(m.slug));
  log.step(`Models (most → least powerful): ${models.map((m) => m.slug).join(' · ')}`);
  const all: Record<string, RunRes[]> = {};

  for (const m of models) {
    process.env.SIGNAL_LLM_MODEL = m.slug;
    log.step(`━━ ${m.slug} (${m.label}) — 20 prompts ━━`);
    const results: RunRes[] = [];
    for (const pr of PROMPTS) {
      const r = await runOne(pr);
      results.push(r);
      log.info(`${r.ok ? 'PASS' : 'FAIL'} [${m.slug}] #${pr.id} ${pr.name} — ${r.picks} picks, ${(r.ms / 1000).toFixed(0)}s${r.issue ? ' · ' + r.issue : ''}`);
    }
    all[m.slug] = results;
  }

  // ---- report ----
  const lines: string[] = [
    `# SyntheTick — model comparison report (OpenRouter)`,
    ``,
    `Generated: ${new Date().toISOString()} · Same 20 full-pipeline prompts per model · Retrieval identical across models (Voyage embeddings)`,
    ``,
    `| Model | Class | Pass | Avg picks | Avg run time | Failures |`,
    `|---|---|---|---|---|---|`,
  ];
  for (const m of models) {
    const rs = all[m.slug]!;
    const pass = rs.filter((r) => r.ok).length;
    const avgP = (rs.reduce((s, r) => s + r.picks, 0) / rs.length).toFixed(1);
    const avgT = (rs.reduce((s, r) => s + r.ms, 0) / rs.length / 1000).toFixed(0);
    const fails = rs.filter((r) => !r.ok).map((r) => `#${r.prompt.id}`).join(' ') || '—';
    lines.push(`| \`${m.slug}\` | ${m.label} | ${pass}/20 | ${avgP} | ${avgT}s | ${fails} |`);
  }
  lines.push(``);
  for (const m of models) {
    lines.push(`## ${m.slug}`, ``, `| # | Prompt | OK | Picks | Dir | Viol | Hit | Time | Issue |`, `|---|---|---|---|---|---|---|---|---|`);
    for (const r of all[m.slug]!) {
      lines.push(
        `| ${r.prompt.id} | ${r.prompt.name} | ${r.ok ? '✅' : '❌'} | ${r.picks} | ${r.dirOk ? '✓' : '✗'} | ${r.viol} | ${r.hit === null ? 'n/a' : r.hit ? '✓' : '✗'} | ${(r.ms / 1000).toFixed(0)}s | ${r.issue ?? ''} |`,
      );
    }
    lines.push(``);
  }
  const reportPath = process.env.REPORT_PATH ?? 'docs/MODEL-REPORT.md';
  writeFileSync(reportPath, lines.join('\n') + '\n');
  const totalPass = Object.values(all).flat().filter((r) => r.ok).length;
  log.step(`${totalPass}/${models.length * PROMPTS.length} model runs OK → ${reportPath}`);
}

main().catch((e) => {
  log.error('test-models failed', e);
  process.exit(1);
});
