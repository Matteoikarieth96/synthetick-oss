/**
 * X bot gate (spec §14, PR 3) — reply composition pure, then the
 * bot_state/bot_replies round trip against the live DB with disposable rows.
 *
 *   npm run test:bot
 *
 * Needs SUPABASE_URL + SUPABASE_SERVICE_KEY. No X calls, no LLM spend.
 * Skips the DB half cleanly when db/bot_state.sql has not been applied yet.
 */
import { createHmac } from 'node:crypto';
import { supabase } from '../ingest/lib/supabase.js';
import { log } from '../ingest/lib/log.js';
import {
  composeAssetsReply,
  stripLeadingMentions,
  enforceReplyRules,
  replyRejection,
  fmtBig,
  MAX_TWEET,
  NO_ASSETS_REPLY,
} from '../bot/reply.js';
import {
  stateGet,
  stateSet,
  claimMention,
  updateClaimKind,
  unlinkedRepliedToday,
} from '../bot/db.js';
import { oauth1Header } from '../bot/x-api.js';
import { selectSpeechVariant } from '../bot/video.js';
import type { AssetHit } from './assets.js';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) log.info(`PASS — ${name}${detail ? `: ${detail}` : ''}`);
  else {
    failures += 1;
    log.error(`FAIL — ${name}${detail ? `: ${detail}` : ''}`);
  }
}

const hit = (over: Partial<AssetHit>): AssetHit => ({
  id: 1,
  name: 'Test',
  ticker: 'TEST',
  kind: 'stock',
  price: 100,
  change1dPct: 1.23,
  currency: 'USD',
  marketCapUsd: 1e9,
  market_withheld: false,
  ...over,
});

