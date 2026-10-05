/**
 * Source extraction for the composer's "Add file / Add link" (spec §0: PDF,
 * pasted text, tweet, or YouTube link — extended to screenshots via vision).
 * Everything returns plain text ready to join the research document.
 */
import http from 'node:http';
import https from 'node:https';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { pipeline, type Readable } from 'node:stream';
import { callClaude, type ContentBlock } from './llm.js';
import { BlockedAddressError, assertPublicLiteralHost, isPrivateHostname, refuseNonPublicPeer, safeLookup } from './netguard.js';
import { PublicError } from './errors.js';
import { log } from '../ingest/lib/log.js';

export interface Extracted {
  text: string;
  label: string; // shown in the source chip / docked line
  approximate?: boolean; // e.g. web-search reconstruction — review before continuing
}

/**
 * Per-call options. `allowWebSearch` gates every PAID lookup behind a link
 * (audit H2, final audit H1): the `:online` web-search fallbacks and the
 * ytscribe transcript API. The server passes a per-user rate-limit check, so
 * a caller cannot turn dead links or video links into unlimited paid spend.
 */
export interface ExtractOptions {
  allowWebSearch?: () => boolean;
}

function webSearchAllowed(opts?: ExtractOptions): void {
  if (opts?.allowWebSearch && !opts.allowWebSearch()) {
    throw new PublicError(
      429,
      'rate_limited',
      'Too many web lookups this hour. Paste the relevant text instead.',
      600,
    );
  }
}

const YT_RE = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;
const TW_RE = /^https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/[^/]+\/status\/\d+/i;

/** A URL the server refuses to fetch (private network, credentials, bad scheme). */
class UnsafeUrlError extends PublicError {
  constructor(message = 'For safety, links to local or private network addresses cannot be loaded.') {
    super(422, 'unsafe_url', message);
    this.name = 'UnsafeUrlError';
  }
}

const MAX_URL_CHARS = 2048;
/** Response bodies are read as a stream and cut at this size (audit M2). */
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;

/** Reject obvious SSRF targets before any server-side page fetch. */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    if (raw.length > MAX_URL_CHARS) throw new Error('too long');
    url = new URL(raw);
  } catch {
    throw new PublicError(400, 'bad_request', 'That does not look like a URL.');
  }
  if (!/^https?:$/.test(url.protocol)) throw new PublicError(400, 'bad_request', 'That does not look like an HTTP URL.');
  if (url.username || url.password || isPrivateHostname(url.hostname)) throw new UnsafeUrlError();
  return url;
}

/** Read an async byte stream up to `cap` bytes (truncating), then stop pulling. */
export async function readCapped(
  stream: AsyncIterable<Buffer | Uint8Array | string>,
  cap = MAX_PAGE_BYTES,
): Promise<{ text: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  for await (const c of stream) {
    const chunk = typeof c === 'string' ? Buffer.from(c) : Buffer.from(c);
    if (bytes + chunk.length >= cap) {
      chunks.push(chunk.subarray(0, cap - bytes));
      truncated = true;
      break; // leaving the loop destroys the underlying stream
    }
    bytes += chunk.length;
    chunks.push(chunk);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

interface PageResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Readable;
}

/**
 * The response body as DECODED bytes (gzip, deflate, br), so readCapped
 * counts what the page really expands to and a decompression bomb is cut at
 * the same 2 MB as a plain body.
 *
 * pipeline, not pipe (final audit H2): `Readable.pipe` forwards neither errors
 * nor a premature close, so a compressed response that stalled, was reset
 * mid-body or hit the request timeout left the decoder open forever and the
 * read loop never settled (the X bot then exited 0 with the mention pending).
 * pipeline destroys the decoder whenever the response dies, and the abort
 * listener destroys whatever is being read when the request's deadline fires,
 * so every path settles: data, an error, or the timeout.
 */
export function decodedBody(res: Readable, contentEncoding: unknown, signal: AbortSignal): Readable {
  const enc = String(contentEncoding ?? '').toLowerCase();
  const decoder =
    enc === 'gzip' || enc === 'x-gzip'
      ? createGunzip()
      : enc === 'deflate'
        ? createInflate()
        : enc === 'br'
          ? createBrotliDecompress()
          : null;
  const body: Readable = decoder ? pipeline(res, decoder, () => {}) : res;
  body.on('error', () => {}); // surfaced through the read loop
  if (signal.aborted) {
    body.destroy(signal.reason as Error);
  } else {
    const onAbort = () => body.destroy(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    // A body that is done no longer needs the deadline (nor stays referenced by it).
    body.once('close', () => signal.removeEventListener('abort', onAbort));
  }
  return body;
}

/**
 * One GET with the connection pinned to a validated address: `safeLookup`
 * runs at connect time and refuses non-public IPs, so DNS rebinding between a
 * pre-check and the connect cannot reach the internal network (audit M2).
 */
function requestOnce(url: URL, signal: AbortSignal): Promise<PageResponse> {
  return new Promise((resolve, reject) => {
    try {
      assertPublicLiteralHost(url.hostname); // the lookup hook is skipped for IP literals
    } catch {
      return reject(new UnsafeUrlError());
    }
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      {
        method: 'GET',
        lookup: safeLookup as never,
        signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (SyntheTick research fetch)',
          accept: 'text/html,*/*',
          'accept-encoding': 'gzip, deflate, br',
        },
      },
      (res) => {
        const body = decodedBody(res, res.headers['content-encoding'], signal);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
      },
    );
    refuseNonPublicPeer(req);
    req.on('error', (err) => {
      reject(err instanceof BlockedAddressError ? new UnsafeUrlError() : err);
    });
    req.end();
  });
}

