#!/usr/bin/env node
/**
 * Drip enrichment demo — runs the REAL pipeline modules step by step with
 * fixture X news and a fixture portfolio, so you can watch the flow without
 * spending X credits or waiting on a SyntheTick screen:
 *
 *   1. fixture X news + portfolio          (fixture — X reads cost money)
 *   2. writeThesis                         (REAL OpenRouter call)
 *   3. fetchDripResearch                   (REAL Drip API: free search; paid
 *                                           summaries only if DRIP_API_KEY set)
 *   4. reviseThesis                        (REAL OpenRouter call)
 *   5. decideTrades with fixture screen picks (real decision engine, shows
 *                                           the bearish-sentiment veto)
 *   6. writeReport                         (to a temp dir, printed)
 *
 * Usage, from sail-agent/:  node scripts/drip-demo.mjs
 * Needs OPENROUTER_API_KEY in env, .sail/.env.local, or ../.env.
 * The real screen step is skipped (minutes + 1 credit); the exact thesis text
 * that would be POSTed to /v1/screen is printed instead.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
process.chdir(root);

// Secrets: env -> .sail/.env.local (settings.js handles those) -> repo-root ../.env
if (!process.env.OPENROUTER_API_KEY) {
  try {
    const text = fs.readFileSync(path.join(root, "..", ".env"), "utf-8");
    for (const line of text.split("\n")) {
      const m = line.match(/^(OPENROUTER_API_KEY|DRIP_API_KEY)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {
    /* no repo-root .env — settings.js may still find .sail/.env.local */
  }
}

const step = (n, title) => console.log(`\n${"─".repeat(70)}\nSTEP ${n} — ${title}\n${"─".repeat(70)}`);
const log = (m) => console.log(`  [agent] ${m}`);

console.log("Compiling src/ (tsc)…");
execSync("npx tsc -p tsconfig.json --noEmit false --outDir .demo-build", { stdio: "inherit" });

const { writeThesis, reviseThesis } = await import(path.join(root, ".demo-build", "thesis.js"));
const { fetchDripResearch } = await import(path.join(root, ".demo-build", "drip.js"));
const { decideTrades } = await import(path.join(root, ".demo-build", "decide.js"));
const { riskParams } = await import(path.join(root, ".demo-build", "risk.js"));
const { writeReport } = await import(path.join(root, ".demo-build", "report.js"));
const { loadSettings } = await import(path.join(root, ".demo-build", "settings.js"));

const settings = loadSettings();

// ── STEP 1: fixtures ────────────────────────────────────────────────────────
step(1, "Fixture X news + portfolio (a real run pulls these from X and the SMA)");
const news = [
  {
    symbol: "NVDA",
    posts: [
      { text: "NVDA guidance up again but every hyperscaler on the call talked about power, not chips. Grid interconnects are the new supply chain.", createdAt: "2026-08-04T09:10:00Z", likes: 4200, reposts: 610 },
      { text: "The trade isn't more GPUs, it's who can energize a datacenter in under 3 years. $NVDA fine but the pick-and-shovel is electrical gear.", createdAt: "2026-08-04T08:22:00Z", likes: 1900, reposts: 240 },
      { text: "$CEG $VST IPPs ripping again on AI power narrative, utilities can't sign PPAs fast enough", createdAt: "2026-08-04T07:45:00Z", likes: 980, reposts: 130 },
    ],
  },
  {
    symbol: "VRT",
    posts: [
      { text: "Vertiv book-to-bill still >1.2, liquid cooling attach rates climbing every quarter. $VRT", createdAt: "2026-08-04T06:30:00Z", likes: 640, reposts: 75 },
      { text: "Transformer lead times now 130+ weeks. Whoever holds switchgear inventory owns the AI buildout.", createdAt: "2026-08-03T21:05:00Z", likes: 1500, reposts: 310 },
    ],
  },
];
const portfolio = [
  { symbol: "NVDA", weightPct: 22 },
  { symbol: "DELL", weightPct: 9 },
];
const holdings = [
  { symbol: "NVDA", balance: 1200000000000000000n, valueUsd: 220 },
  { symbol: "DELL", balance: 700000000000000000n, valueUsd: 90 },
];
const cashUsd = 690;
console.log(`  ${news.reduce((s, n) => s + n.posts.length, 0)} fixture posts across ${news.map((n) => n.symbol).join(", ")}; portfolio NVDA 22% / DELL 9% / cash`);

