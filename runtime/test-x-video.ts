/**
 * Live, non-posting X video preview.
 *
 * Usage:
 *   npm run test:x-video -- https://x.com/user/status/123
 *
 * Reads the post and its media with X app auth, runs the production video
 * transcription + asset extraction path, and prints the reply that the bot
 * would compose. It never spends a SyntheTick credit or posts to X.
 */
import 'dotenv/config';
import { assetsFromContent } from './assets.js';
import { composeSmartReply } from '../bot/reply.js';
import { transcribeXVideo } from '../bot/video.js';
import type { XMedia, XTweet } from '../bot/x-api.js';

function postId(raw: string): string {
  const match = raw.match(/(?:status\/)?(\d{10,})/);
  if (!match?.[1]) throw new Error('pass an X post URL or numeric post id');
  return match[1];
}

async function main() {
  const id = postId(process.argv[2] ?? '');
  const bearer = process.env.X_BOT_BEARER?.trim();
  if (!bearer) throw new Error('X_BOT_BEARER missing');

  const url = new URL(`https://api.x.com/2/tweets/${id}`);
  url.searchParams.set('tweet.fields', 'author_id,entities,attachments');
  url.searchParams.set('expansions', 'attachments.media_keys');
  url.searchParams.set('media.fields', 'media_key,type,duration_ms,variants');
  const res = await fetch(url, { headers: { authorization: `Bearer ${bearer}` } });
  if (!res.ok) throw new Error(`X post lookup failed: ${res.status} ${await res.text()}`);
  const payload = (await res.json()) as {
    data?: XTweet;
    includes?: { media?: XMedia[] };
  };
  if (!payload.data) throw new Error('X post lookup returned no post');
  const video = (payload.includes?.media ?? []).find((item) => item.type === 'video');
  if (!video) throw new Error('post has no expanded video attachment');

  console.log(`POST ${payload.data.id}`);
  console.log(`VIDEO ${(video.duration_ms ?? 0) / 1000}s, ${video.variants?.length ?? 0} variant(s)`);
  console.log(`POST TEXT\n${payload.data.text}\n`);

  const transcript = await transcribeXVideo(video);
  console.log(`TRANSCRIPT (${transcript.length} chars)\n${transcript.slice(0, 2_000)}${transcript.length > 2_000 ? '\n[…]' : ''}\n`);

  const content = `${payload.data.text}\n\n[Attached video transcript]\n${transcript}`;
  const result = await assetsFromContent(content, '');
  console.log(`THESIS\n${JSON.stringify(result.thesis, null, 2)}\n`);
  console.log(
    `ASSETS\n${result.assets.map((asset) => `${asset.ticker} — ${asset.name}`).join('\n') || '(none)'}\n`,
  );
  if (result.unmatched.length) console.log(`UNMATCHED\n${result.unmatched.join('\n')}\n`);

  const reply = await composeSmartReply(content, result, null, '');
  console.log(`REPLY PREVIEW (${reply.length} chars)\n${reply}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