async function fetchPublicPage(initial: URL): Promise<{ res: PageResponse; finalUrl: URL }> {
  const signal = AbortSignal.timeout(12_000);
  let current = initial;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const res = await requestOnce(current, signal);
    if (![301, 302, 303, 307, 308].includes(res.status)) return { res, finalUrl: current };
    const location = res.headers.location;
    res.body.destroy();
    if (!location) throw new Error(`page redirect failed (HTTP ${res.status})`);
    // Every hop is re-validated (literal IPs here, resolved IPs at connect).
    current = assertPublicHttpUrl(new URL(location, current).href);
  }
  throw new Error('page redirected too many times');
}

/**
 * HTML scanning below is deliberately regex-light. Pages are attacker
 * controlled, and lazy or greedy patterns such as `<div[^>]+...>([\s\S]*)</div>`
 * or `<[^>]+>` re-scan the rest of the input from every `<` when the closing
 * piece is missing, which is quadratic and froze the event loop on a 2 MB page
 * of `<div ` (audit N1). Every helper here moves forward through the text once:
 * sticky/global exec calls resume at `lastIndex`, and a missing closer is
 * remembered so it is never searched for twice.
 */

/** Replace every `<...>` tag with `repl` in one forward pass (`<>` stays text). */
function replaceTags(html: string, repl = ' '): string {
  let out = '';
  let i = 0;
  for (;;) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    const gt = html.indexOf('>', lt + 1);
    if (gt === -1) break; // no `>` left, so no later `<` can close either
    if (gt === lt + 1) {
      out += html.slice(i, lt + 1); // "<>" is not a tag
      i = lt + 1;
      continue;
    }
    out += html.slice(i, lt) + repl;
    i = gt + 1;
  }
  return out + html.slice(i);
}

/**
 * Remove `<tag ...> ... </tag>` blocks for the given tag names (lazy match to
 * the first closer, like the regex it replaces). An opener without a closer is
 * left in place; since no later opener of that tag can find a closer either, the
 * search for it is not repeated.
 */
function cutBlocks(html: string, tags: string[]): string {
  const openRe = new RegExp(`<(${tags.join('|')})\\b`, 'gi');
  const closeRes = new Map(tags.map((t) => [t, new RegExp(`</${t}\\s*>`, 'gi')]));
  const noCloser = new Set<string>();
  let out = '';
  let copied = 0;
  for (let m = openRe.exec(html); m; m = openRe.exec(html)) {
    const tag = m[1]!.toLowerCase();
    if (noCloser.has(tag)) continue;
    const closeRe = closeRes.get(tag)!;
    closeRe.lastIndex = m.index + m[0].length;
    const close = closeRe.exec(html);
    if (!close) {
      noCloser.add(tag);
      continue;
    }
    out += html.slice(copied, m.index) + ' ';
    copied = close.index + close[0].length;
    openRe.lastIndex = copied;
  }
  return out + html.slice(copied);
}

