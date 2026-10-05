/**
 * SyntheTick /v1/screen client — universe mode.
 *
 * POST {base}/v1/screen {thesis, universe:"robinhood"} with an stk_ API key,
 * then read the SSE stream (status / credits / result / error, ": hb"
 * heartbeats) until the result event. A screen takes minutes and costs one
 * SyntheTick credit; a failed run refunds server-side.
 */
import { requireSecret } from "./settings.js";

/** The Sailor runner ticks strictly one after another, so a request that never
 * answers would freeze the agent for good (no plan draining, no exits). Every
 * call is bounded. A screen normally takes 1-3 minutes and streams a heartbeat
 * every 20s; the ceiling covers slow runs with room to spare. */
export const CREDITS_TIMEOUT_MS = 20_000;
export const SCREEN_TIMEOUT_MS = 15 * 60_000;

export interface ScreenPick {
  ticker: string;
  name: string;
  kind: string;
  score: number;
  dir: "long" | "short";
  why: string;
  token?: { address: string; chainId: number; decimals: number } | null;
}

export interface ScreenResult {
  thesis: { title?: string } & Record<string, unknown>;
  universe: { name: string; chainId: number } | null;
  picks: ScreenPick[];
}

/**
 * GET /v1/me — today's remaining credit balance for the API key.
 * Returns null when the server runs open (no auth bound, e.g. local dev).
 */
export async function fetchCredits(baseUrl: string): Promise<number | null> {
  const key = requireSecret("SYNTHETICK_API_KEY");
  const res = await fetch(`${baseUrl}/v1/me`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(CREDITS_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`SyntheTick /v1/me HTTP ${res.status}`);
  const json = (await res.json()) as { credits?: number | null };
  return json.credits ?? null;
}

export async function runScreen(
  baseUrl: string,
  thesisText: string,
  log: (m: string) => void,
): Promise<ScreenResult> {
  const key = requireSecret("SYNTHETICK_API_KEY");
  const res = await fetch(`${baseUrl}/v1/screen`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ thesis: thesisText, universe: "robinhood" }),
    // Also bounds the stream reads below: the body aborts with the request.
    signal: AbortSignal.timeout(SCREEN_TIMEOUT_MS),
  });
  if (res.status === 402) throw new Error("SyntheTick: out of credits (402)");
  if (!res.ok || !res.body) throw new Error(`SyntheTick /v1/screen HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: ScreenResult | null = null;
  let error: string | null = null;

  const handleBlock = (block: string) => {
    let event = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7).trim();
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    if (!event) return; // heartbeat comment
    if (event === "status") log(`screen: ${JSON.parse(data)}`);
    else if (event === "result") result = JSON.parse(data) as ScreenResult;
    else if (event === "error") error = String(JSON.parse(data)?.error ?? data);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      handleBlock(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
    }
  }
  if (buffer.trim()) handleBlock(buffer);

  if (error) throw new Error(`SyntheTick screen failed: ${error}`);
  if (!result) throw new Error("SyntheTick screen stream ended without a result event");
  const r: ScreenResult = result;
  log(`screen: ${r.picks.length} picks`);
  return r;
}
