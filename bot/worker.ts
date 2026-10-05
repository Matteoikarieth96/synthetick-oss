/**
 * X bot worker (spec §14, PR 3) — its own Railway service: `npm run bot`.
 *
 * Loop: poll mentions since the stored watermark → per mention, resolve the
 * author to a linked SyntheTick user → charge 1 credit → assetsFromContent
 * in-process → reply with $tickers + price + day change. Claim-first rows in
 * bot_replies plus the per-mention since_id advance make restarts idempotent:
 * a crash can drop at most one reply, never double-reply or double-charge.
 *
 * First run with no watermark initializes it to the newest existing mention
 * WITHOUT replying — the bot never answers backlog from before it went live.
 *
 * Liveness (final audit H2): every mention runs under a deadline
 * (X_BOT_MENTION_TIMEOUT_SECONDS, default 240), the post-charge work under a
 * shorter one that aborts its model calls and refunds, and a drained event
 * loop or an escaped error exits with code 1 so the platform restarts the
 * worker. Cost (L9): template replies once per author per UTC day and a global
 * daily cap on posts (X_BOT_MAX_REPLIES_PER_DAY, default 300).
 */
import { assetsFromContent } from '../runtime/assets.js';
import { extractLink } from '../runtime/extract.js';
import { withRunSignal } from '../runtime/runsignal.js';
import { dailyQuota, tryConsume } from '../server/ratelimit.js';
import { spendCredit, refundCredit, refundCreditDetailed, logPrompt, type AuthedUser } from '../server/auth.js';
import { log } from '../ingest/lib/log.js';
import { installExitGuards, mentionTimeouts, ReplyBudget, withDeadline, type TemplateReply } from './guards.js';
import {
  requireBotEnv,
  getBotUserId,
  getMentions,
  postReply,
  XRateLimit,
  type XTweet,
  type XMedia,
  type MentionsPage,
} from './x-api.js';
import { transcribeXVideo } from './video.js';
import {
  requireBotTables,
  stateGet,
  stateSet,
  claimMention,
  updateClaimKind,
  unlinkedRepliedToday,
  linkedUserFor,
} from './db.js';
import {
  composeSmartReply,
  relatedPredictionMarket,
  stripLeadingMentions,
  runFailedReply,
  UNLINKED_REPLY,
  NO_CREDITS_REPLY,
} from './reply.js';

const SINCE_KEY = 'since_id';
/** bot_state key holding today's post count ({day, posts}), so a restart keeps the daily cap. */
const POSTS_KEY = 'replies_today';
// Default 120s = 7.5 req/15min, under the Basic tier's 10/15min mentions cap.
const POLL_MS = Math.max(60, Number(process.env.X_BOT_POLL_SECONDS || 120)) * 1000;
const MAX_CONTENT = 40_000;
const { mentionMs: MENTION_TIMEOUT_MS, workMs: WORK_TIMEOUT_MS } = mentionTimeouts();
const budget = ReplyBudget.fromEnv();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Post a reply and count it against today's cap (persisted best-effort). A
 * template reply is also remembered per author for the day. */
async function post(text: string, mentionId: string, template?: { kind: TemplateReply; author: string }) {
  await postReply(text, mentionId);
  const state = budget.recordPost();
  if (template) budget.recordTemplate(template.kind, template.author);
  try {
    await stateSet(POSTS_KEY, JSON.stringify(state));
  } catch (err) {
    log.warn(`bot: could not persist today's post count: ${(err as Error).message}`);
  }
}