/** Remove `<!-- ... -->` comments (an unterminated one is left as is). */
function cutComments(html: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const open = html.indexOf('<!--', i);
    if (open === -1) break;
    const close = html.indexOf('-->', open + 4);
    if (close === -1) break;
    out += html.slice(i, open) + ' ';
    i = close + 3;
  }
  return out + html.slice(i);
}

/**
 * Inner HTML of the first `<tag>` up to the last `</tag>`, or undefined.
 * `openEnded` (the body was cut at the size cap, e2e R1): the closer was cut
 * off with the rest of the page, so an opener without one runs to the end of
 * the input instead of failing over to the whole page with its site chrome.
 */
function innerOfTag(html: string, tag: string, openEnded = false): string | undefined {
  const open = new RegExp(`<${tag}\\b`, 'i').exec(html);
  if (!open) return undefined;
  const gt = html.indexOf('>', open.index);
  if (gt === -1) return undefined;
  const closeRe = new RegExp(`</${tag}\\s*>`, 'gi');
  let lastClose = -1;
  for (let m = closeRe.exec(html); m; m = closeRe.exec(html)) lastClose = m.index;
  if (lastClose > gt) return html.slice(gt + 1, lastClose);
  return openEnded ? html.slice(gt + 1) : undefined;
}

const CONTENT_DIV_ATTR_RE = /\b(?:id|class)=["'][^"']*(?:article-body|post-content|entry-content|story-body|main-content)/i;
const MAX_OPEN_TAG_CHARS = 2000;

/** Inner HTML of the first content-looking `<div id|class="...article-body...">`
 * up to the last `</div>` (to the end of a cut body when `openEnded`). Only
 * open tags that are short and contain no stray `<` are examined, so every
 * character is looked at a bounded number of times. */
function innerOfContentDiv(html: string, openEnded = false): string | undefined {
  const divRe = /<div\b/gi;
  let gt = -1; // cached position of the next `>`, reused while it is still ahead
  for (let m = divRe.exec(html); m; m = divRe.exec(html)) {
    if (gt <= m.index) {
      gt = html.indexOf('>', m.index);
      if (gt === -1) return undefined; // no tag can end after this point
    }
    if (gt - m.index > MAX_OPEN_TAG_CHARS) continue;
    const tagText = html.slice(m.index + 4, gt);
    if (tagText.includes('<') || !CONTENT_DIV_ATTR_RE.test(tagText)) continue;
    const closeRe = /<\/div\s*>/gi;
    let lastClose = -1;
    for (let c = closeRe.exec(html); c; c = closeRe.exec(html)) lastClose = c.index;
    if (lastClose > gt) return html.slice(gt + 1, lastClose);
    return openEnded ? html.slice(gt + 1) : undefined;
  }
  return undefined;
}

/** Page <title> text (first one), trimmed; undefined when absent. */
export function extractTitle(html: string): string | undefined {
  const open = /<title\b/i.exec(html);
  if (!open) return undefined;
  const gt = html.indexOf('>', open.index);
  if (gt === -1) return undefined;
  const closeRe = /<\/title\s*>/gi;
  closeRe.lastIndex = gt + 1;
  const close = closeRe.exec(html);
  return close ? html.slice(gt + 1, close.index).trim() : undefined;
}

export function stripHtml(html: string): string {
  return replaceTags(
    cutBlocks(html, ['script', 'style'])
      .replace(/<br\s*\/?>/gi, '\n')
      // Block-level closes become line breaks so nav items land on their own
      // lines — dropChromeLines depends on this to spot repeated boilerplate.
      .replace(/<\/(p|div|li|h[1-6]|section|article|blockquote|tr|figcaption)>/gi, '\n'),
  )
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&\w+;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n')
    .trim();
}

/** Readability-lite (no deps — must port to Edge Functions): cut non-content
 * subtrees, then prefer the page's main content container when it has real text.
 * `truncated`: the body was cut at MAX_PAGE_BYTES, so a container whose closing
 * tag is missing runs to the end of the input (e2e R1). The <title> element is
 * always cut: the caller prepends the title once, and the whole-page fallback
 * used to repeat it as the first body line. */
export function extractMainHtml(html: string, opts: { truncated?: boolean } = {}): string {
  const openEnded = opts.truncated === true;
  const cleaned = cutBlocks(cutComments(html), ['noscript', 'svg', 'iframe', 'form', 'nav', 'footer', 'aside', 'button', 'select', 'title']);
  const main = innerOfTag(cleaned, 'article', openEnded) ?? innerOfTag(cleaned, 'main', openEnded) ?? innerOfContentDiv(cleaned, openEnded);
  // Fall back to the whole page when the container is a stub (listing pages,
  // decorative <article> wrappers).
  return main && stripHtml(main).length > 400 ? main : cleaned;
}

const CHROME_RE = /^(skip to|accept( all)?( cookies)?|cookie|subscribe|sign (in|up)|log ?in|menu|search|share|learn more|read more|see (all|more)|contact( us)?|privacy policy|terms|©|\d+\s*\/\s*\d+$)/i;

/** Drop nav/boilerplate lines that survive tag stripping: exact repeats of
 * short lines (menus render on every carousel slide) and known chrome phrases. */
function dropChromeLines(text: string): string {
  const lines = text.split('\n').map((l) => l.trim());
  const count = new Map<string, number>();
  for (const l of lines) if (l && l.length < 80) count.set(l, (count.get(l) ?? 0) + 1);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    if (!l) continue;
    const short = l.length < 80;
    if (short && CHROME_RE.test(l)) continue;
    if (short && (count.get(l) ?? 0) >= 2) {
      if (seen.has(l)) continue; // keep the first occurrence only
      seen.add(l);
    }
    out.push(l);
  }
  return out.join('\n');
}

