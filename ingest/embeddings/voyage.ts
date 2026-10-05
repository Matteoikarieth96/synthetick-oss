import { env } from '../lib/env.js';
import { log, sleep } from '../lib/log.js';
import { supabase, type AssetRow } from '../lib/supabase.js';

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
export const EMBED_MODEL = 'voyage-3-lite'; // 512-dim (matches schema §3)
// ≤64 texts ≈ 8k tokens/call — stays under the base-tier 10k TPM cap (spec §4.3
// says 128; base-tier Voyage rejects that batch size, so default down).
const BATCH = Number(process.env.EMBED_BATCH ?? 64);
const EMBED_DIM = 512;

/** Voyage rejects the entire batch with HTTP 400 when any input is not clean
 * UTF-8. Two vendor-text hazards produce that: slicing a description mid-emoji
 * leaves a lone surrogate, and descriptions occasionally carry raw control
 * bytes. Both hit the live crypto ingest on 2026-07-28 (coins "Bermuda Shorts",
 * "Cod3x USD", "Big Pump"). Tabs and newlines are legitimate, so keep those. */
export function sanitizeEmbedText(s: string): string {
  return s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .trim();
}

/** Text embedded per asset (spec §4.3): name + kind + sector/categories +
 * ETF holdings/sector names + first 400 chars of description. Holdings enter
 * as NAMES only — company names carry the semantics; ticker symbols are
 * near-meaningless tokens to the embedding model and just burn TPM budget. */
