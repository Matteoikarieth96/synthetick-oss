/**
 * Gate for spec §16.1 events + quote venue-state extras (§16.2): at least one
 * universe asset carries a non-empty events list with stripped enum values and
 * YYYY-MM-DD process dates, a CASH_DIVIDEND rate is a plausible decimal
 * string, and quote.sessions.market.whole is populated on a quoted asset.
 *
 *   npx tsx runtime/test-universe-events.ts
 */
import 'dotenv/config';
import { log } from '../ingest/lib/log.js';
import { universeAssetData } from './universe.js';

const fail = (msg: string): never => {
  log.error(msg);
  process.exit(1);
};

const all = await universeAssetData('robinhood');
if (all.length < 90) fail(`expected ~96 assets, got ${all.length}`);

const withEvents = all.filter((a) => (a.events?.length ?? 0) > 0);
if (!withEvents.length) fail('no asset carries events (feed empty or all-null)');
log.info(`events on: ${withEvents.map((a) => `${a.ticker}[${a.events!.map((e) => e.type).join(',')}]`).join(' ')}`);

for (const a of withEvents) {
  for (const e of a.events!) {
    if (/^CORPORATE_ACTION/.test(e.type) || /^CORPORATE_ACTION/.test(e.status)) fail(`${a.ticker}: unstripped enum ${e.type}/${e.status}`);
    if (e.processDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(e.processDate)) fail(`${a.ticker}: bad processDate ${e.processDate}`);
  }
}

const div = withEvents.flatMap((a) => a.events!.map((e) => ({ ticker: a.ticker, e }))).find(({ e }) => e.type === 'CASH_DIVIDEND');
if (!div) fail('no CASH_DIVIDEND in the feed (unexpected: dividends dominate it)');
const rate = (div!.e.details as { rate?: unknown } | null)?.rate;
if (typeof rate !== 'string' || !/^\d+(\.\d+)?$/.test(rate)) fail(`${div!.ticker}: dividend rate not a decimal string: ${JSON.stringify(rate)}`);
log.info(`sample dividend: ${div!.ticker} ${rate} USD/share, ${div!.e.status}, ${div!.e.processDate}`);

const quoted = all.find((a) => a.quote);
if (!quoted) fail('no asset carries a quote (venue down? rerun)');
const q = quoted!.quote!;
if (!q.sessions?.market?.whole) fail(`${quoted!.ticker}: quote.sessions.market.whole missing`);
log.info(`quote extras on ${quoted!.ticker}: currency=${q.currency} pendingMultiplier=${q.pendingMultiplier} market=${q.sessions!.market.whole}/${q.sessions!.market.fractional} overnight=${q.sessions!.overnight.whole}`);

const withMult = all.filter((a) => a.onchain?.uiMultiplier != null);
if (withMult.length < 90) fail(`uiMultiplier on only ${withMult.length}/96 assets (chain RPC degraded? rerun)`);
const non1 = withMult.filter((a) => Math.abs(a.onchain!.uiMultiplier! - 1) > 1e-12);
if (!non1.length) fail('every uiMultiplier is exactly 1.0 (splits/dividends should have moved some)');
log.info(`uiMultiplier on ${withMult.length} assets; non-1.0: ${non1.map((a) => `${a.ticker}=${a.onchain!.uiMultiplier}`).join(' ')}`);
for (const a of withMult) {
  if (a.quote?.multiplier != null && Math.abs(a.onchain!.uiMultiplier! - a.quote.multiplier) > 1e-6)
    fail(`${a.ticker}: onchain uiMultiplier ${a.onchain!.uiMultiplier} disagrees with venue multiplier ${a.quote.multiplier}`);
  if (a.onchain!.pendingMultiplier != null && a.onchain!.pendingEffectiveAt != null && new Date(a.onchain!.pendingEffectiveAt).getTime() < Date.now())
    fail(`${a.ticker}: pendingMultiplier with a PAST effectiveAt ${a.onchain!.pendingEffectiveAt} (already-applied change leaked as pending)`);
}

const withSupply = all.filter((a) => a.onchain?.totalSupply != null && a.onchain.totalSupply > 0);
if (withSupply.length < 90) fail(`positive totalSupply on only ${withSupply.length}/96 assets`);
log.info(`totalSupply on ${withSupply.length} assets; largest: ${[...withSupply].sort((x, y) => y.onchain!.totalSupply! - x.onchain!.totalSupply!).slice(0, 3).map((a) => `${a.ticker}=${Math.round(a.onchain!.totalSupply!).toLocaleString()}`).join(' ')}`);

const withOracle = all.filter((a) => a.onchain?.oracle?.priceUsd != null);
if (withOracle.length < 20) fail(`oracle price on only ${withOracle.length} assets (Chainlink RDD or feed reads degraded? rerun)`);
let oracleChecked = 0;
for (const a of withOracle) {
  const o = a.onchain!.oracle!;
  if (o.stale || a.onchain!.oraclePaused) continue;
  const mid = a.quote && a.quote.bid != null && a.quote.ask != null ? (a.quote.bid + a.quote.ask) / 2 : null;
  // An unknown venue multiplier is null (never 1): fall back to the contract's own.
  const mult = a.quote?.multiplier ?? a.onchain!.uiMultiplier;
  if (mid == null || mult == null) continue;
  const tokenMid = mid * mult;
  const diffPct = Math.abs((o.priceUsd! - tokenMid) / tokenMid) * 100;
  if (diffPct > 10) fail(`${a.ticker}: fresh oracle $${o.priceUsd} vs venue token mid $${tokenMid.toFixed(2)} differs ${diffPct.toFixed(1)}%`);
  oracleChecked++;
}
log.info(`oracle prices on ${withOracle.length} assets (${oracleChecked} fresh cross-checked vs venue within 10%)`);
const paused = all.filter((a) => a.onchain?.oraclePaused);
if (paused.length) log.info(`oracle paused (corporate action in flight): ${paused.map((a) => a.ticker).join(' ')}`);

const none = all.find((a) => a.events?.length === 0);
if (!none) fail('every asset has events — [] vs null degradation cannot be observed');
log.info(`empty-but-answered example: ${none!.ticker} events=[]`);

log.info('universe events gate: PASS');
