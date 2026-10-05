/**
 * Resumable archiving tool for FMP bulk, ETF and price-history endpoints (spec §17).
 * Use it only if your FMP plan and license allow you to store the data.
 *
 *   bulk    — every whole-market bulk CSV family, raw and gzipped, including
 *             the annual ratios/key-metrics/growth files back to 2015
 *             (whole-market historical fundamentals in ~50 calls).
 *   etf     — etf/info + holdings + sector-weightings + country-weightings
 *             per active ETF/bond-ETF, one JSON per fund.
 *   history — per-symbol EOD closes since ARCHIVE_HISTORY_FROM (default
 *             2010-01-01) plus dividend and split events (split events let us
 *             adjust our never-split-adjusted closes ourselves later).
 *   upload  — sync the local directory to a private storage bucket (ARCHIVE_BUCKET).
 *
 * Everything lands under fmp-archive/ (gitignored) with a manifest.jsonl
 * audit trail. Every phase is resumable: existing files are skipped, so an
 * interrupted run picks up where it stopped. Re-running after a partial
 * failure retries only what's missing.
 *
 * Bulk constraints inherited from run-metrics (spec §15.2, learned live):
 * calls spaced ARCHIVE_BULK_GAP_MS apart (shared coarse limiter), `part`
 * walked until HTTP 400 (terminal, not retryable), some errors arrive as
 * HTTP 200 with a JSON body so the first bytes are sniffed before saving.
 *
 * Run: npm run archive:fmp [-- bulk|etf|history|upload|all]
 */
import { createHash } from 'node:crypto';
import { createGzip, gzipSync } from 'node:zlib';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { requireFmp } from './lib/env.js';
import { fetchJson } from './lib/http.js';
import { fmpLimiter } from './lib/ratelimit.js';
import { supabase } from './lib/supabase.js';
import { log, sleep } from './lib/log.js';

const BASE = 'https://financialmodelingprep.com/stable';
const DIR = path.resolve(process.env.ARCHIVE_DIR ?? 'fmp-archive');
const BULK_GAP_MS = Number(process.env.ARCHIVE_BULK_GAP_MS ?? 12_000);
const HIST_FROM = process.env.ARCHIVE_HISTORY_FROM ?? '2010-01-01';
const CONCURRENCY = Number(process.env.ARCHIVE_CONCURRENCY ?? 6);
/** 0 = whole universe; small values for smoke tests. */
const LIMIT = Number(process.env.ARCHIVE_LIMIT ?? 0);
/** Annual bulk families are pulled for FY YEAR_FROM..YEAR_TO. */
const YEAR_FROM = Number(process.env.ARCHIVE_YEAR_FROM ?? 2015);
const YEAR_TO = Number(process.env.ARCHIVE_YEAR_TO ?? 2025);
const BUCKET = process.env.ARCHIVE_BUCKET ?? 'fmp-archive';

const key = requireFmp();

// ---------------------------------------------------------------- manifest

