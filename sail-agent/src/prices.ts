/**
 * Token USD prices from the venue itself: Robinhood's public Stock Token API.
 * token price = share mid price x currentMultiplier (corporate actions).
 * Fail closed: a symbol with no readable price OR no determinable multiplier
 * (absent included: never defaulted to 1) returns nothing and the caller must
 * skip it (logged below): never trade on a missing or guessed number. This is
 * real-money code: sizing a sell off a share price when the token has split
 * (multiplier != 1) is off by that factor. This price is also the independent
 * reference every swap quote is checked against (src/guards.ts).
 */
const RHJ = "https://api.robinhood.com/rhj";
const TIMEOUT_MS = 15_000;

export interface VenuePrice {
  symbol: string;
  mid: number; // USD per token (multiplier applied)
  halted: boolean;
}

/**
 * Pure: the /rhj/assets payload -> tokenSymbol -> multiplier. Only a
 * currentMultiplier that is PRESENT and strictly positive counts. An absent or
 * empty field is UNKNOWN, not 1 (final-bugs D8a, owner decision): under a
 * venue schema change a split token would otherwise be sized off the share
 * price, selling up to the split ratio more tokens than intended. Unknown
 * symbols are left out of the map, so every caller fails closed on them.
 * Exported for offline tests.
 */
export function parseMultipliers(json: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const obj = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const items = Array.isArray(json) ? json : (obj["results"] ?? obj["assets"] ?? []);
  if (!Array.isArray(items)) return out;
  for (const a of items as { tokenSymbol?: unknown; currentMultiplier?: unknown }[]) {
    if (!a || typeof a.tokenSymbol !== "string" || !a.tokenSymbol) continue;
    const raw = a.currentMultiplier;
    if (raw == null || raw === "") continue; // absent -> unknown -> omitted (fail closed)
    const m = Number(raw);
    if (Number.isFinite(m) && m > 0) out.set(a.tokenSymbol, m);
    // else: malformed -> unknown -> omitted (fail closed)
  }
  return out;
}

export async function fetchVenuePrices(symbols: string[]): Promise<Map<string, VenuePrice>> {
  const out = new Map<string, VenuePrice>();
  if (!symbols.length) return out;

  // Without the multiplier table no token price can be trusted: fail closed
  // for EVERY symbol instead of defaulting to 1.
  let multipliers: Map<string, number>;
  try {
    const res = await fetch(`${RHJ}/assets`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[prices] /rhj/assets answered ${res.status}: skipping all ${symbols.length} symbol(s), multiplier unknown`);
      return out;
    }
    multipliers = parseMultipliers((await res.json()) as unknown);
  } catch (err) {
    console.warn(`[prices] /rhj/assets unreadable (${(err as Error).message}): skipping all ${symbols.length} symbol(s), multiplier unknown`);
    return out;
  }

  await Promise.all(
    symbols.map(async (symbol) => {
      const mult = multipliers.get(symbol);
      if (mult === undefined) {
        console.warn(`[prices] ${symbol}: corporate-action multiplier unknown, skipping (fail closed)`);
        return;
      }
      try {
        const res = await fetch(`${RHJ}/prices/${encodeURIComponent(symbol)}`, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) return;
        const json = (await res.json()) as { quotes?: { bid?: string; ask?: string; isTradingHalt?: boolean }[] };
        const q = json.quotes?.[0];
        const bid = Number(q?.bid);
        const ask = Number(q?.ask);
        if (!q || !Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return;
        out.set(symbol, { symbol, mid: ((bid + ask) / 2) * mult, halted: q.isTradingHalt === true });
      } catch {
        // unreadable price -> absent from the map -> caller skips the symbol
      }
    }),
  );
  return out;
}
