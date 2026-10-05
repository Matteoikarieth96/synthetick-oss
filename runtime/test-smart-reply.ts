/**
 * Smart-reply live preview (spec §14, 2026-07-22) — runs the real pipeline
 * (extraction LLM + DB + market vendors + composition LLM) on sample posts
 * and prints what the bot WOULD reply. Nothing is posted to X, no credits
 * are charged. Costs a few cents of LLM + vendor calls per run.
 *
 *   npx tsx runtime/test-smart-reply.ts ["custom post text"]
 */
import { assetsFromContent } from './assets.js';
import { composeSmartReply, relatedPredictionMarket, MAX_TWEET } from '../bot/reply.js';
import { log } from '../ingest/lib/log.js';

const SAMPLES = [
  'Ethereum staking yields are quietly becoming the benchmark rate of crypto. Rollups settle to L1, restaking compounds demand, and ETH the asset accrues it all.',
  'TSMC just broke ground on its third Arizona fab. The US chip supply chain buildout is accelerating and the equipment makers are booked out for years. Nvidia and ASML keep eating.',
  'Milan is quietly building a defense-tech corridor: Leonardo is hiring at scale and Fincantieri just won another naval contract. European rearmament is not a trade, it is a decade.',
];

async function main() {
  const custom = process.argv[2];
  for (const post of custom ? [custom] : SAMPLES) {
    log.step(`POST: ${post.slice(0, 90)}…`);
    const result = await assetsFromContent(post);
    const { assets, unmatched } = result;
    log.info(
      `thesis: ${result.thesis?.title ?? '(none)'} | ranked assets: ${assets.map((a) => a.ticker).join(', ') || '(none)'}${unmatched.length ? ` | unmatched: ${unmatched.join(', ')}` : ''}`,
    );
    const pm = await relatedPredictionMarket(result);
    if (pm) log.info(`prediction market: "${pm.question}" (score ${pm.score})`);
    const reply = await composeSmartReply(post, result, pm);
    const cashtags = (reply.match(/\$(?=[A-Za-z])/g) ?? []).length;
    log.info(`REPLY (${reply.length}/${MAX_TWEET} chars, ${cashtags} cashtag): ${reply}`);
  }
}

main().catch((err) => {
  log.error('smart reply preview crashed', err);
  process.exit(1);
});
