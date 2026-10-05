/** LLM call + JSON guard — via OpenRouter (spec §2, decision 2026-07-06).
 * OpenAI-compatible chat format; default model anthropic/claude-sonnet-4.6,
 * overridable with SIGNAL_LLM_MODEL. Web search uses OpenRouter's `:online`
 * model suffix; images travel as data-URL image_url parts. All keys stay
 * server-side (Edge Function secret in deployment — never the browser). */
import 'dotenv/config';
import { currentRunSignal, RunAbortedError } from './runsignal.js';

// Resolved per call so tests/tools can switch models at runtime.
// `||`, not `??`: a missing CI secret arrives as an empty string, and an empty
// model must never reach OpenRouter — it falls through to the account's
// default-model / auto-router, which is free to pick a frontier-priced model.
const model = () => process.env.SIGNAL_LLM_MODEL || 'anthropic/claude-sonnet-4.6';
/** App attribution sent to OpenRouter (HTTP-Referer). Forks set their own site
 * with OPENROUTER_REFERER so their calls are not attributed to synthetick.org. */
export const openRouterReferer = () => process.env.OPENROUTER_REFERER?.trim() || 'https://synthetick.org';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const LLM_TIMEOUT_MS = Number(process.env.SIGNAL_LLM_TIMEOUT_MS ?? 90_000);
const LLM_RETRIES = Number(process.env.SIGNAL_LLM_RETRIES ?? 1);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const transientStatus = (status: number) => status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
const transientMessage = (message: string) => /terminat|timed? out|timeout|overload|temporar|rate.?limit|try again|fetch failed|network|socket|econn/i.test(message);

export function requireOpenRouterKey(): string {
  const k = process.env.OPENROUTER_API_KEY;
  if (!k || !k.trim()) throw new Error('OPENROUTER_API_KEY missing (needed by /thesis, /select, /audit, /analysis, /extract)');
  return k.trim();
}

/** A content block for multimodal calls (text, base64 image, or base64 audio)
 * — internal shape, mapped to OpenAI-style parts on the wire. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'audio'; format: 'wav' | 'mp3'; data: string };

type WirePart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: 'wav' | 'mp3' } };

function toWire(user: string | ContentBlock[]): string | WirePart[] {
  if (typeof user === 'string') return user;
  return user.map((b): WirePart =>
    b.type === 'text'
      ? { type: 'text', text: b.text }
      : b.type === 'audio'
        ? { type: 'input_audio', input_audio: { data: b.data, format: b.format } }
        : {
            type: 'image_url',
            image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
          },
  );
}

export async function callClaude(
  user: string | ContentBlock[],
  opts: { system?: string; maxTokens?: number; web?: boolean; temperature?: number; model?: string } = {},
): Promise<string> {
  const messages: { role: 'system' | 'user'; content: string | WirePart[] }[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: toWire(user) });
  // Per-call override for calls the default model can't serve (audio input).
  const m = opts.model ?? model();
  const configuredRetries = Number.isFinite(LLM_RETRIES) ? Math.max(0, Math.min(3, Math.trunc(LLM_RETRIES))) : 1;
  const timeoutMs = Number.isFinite(LLM_TIMEOUT_MS) && LLM_TIMEOUT_MS >= 1_000 ? LLM_TIMEOUT_MS : 90_000;
  let lastError: Error | undefined;
  // The run's own cancellation signal (review R12): a disconnected client
  // aborts the in-flight request, and no further attempt is made.
  const runSignal = currentRunSignal();
  for (let attempt = 0; attempt <= configuredRetries; attempt++) {
    if (runSignal?.aborted) throw new RunAbortedError();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        signal: runSignal ? AbortSignal.any([controller.signal, runSignal]) : controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${requireOpenRouterKey()}`,
          // OpenRouter derives app attribution from HTTP-Referer only; without
          // it our calls show as app "Unknown" in the dashboard logs.
          'http-referer': openRouterReferer(),
          'x-title': 'SyntheTick',
        },
        body: JSON.stringify({
          // `:online` = OpenRouter's built-in web search (v3's YouTube path).
          model: opts.web ? `${m}:online` : m,
          max_tokens: opts.maxTokens ?? 1500,
          // Structured extraction/rerank calls pass a low temperature (spec §5.3):
          // at the default 1.0 the rerank was observed dropping a thesis's own
          // named asset run-to-run. Prose calls omit it and keep the default.
          ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
          messages,
          // Always-thinking models (Gemini 2.5, OpenAI o-series) burn max_tokens
          // on hidden reasoning and truncate the visible JSON — cap the thinking
          // budget. Not sent to others (it would needlessly ENABLE reasoning).
          ...(/gemini-2\.5|gemini.*thinking|^openai\/o\d/.test(m)
            ? { reasoning: { max_tokens: 1024 } }
            : {}),
        }),
      });
      if (!res.ok) {
        const message = `OpenRouter API ${res.status}: ${(await res.text()).slice(0, 200)}`;
        if (attempt < configuredRetries && transientStatus(res.status)) {
          lastError = new Error(message);
          await wait(500 * (attempt + 1));
          continue;
        }
        throw new Error(message);
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string | { type: string; text?: string }[] } }[];
        error?: { message?: string };
      };
      if (data.error?.message) {
        const message = `OpenRouter: ${data.error.message.slice(0, 200)}`;
        if (attempt < configuredRetries && transientMessage(message)) {
          lastError = new Error(message);
          await wait(500 * (attempt + 1));
          continue;
        }
        throw new Error(message);
      }
      const content = data.choices?.[0]?.message?.content;
      if (typeof content === 'string') return content.trim();
      if (Array.isArray(content)) {
        return content
          .filter((p) => p.type === 'text')
          .map((p) => p.text ?? '')
          .join('\n')
          .trim();
      }
      throw new Error('OpenRouter: empty completion');
    } catch (error) {
      // A cancelled run is final: never retried, never reported as a timeout.
      if (runSignal?.aborted) throw new RunAbortedError();
      const err = error as Error;
      const timedOut = err.name === 'AbortError';
      const wrapped = timedOut ? new Error(`OpenRouter request timed out after ${timeoutMs}ms`) : err;
      if (attempt < configuredRetries && (timedOut || transientMessage(wrapped.message))) {
        lastError = wrapped;
        await wait(500 * (attempt + 1));
        continue;
      }
      throw wrapped;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError ?? new Error('OpenRouter request failed after retry');
}

/** First balanced JSON value in the text (string- and escape-aware) — the
 * fallback for model output shaped `{…}\n\nNote: I flagged [X] because…`,
 * where trimming to the LAST bracket keeps the trailing prose. */
