/**
 * X video → transcript for the bot.
 *
 * X returns playback variants, not an audio transcript. We deliberately use
 * the smallest MP4 variant because every rendition carries the same spoken
 * audio, then normalize it to the WAV format accepted by extractAudio().
 *
 * Third-party media is untrusted input (final audit L8): the download follows
 * no redirect it has not checked against X's media CDN first, and ffmpeg reads
 * only the local file (`-protocol_whitelist file`) with the container forced
 * to MP4 (`-f mp4`), so a crafted file cannot make it open URLs or pick an
 * exotic demuxer. FFMPEG_PATH selects a system ffmpeg (distro package, updated
 * by the OS) instead of the binary ffmpeg-static downloads at install time.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import ffmpegStaticPath from 'ffmpeg-static';
import { extractAudio } from '../runtime/extract.js';
import type { XMedia, XMediaVariant } from './x-api.js';

const execFileAsync = promisify(execFile);
const MAX_VIDEO_BYTES = 60 * 1024 * 1024;
const MAX_VIDEO_DURATION_MS = 10 * 60 * 1000;
const MAX_WAV_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 3;

/** The ffmpeg binary: FFMPEG_PATH (an absolute path to a system ffmpeg) when set, else ffmpeg-static's. */
export function ffmpegBinary(env: Record<string, string | undefined> = process.env): string | null {
  const custom = env.FFMPEG_PATH?.trim();
  if (custom) {
    if (!isAbsolute(custom)) throw new Error('FFMPEG_PATH must be an absolute path to an ffmpeg binary');
    return custom;
  }
  return ffmpegStaticPath ?? null;
}

/** ffmpeg arguments: local file input only, MP4 container forced, 16 kHz mono 16-bit WAV out. */
export function ffmpegArgs(input: string, output: string): string[] {
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    // Input options: read nothing but the local file, as an MP4 container.
    '-protocol_whitelist',
    'file',
    '-f',
    'mp4',
    '-i',
    input,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    '-f',
    'wav',
    output,
  ];
}

function isTrustedXVideoUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && (url.hostname === 'video.twimg.com' || url.hostname.endsWith('.twimg.com'));
  } catch {
    return false;
  }
}

/** Prefer the cheapest-to-download MP4; picture quality does not affect STT. */
export function selectSpeechVariant(variants: XMediaVariant[]): XMediaVariant | null {
  return (
    variants
      .filter((v) => v.content_type === 'video/mp4' && isTrustedXVideoUrl(v.url))
      .sort((a, b) => (a.bit_rate ?? Number.MAX_SAFE_INTEGER) - (b.bit_rate ?? Number.MAX_SAFE_INTEGER))[0] ??
    null
  );
}

/**
 * GET a video, following redirects by hand: every hop is checked against X's
 * media CDN BEFORE it is requested (fetch's own redirect handling would have
 * requested the target first and been checked only afterwards).
 */
async function fetchTrusted(url: string, signal: AbortSignal): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isTrustedXVideoUrl(current)) {
      throw new Error(hop === 0 ? 'X returned an untrusted video URL' : 'X video redirected outside its media CDN');
    }
    const res = await fetch(current, { signal, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(res.status)) return res;
    const location = res.headers.get('location');
    await res.body?.cancel().catch(() => {});
    if (!location) throw new Error(`X video redirect without a location (HTTP ${res.status})`);
    current = new URL(location, current).href;
  }
  throw new Error('X video redirected too many times');
}

export async function downloadBounded(url: string): Promise<Buffer> {
  const res = await fetchTrusted(url, AbortSignal.timeout(45_000));
  if (!res.ok) throw new Error(`X video download failed (HTTP ${res.status})`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_VIDEO_BYTES) throw new Error('X video is too large to transcribe (max 60 MB)');
  if (!res.body) throw new Error('X video download returned no body');

  const chunks: Buffer[] = [];
  const reader = res.body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_VIDEO_BYTES) {
        await reader.cancel();
        throw new Error('X video is too large to transcribe (max 60 MB)');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/** Download, demux/transcode, and transcribe one X video attachment. */
export async function transcribeXVideo(media: XMedia): Promise<string> {
  if (media.type !== 'video') throw new Error(`unsupported X media type ${media.type}`);
  if (media.duration_ms != null && media.duration_ms > MAX_VIDEO_DURATION_MS) {
    throw new Error('X video is longer than the 10-minute transcription limit');
  }
  const variant = selectSpeechVariant(media.variants ?? []);
  if (!variant) throw new Error('X video has no downloadable MP4 variant');
  const ffmpeg = ffmpegBinary();
  if (!ffmpeg) throw new Error('no ffmpeg binary: set FFMPEG_PATH or install ffmpeg-static');

  const video = await downloadBounded(variant.url);
  const dir = await mkdtemp(join(tmpdir(), 'synthetick-x-video-'));
  const input = join(dir, 'source.mp4');
  const output = join(dir, 'speech.wav');
  try {
    await writeFile(input, video);
    await execFileAsync(ffmpeg, ffmpegArgs(input, output), { timeout: 90_000, maxBuffer: 1024 * 1024 });
    const wav = await readFile(output);
    if (wav.byteLength > MAX_WAV_BYTES) throw new Error('transcoded X video audio is too large');
    const extracted = await extractAudio('audio/wav', wav.toString('base64'));
    return extracted.text;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