async function main() {
  log.step('X bot gate (bot/reply.ts + bot/db.ts)');

  // ---- reply composition (pure) ---------------------------------------------
  check('empty list → no-assets reply', composeAssetsReply([]) === NO_ASSETS_REPLY);

  const usd = composeAssetsReply([hit({ ticker: 'NVDA', price: 123.45, change1dPct: 0.23 })]);
  check('USD item hides currency code', usd === 'Assets in this post: $NVDA 123.45 (+0.2% 1d).', usd);

  const eur = composeAssetsReply([
    hit({ ticker: 'ASML.AS', price: 1572.2, change1dPct: 3.38, currency: 'EUR' }),
  ]);
  check('non-USD shows code, >=1000 rounds', eur === 'Assets in this post: $ASML.AS 1,572 EUR (+3.4% 1d).', eur);

  const down = composeAssetsReply([hit({ ticker: 'TSLA', price: 244.4, change1dPct: -2.5 })]);
  check('negative change keeps its sign', down.includes('(-2.5% 1d)'), down);

  const subDollar = composeAssetsReply([
    hit({ ticker: 'DOGE', price: 0.123456, change1dPct: 5, kind: 'crypto' }),
  ]);
  check('sub-dollar price keeps precision', subDollar.includes('$DOGE 0.123'), subDollar);

  const bare = composeAssetsReply([hit({ price: null, change1dPct: null })]);
  check('missing market data degrades to the cashtag', bare === 'Assets in this post: $TEST.', bare);

  const two = composeAssetsReply([
    hit({ id: 1, ticker: 'NVDA', price: 123.45, change1dPct: 0.23 }),
    hit({ id: 2, ticker: 'TSM', price: 402.3, change1dPct: 0.99 }),
  ]);
  check(
    'only the lead asset carries the cashtag (X one-cashtag limit)',
    two === 'Assets in this post: $NVDA 123.45 (+0.2% 1d), TSM 402.30 (+1.0% 1d).',
    two,
  );

  const many = composeAssetsReply(
    Array.from({ length: 8 }, (_, i) =>
      hit({ id: i, ticker: `LONGTICKER${i}.MI`, price: 12345.67, change1dPct: -10.55, currency: 'EUR' }),
    ),
  );
  check('long list truncates under 280', many.length <= MAX_TWEET, `${many.length} chars`);
  check('truncation says how many were dropped', / and \d+ more\.$/.test(many), many);
  check('multi-asset reply has exactly one $', (many.match(/\$/g) ?? []).length === 1, many);

  check(
    'leading @mentions stripped, inner kept',
    stripLeadingMentions('@SyntheTick  @someone check this: @example_user ships') === 'check this: @example_user ships',
  );

  // ---- smart-reply guards (pure) --------------------------------------------
  const btc = hit({ ticker: 'BTC' });
  check(
    'guard crowns the data mention, not the thesis phrase',
    enforceReplyRules('Satsuma BTC Exit: BTC at 65,987 USD is worth watching.', btc) ===
      'Satsuma BTC Exit: $BTC at 65,987 USD is worth watching.',
  );
  check(
    'guard strips extra cashtags and keeps one',
    enforceReplyRules('Watch $BTC at 65,000 and $ETH too.', btc) === 'Watch $BTC at 65,000 and ETH too.',
  );
  check(
    'guard crowns the only occurrence when no digits follow',
    enforceReplyRules('Keep BTC on your radar.', btc) === 'Keep $BTC on your radar.',
  );
  check(
    'guard finds the ticker case-insensitively, keeps prose casing',
    enforceReplyRules('OpenAI is worth watching.', hit({ ticker: 'OPENAI' })) ===
      '$OpenAI is worth watching.',
  );
  check('guard rejects a URL', enforceReplyRules('BTC 65,000 see https://x.com', btc) === null);
  check('guard rejects a draft missing the lead ticker', enforceReplyRules('Bitcoin looks fine.', btc) === null);
  check('guard rejects over-280 drafts', enforceReplyRules('BTC 1 ' + 'x'.repeat(290), btc) === null);
  check(
    'guard replaces em and en dashes',
    enforceReplyRules('BTC at 65,000 — worth watching – today.', btc) ===
      '$BTC at 65,000 - worth watching - today.',
  );
  check('fmtBig: 2.14e12 → 2.1T', fmtBig(2.14e12) === '2.1T', fmtBig(2.14e12));
  check('fmtBig: 2.96e11 → 296B', fmtBig(2.96e11) === '296B', fmtBig(2.96e11));
  check('fmtBig: 6.9e7 → 69M', fmtBig(6.9e7) === '69M', fmtBig(6.9e7));

  // ---- X media selection (pure) --------------------------------------------
  const selectedVideo = selectSpeechVariant([
    { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/a.m3u8' },
    { bit_rate: 2_176_000, content_type: 'video/mp4', url: 'https://video.twimg.com/large.mp4' },
    { bit_rate: 256_000, content_type: 'video/mp4', url: 'https://video.twimg.com/small.mp4' },
  ]);
  check('video transcription selects the lowest-bitrate MP4', selectedVideo?.bit_rate === 256_000);
  check(
    'video transcription rejects non-X media hosts',
    selectSpeechVariant([
      { bit_rate: 256_000, content_type: 'video/mp4', url: 'https://attacker.example/video.mp4' },
    ]) === null,
  );

  // ---- reply content filter (M7) -------------------------------------------
  check('filter passes a clean data reply', replyRejection('For chips, BTC at 65,987 USD (+1.2%) is worth watching.') === null);
  check('filter rejects a URL', replyRejection('BTC is on the radar, see https://example.com/x') === 'url');
  check('filter rejects a bare domain', replyRejection('Details at example.com now') === 'url');
  check('filter rejects a www host', replyRejection('Go to www.example.org') === 'url');
  check('filter allows a dotted ticker', replyRejection('Keep C3.AI on the radar.', { knownTickers: ['C3.AI'] }) === null);
  check('filter allows decimals and venue tickers', replyRejection('ASML.AS 1,572 EUR (+3.4%), NVDA 123.45.') === null);
  check('filter rejects an unlisted @mention', replyRejection('Thanks @scammer for the tip') === 'mention');
  check('filter allows an allowlisted @mention', replyRejection('Thanks @SyntheTick', { allowedMentions: ['syntheTick'] }) === null);
  check('filter rejects two cashtags', replyRejection('Watch $BTC and $ETH today') === 'cashtags');
  check('filter allows one cashtag and dollar prices', replyRejection('Watch $BTC at $65,000') === null);
  check('filter rejects blocklisted scam wording', replyRejection('Free giveaway, DM me for BTC') === 'blocklist');
  check('filter blocklist is word-bounded', replyRejection('Guaranteeing nothing, ETH at 3,100 is worth watching.') === null);
  check('filter blocklist rejects trading instructions', replyRejection('You should buy BTC now') === 'blocklist');

  // ---- OAuth 1.0a signer ------------------------------------------------------
  // Obviously fake credentials (no X documentation secrets, which trip secret
  // scanners). The expected signature is recomputed here with an independent,
  // minimal RFC 5849 implementation, so the test still verifies the signing
  // code: parameter encoding and sorting, base string, HMAC-SHA1 key.
  const FAKE = {
    oauth_consumer_key: 'fake-consumer-key',
    oauth_nonce: 'fakenonce1234567890',
    oauth_timestamp: '1700000000',
    oauth_token: 'fake-access-token',
    consumer_secret: 'FAKE-CONSUMER-SECRET-FOR-TESTS',
    token_secret: 'FAKE-TOKEN-SECRET-FOR-TESTS',
  };
  const statusText = 'Hello Ladies + Gentlemen, a signed OAuth request!';
  const signUrl =
    'https://api.x.com/1.1/statuses/update.json?include_entities=true&status=' + encodeURIComponent(statusText);
  const signed = oauth1Header('POST', signUrl, FAKE);
  const sig = decodeURIComponent(/oauth_signature="([^"]+)"/.exec(signed)?.[1] ?? '');
  const pct = (v: string) =>
    encodeURIComponent(v).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const refParams: [string, string][] = [
    ['include_entities', 'true'],
    ['status', statusText],
    ['oauth_consumer_key', FAKE.oauth_consumer_key],
    ['oauth_nonce', FAKE.oauth_nonce],
    ['oauth_signature_method', 'HMAC-SHA1'],
    ['oauth_timestamp', FAKE.oauth_timestamp],
    ['oauth_token', FAKE.oauth_token],
    ['oauth_version', '1.0'],
  ];
  const refBase = [
    'POST',
    pct('https://api.x.com/1.1/statuses/update.json'),
    pct(
      refParams
        .map(([k, v]): [string, string] => [pct(k), pct(v)])
        .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1))
        .map(([k, v]) => `${k}=${v}`)
        .join('&'),
    ),
  ].join('&');
  const refSig = createHmac('sha1', `${pct(FAKE.consumer_secret)}&${pct(FAKE.token_secret)}`)
    .update(refBase)
    .digest('base64');
  check('OAuth 1.0a signature matches an independent recomputation', sig === refSig, sig);
  check(
    'OAuth 1.0a signature changes with the token secret',
    decodeURIComponent(
      /oauth_signature="([^"]+)"/.exec(oauth1Header('POST', signUrl, { ...FAKE, token_secret: 'OTHER' }))?.[1] ?? '',
    ) !== sig,
  );

  // ---- bot_state / bot_replies ----------------------------------------------
  const probe = await supabase.from('bot_state').select('key').limit(1);
  if (probe.error && /does not exist|not find/i.test(probe.error.message)) {
    log.warn('SKIP — bot_state table missing: run db/bot_state.sql in the Supabase SQL editor first');
    finish();
    return;
  }
  if (probe.error) throw new Error(`bot_state probe failed: ${probe.error.message}`);

  const stamp = Date.now();
  const stateKey = `test-since-${stamp}`;
  const mention = (n: number) => `test-mention-${stamp}-${n}`;
  const author = `test-author-${stamp}`;

  try {
    check('unset state reads null', (await stateGet(stateKey)) === null);
    await stateSet(stateKey, '111');
    await stateSet(stateKey, '222'); // upsert replaces
    check('state round trip (upsert wins)', (await stateGet(stateKey)) === '222');

    check('first claim wins', (await claimMention(mention(1), author, 'assets')) === true);
    check('second claim refused', (await claimMention(mention(1), author, 'assets')) === false);
    await updateClaimKind(mention(1), 'no_credits');
    const { data: row } = await supabase
      .from('bot_replies')
      .select('kind')
      .eq('mention_id', mention(1))
      .single();
    check('claim kind updatable', row?.kind === 'no_credits');

    check('fresh author not throttled', (await unlinkedRepliedToday(author)) === false);
    await claimMention(mention(2), author, 'unlinked');
    check('unlinked reply throttles for the day', (await unlinkedRepliedToday(author)) === true);
  } finally {
    await supabase.from('bot_state').delete().eq('key', stateKey);
    await supabase.from('bot_replies').delete().eq('author_x_id', author);
    log.info('cleanup — disposable bot rows deleted');
  }

  finish();
}

function finish() {
  if (failures) {
    log.error(`${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
  log.step('ALL BOT CHECKS PASSED');
}

main().catch((err) => {
  log.error('bot gate crashed', err);
  process.exit(1);
});
