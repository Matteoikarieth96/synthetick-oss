/**
 * Offline tests for the sail-agent's fail-closed state and I/O handling
 * (2026-10 final correctness pass). No chain, no network, no keys: runs in a
 * throwaway working directory and replaces `fetch` in-process. Imports only
 * modules without viem/Sailor runtime dependencies, so it needs no install.
 *   npx tsx sail-agent/test/offline.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

// Sources are read relative to this file: the test itself runs in a temp cwd.
const sourceOf = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), "utf-8");

// plan.ts resolves .sail/memory/plan.json against the cwd at import time.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sail-agent-offline-"));
process.chdir(dir);

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? `: ${detail}` : ""}`);
}
function throwsKind(fn: () => unknown, name: string): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return (e as Error).name === name;
  }
}

const plan = await import("../src/plan.js");
const { loadSettings } = await import("../src/settings.js");
const { fetchCredits, runScreen } = await import("../src/screen.js");
const { writeThesis } = await import("../src/thesis.js");
const { fetchNews } = await import("../src/news.js");
const guards = await import("../src/guards.js");
const { parseMultipliers } = await import("../src/prices.js");

const memory = path.join(dir, ".sail", "memory");
const planFile = path.join(memory, "plan.json");
const now = Math.floor(Date.now() / 1000);
const dayPlan = (date: string): import("../src/plan.js").DayPlan => ({
  createdAt: now,
  expiresAt: now + 3600,
  pipelineDate: date,
  thesisTitle: "t",
  trades: [{ side: "buy", symbol: "NVDA", usd: 10, score: 90, reason: "r", status: "pending" }],
});

// ---- plan.json: missing vs corrupt ---------------------------------------------
check("no plan file: no plan, no pipeline date", plan.loadPlan(now) === null && plan.lastPipelineDate() === null);

plan.savePlan(dayPlan("2026-10-05"));
check("savePlan round-trips", plan.lastPipelineDate() === "2026-10-05" && plan.loadPlan(now)?.trades.length === 1);
check("savePlan leaves no temp file behind", fs.readdirSync(memory).every((f) => !f.endsWith(".tmp")), fs.readdirSync(memory).join(","));

for (const [label, body] of [
  ["truncated JSON", '{"createdAt": 1, "pipelineDa'],
  ["empty file", ""],
  ["JSON that is not a plan", "[]"],
] as const) {
  fs.writeFileSync(planFile, body);
  check(`corrupt plan (${label}): loadPlan fails closed, not "no plan"`, throwsKind(() => plan.loadPlan(now), "PlanFileCorruptError"));
  check(
    `corrupt plan (${label}): the daily guard refuses instead of answering "never ran"`,
    throwsKind(() => plan.lastPipelineDate(), "PlanFileCorruptError"),
  );
}

// A write that dies midway (full disk, crash) must leave the previous plan intact.
plan.savePlan(dayPlan("2026-10-04"));
const realWrite = fs.writeFileSync;
fs.writeFileSync = ((file: fs.PathOrFileDescriptor, data: unknown, ...rest: unknown[]) => {
  if (String(file).endsWith(".tmp")) {
    realWrite(file, String(data).slice(0, 10)); // half-written temp file
    throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
  }
  return (realWrite as (...a: unknown[]) => void)(file, data, ...rest);
}) as typeof fs.writeFileSync;
let threw = false;
try {
  plan.savePlan(dayPlan("2026-10-05"));
} catch {
  threw = true;
} finally {
  fs.writeFileSync = realWrite;
}
check("failed write: savePlan reports it", threw);
check("failed write: the previous plan.json is intact and readable", plan.lastPipelineDate() === "2026-10-04");
check("failed write: the half-written temp file is cleaned up", fs.readdirSync(memory).every((f) => !f.endsWith(".tmp")));

plan.recordPipelineAttempt("2026-10-05");
plan.recordPipelineAttempt("2026-10-05");
check("pipeline attempts count up per day", plan.pipelineAttempts("2026-10-05") === 2 && plan.pipelineAttempts("2026-10-06") === 0);

// ---- agent.config.json: money knobs must be real numbers -----------------------
const baseConfig = {
  riskTier: "balanced",
  maxTradePctOverride: null,
  hardCapUsdPerTrade: 200,
  minTradeUsd: 1,
  slippageBps: 150,
  watchlist: [],
  synthetickBaseUrl: "https://example.invalid",
  newsMaxPostsPerTicker: 8,
  newsMaxTickers: 10,
  thesisModel: "m",
  planTtlHours: 12,
};
const withConfig = (patch: Record<string, unknown>): boolean => {
  const cfg: Record<string, unknown> = { ...baseConfig, ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete cfg[k];
  fs.writeFileSync(path.join(dir, "agent.config.json"), JSON.stringify(cfg));
  try {
    loadSettings();
    return true;
  } catch {
    return false;
  }
};
check("valid config loads", withConfig({}));
check("fractional slippageBps is refused at load (was a BigInt crash on every trade)", !withConfig({ slippageBps: 150.5 }));
check("missing hardCapUsdPerTrade is refused (undefined <= 0 used to pass)", !withConfig({ hardCapUsdPerTrade: undefined }));
check("missing minTradeUsd is refused", !withConfig({ minTradeUsd: undefined }));
check("maxTradePctOverride above 100% is refused", !withConfig({ maxTradePctOverride: 500 }));
check("maxTradePctOverride 20 is fine", withConfig({ maxTradePctOverride: 20 }));
withConfig({});
check("maxQuoteDeviationBps defaults to 300 (3%) for configs without it", loadSettings().maxQuoteDeviationBps === 300);
check("maxQuoteDeviationBps is configurable", withConfig({ maxQuoteDeviationBps: 500 }) && loadSettings().maxQuoteDeviationBps === 500);
check("maxQuoteDeviationBps out of range or fractional is refused (never trade unguarded)", !withConfig({ maxQuoteDeviationBps: 5000 }) && !withConfig({ maxQuoteDeviationBps: 2.5 }) && !withConfig({ maxQuoteDeviationBps: "300" }));
withConfig({});

// ---- M5: quote vs an independent reference price (REAL MONEY) ------------------
const USDG_DEC = 6;
const TOK_DEC = 18;
const usdg = (n: number) => BigInt(Math.round(n * 1e6));
const tok = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const quote = (side: "buy" | "sell", amountIn: bigint, expectedOut: bigint, ref: number, bps = 300) =>
  guards.checkQuoteAgainstReference({ side, amountIn, expectedOut, usdgDecimals: USDG_DEC, tokenDecimals: TOK_DEC, referencePriceUsd: ref, maxDeviationBps: bps });
// NVDA-like token at $180: 200 USDG should buy ~1.111 tokens.
check("quote: a fair buy (0.5% fees and impact) passes", quote("buy", usdg(200), tok(200 / 180.9), 180).ok);
const pumped = quote("buy", usdg(200), tok(200 / 190), 180);
check("quote: a buy into a pool pushed 5.6% above the venue price is skipped", !pumped.ok && /from the reference/.test(pumped.reason), pumped.ok ? "" : pumped.reason);
check("quote: a sell into a pool dumped 5% below the venue price is skipped", !quote("sell", tok(1), usdg(171), 180).ok);
check("quote: a fair sell passes", quote("sell", tok(1), usdg(179.2), 180).ok);
check("quote: a gap in OUR favor beyond the limit is skipped too (fail closed both ways)", !quote("buy", usdg(200), tok(200 / 170), 180).ok);
check("quote: exactly at the limit passes, just beyond it does not", quote("sell", tok(1), usdg(174.6), 180).ok && !quote("sell", tok(1), usdg(174.5), 180).ok);
check("quote: the limit is configurable", quote("buy", usdg(200), tok(200 / 190), 180, 600).ok);
check("quote: no reference price fails closed", !quote("buy", usdg(200), tok(1.1), 0).ok && !quote("buy", usdg(200), tok(1.1), Number.NaN).ok);
check("quote: a zero quote or amount fails closed", !quote("buy", usdg(200), 0n, 180).ok && !quote("sell", 0n, usdg(1), 180).ok);
check("quote: an invalid limit fails closed", !quote("buy", usdg(200), tok(200 / 180.9), 180, 0).ok);

// ---- M5: sells never exceed the documented USD cap, whatever the token price ----
const sell = (usd: number, price: number, held: bigint, cap = 200, bps = 300) =>
  guards.sizeSell({ usd, referencePriceUsd: price, decimals: TOK_DEC, held, capUsd: cap, maxDeviationBps: bps });
const units = (s: { amountIn: bigint }) => Number(s.amountIn) / 1e18;
const nvda = sell(200, 180, tok(100));
check("sell: a $200 NVDA sell stays under $200 even at +3%", units(nvda) * 180 * 1.03 <= 200 + 1e-9 && nvda.limitedBy === "usd-cap", `${units(nvda)} tokens`);
const spy = sell(200, 650, tok(100));
check("sell: SPY at $650 sells about $194 worth, not 10 tokens ($6.5k)", units(spy) < 0.31 && units(spy) * 650 <= 200, `${units(spy)} tokens`);
const cheap = sell(200, 5, tok(1000));
check("sell: a $5 token is clamped to the on-chain 10-token cap (no certain denial)", units(cheap) === guards.ONCHAIN_SELL_CAP_TOKENS && cheap.limitedBy === "onchain-cap");
const small = sell(50, 180, tok(100));
check("sell: a smaller plan amount is sold as planned", small.limitedBy === "plan" && Math.abs(units(small) * 180 - 50) < 0.01);
check("sell: never more than held", sell(200, 180, tok(0.5)).amountIn === tok(0.5) && sell(200, 180, tok(0.5)).limitedBy === "holding");
check("sell: no usable price sells nothing (fail closed)", sell(200, 0, tok(10)).amountIn === 0n && sell(200, Number.NaN, tok(10)).amountIn === 0n);
check("sell: the final USDG quote is held to the cap", guards.sellWithinUsdCap(usdg(199.99), USDG_DEC, 200) && !guards.sellWithinUsdCap(usdg(200.01), USDG_DEC, 200));

// ---- D8a: a missing corporate-action multiplier is unknown, never 1 -------------
const mult = parseMultipliers([{ tokenSymbol: "AAA", currentMultiplier: "4" }, { tokenSymbol: "BBB" }, { tokenSymbol: "CCC", currentMultiplier: "" }]);
check("multiplier: absent or empty is unknown (the symbol fails closed)", mult.get("AAA") === 4 && !mult.has("BBB") && !mult.has("CCC"));
const overviewData = sourceOf("../scripts/build-overview-data.mjs");
check(
  "multiplier: the dashboard data script no longer defaults it to 1 either",
  !/currentMultiplier \|\| "1"/.test(overviewData) && !/multipliers\.get\(h\.symbol\) \?\? 1/.test(overviewData) && /if \(mult === undefined\) return;/.test(overviewData),
);

// ---- the execution path uses all of the above ------------------------------------
const agentSrc = sourceOf("../src/agent.ts");
const exec = agentSrc.slice(agentSrc.indexOf("async function executeTrades"), agentSrc.indexOf("// ── The agent"));
check("agent: every pending trade (buys too) needs the venue reference price", /filter\(\(t\) => t\.status === "pending"\)/.test(exec) && /no venue reference price or trading halted, deferring/.test(exec));
check("agent: sells are sized by sizeSell", /sizeSell\(\{/.test(exec) && !/trade\.usd \/ p\.mid/.test(exec));
check(
  "agent: the quote is checked against the reference BEFORE any swap is dispatched",
  exec.indexOf("checkQuoteAgainstReference(") > exec.indexOf("quoteExactInputSingle") &&
    exec.indexOf("checkQuoteAgainstReference(") < exec.indexOf('functionName: "exactInputSingle"') &&
    exec.indexOf("sellWithinUsdCap(") < exec.indexOf('functionName: "exactInputSingle"'),
);
check("agent.config.json carries the deviation limit", JSON.parse(sourceOf("../agent.config.json")).maxQuoteDeviationBps === 300);

// ---- L14: the local dashboard treats its data as data ---------------------------
{
  const html = sourceOf("../ui/overview.html");
  const script = html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));
  const els = new Map<string, Record<string, string>>();
  const el = (id: string) => {
    if (!els.has(id)) els.set(id, { textContent: "", innerHTML: "", href: "", className: "" });
    return els.get(id)!;
  };
  const hash = `0x${"ab".repeat(32)}`;
  const evil = {
    generatedAt: new Date().toISOString(),
    sma: "<b>sma</b>",
    explorer: "javascript:alert(0)",
    portfolio: {
      navUsd: 100,
      cashUsd: 50,
      positions: [
        { symbol: "<img src=x onerror=alert(1)>", name: '"><script>alert(2)</script>', logo: "javascript:alert(3)", tokens: 1, priceUsd: 1, dayLow: null, dayHigh: null, valueUsd: 25, weightPct: 25, plUsd: null, sector: null, marketCapUsd: null, halted: false },
        { symbol: "OK", name: "ok", logo: 'https://cdn.example/l.png" onerror="alert(4)', tokens: 1, priceUsd: 1, dayLow: 1, dayHigh: 2, valueUsd: 25, weightPct: 25, plUsd: 1, sector: "<i>s</i>", marketCapUsd: 1e9, halted: true },
      ],
    },
    transactions: [
      { ts: Date.now(), type: 'buy" onmouseover="alert(5)', symbol: "X", tokens: 1, usd: 1, priceUsd: 1, txHash: '0x12" onclick="alert(6)' },
      { ts: Date.now(), type: "sell", symbol: "Y", tokens: 1, usd: 1, priceUsd: 1, txHash: hash },
    ],
    activity: [{ ts: Date.now(), text: "<script>alert(7)</script>", txHash: "javascript:alert(8)" }],
  };
  const sandbox = { document: { getElementById: el }, fetch: async () => ({ json: async () => evil }), setInterval: () => 0, URL, console };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  await new Promise((r) => setTimeout(r, 50));
  const all = [...els.values()].map((e) => `${e.innerHTML} ${e.href}`).join("\n");
  const positions = el("positions").innerHTML;
  const imgs = positions.match(/<img[^>]*>/g) ?? [];
  check("L14 no javascript: URL reaches the page", !/javascript:/i.test(all));
  check("L14 no raw markup from the data (scripts and tags are escaped)", !/<script/i.test(all) && !/<img src=x/i.test(all) && /&lt;script&gt;/.test(all));
  check("L14 logos: https only, and the URL cannot break out of src", imgs.length === 1 && /^<img class="loglogo" src="https:\/\/cdn\.example\/[^"<>]*" alt=""\/>$/.test(imgs[0]!), imgs.join(" "));
  const txs = el("txs").innerHTML;
  check("L14 tx links only for real 32-byte hashes", (txs.match(/<a /g) ?? []).length === 1 && txs.includes(`/tx/${hash}"`) && !/onclick="/.test(txs) && !/<a /.test(el("log").innerHTML));
  check("L14 a hostile type cannot add attributes", !/onmouseover="/.test(txs) && /class="tag "/.test(txs));
  check("L14 the explorer link only takes https", el("explorer").href === "");
}

// ---- every outbound call is bounded (the runner ticks one at a time) -----------
process.env.SYNTHETICK_API_KEY = "stk_offline";
process.env.OPENROUTER_API_KEY = "offline";
process.env.X_BEARER_TOKEN = "offline";
const realFetch = globalThis.fetch;
const signals: Record<string, boolean> = {};
try {
  globalThis.fetch = (async (u: unknown, init?: RequestInit) => {
    const url = String(u);
    const key = url.includes("/v1/me")
      ? "credits"
      : url.includes("/v1/screen")
        ? "screen"
        : url.includes("openrouter")
          ? "thesis"
          : "news";
    signals[key] = init?.signal instanceof AbortSignal;
    if (key === "credits") return new Response(JSON.stringify({ credits: 3 }), { status: 200 });
    if (key === "screen") {
      return new Response('event: result\ndata: {"thesis":{},"universe":null,"picks":[]}\n\n', { status: 200 });
    }
    if (key === "thesis") {
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"t","thesis":"x","sentiment":{}}' } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as typeof fetch;
  const quiet = () => {};
  await fetchCredits("https://example.invalid");
  await runScreen("https://example.invalid", "thesis", quiet);
  await writeThesis([], [], "m", quiet);
  await fetchNews([{ symbol: "AAPL", name: "Apple" }], 10, quiet);
} finally {
  globalThis.fetch = realFetch;
}
for (const k of ["credits", "screen", "thesis", "news"]) {
  check(`${k} request carries a timeout signal`, signals[k] === true, JSON.stringify(signals));
}

// ---- OpenRouter attribution follows OPENROUTER_REFERER ---------------------------
const referers: string[] = [];
try {
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    referers.push(String((init?.headers as Record<string, string>)["http-referer"]));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"t","thesis":"x","sentiment":{}}' } }] }), { status: 200 });
  }) as typeof fetch;
  await writeThesis([], [], "m", () => {});
  process.env.OPENROUTER_REFERER = "https://fork.example";
  await writeThesis([], [], "m", () => {});
} finally {
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_REFERER;
}
check("thesis referer: default synthetick.org, OPENROUTER_REFERER overrides", referers[0] === "https://synthetick.org" && referers[1] === "https://fork.example", referers.join(","));

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