function firstBalancedJSON(t: string): string | null {
  const start = t.search(/[[{]/);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return t.slice(start, i + 1);
    }
  }
  return null;
}

/** Escape double quotes that sit INSIDE string values — the model quoted
 * source text verbatim (`{"REMX":"…targets "ETFs focused on…" and…"}`),
 * which is invalid JSON no other repair can save. Heuristic: an unescaped
 * quote only CLOSES a string when the next non-space char is a JSON
 * delimiter (`:` `,` `}` `]`) or end of input; any other quote is content. */
function escapeInnerQuotes(t: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (!inStr) {
      if (c === '"') inStr = true;
      out += c;
    } else if (c === '\\') {
      out += c + (t[i + 1] ?? '');
      i++;
    } else if (c === '"') {
      let j = i + 1;
      while (j < t.length && /\s/.test(t[j] ?? '')) j++;
      const n = t[j];
      if (n === undefined || n === ':' || n === ',' || n === '}' || n === ']') {
        inStr = false;
        out += c;
      } else {
        out += '\\"';
      }
    } else {
      out += c;
    }
  }
  return out;
}

/** v3 parseJSON + repair pass: strip fences, trim to the outermost JSON
 * payload, and fix common model slips (leading-dot decimals like `"s":.78`,
 * trailing commas) before parsing; when the payload is followed by prose
 * that itself contains brackets, fall back to the first balanced value. */
export function parseJSON<T = unknown>(text: string): T {
  const repair = (s: string) =>
    s
      .replace(/([:[,]\s*)\.(\d)/g, '$10.$2') // .78 → 0.78
      .replace(/,\s*([}\]])/g, '$1'); // trailing commas
  let t = (text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const a = t.search(/[[{]/);
  if (a > 0) t = t.slice(a);
  const lastCurly = t.lastIndexOf('}');
  const lastSq = t.lastIndexOf(']');
  const end = Math.max(lastCurly, lastSq);
  if (end >= 0) t = t.slice(0, end + 1);
  const balanced = firstBalancedJSON(t);
  const candidates = [
    t,
    repair(t),
    ...(balanced ? [balanced, repair(balanced)] : []),
    // Last resort: unescaped quotes inside string values (model quoted the
    // thesis verbatim). Runs after the plain candidates so valid JSON is
    // never touched, and a wrong guess just falls through to the error.
    escapeInnerQuotes(t),
    repair(escapeInnerQuotes(repair(t))),
  ];
  for (const c of candidates) {
    try {
      return JSON.parse(c) as T;
    } catch {
      /* try the next candidate */
    }
  }
  // Every candidate failed → the model answered in prose, not JSON. V8's own
  // parse error quotes whatever bracketed fragment the trimming kept (a stray
  // "[assets]" mid-sentence once read like a request-parameter bug), so
  // surface the model's actual words instead.
  const raw = (text || '').trim().replace(/\s+/g, ' ');
  throw new Error(`Model returned non-JSON output: "${raw.slice(0, 160)}${raw.length > 160 ? '…' : ''}"`);
}