/** Load today's post count after a restart. */
async function restorePostCount() {
  try {
    const raw = await stateGet(POSTS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as { day?: unknown; posts?: unknown };
    if (typeof saved.day === 'string' && typeof saved.posts === 'number') budget.restore(saved.day, saved.posts);
  } catch (err) {
    log.warn(`bot: could not read today's post count: ${(err as Error).message}`);
  }
}

/** The text the bot analyzes: the replied-to parent, else the mention itself. */
async function contentFor(
  mention: XTweet,
  parents: Map<string, XTweet>,
  media: Map<string, XMedia>,
): Promise<string> {
  const parentId = mention.referenced_tweets?.find((r) => r.type === 'replied_to')?.id;
  const parent = parentId ? parents.get(parentId) : undefined;
  const source = parent ?? mention;
  const parts = [parent ? parent.text : stripLeadingMentions(mention.text)];

  // The source post's attached video is part of the thesis, not decoration.
  // Transcription is best-effort so media trouble never discards usable text.
  const video = (source.attachments?.media_keys ?? [])
    .map((key) => media.get(key))
    .find((item): item is XMedia => item?.type === 'video');
  if (video) {
    try {
      const transcript = await transcribeXVideo(video);
      parts.push(`[Attached video transcript]\n${transcript}`);
    } catch (err) {
      log.warn(`bot: video transcription failed (${source.id}): ${(err as Error).message}`);
    }
  }

  // The parent's first external link rides the extract path, best-effort:
  // a paywalled or dead link still analyzes the post text alone.
  const urls = source.entities?.urls ?? [];
  const external = urls
    .map((u) => u.expanded_url ?? '')
    .find((u) => u && !/^https?:\/\/(x\.com|twitter\.com)\//i.test(u));
  if (external) {
    try {
      // Third-party links are untrusted: the paid web-search fallback is budgeted
      // per mention author (RATE_WEBSEARCH_PER_USER_HOUR), like the web app.
      const ex = await extractLink(external, {
        allowWebSearch: () => tryConsume('websearch', `x:${mention.author_id ?? 'unknown'}`),
      });
      parts.push(ex.text);
    } catch (err) {
      log.warn(`bot: link extraction failed (${external}): ${(err as Error).message}`);
    }
  }
  return parts.join('\n\n').slice(0, MAX_CONTENT);
}

async function handleLinked(
  user: AuthedUser,
  mention: XTweet,
  parents: Map<string, XTweet>,
  media: Map<string, XMedia>,
) {
  const author = mention.author_id ?? 'unknown';
  const spend = await spendCredit(user.id, 1, 'search');
  if (!spend.ok) {
    await updateClaimKind(mention.id, 'no_credits');
    // Once per author per day (L9): a second out-of-credits mention costs nothing.
    if (budget.templateAllowed('no_credits', author)) {
      await post(NO_CREDITS_REPLY, mention.id, { kind: 'no_credits', author });
    }
    log.info(`bot: ${mention.id} out of credits (user ${user.id})`);
    return;
  }
  // With a parent post, the mention's own text is the reader's request
  // ("give me only ETFs", "assets to short") — context, not content.
  const hasParent = Boolean(mention.referenced_tweets?.some((r) => r.type === 'replied_to'));
  const request = hasParent ? stripLeadingMentions(mention.text) : '';
  let reply: string;
  try {
    // Inside the try: the credit is already spent, so a failure while reading
    // the post (media, link) must refund like any other failed run. The work
    // runs under a deadline that also aborts its model calls (H2), so a stuck
    // source refunds and answers instead of stalling the loop.
    reply = await withDeadline(
      WORK_TIMEOUT_MS,
      (signal) =>
        withRunSignal(signal, async () => {
          const content = await contentFor(mention, parents, media);
          logPrompt(user, `[X bot] ${content.slice(0, 2000)}`);
          // The bot's replies are public posts on X: the API channel of the data
          // display policy (no vendor market data unless API_RELAY_MARKET_DATA=1).
          const result = await assetsFromContent(content, request, { channel: 'api' });
          const pm = await relatedPredictionMarket(result, request);
          return composeSmartReply(content, result, pm, request);
        }),
      `mention ${mention.id}`,
    );
  } catch (err) {
    // Refunds are capped per day (L5); the reply says what happened to the credit.
    const outcome = await refundCreditDetailed(user.id);
    await updateClaimKind(mention.id, 'error');
    if (budget.templateAllowed('run_failed', author)) {
      const text = runFailedReply(outcome.refunded ? 'refunded' : outcome.reason, dailyQuota('refund').limit);
      await post(text, mention.id, { kind: 'run_failed', author });
    }
    log.error(`bot: run failed for ${mention.id}`, err);
    return;
  }
  try {
    await post(reply, mention.id);
  } catch (err) {
    await refundCredit(user.id);
    await updateClaimKind(mention.id, 'error');
    throw err; // posting is broken; let the loop back off
  }
  // Ids and a length only: neither the user's email nor the posted text belongs in logs.
  log.info(`bot: replied to ${mention.id} for user ${user.id} (${reply.length} chars)`);
}

async function handleMention(
  botId: string,
  mention: XTweet,
  parents: Map<string, XTweet>,
  media: Map<string, XMedia>,
) {
  if (mention.author_id === botId || !mention.author_id) return;
  const author = mention.author_id;
  const user = await linkedUserFor(author);
  if (!user) {
    // The pointer reply goes to an author once per UTC day (database check,
    // plus the in-process memory) and only while today's post cap allows it.
    const reply = !(await unlinkedRepliedToday(author)) && budget.templateAllowed('unlinked', author);
    if (!(await claimMention(mention.id, author, reply ? 'unlinked' : 'ignored'))) return;
    if (reply) {
      await post(UNLINKED_REPLY, mention.id, { kind: 'unlinked', author });
      log.info(`bot: pointed unlinked author ${author} at synthetick.org`);
    }
    return;
  }
  // Today's post cap reached (L9): no charge and no reply; the mention is
  // recorded as ignored so it is never picked up again.
  if (!budget.canPost()) {
    if (await claimMention(mention.id, author, 'ignored')) {
      log.warn(`bot: daily post cap (${budget.maxPostsPerDay}) reached, mention ${mention.id} ignored without a charge`);
    }
    return;
  }
  if (!(await claimMention(mention.id, author, 'assets'))) return;
  await handleLinked(user, mention, parents, media);
}

async function main() {
  requireBotEnv();
  await requireBotTables();
  const botId = await getBotUserId();
  let sinceId = await stateGet(SINCE_KEY);
  await restorePostCount();
  log.step(
    `SyntheTick X bot → user ${botId}, poll ${POLL_MS / 1000}s, since_id ${sinceId ?? '(none)'}, ` +
      `mention deadline ${MENTION_TIMEOUT_MS / 1000}s, posts today ${budget.postsToday}/${budget.maxPostsPerDay}`,
  );

  if (!sinceId) {
    // Initialize the watermark without answering pre-launch backlog.
    const page = await getMentions(botId, null);
    sinceId = page.newestId ?? '1';
    await stateSet(SINCE_KEY, sinceId);
    log.info(`bot: watermark initialized at ${sinceId}, ${page.mentions.length} old mention(s) skipped`);
  }

  for (;;) {
    try {
      const page: MentionsPage = await getMentions(botId, sinceId);
      for (const mention of page.mentions) {
        try {
          // The whole mention is bounded too (H2): a hung database or X call
          // cannot stall the loop, the next mention is handled regardless.
          await withDeadline(MENTION_TIMEOUT_MS, () => handleMention(botId, mention, page.parents, page.media), `mention ${mention.id}`);
        } catch (err) {
          if (err instanceof XRateLimit) throw err;
          // One bad mention must not stall the stream behind it.
          log.error(`bot: mention ${mention.id} failed`, err);
        }
        sinceId = mention.id;
        await stateSet(SINCE_KEY, sinceId);
      }
    } catch (err) {
      if (err instanceof XRateLimit) {
        const waitMs = Math.max(err.resetAtMs - Date.now(), 5_000);
        log.warn(`bot: rate limited, sleeping ${Math.round(waitMs / 1000)}s`);
        await sleep(waitMs);
        continue;
      }
      log.error('bot: poll failed', err);
    }
    await sleep(POLL_MS);
  }
}

// A drained loop or an escaped error must be a FAILURE exit (H2): Railway's
// restart policy restarts failed workers only.
installExitGuards(process, log);

main().then(
  () => {
    log.error('bot: the poll loop returned, which it never should; exiting 1 so the worker is restarted');
    process.exit(1);
  },
  (err) => {
    log.error('bot: fatal', err);
    process.exit(1);
  },
);
