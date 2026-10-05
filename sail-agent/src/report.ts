/**
 * Daily human-readable report: what the agent read, thought, and decided.
 * Written to reports/YYYY-MM-DD.md next to a .json twin. Pure output — the
 * ledger (.sail/memory/ledger.jsonl) stays the source of truth for what
 * actually executed on-chain.
 */
import fs from "node:fs";
import path from "node:path";
import type { TickerNews } from "./news.js";
import type { ThesisResult } from "./thesis.js";
import type { DripResearchItem } from "./drip.js";
import type { ScreenPick } from "./screen.js";
import type { PlannedTrade, Holding } from "./decide.js";

export function writeReport(args: {
  date: string;
  news: TickerNews[];
  thesis: ThesisResult;
  research: DripResearchItem[];
  spentCents: number;
  divergence: string | null;
  picks: ScreenPick[];
  holdings: Holding[];
  cashUsd: number;
  plan: PlannedTrade[];
}): string {
  const { date, news, thesis, research, spentCents, divergence, picks, holdings, cashUsd, plan } = args;
  const dir = path.join(process.cwd(), "reports");
  fs.mkdirSync(dir, { recursive: true });

  const nav = cashUsd + holdings.reduce((s, h) => s + h.valueUsd, 0);
  const md = `# Sail agent daily report — ${date}

## Portfolio
NAV $${nav.toFixed(2)} — cash $${cashUsd.toFixed(2)}${holdings.length ? "" : ", no token holdings"}
${holdings.map((h) => `- ${h.symbol}: $${h.valueUsd.toFixed(2)}`).join("\n")}

## Thesis: ${thesis.title}
${thesis.thesis}

Sentiment from news: ${Object.entries(thesis.sentiment).map(([t, s]) => `${t}=${s}`).join(", ") || "n/a"}

## News read (${news.reduce((s, n) => s + n.posts.length, 0)} posts)
${news.map((n) => `- ${n.symbol}: ${n.posts.length} posts, top: "${(n.posts[0]?.text ?? "").replace(/\n/g, " ").slice(0, 120)}"`).join("\n") || "- none"}

## Newsletter research (Drip, ${(spentCents / 100).toFixed(2)} USD spent)
${research.map((r) => `- **${r.publication}** — "${r.title.replace(/\n/g, " ").slice(0, 90)}" (${r.publishedAt.slice(0, 10)}, ${r.paidCents === null ? "free snippet" : `paid ${r.paidCents}c`})`).join("\n") || "- none"}
${divergence ? `\n**Divergence vs X flow:** ${divergence}` : ""}

## Screen picks (top 10 of ${picks.length})
| ticker | dir | score | why |
|---|---|---|---|
${picks.slice(0, 10).map((p) => `| ${p.ticker} | ${p.dir} | ${p.score} | ${p.why.replace(/\|/g, "/").slice(0, 100)} |`).join("\n")}

## Plan
${plan.map((t) => `- ${t.side.toUpperCase()} ${t.symbol} $${t.usd} — ${t.reason}`).join("\n") || "- no trades today"}

*Execution status lives in .sail/memory/plan.json and .sail/memory/ledger.jsonl.*
`;

  const mdPath = path.join(dir, `${date}.md`);
  fs.writeFileSync(mdPath, md);
  // bigint (Holding.balance) has no JSON encoding — stringify via toString.
  fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  return mdPath;
}