/** X/Twitter post via the public oEmbed endpoint (no API key needed). */
async function extractTweet(url: string): Promise<Extracted> {
  const res = await fetch(
    `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&omit_script=true&dnt=true`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) {
    log.warn(`extract: tweet lookup failed (HTTP ${res.status})`);
    throw new PublicError(422, 'source_unreadable', 'That post could not be loaded. Is it public?');
  }
  const j = (await res.json()) as { html?: string; author_name?: string };
  const text = stripHtml(j.html ?? '');
  if (text.length < 10) throw new PublicError(422, 'source_unreadable', 'Could not read any text from that post.');
  return { text, label: `X post by ${j.author_name ?? 'unknown'}` };
}

/** Real YouTube transcript via ytscribe.ai (spec §5.1). Returns null when the
 * key is missing, credits are exhausted, or the API fails — caller falls back.
 * Live payload (verified 2026-07-07): {status:"ok", data:{transcript, segments[],
 * metadata:{video:{title, author_name}}}}; alternate field names kept as guards. */
async function fetchYtscribeTranscript(url: string): Promise<{ text: string; label: string } | null> {
  const key = process.env.YTSCRIBE_API_KEY?.trim();
  if (!key) return null;
  try {
    const res = await fetch('https://ytscribe.ai/api/transcripts', {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      status?: string;
      data?: unknown;
      transcript?: unknown;
      text?: unknown;
      segments?: { text?: unknown }[];
      metadata?: { video?: { title?: unknown; author_name?: unknown } };
    };
    if (j.status === 'error') return null; // e.g. "Insufficient API credits"
    const d = (typeof j.data === 'object' && j.data !== null ? j.data : j) as typeof j;
    const raw =
      typeof d.transcript === 'string'
        ? d.transcript
        : typeof d.text === 'string'
          ? d.text
          : Array.isArray(d.segments)
            ? d.segments.map((s) => String(s?.text ?? '')).join(' ')
            : '';
    const clean = raw.replace(/\s+/g, ' ').trim();
    if (clean.length < 80) return null;
    // Title + author give the thesis extractor context a bare transcript lacks.
    const title = typeof d.metadata?.video?.title === 'string' ? d.metadata.video.title.trim() : '';
    const author = typeof d.metadata?.video?.author_name === 'string' ? d.metadata.video.author_name.trim() : '';
    const header = title ? `${title}${author ? ` — ${author}` : ''}\n\n` : '';
    return {
      text: (header + clean).slice(0, 60_000),
      label: title ? `YouTube: ${title.slice(0, 52)}` : 'YouTube transcript (ytscribe)',
    };
  } catch {
    return null;
  }
}

/** YouTube: real transcript when ytscribe is available, else reconstruct the
 * video's substance via Claude web search (v3 port). Both are paid lookups, so
 * one web-lookup token covers the link whichever path answers it (final audit
 * H1: the ytscribe call used to run before any gate). */
async function extractYouTube(url: string, opts?: ExtractOptions): Promise<Extracted> {
  const id = url.match(YT_RE)?.[1];
  webSearchAllowed(opts); // paid ytscribe transcript, else the paid `:online` fallback below
  const transcript = await fetchYtscribeTranscript(`https://www.youtube.com/watch?v=${id}`);
  if (transcript) return transcript;
  const sys =
    'You retrieve the substance of a YouTube video for investment research. Use web search to find its transcript, official description, or detailed write-ups/summaries about it. Output plain text only, no preamble.';
  const usr =
    `Video: https://www.youtube.com/watch?v=${id}\n` +
    `Using web search, reconstruct what this video actually says: its title, who is speaking, and — in as much detail as you can — the investment thesis, the arguments made, and any specific companies, tickers, sectors or assets mentioned. ` +
    `Write 150–500 words of plain prose that could stand in for the transcript. If you genuinely cannot find enough to reconstruct it, output exactly: NOTFOUND`;
  const raw = await callClaude(usr, { system: sys, web: true, maxTokens: 1500 });
  if (/^\s*NOTFOUND/i.test(raw) || raw.replace(/\s/g, '').length < 40) {
    throw new PublicError(422, 'source_unreadable', 'Could not reconstruct this video. Paste its transcript instead.');
  }
  return { text: raw.trim(), label: 'YouTube video (via web search)', approximate: true };
}

async function reconstructLinkViaWebSearch(url: string, reason: string, opts?: ExtractOptions): Promise<Extracted> {
  webSearchAllowed(opts); // paid `:online` call below
  // Publicly accessible material only: reporting, quotes and summaries ABOUT
  // the page, never its paywalled or subscriber-only text.
  const sys =
    'You gather publicly accessible information about a web page for investment research. Use web search to find public reporting, quotes and summaries about the page: news coverage, syndicated excerpts, the publisher\'s own public summary, and closely related public references. Never reproduce paywalled or subscriber-only text and never try to get around a paywall. Output plain text only, no preamble.';
  const usr =
    `URL: ${url}\nDirect extraction failed: ${reason}\n\n` +
    `Using web search, summarize in your own words what publicly accessible reporting, quotes and summaries say about this page, post, article or video, as source material for an investment thesis. ` +
    `Focus on the investment view, arguments, catalysts, companies, tickers, sectors, asset classes, geographies, numbers, and explicit constraints mentioned. ` +
    `Write 120 to 600 words of plain prose. If you cannot find enough publicly accessible information about it, output exactly: NOTFOUND`;
  const raw = await callClaude(usr, { system: sys, web: true, maxTokens: 1800 });
  if (/^\s*NOTFOUND/i.test(raw) || raw.replace(/\s/g, '').length < 40) {
    throw new PublicError(422, 'source_unreadable', 'Could not read or reconstruct that link. Paste the relevant text instead.');
  }
  return { text: raw.trim(), label: `${new URL(url).hostname} (via web search)`, approximate: true };
}

/** Generic article/page: fetch + strip to readable text. */
async function extractArticle(url: string, opts?: ExtractOptions): Promise<Extracted> {
  const initial = assertPublicHttpUrl(url);
  try {
    const { res, finalUrl } = await fetchPublicPage(initial);
    if (res.status < 200 || res.status >= 300) {
      res.body.destroy();
      throw new Error(`page fetch failed (HTTP ${res.status})`);
    }
    // Streamed and cut at 2 MB: a huge or endless response cannot exhaust memory.
    // A cut page lost its closing tags: extraction treats the end of input as
    // the end of the main container (e2e R1).
    const { text: html, truncated } = await readCapped(res.body);
    const title = extractTitle(html);
    const body = dropChromeLines(stripHtml(extractMainHtml(html, { truncated }))).slice(0, 60_000);
    if (body.length < 80) throw new Error('that page has no readable text (it may need JavaScript)');
    return { text: (title ? title + '\n\n' : '') + body, label: title ? title.slice(0, 60) : finalUrl.hostname };
  } catch (err) {
    // A policy block must never reach the web-search LLM: that would hand an
    // attacker-chosen internal URL to a model that browses on our behalf.
    if (err instanceof UnsafeUrlError || err instanceof BlockedAddressError) throw err;
    log.warn(`extract: direct fetch of ${initial.hostname} failed, trying web search: ${(err as Error).message}`);
    // Coarse, fixed reason: raw network errors may name internal hosts or ports.
    return reconstructLinkViaWebSearch(initial.href, 'the page could not be fetched or read', opts);
  }
}

/** Route a link to the right extractor. */
export async function extractLink(url: string, opts?: ExtractOptions): Promise<Extracted> {
  const clean = assertPublicHttpUrl(url.trim()).href;
  if (TW_RE.test(clean)) return extractTweet(clean);
  if (YT_RE.test(clean)) return extractYouTube(clean, opts);
  return extractArticle(clean, opts);
}

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Screenshot/image → text via Claude vision. */
export async function extractImage(mediaType: string, base64Data: string): Promise<Extracted> {
  if (typeof base64Data !== 'string' || typeof mediaType !== 'string' || !IMAGE_TYPES.has(mediaType)) {
    throw new PublicError(415, 'unsupported_media', 'Unsupported image type. Send a JPEG, PNG, GIF or WebP image.');
  }
  if (Buffer.byteLength(base64Data, 'base64') > MAX_IMAGE_BYTES) {
    throw new PublicError(413, 'source_too_large', 'Image too large (max 5MB).');
  }
  const blocks: ContentBlock[] = [
    { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
    {
      type: 'text',
      text:
        'This image is source material for investment research (often a screenshot of a post, chart, article or slide). ' +
        'Extract ALL legible text verbatim. Then, if there are charts or figures, describe concisely what they show ' +
        '(assets, direction, magnitudes). Output plain text only, no preamble.',
    },
  ];
  const raw = await callClaude(blocks, { maxTokens: 1500 });
  if (raw.replace(/\s/g, '').length < 20) {
    throw new PublicError(422, 'source_unreadable', 'Could not read anything useful from that image.');
  }
  return { text: raw.trim(), label: 'screenshot (via vision)' };
}

// Voice notes arrive already normalized to 16 kHz mono WAV by the browser
// (spec §5.1), so only the two OpenRouter `input_audio` formats are accepted.
const AUDIO_FORMATS: Record<string, 'wav' | 'mp3'> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
};
// 10 min of 16 kHz mono 16-bit WAV ≈ 19 MB; a little headroom on top.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
// The default text model (Claude) takes no audio input — route to an
// audio-capable model on OpenRouter instead.
// `||`, not `??`: empty string means unset (see the model() note in llm.ts).
const audioModel = () => process.env.SIGNAL_AUDIO_MODEL || 'google/gemini-2.5-flash';

/** Voice note / audio file → verbatim transcript via an audio-capable model. */
export async function extractAudio(mediaType: string, base64Data: string): Promise<Extracted> {
  // hasOwn: a media_type like "constructor" must not resolve to a prototype member.
  const format = Object.hasOwn(AUDIO_FORMATS, mediaType) ? AUDIO_FORMATS[mediaType] : undefined;
  if (typeof base64Data !== 'string' || !format) {
    throw new PublicError(415, 'unsupported_media', 'Unsupported audio type. Send wav or mp3.');
  }
  if (Buffer.byteLength(base64Data, 'base64') > MAX_AUDIO_BYTES) {
    throw new PublicError(413, 'source_too_large', 'Audio too large (max about 10 minutes).');
  }
  const blocks: ContentBlock[] = [
    { type: 'audio', format, data: base64Data },
    {
      type: 'text',
      text:
        'This voice note is source material for investment research. Transcribe the speech verbatim, ' +
        'in its original language, as plain prose (no timestamps, no speaker labels unless there are ' +
        'clearly several speakers). Keep every company name, ticker, number and instruction exactly as ' +
        'spoken. Output the transcript only, no preamble. If there is no intelligible speech, output exactly: NOSPEECH',
    },
  ];
  const raw = await callClaude(blocks, { maxTokens: 8000, temperature: 0, model: audioModel() });
  if (/^\s*NOSPEECH/i.test(raw) || raw.replace(/\s/g, '').length < 10) {
    throw new PublicError(422, 'source_unreadable', 'Could not hear any speech in that recording.');
  }
  return { text: raw.trim().slice(0, 60_000), label: 'voice note (transcribed)' };
}
