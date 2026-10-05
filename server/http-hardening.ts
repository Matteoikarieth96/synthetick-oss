/**
 * Node HTTP server limits (final audit L7). Node's defaults wait 60 s for
 * request headers and 300 s for a whole request and accept unlimited
 * connections; Railway's proxy absorbs most slow clients, a self-hosted server
 * has nothing in front of it.
 *
 * What each limit covers, and why SSE is safe:
 *   - headersTimeout / requestTimeout bound RECEIVING a request (headers, then
 *     headers plus body). Node stops checking a connection once its request has
 *     been fully read, so a response that streams for minutes afterwards (the
 *     /api/complete and /v1/screen SSE runs, MCP's stream) is not affected.
 *   - timeout stays 0 (no socket inactivity limit): a long run's stream must
 *     stay open; it sends a heartbeat every 20 s anyway.
 *   - keepAliveTimeout above the usual 60 s proxy idle timeout, so a proxy
 *     never reuses a connection the server is closing (a 502 race).
 *   - maxConnections caps open sockets (SERVER_MAX_CONNECTIONS, default 1000).
 *
 * Pure (no env.ts import): runtime/test-security-fixes-offline.ts runs a live
 * check against a local server built from these options.
 */
import type http from 'node:http';

export const HTTP_LIMITS = {
  headersTimeoutMs: 15_000,
  requestTimeoutMs: 120_000,
  keepAliveTimeoutMs: 65_000,
  /** How often Node checks the two timeouts above (its default is 30 s). */
  connectionsCheckingIntervalMs: 5_000,
  maxConnections: 1000,
} as const;

export type HttpLimits = { [K in keyof typeof HTTP_LIMITS]: number };

/** SERVER_MAX_CONNECTIONS when it is a positive integer, else the default. */
export function maxConnectionsFrom(
  env: Record<string, string | undefined> = process.env,
  fallback: number = HTTP_LIMITS.maxConnections,
): number {
  const n = Number(env.SERVER_MAX_CONNECTIONS);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Options for http.createServer (Node validates headersTimeout <= requestTimeout here). */
export function httpServerOptions(limits: HttpLimits = HTTP_LIMITS): http.ServerOptions {
  return {
    headersTimeout: limits.headersTimeoutMs,
    requestTimeout: limits.requestTimeoutMs,
    keepAliveTimeout: limits.keepAliveTimeoutMs,
    connectionsCheckingInterval: limits.connectionsCheckingIntervalMs,
  };
}

/** Apply the limits that are properties rather than constructor options. */
export function hardenHttpServer(
  server: http.Server,
  env: Record<string, string | undefined> = process.env,
  limits: HttpLimits = HTTP_LIMITS,
): http.Server {
  server.headersTimeout = limits.headersTimeoutMs;
  server.requestTimeout = limits.requestTimeoutMs;
  server.keepAliveTimeout = limits.keepAliveTimeoutMs;
  server.timeout = 0; // never cut an idle socket: SSE streams must stay open
  server.maxConnections = maxConnectionsFrom(env, limits.maxConnections);
  return server;
}