// ── STEP 2: draft thesis (real OpenRouter) ──────────────────────────────────
step(2, `Draft thesis from X flow — REAL OpenRouter call (${settings.thesisModel})`);
const draft = await writeThesis(news, portfolio, settings.thesisModel, log);
console.log(`\n  title:     ${draft.title}`);
console.log(`  thesis:    ${draft.thesis}`);
console.log(`  sentiment: ${JSON.stringify(draft.sentiment)}`);

// ── STEP 3: Drip research (real API) ────────────────────────────────────────
step(3, "Drip newsletter research — REAL dripstack.xyz calls");
const query = draft.searchQuery?.trim() || draft.title;
console.log(`  search query: "${query}"`);
console.log(`  caps: ${settings.dripMaxSummariesPerRun} summaries, ${settings.dripMaxCentsPerRun}c budget, coverage >= ${settings.dripMinCoverage}, <= ${settings.dripMaxAgeDays}d old`);
const research = await fetchDripResearch(
  query,
  { maxSummaries: settings.dripMaxSummariesPerRun, maxCents: settings.dripMaxCentsPerRun, minCoverage: settings.dripMinCoverage, maxAgeDays: settings.dripMaxAgeDays, noRebuyDays: settings.dripNoRebuyDays },
  log,
);
for (const r of research.items) {
  console.log(`\n  • ${r.publication} — "${r.title}" (${r.publishedAt.slice(0, 10)}, ${r.paidCents === null ? `snippet free, full summary would cost ${r.priceCents}c` : `PAID ${r.paidCents}c`})`);
  console.log(`    ${(r.content || "(title only — no snippet)").replace(/\s+/g, " ").slice(0, 220)}…`);
}
console.log(`\n  total spent: ${research.spentCents}c`);

// ── STEP 4: revision (real OpenRouter) ──────────────────────────────────────
let thesis = draft;
let divergence = null;
if (research.items.length) {
  step(4, `Thesis revision with newsletter research — REAL OpenRouter call`);
  thesis = await reviseThesis(draft, research.items, settings.thesisModel, log);
  divergence = thesis.divergence;
  console.log(`\n  title:      ${thesis.title}`);
  console.log(`  thesis:     ${thesis.thesis}`);
  console.log(`  sentiment:  ${JSON.stringify(thesis.sentiment)}`);
  console.log(`  divergence: ${divergence ?? "none — research agrees with X flow"}`);
} else {
  step(4, "Thesis revision — SKIPPED (no research items), draft carries through");
}

// ── STEP 5: screen (printed) + decision engine on fixture picks ─────────────
step(5, "Screen + decide — screen text printed (real screen = minutes + 1 credit), decideTrades is the REAL engine on fixture picks");
console.log(`  would POST to ${settings.synthetickBaseUrl}/v1/screen {universe:"robinhood"}:\n  "${thesis.title}. ${thesis.thesis.slice(0, 160)}…"\n`);
const fixturePicks = [
  { ticker: "NVDA", name: "NVIDIA", kind: "stock", score: 82, dir: "long", why: "fixture: AI compute demand anchor of the power thesis" },
  { ticker: "DELL", name: "Dell Technologies", kind: "stock", score: 78, dir: "long", why: "fixture: AI server + liquid-cooled rack integrator" },
  { ticker: "INTC", name: "Intel", kind: "stock", score: 70, dir: "long", why: "fixture: US fab buildout power adjacency" },
];
const risk = riskParams(settings.riskTier, settings.maxTradePctOverride);
const decideArgs = { picks: fixturePicks, holdings, cashUsd, risk, hardCapUsdPerTrade: settings.hardCapUsdPerTrade, minTradeUsd: settings.minTradeUsd, log };
console.log(`  fixture picks: ${fixturePicks.map((p) => `${p.ticker}(${p.score} ${p.dir})`).join(", ")}\n`);
console.log("  5a. decide with today's ACTUAL revised sentiment:\n");
const trades = decideTrades({ ...decideArgs, sentiment: thesis.sentiment });
console.log('\n  5b. same picks, but pretending the newsletters had turned DELL bearish ("sentiment veto" channel):\n');
decideTrades({ ...decideArgs, sentiment: { ...thesis.sentiment, DELL: "bearish" } });

// ── STEP 6: report ──────────────────────────────────────────────────────────
step(6, "Daily report (written to a temp dir for the demo)");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "drip-demo-"));
process.chdir(tmp);
const reportPath = writeReport({
  date: new Date().toISOString().slice(0, 10),
  news,
  thesis,
  research: research.items,
  spentCents: research.spentCents,
  divergence,
  picks: fixturePicks,
  holdings,
  cashUsd,
  plan: trades,
});
console.log(fs.readFileSync(reportPath, "utf-8"));
console.log(`(report at ${reportPath})`);
