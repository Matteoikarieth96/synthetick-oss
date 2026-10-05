/**
 * MCP server (spec §13): a stateless Streamable-HTTP endpoint at POST /mcp on
 * the same Node server, authenticated with the same API keys as /v1. Each
 * request gets a fresh McpServer + transport pair (no sessions to manage);
 * the run itself happens in-process via the shared performRun, so there is no
 * HTTP hop and no extra timeout to reason about.
 *
 * Tools: run_screen (1 credit, streams §5.7 status lines as notifications),
 * get_credits (free peek at today's balance).
 */
import type http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { log } from '../ingest/lib/log.js';
import { chargeFirst, spendCredit, type AuthedUser, type SpendResult } from './auth.js';
import { performRun, buildScreenInput, OutOfCreditsError } from './run.js';
import { runFailureMessage, runFailureNotes, withRunFailureNotes } from '../runtime/errors.js';
import { RunAbortedError, withRunSignal } from '../runtime/runsignal.js';
import { screenFields, MAX_SCREEN_THESIS_CHARS } from './validate.js';
import { assertRunSlotAvailable, consume } from './ratelimit.js';

const err = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });
const ok = (payload: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(payload) }] });

function buildServer(user: AuthedUser | null): McpServer {
  const server = new McpServer(
    { name: 'synthetick', version: '0.4.0' },
    { capabilities: { logging: {} } },
  );

  server.registerTool(
    'run_screen',
    {
      title: 'Run a SyntheTick screen',
      description:
        'Screen the market against an investment thesis: stocks, ETFs, bond ETFs, crypto, selected pre-IPO companies and prediction markets. ' +
        'Returns up to 10 matched assets ranked by thesis alignment, each with its rationale and analysis. ' +
        'Market data is included only when the server operator has the data rights to relay it; otherwise market is null and market_note says why. ' +
        'Costs 1 credit from the daily budget and usually takes 1 to 3 minutes. Constraints are binding filters; constraints written in the thesis text itself are honored too.',
      // Enums come from server/validate.ts, the same definitions /v1/screen
      // validates against, so REST and MCP cannot drift apart.
      inputSchema: {
        thesis: z
          .string()
          .min(8)
          .max(MAX_SCREEN_THESIS_CHARS)
          .describe('The investment thesis: a few sentences describing the investment case.'),
        assets: screenFields.assets
          .optional()
          .describe('Restrict results to these asset kinds. Omit for all kinds.'),
        regions: screenFields.regions
          .optional()
          .describe('Restrict listed assets to these regions (by company domicile).'),
        caps: screenFields.caps
          .optional()
          .describe('Restrict to these market-cap classes (USD normalized).'),
        cn_hkex_only: screenFields.cn_hkex_only
          .optional()
          .describe('With regions including cn: only HKEX-listed names, no ADRs.'),
        breadth: screenFields.breadth
          .optional()
          .describe('diversified spreads the ten slots across the thesis strategies; default focused.'),
        universe: screenFields.universe
          .optional()
          .describe(
            'Tradable-universe mode: restrict picks to assets that exist as tokenized stocks on this venue ' +
              '(robinhood = Robinhood Chain stock tokens). Each pick then includes its token contract ' +
              '(address, chainId, decimals). Prediction markets are excluded unless assets includes polymarket.',
          ),
      },
    },
    async (args, extra) => {
      // Status lines ride the POST's SSE stream as notifications: progress
      // notifications when the client sent a progressToken, logging messages
      // otherwise. Either way the bytes double as a Cloudflare keep-alive.
      const progressToken = extra._meta?.progressToken;
      let progress = 0;
      const notify = (line: string) => {
        const p =
          progressToken !== undefined
            ? extra.sendNotification({
                method: 'notifications/progress',
                params: { progressToken, progress: ++progress, message: line },
              })
            : extra.sendNotification({
                method: 'notifications/message',
                params: { level: 'info', data: line },
              });
        p.catch((e) => log.warn(`mcp notify failed: ${(e as Error).message}`));
      };
      const keepAlive = setInterval(() => notify('Screen still running…'), 25_000);
      // The error text must match what happened to the credit: refunded,
      // kept (daily refund cap, failure notes), or never charged (auth off).
      let refunded = false;
      try {
        return await withRunFailureNotes(async () => {
          try {
            // Per-user burst budget for screens (audit H2), and the concurrent-run
            // cap checked BEFORE the charge (performRun takes the slot itself).
            if (user) {
              consume('run', `u:${user.id}`);
              assertRunSlotAvailable(user.id);
            }
            // Charge FIRST, then the paid thesis call (final audit L4); the run
            // core takes the prepaid credit over, a failure before it refunds.
            let noCredit: SpendResult | null = null;
            const done = await chargeFirst(
              user,
              { signal: extra.signal, onNoCredit: (s) => (noCredit = s), onRefund: () => (refunded = true) },
              async () => {
                // extra.signal fires when the client cancels or the connection closes
                // (review R12): the thesis call and the pipeline stop with it.
                const input = await withRunSignal(extra.signal, () =>
                  buildScreenInput(
                    args.thesis,
                    { assets: args.assets, regions: args.regions, caps: args.caps, cn_hkex_only: args.cn_hkex_only, universe: args.universe },
                    args.breadth,
                    '[MCP]',
                    // MCP is always the API channel of the data display policy.
                    'api',
                  ),
                );
                // §5.7 lines also ride the final payload (as `status`): notifications
                // are ephemeral and many MCP clients drop them, which left an
                // over-constrained run's empty `picks` with no explanation — the audit
                // drops and the "no candidate passed" line are the honest-empty story.
                const statusLines: string[] = [];
                const payload = await performRun(user, input, {
                  signal: extra.signal,
                  onStart: () => {},
                  onStatus: (line) => {
                    statusLines.push(line);
                    notify(line);
                  },
                  onRefund: () => {
                    refunded = true;
                  },
                });
                return { ...payload, status: statusLines };
              },
            );
            if (!done) {
              const s = noCredit as SpendResult | null;
              return err(`No credits left today. Credits refresh every day at midnight UTC. (${s?.credits ?? 0}/${s?.cap ?? 0} credits left)`);
            }
            return ok(done.value);
          } catch (e) {
            if (e instanceof OutOfCreditsError) {
              return err(`${e.message} (${e.credits}/${e.cap} credits left)`);
            }
            // Cancelled by the client: the SDK drops this response anyway.
            if (e instanceof RunAbortedError) return err('The screen was cancelled.');
            // Curated message only (audit M4): the raw error stays in the server
            // log. A refund refused by the daily cap is already in the message
            // (failure notes); otherwise say what happened to the credit.
            const { message } = runFailureMessage(e);
            const credit = !user
              ? 'No credit was charged.'
              : refunded
                ? 'The charged credit was refunded.'
                : runFailureNotes()
                  ? ''
                  : 'No credit was charged.';
            return err(`The screen failed: ${message}${credit ? ` ${credit}` : ''}`);
          }
        });
      } finally {
        clearInterval(keepAlive);
      }
    },
  );

  server.registerTool(
    'get_credits',
    {
      title: 'Check remaining SyntheTick credits',
      description:
        'Today\'s remaining credit balance for the API key\'s account. A screen costs 1 credit; the balance refreshes every day at midnight UTC.',
      inputSchema: {},
    },
    async () => {
      if (!user) return ok({ authRequired: false, credits: null, cap: null });
      const peek = await spendCredit(user.id, 0, 'daily_reset');
      return ok({ email: user.email, credits: peek.credits, cap: peek.cap });
    },
  );

  return server;
}

/** Handle one /mcp request: fresh server + stateless transport per call. */
export async function handleMcp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  user: AuthedUser | null,
): Promise<void> {
  const server = buildServer(user);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.once('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}