export function buildEmbedText(a: Pick<AssetRow, 'name' | 'kind' | 'sector' | 'categories' | 'description' | 'etf_portfolio' | 'enrichment'>): string {
  const cats = (a.categories ?? []).slice(0, 12).join(', ');
  const desc = (a.description ?? '').slice(0, 400);
  const enrichment = (a.enrichment ?? '').trim().slice(0, 700); // thematic context (spec §4.3b)
  const holdings = (a.etf_portfolio?.top_holdings ?? [])
    .slice(0, 8)
    .map((h) => h.name || h.symbol)
    .filter(Boolean)
    .join(', ');
  const sectors = (a.etf_portfolio?.sector_weights ?? [])
    .slice(0, 6)
    .map((s) => s.name)
    .join(', ');
  return sanitizeEmbedText(
    [
      a.name,
      a.kind,
      a.sector ?? '',
      cats,
      holdings ? `ETF holdings: ${holdings}` : '',
      sectors ? `ETF sectors: ${sectors}` : '',
      desc,
      enrichment ? `Context: ${enrichment}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

interface VoyageResp {
  data: { embedding: number[]; index: number }[];
}

/** Embed a batch of texts (≤128) with voyage-3-lite. */
async function embedBatch(texts: string[]): Promise<number[][]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = await fetch(VOYAGE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.VOYAGE_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ input: texts, model: EMBED_MODEL, input_type: 'document' }),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`voyage HTTP ${res.status}`);
        // TPM limits reset per minute — honor Retry-After, else back off to ≥60s.
        const ra = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(2000 * 2 ** attempt, 65000);
        log.warn(`voyage HTTP ${res.status}, retry in ${wait}ms (attempt ${attempt + 1})`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        // A 4xx here means the request itself is wrong (bad key, bad input) —
        // it never becomes a 2xx, so fail now instead of burning eight backoffs
        // and ~4 minutes before reporting the same error.
        throw Object.assign(new Error(`voyage HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`), {
          fatal: true,
        });
      }
      const json = (await res.json()) as VoyageResp;
      // Preserve request order.
      const ordered = json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
      for (const e of ordered) {
        if (e.length !== EMBED_DIM) {
          throw new Error(`voyage returned dim ${e.length}, expected ${EMBED_DIM}`);
        }
      }
      return ordered;
    } catch (err) {
      if ((err as { fatal?: boolean }).fatal) throw err;
      lastErr = err;
      await sleep(Math.min(2000 * 2 ** attempt, 65000));
    }
  }
  throw new Error(`embedBatch failed: ${(lastErr as Error)?.message ?? String(lastErr)}`);
}

/** Ceiling for ONE query-embed request on the research path (review R3): a
 * half-open socket must not stall a run for the HTTP client's 5-minute default. */
const QUERY_TIMEOUT_MS = 30_000;

/** Embed a single retrieval query (thesis summary+themes) with input_type "query".
 * Retries 429/5xx like embedBatch — no-payment-method accounts get only 3 RPM.
 * `signal` is the run's cancellation signal (client gone): no further attempt. */
export async function embedQuery(text: string, signal?: AbortSignal): Promise<number[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (signal?.aborted) throw new Error('voyage query embed aborted: the run was cancelled');
    const timeout = AbortSignal.timeout(QUERY_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(VOYAGE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.VOYAGE_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ input: [text], model: EMBED_MODEL, input_type: 'query' }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      if (signal?.aborted) throw new Error('voyage query embed aborted: the run was cancelled');
      if (timeout.aborted) throw new Error(`voyage query embed timed out after ${QUERY_TIMEOUT_MS}ms`);
      throw err;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`voyage query embed HTTP ${res.status}`);
      const ra = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(2000 * 2 ** attempt, 65000);
      log.warn(`voyage query embed HTTP ${res.status}, retry in ${wait}ms (attempt ${attempt + 1})`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      // The response body can describe our vendor account (quota, plan, key
      // state): log it server-side, keep it out of the error that can reach a
      // client (security audit M4).
      log.warn(`voyage query embed HTTP ${res.status} body: ${(await res.text()).slice(0, 200)}`);
      throw new Error(`voyage query embed HTTP ${res.status}`);
    }
    const json = (await res.json()) as VoyageResp;
    const emb = json.data[0]?.embedding;
    if (!emb || emb.length !== EMBED_DIM) throw new Error(`voyage query embed bad dim ${emb?.length}`);
    return emb;
  }
  throw new Error(`embedQuery failed: ${(lastErr as Error)?.message ?? String(lastErr)}`);
}

export interface EmbedTarget {
  id: number;
  text: string;
}

// A single request above the 10k TPM cap can NEVER succeed (the limiter
// counts per minute, so it 429s through every retry and fails the run).
// Chunk by estimated tokens as well as count: ~4 chars/token, ~8k target.
const BATCH_CHAR_BUDGET = 32_000;

function* tokenAwareChunks(targets: EmbedTarget[]): Generator<EmbedTarget[]> {
  let chunk: EmbedTarget[] = [];
  let chars = 0;
  for (const t of targets) {
    if (chunk.length && (chunk.length >= BATCH || chars + t.text.length > BATCH_CHAR_BUDGET)) {
      yield chunk;
      chunk = [];
      chars = 0;
    }
    chunk.push(t);
    chars += t.text.length;
  }
  if (chunk.length) yield chunk;
}

/** HNSW inserts get slower as the index grows — a full 64-row statement can
 * trip Supabase's statement timeout once the table holds tens of thousands of
 * vectors (hit live at ~27k rows, 2026-07-10). Retry in smaller slices with
 * backoff; the upsert is idempotent so re-writing a succeeded slice is safe. */
async function upsertEmbeddingRows(rows: Record<string, unknown>[]): Promise<void> {
  let size = rows.length;
  for (let attempt = 0; ; attempt++) {
    try {
      for (let i = 0; i < rows.length; i += size) {
        const { error } = await supabase
          .from('asset_embeddings')
          .upsert(rows.slice(i, i + size), { onConflict: 'asset_id' });
        if (error) throw new Error(error.message);
      }
      return;
    } catch (err) {
      if (attempt >= 3) throw new Error(`asset_embeddings upsert failed: ${(err as Error).message}`);
      size = Math.max(4, Math.ceil(size / 4));
      log.warn(`asset_embeddings upsert error (${(err as Error).message}) — retrying in slices of ${size}`);
      await sleep(2000 * (attempt + 1));
    }
  }
}

/** Embed the given assets and upsert into asset_embeddings. Returns count embedded. */
export async function embedAssets(targets: EmbedTarget[]): Promise<number> {
  let done = 0;
  for (const chunk of tokenAwareChunks(targets)) {
    const vectors = await embedBatch(chunk.map((t) => t.text));
    const rows = chunk.map((t, j) => ({
      asset_id: t.id,
      embedding: vectors[j] as unknown as string, // pgvector accepts number[] serialized by supabase-js
      model: EMBED_MODEL,
      updated_at: new Date().toISOString(),
    }));
    await upsertEmbeddingRows(rows);
    done += chunk.length;
    log.info(`embedded ${done}/${targets.length}`);
  }
  return done;
}

/**
 * Return asset ids (of a source) that need embedding: no embedding row yet, or
 * the asset was updated more recently than its embedding (delta, spec §4.3).
 */
export async function findStaleEmbeddings(source: AssetRow['source']): Promise<Set<number>> {
  const stale = new Set<number>();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('assets')
      .select('id, updated_at, asset_embeddings(updated_at)')
      .eq('source', source)
      .eq('is_active', true)
      // Stable order: offset paging without ORDER BY can skip rows, and a
      // skipped row is a silently missed embedding (review R2).
      .order('id')
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`findStaleEmbeddings failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data as unknown as {
      id: number;
      updated_at: string;
      asset_embeddings: { updated_at: string } | { updated_at: string }[] | null;
    }[]) {
      const emb = Array.isArray(row.asset_embeddings) ? row.asset_embeddings[0] : row.asset_embeddings;
      if (!emb || new Date(row.updated_at) > new Date(emb.updated_at)) stale.add(row.id);
    }
    if (data.length < pageSize) break;
  }
  return stale;
}
