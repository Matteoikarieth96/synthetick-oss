#!/usr/bin/env node
/**
 * Gather everything the dashboard overview page renders into
 * ui/dist/overview-data.json (atomic write). Server-side on purpose: no CORS,
 * and the SyntheTick API key stays in .sail/.env.local — only derived,
 * non-secret data lands in the JSON.
 *
 * Sources:
 *  - Robinhood Chain RPC: SMA balances (USDG + the tradable basket)
 *  - Robinhood /rhj: venue prices + multipliers for held tokens
 *  - SyntheTick /v1/universe/robinhood(/assets): names, logos, sector,
 *    market cap, day range (assets endpoint only if an API key is present)
 *  - Blockscout: the SMA's ERC-20 transfers -> typed transactions (buy/sell/
 *    deposit) with per-trade price; also the source of truth for cost basis
 *  - reports/*.json + .sail/memory/ledger.jsonl: the human-readable activity log
 *
 *   node scripts/build-overview-data.mjs           # one shot
 *   node scripts/build-overview-data.mjs --loop 300  # rebuild every 300s
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const OUT = path.join(root, "ui", "dist", "overview-data.json");

// ── config / secrets ────────────────────────────────────────────────────────
const envFile = path.join(root, ".sail", ".env.local");
const env = {};
try {
  for (const line of fs.readFileSync(envFile, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
} catch {
  // no env file — public sources still work
}
const RPC = env.ROBINHOOD_RPC_URL || env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const STK = process.env.SYNTHETICK_API_KEY || env.SYNTHETICK_API_KEY || null;
const BASE = "https://synthetick.org";

const accountPath = path.join(root, ".sail", "account.json");
if (!fs.existsSync(accountPath)) {
  console.error(
    "Missing .sail/account.json: it holds YOUR Safe/owner/manager addresses and is not shipped with this repo.\n" +
      "Run the Sailor setup wizard (see AGENTS.md, `sailor init`) to create it, or copy .sail/account.example.json to\n" +
      ".sail/account.json and fill in your own addresses. Never commit it.",
  );
  process.exit(1);
}
const account = JSON.parse(fs.readFileSync(accountPath, "utf-8"));
const SMA = (account.safe ?? account[0]?.safe).toLowerCase();

const universeTs = fs.readFileSync(path.join(root, "src", "universe.ts"), "utf-8");
const TRADABLE = JSON.parse(
  universeTs.match(/export const TRADABLE[^=]*= (\[[\s\S]*?\]);/)[1].replace(/" as Address/g, '"'),
);
const USDG = universeTs.match(/export const USDG[^=]*= "(0x[0-9a-fA-F]{40})"/)[1];
const bySymbol = new Map(TRADABLE.map((t) => [t.symbol, t]));
const byToken = new Map(TRADABLE.map((t) => [t.token.toLowerCase(), t]));

// ── helpers ─────────────────────────────────────────────────────────────────
async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { accept: "application/json", ...headers } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function rpcBalance(token, holder) {
  const data = "0x70a08231" + holder.slice(2).toLowerCase().padStart(64, "0");
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: token, data }, "latest"] }),
  });
  const json = await res.json();
  return BigInt(json.result ?? "0x0");
}

// ── build ───────────────────────────────────────────────────────────────────
async function build() {
  // 1. balances
  const cashUnits = await rpcBalance(USDG, SMA);
  const held = [];
  for (const t of TRADABLE) {
    const bal = await rpcBalance(t.token, SMA);
    if (bal > 0n) held.push({ ...t, balance: bal });
  }

  // 2. venue prices (mid x multiplier) for held tokens
  // A missing or malformed currentMultiplier is UNKNOWN, never 1 (same rule as
  // src/prices.ts): such a position is shown unpriced rather than mispriced.
  let multipliers = new Map();
  try {
    const assets = await getJson("https://api.robinhood.com/rhj/assets");
    const items = Array.isArray(assets) ? assets : (assets.results ?? assets.assets ?? []);
    multipliers = new Map(
      items.flatMap((a) => {
        const raw = a?.currentMultiplier;
        const m = Number(raw);
        return typeof a?.tokenSymbol === "string" && raw != null && raw !== "" && Number.isFinite(m) && m > 0 ? [[a.tokenSymbol, m]] : [];
      }),
    );
  } catch {
    // unreadable: every multiplier unknown, so no position gets a price
  }
  const prices = new Map();
  await Promise.all(
    held.map(async (h) => {
      const mult = multipliers.get(h.symbol);
      if (mult === undefined) return; // unknown multiplier: unpriced (valued at 0, flagged in the UI)
      try {
        const q = (await getJson(`https://api.robinhood.com/rhj/prices/${h.symbol}`)).quotes?.[0];
        const bid = Number(q?.bid);
        const ask = Number(q?.ask);
        if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0)
          prices.set(h.symbol, {
            mid: ((bid + ask) / 2) * mult,
            dayLow: Number(q.dailyLow) || null,
            dayHigh: Number(q.dailyHigh) || null,
            halted: q.isTradingHalt === true,
          });
      } catch {
        // absent -> position valued at last resort 0, flagged in UI
      }
    }),
  );

  // 3. identity + market context
  let meta = new Map();
  try {
    const reg = await getJson(`${BASE}/v1/universe/robinhood`);
    meta = new Map(reg.assets.map((a) => [a.symbol, { name: a.name, logo: a.logoUrl ?? null }]));
  } catch {
    // fall back to universe.ts names
  }
  const market = new Map();
  if (STK && held.length) {
    await Promise.all(
      held.map(async (h) => {
        try {
          const a = await getJson(`${BASE}/v1/universe/robinhood/assets/${h.symbol}`, {
            authorization: `Bearer ${STK}`,
          });
          market.set(h.symbol, {
            sector: a.sector ?? null,
            marketCapUsd: a.marketCapUsd ?? null,
            about: a.about ? String(a.about).slice(0, 200) : null,
          });
        } catch {
          // metrics stay null
        }
      }),
    );
  }

  // 4. transactions from Blockscout (authoritative, includes CI trades)
  const transactions = [];
  try {
    const tx = await getJson(
      `https://robinhoodchain.blockscout.com/api/v2/addresses/${SMA}/token-transfers?type=ERC-20`,
    );
    const byHash = new Map();
    for (const it of tx.items ?? []) {
      const h = it.transaction_hash;
      if (!byHash.has(h)) byHash.set(h, []);
      byHash.get(h).push(it);
    }
    for (const [hash, legs] of byHash) {
      const ts = legs[0].timestamp ?? null;
      const leg = (pred) => legs.find(pred);
      const val = (l) => Number(l.total.value) / 10 ** Number(l.total.decimals);
      const usdgOut = leg((l) => l.token.symbol === "USDG" && l.from.hash.toLowerCase() === SMA);
      const usdgIn = leg((l) => l.token.symbol === "USDG" && l.to.hash.toLowerCase() === SMA);
      const tokIn = leg((l) => l.token.symbol !== "USDG" && l.to.hash.toLowerCase() === SMA);
      const tokOut = leg((l) => l.token.symbol !== "USDG" && l.from.hash.toLowerCase() === SMA);
      if (usdgOut && tokIn) {
        transactions.push({ ts, type: "buy", symbol: tokIn.token.symbol, tokens: val(tokIn), usd: val(usdgOut), priceUsd: val(usdgOut) / val(tokIn), txHash: hash });
      } else if (tokOut && usdgIn) {
        transactions.push({ ts, type: "sell", symbol: tokOut.token.symbol, tokens: val(tokOut), usd: val(usdgIn), priceUsd: val(usdgIn) / val(tokOut), txHash: hash });
      } else if (usdgIn) {
        transactions.push({ ts, type: "deposit", symbol: "USDG", tokens: val(usdgIn), usd: val(usdgIn), priceUsd: 1, txHash: hash });
      } else if (usdgOut) {
        transactions.push({ ts, type: "withdrawal", symbol: "USDG", tokens: val(usdgOut), usd: val(usdgOut), priceUsd: 1, txHash: hash });
      } else if (tokIn) {
        transactions.push({ ts, type: "deposit", symbol: tokIn.token.symbol, tokens: val(tokIn), usd: null, priceUsd: null, txHash: hash });
      }
    }
    transactions.sort((a, b) => (b.ts ?? "").localeCompare(a.ts ?? ""));
  } catch {
    // chain history unavailable this cycle — page shows what it has
  }

  // 5. positions with value, weight and (approximate) cost-basis P&L
  const cashUsd = Number(cashUnits) / 1e6;
  const positions = held.map((h) => {
    const p = prices.get(h.symbol);
    const tokens = Number(h.balance) / 10 ** h.decimals;
    const valueUsd = p ? tokens * p.mid : 0;
    const spent = transactions.filter((t) => t.type === "buy" && t.symbol === h.symbol).reduce((s, t) => s + t.usd, 0);
    const recovered = transactions.filter((t) => t.type === "sell" && t.symbol === h.symbol).reduce((s, t) => s + t.usd, 0);
    const basis = spent - recovered;
    return {
      symbol: h.symbol,
      name: meta.get(h.symbol)?.name ?? bySymbol.get(h.symbol)?.name ?? h.symbol,
      logo: meta.get(h.symbol)?.logo ?? null,
      tokens,
      priceUsd: p?.mid ?? null,
      dayLow: p?.dayLow ?? null,
      dayHigh: p?.dayHigh ?? null,
      halted: p?.halted ?? false,
      valueUsd,
      plUsd: p && basis > 0 ? valueUsd - basis : null,
      sector: market.get(h.symbol)?.sector ?? null,
      marketCapUsd: market.get(h.symbol)?.marketCapUsd ?? null,
    };
  });
  const navUsd = cashUsd + positions.reduce((s, p) => s + p.valueUsd, 0);
  for (const p of positions) p.weightPct = navUsd > 0 ? (p.valueUsd / navUsd) * 100 : 0;
  positions.sort((a, b) => b.valueUsd - a.valueUsd);

  // 6. human-readable activity log: chain trades + pipeline days + ledger skips
  const activity = [];
  for (const t of transactions) {
    if (t.type === "buy") activity.push({ ts: t.ts, text: `Bought ${t.tokens.toFixed(6)} ${t.symbol} for ${t.usd.toFixed(2)} USDG (at ~$${t.priceUsd.toFixed(2)} per token)`, txHash: t.txHash });
    else if (t.type === "sell") activity.push({ ts: t.ts, text: `Sold ${t.tokens.toFixed(6)} ${t.symbol} for ${t.usd.toFixed(2)} USDG (at ~$${t.priceUsd.toFixed(2)} per token)`, txHash: t.txHash });
    else if (t.type === "deposit") activity.push({ ts: t.ts, text: `Received a deposit of ${t.tokens.toFixed(2)} ${t.symbol}`, txHash: t.txHash });
    else if (t.type === "withdrawal") activity.push({ ts: t.ts, text: `Sent ${t.tokens.toFixed(2)} USDG out of the account`, txHash: t.txHash });
  }
  const reportsDir = path.join(root, "reports");
  try {
    for (const f of fs.readdirSync(reportsDir).filter((f) => f.endsWith(".json"))) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(reportsDir, f), "utf-8"));
        const posts = (r.news ?? []).reduce((s, n) => s + n.posts.length, 0);
        const planned = (r.plan ?? []).map((t) => `${t.side.toUpperCase()} ${t.symbol} $${t.usd}`).join(", ") || "no trades";
        const research = (r.research ?? []).length
          ? `, read ${r.research.length} newsletter piece${r.research.length > 1 ? "s" : ""} (${((r.spentCents ?? 0) / 100).toFixed(2)} USD)`
          : "";
        const diverged = r.divergence ? ` Research diverged from X: ${r.divergence}` : "";
        activity.push({
          ts: `${r.date}T23:59:59Z`,
          text: `Daily pipeline: read ${posts} posts on X, wrote the thesis "${r.thesis.title}"${research}, screened ${(r.picks ?? []).length} picks, planned: ${planned}.${diverged}`,
          report: r.date,
        });
        for (const t of r.plan ?? [])
          activity.push({ ts: `${r.date}T23:59:58Z`, text: `Decision: ${t.side} ${t.symbol} for $${t.usd} — ${t.reason}`, report: r.date });
      } catch {
        // skip malformed report
      }
    }
  } catch {
    // no reports yet
  }
  try {
    const ledger = fs.readFileSync(path.join(root, ".sail", "memory", "ledger.jsonl"), "utf-8").split("\n").filter(Boolean);
    for (const line of ledger.slice(-100)) {
      try {
        const e = JSON.parse(line);
        const ts = new Date(e.ts * 1000).toISOString();
        if (e.kind === "skipped") activity.push({ ts, text: `Held back: ${e.reason}` });
        else if (e.kind === "acted" && e.outcome === "reverted") activity.push({ ts, text: `A swap was rejected on-chain (the mandate or slippage floor held): tx ${e.txHash}`, txHash: e.txHash });
      } catch {
        // skip malformed line
      }
    }
  } catch {
    // no local ledger (CI-only operation) — chain transfers still cover trades
  }
  activity.sort((a, b) => (b.ts ?? "").localeCompare(a.ts ?? ""));

  const out = {
    generatedAt: new Date().toISOString(),
    sma: SMA,
    chainId: 4663,
    explorer: `https://robinhoodchain.blockscout.com/address/${SMA}`,
    portfolio: { navUsd, cashUsd, positions },
    transactions: transactions.slice(0, 30),
    activity: activity.slice(0, 60),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const tmp = OUT + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(out, null, 1));
  fs.renameSync(tmp, OUT);
  console.log(`overview-data.json: NAV $${navUsd.toFixed(2)}, ${positions.length} positions, ${transactions.length} txs, ${activity.length} log lines`);
}

const loopIdx = process.argv.indexOf("--loop");
if (loopIdx >= 0) {
  const sec = Number(process.argv[loopIdx + 1]) || 300;
  for (;;) {
    try {
      await build();
    } catch (e) {
      console.error("overview build failed:", e.message);
    }
    await new Promise((r) => setTimeout(r, sec * 1000));
  }
} else {
  await build();
}