function manifest(entry: Record<string, unknown>): void {
  appendFileSync(
    path.join(DIR, 'manifest.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n',
  );
}

/** Strip the API key from a URL before it lands in logs or the manifest. */
function redact(url: string): string {
  return url.replace(/apikey=[^&]+/, 'apikey=***');
}

// ---------------------------------------------------- streaming CSV download

interface DlResult {
  status: 'saved' | 'skipped' | 'terminal' | 'failed';
  bytes?: number;
  sha256?: string;
  note?: string;
}

/**
 * Download one bulk CSV to `dest` (gzipped), sniffing the first bytes: FMP
 * delivers some errors as HTTP 200 with a JSON body, and saving one of those
 * as a "CSV" would silently poison the archive. The sha256 is of the raw
 * (uncompressed) bytes so pages can be compared for no-op pagination.
 */
async function downloadCsv(url: string, dest: string, label: string): Promise<DlResult> {
  if (existsSync(dest)) return { status: 'skipped' };
  const attempts = 4;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(900_000) });
      if (res.status === 400) {
        // End of a paged family announces itself as HTTP 400 — terminal.
        await res.text().catch(() => '');
        return { status: 'terminal', note: 'HTTP 400' };
      }
      if (res.status === 429 || res.status >= 500) {
        await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => '');
        return { status: 'failed', note: `HTTP ${res.status}: ${body.slice(0, 120)}` };
      }
      const reader = res.body.getReader();
      let first = await reader.read();
      while (!first.done && first.value.length === 0) first = await reader.read();
      if (first.done || !first.value) return { status: 'failed', note: 'empty response' };
      const head = Buffer.from(first.value.slice(0, 64)).toString('utf8').trimStart();
      if (head.startsWith('{') || head.startsWith('[')) {
        // JSON error in CSV clothing — collect a snippet, then retry.
        const chunks = [Buffer.from(first.value)];
        for (let i = 0; i < 4; i++) {
          const n = await reader.read();
          if (n.done || !n.value) break;
          chunks.push(Buffer.from(n.value));
        }
        await reader.cancel().catch(() => {});
        throw new Error(`JSON body: ${Buffer.concat(chunks).toString('utf8').slice(0, 160)}`);
      }
      const tmp = dest + '.tmp';
      const gz = createGzip({ level: 6 });
      const sinkDone = pipeline(gz, createWriteStream(tmp));
      const hash = createHash('sha256');
      let bytes = 0;
      const write = async (buf: Uint8Array) => {
        hash.update(buf);
        bytes += buf.length;
        if (!gz.write(buf)) await new Promise((r) => gz.once('drain', r));
      };
      await write(first.value);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) await write(value);
      }
      gz.end();
      await sinkDone;
      renameSync(tmp, dest);
      return { status: 'saved', bytes, sha256: hash.digest('hex') };
    } catch (err) {
      if (attempt === attempts) return { status: 'failed', note: (err as Error).message };
      const wait = 30_000 * attempt;
      log.warn(`${label}: ${(err as Error).message} — retry in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  return { status: 'failed', note: 'unreachable' };
}

/** Download one family file with the shared bulk gap and a manifest entry. */
async function grabBulk(name: string, url: string): Promise<DlResult> {
  const dest = path.join(DIR, 'bulk', `${name}.csv.gz`);
  const r = await downloadCsv(url, dest, name);
  if (r.status !== 'skipped') {
    manifest({ phase: 'bulk', file: `bulk/${name}.csv.gz`, url: redact(url), ...r });
    log[r.status === 'saved' ? 'info' : 'warn'](
      `${name}: ${r.status}${r.bytes ? ` (${(r.bytes / 1e6).toFixed(1)} MB raw)` : ''}${r.note ? ` — ${r.note}` : ''}`,
    );
    await sleep(BULK_GAP_MS);
  } else {
    log.info(`${name}: already archived, skipping`);
  }
  return r;
}

/**
 * Walk a paged family upward until HTTP 400 (terminal), an empty page, or a
 * page byte-identical to the previous one (`part` is a no-op on some
 * families — profile-bulk paginates for real, ratios-ttm-bulk doesn't).
 */
async function grabBulkParts(name: string, urlFor: (part: number) => string): Promise<void> {
  let prevSha: string | null = null;
  for (let part = 0; part < 30; part++) {
    const file = `${name}.part${part}`;
    const dest = path.join(DIR, 'bulk', `${file}.csv.gz`);
    const r = await downloadCsv(urlFor(part), dest, file);
    if (r.status === 'skipped') {
      log.info(`${file}: already archived, skipping`);
      prevSha = null; // can't compare across runs; the 400 wall still terminates
      continue;
    }
    manifest({ phase: 'bulk', file: `bulk/${file}.csv.gz`, url: redact(urlFor(part)), ...r });
    if (r.status === 'terminal') {
      log.info(`${name}: part ${part} → HTTP 400, family complete`);
      break;
    }
    if (r.status === 'failed') {
      log.warn(`${file}: failed — ${r.note}; stopping this family (re-run resumes here)`);
      break;
    }
    if (prevSha && r.sha256 === prevSha) {
      rmSync(dest);
      log.info(`${name}: part ${part} identical to part ${part - 1} — single-page family`);
      break;
    }
    if ((r.bytes ?? 0) < 64) {
      rmSync(dest);
      log.info(`${name}: part ${part} empty, family complete`);
      break;
    }
    log.info(`${file}: saved (${((r.bytes ?? 0) / 1e6).toFixed(1)} MB raw)`);
    prevSha = r.sha256 ?? null;
    await sleep(BULK_GAP_MS);
  }
}

async function phaseBulk(): Promise<void> {
  log.step('Phase bulk: whole-market CSV families');
  mkdirSync(path.join(DIR, 'bulk'), { recursive: true });

  for (const name of ['ratios-ttm-bulk', 'key-metrics-ttm-bulk', 'scores-bulk']) {
    await grabBulk(name, `${BASE}/${name}?apikey=${key}`);
  }
  for (const name of [
    'profile-bulk',
    'rating-bulk',
    'price-target-summary-bulk',
    'upgrades-downgrades-consensus-bulk',
  ]) {
    await grabBulkParts(name, (part) => `${BASE}/${name}?part=${part}&apikey=${key}`);
  }
  // Annual whole-market fundamentals: ratios + key metrics + the two growth
  // files per fiscal year. ~44 calls for a decade of history the nightly
  // ingest never kept.
  for (let year = YEAR_TO; year >= YEAR_FROM; year--) {
    for (const name of ['ratios-bulk', 'key-metrics-bulk', 'income-statement-growth-bulk', 'cash-flow-statement-growth-bulk']) {
      await grabBulk(`${name}.${year}.FY`, `${BASE}/${name}?year=${year}&period=FY&apikey=${key}`);
    }
  }
  // Latest full trading session as a cross-check snapshot (eod-bulk refuses
  // back-to-back dates, so exactly one date, walking back over non-sessions).
  for (let back = 1; back <= 7; back++) {
    const date = new Date(Date.now() - back * 86400_000).toISOString().slice(0, 10);
    const r = await grabBulk(`eod-bulk.${date}`, `${BASE}/eod-bulk?date=${date}&apikey=${key}`);
    if (r.status === 'skipped' || (r.status === 'saved' && (r.bytes ?? 0) > 50_000)) break;
    if (r.status === 'saved') rmSync(path.join(DIR, 'bulk', `eod-bulk.${date}.csv.gz`)); // holiday stub
  }
  log.step('Phase bulk done');
}

// ------------------------------------------------------------------ assets

interface Target {
  id: number;
  vendor_id: string;
}

async function loadTargets(kinds: string[]): Promise<Target[]> {
  const out: Target[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from('assets')
      .select('id, vendor_id, market_cap_usd')
      .eq('is_active', true)
      .eq('source', 'fmp')
      .in('kind', kinds)
      // Biggest first: an interrupted run leaves the most-queried names done.
      .order('market_cap_usd', { ascending: false, nullsFirst: false })
      // Unique tiebreaker: equal and null caps have no stable order, so offset
      // pages could skip or repeat those rows (review R2).
      .order('id')
      .range(from, from + page - 1);
    if (error) throw new Error(`loadTargets failed: ${error.message}`);
    if (!data?.length) break;
    out.push(...data.map((r) => ({ id: r.id as number, vendor_id: r.vendor_id as string })));
    if (data.length < page) break;
  }
  return LIMIT > 0 ? out.slice(0, LIMIT) : out;
}

async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

/** vendor_id → safe filename (BRK-B, 0700.HK, ^GSPC all pass through fine). */
function fileFor(sub: string, vendorId: string): string {
  return path.join(DIR, sub, `${vendorId.replace(/[^A-Za-z0-9._^-]/g, '_')}.json.gz`);
}

function writeJsonGz(dest: string, obj: unknown): number {
  const buf = gzipSync(Buffer.from(JSON.stringify(obj)), { level: 6 });
  writeFileSync(dest, buf);
  return buf.length;
}

// --------------------------------------------------------------------- etf

async function phaseEtf(): Promise<void> {
  log.step('Phase etf: composition per active ETF/bond ETF');
  mkdirSync(path.join(DIR, 'etf'), { recursive: true });
  const targets = await loadTargets(['etf', 'bond']);
  const todo = targets.filter((t) => !existsSync(fileFor('etf', t.vendor_id)));
  log.info(`${targets.length} funds, ${targets.length - todo.length} already archived, ${todo.length} to fetch`);

  let done = 0;
  let failed = 0;
  await runPool(todo, CONCURRENCY, async (t) => {
    const sym = encodeURIComponent(t.vendor_id);
    const calls: [string, string][] = [
      ['info', `${BASE}/etf/info?symbol=${sym}&apikey=${key}`],
      ['holdings', `${BASE}/etf/holdings?symbol=${sym}&apikey=${key}`],
      ['sectorWeightings', `${BASE}/etf/sector-weightings?symbol=${sym}&apikey=${key}`],
      ['countryWeightings', `${BASE}/etf/country-weightings?symbol=${sym}&apikey=${key}`],
    ];
    const out: Record<string, unknown> = { symbol: t.vendor_id, fetchedAt: new Date().toISOString() };
    const errors: Record<string, string> = {};
    let anyOk = false;
    for (const [field, url] of calls) {
      try {
        await fmpLimiter.wait();
        out[field] = await fetchJson(url, { label: `etf/${field} ${t.vendor_id}`, retries: 2 });
        anyOk = true;
      } catch (err) {
        out[field] = null;
        errors[field] = (err as Error).message.slice(0, 200);
      }
    }
    if (!anyOk) {
      // Nothing answered — leave no file so a re-run retries this fund.
      failed++;
      manifest({ phase: 'etf', symbol: t.vendor_id, status: 'failed', errors });
      return;
    }
    if (Object.keys(errors).length) out.errors = errors;
    writeJsonGz(fileFor('etf', t.vendor_id), out);
    done++;
    if (done % 100 === 0) log.info(`…${done}/${todo.length} funds`);
  });
  manifest({ phase: 'etf', status: 'done', fetched: done, failed, total: targets.length });
  log.step(`Phase etf done — ${done} archived, ${failed} failed`);
}

// ----------------------------------------------------------------- history

async function endpointAnswers(name: string): Promise<boolean> {
  try {
    await fmpLimiter.wait();
    await fetchJson(`${BASE}/${name}?symbol=AAPL&apikey=${key}`, { label: `probe ${name}`, retries: 1 });
    return true;
  } catch (err) {
    log.warn(`${name} endpoint unavailable, skipping it for this run: ${(err as Error).message.slice(0, 120)}`);
    return false;
  }
}

async function phaseHistory(): Promise<void> {
  log.step(`Phase history: per-symbol EOD since ${HIST_FROM} + dividends + splits`);
  mkdirSync(path.join(DIR, 'history'), { recursive: true });
  const targets = await loadTargets(['stock', 'etf', 'bond']);
  const todo = targets.filter((t) => !existsSync(fileFor('history', t.vendor_id)));
  log.info(`${targets.length} assets, ${targets.length - todo.length} already archived, ${todo.length} to fetch`);
  if (!todo.length) return;

  // Splits matter beyond bookkeeping: no FMP price endpoint serves
  // split-adjusted closes (spec §15.2), so archived split events are what
  // makes the archived closes adjustable later.
  const withDividends = await endpointAnswers('dividends');
  const withSplits = await endpointAnswers('splits');

  let done = 0;
  let failed = 0;
  await runPool(todo, CONCURRENCY, async (t) => {
    const sym = encodeURIComponent(t.vendor_id);
    try {
      await fmpLimiter.wait();
      const eod = await fetchJson<unknown[]>(
        `${BASE}/historical-price-eod/light?symbol=${sym}&from=${HIST_FROM}&apikey=${key}`,
        { label: `hist eod ${t.vendor_id}`, retries: 2 },
      );
      const out: Record<string, unknown> = {
        symbol: t.vendor_id,
        from: HIST_FROM,
        fetchedAt: new Date().toISOString(),
        eod,
      };
      const errors: Record<string, string> = {};
      for (const [field, name, enabled] of [
        ['dividends', 'dividends', withDividends],
        ['splits', 'splits', withSplits],
      ] as const) {
        if (!enabled) continue;
        try {
          await fmpLimiter.wait();
          out[field] = await fetchJson(`${BASE}/${name}?symbol=${sym}&apikey=${key}`, {
            label: `${name} ${t.vendor_id}`,
            retries: 1,
          });
        } catch (err) {
          out[field] = null;
          errors[field] = (err as Error).message.slice(0, 200);
        }
      }
      if (Object.keys(errors).length) out.errors = errors;
      writeJsonGz(fileFor('history', t.vendor_id), out);
      done++;
    } catch (err) {
      // No file written — a re-run retries this symbol.
      failed++;
      log.warn(`skip ${t.vendor_id}: ${(err as Error).message.slice(0, 160)}`);
    }
    if (done % 500 === 0 && done) log.info(`…${done}/${todo.length} symbols`);
  });
  manifest({ phase: 'history', status: 'done', fetched: done, failed, total: targets.length, from: HIST_FROM });
  log.step(`Phase history done — ${done} archived, ${failed} failed`);
}

// ------------------------------------------------------------------ upload

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...walkFiles(abs));
    else if (!abs.endsWith('.tmp')) out.push(abs);
  }
  return out;
}

async function phaseUpload(): Promise<void> {
  log.step(`Phase upload: sync ${DIR} → storage bucket ${BUCKET}`);
  const { error: bucketErr } = await supabase.storage.createBucket(BUCKET, { public: false });
  if (bucketErr && !/already exists/i.test(bucketErr.message)) {
    throw new Error(`createBucket ${BUCKET} failed: ${bucketErr.message}`);
  }
  const files = walkFiles(DIR);
  log.info(`${files.length} local files to sync`);
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  await runPool(files, 5, async (abs) => {
    const rel = path.relative(DIR, abs).split(path.sep).join('/');
    const { error } = await supabase.storage.from(BUCKET).upload(rel, readFileSync(abs), {
      contentType: rel.endsWith('.gz') ? 'application/gzip' : 'application/json',
      upsert: rel === 'manifest.jsonl', // manifest grows; data files are immutable
    });
    if (!error) uploaded++;
    else if (/already exists|duplicate/i.test(error.message)) skipped++;
    else {
      failed++;
      log.warn(`upload ${rel}: ${error.message}`);
    }
    if ((uploaded + skipped) % 1000 === 0 && uploaded + skipped > 0) {
      log.info(`…${uploaded + skipped}/${files.length} synced`);
    }
  });
  log.step(`Phase upload done — ${uploaded} uploaded, ${skipped} already present, ${failed} failed`);
}

// -------------------------------------------------------------------- main

async function main(): Promise<void> {
  const phase = process.argv[2] ?? 'all';
  mkdirSync(DIR, { recursive: true });
  const started = Date.now();
  log.step(`FMP archive → ${DIR} (phase: ${phase})`);

  if (phase === 'bulk' || phase === 'all') await phaseBulk();
  if (phase === 'etf' || phase === 'all') await phaseEtf();
  if (phase === 'history' || phase === 'all') await phaseHistory();
  if (phase === 'upload') await phaseUpload();
  if (!['bulk', 'etf', 'history', 'upload', 'all'].includes(phase)) {
    throw new Error(`unknown phase "${phase}" — use bulk | etf | history | upload | all`);
  }
  log.step(`Archive run finished in ${Math.round((Date.now() - started) / 1000)}s`);
}

main().catch((err) => {
  log.error(`archive failed: ${(err as Error).message}`);
  process.exit(1);
});
