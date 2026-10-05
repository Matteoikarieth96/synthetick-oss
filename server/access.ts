/**
 * Access-mode decisions that must not depend on anything a remote client can
 * choose (security audit H4, L4). Pure: no env.ts import, no network, so
 * runtime/test-security.ts and test-regression.ts exercise it offline.
 *
 *   - Production never runs without auth by accident: assertAuthConfigured().
 *   - "Local" means the TCP peer is a loopback address, not that the client
 *     SAYS its Host is localhost (Host is attacker-controlled).
 *   - The dev server binds to 127.0.0.1 unless HOST is set deliberately.
 */
import type http from 'node:http';
import { isLoopbackAddress } from '../runtime/netguard.js';

export interface AccessEnv {
  NODE_ENV?: string;
  RAILWAY_ENVIRONMENT?: string;
  SUPABASE_ANON_KEY?: string;
  ALLOW_OPEN_ACCESS?: string;
  HOST?: string;
}

/** Deployed = production build or Railway. Locality shortcuts never apply there. */
export function isDeployedEnv(env: AccessEnv = process.env): boolean {
  return env.NODE_ENV === 'production' || Boolean(env.RAILWAY_ENVIRONMENT);
}

/**
 * Refuse to start a deployed server with auth switched off. Without
 * SUPABASE_ANON_KEY every endpoint (including /v1, /mcp and /api/complete)
 * would run open with no credits and no limits, so a missing variable must be
 * a loud failure, not a silent downgrade. ALLOW_OPEN_ACCESS=1 is the explicit
 * opt-out for a deliberately public, free deployment.
 */
export function assertAuthConfigured(env: AccessEnv = process.env): void {
  if (!isDeployedEnv(env)) return;
  if (env.SUPABASE_ANON_KEY?.trim()) return;
  if (env.ALLOW_OPEN_ACCESS === '1') return;
  throw new Error(
    'Refusing to start in production without auth: SUPABASE_ANON_KEY is not set, so every endpoint would be ' +
      'open (no sign-in, no credits, no limits). Set SUPABASE_ANON_KEY, or set ALLOW_OPEN_ACCESS=1 if an open ' +
      'deployment is really intended.',
  );
}

/**
 * Address the HTTP server binds to. Development binds to loopback only, so a
 * dev server is never reachable from the network unless HOST is set on
 * purpose. Deployed servers keep Node's default (all interfaces): the platform
 * proxy has to reach them.
 */
export function bindHost(env: AccessEnv = process.env): string | undefined {
  const host = env.HOST?.trim();
  if (host) return host;
  return isDeployedEnv(env) ? undefined : '127.0.0.1';
}

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Hostname part of a Host header value ("localhost:8787" -> "localhost"; "[::1]:8787" -> "[::1]"). */
function hostName(host: string): string {
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(host.trim().toLowerCase());
  return m ? m[1]! : '';
}

const FORWARDING_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip', 'cf-connecting-ip'];

type Req = Pick<http.IncomingMessage, 'headers' | 'socket'>;

/**
 * Local-development request: not deployed, AND all of
 *   - the TCP peer is loopback (a remote client cannot fake its socket),
 *   - no proxy forwarding headers (a reverse proxy on the same machine makes
 *     every remote client look like loopback),
 *   - the Host header names a loopback host (stops DNS rebinding: a page on
 *     evil.example resolving to 127.0.0.1 still sends Host: evil.example),
 *   - any Origin header is this same loopback host (stops a web page from
 *     driving the developer's keys with a cross-site POST).
 * Sign-in can never complete on localhost (Supabase only redirects OAuth to
 * the production URL), which is why loopback requests skip the gate at all.
 */
export function isLocalRequest(req: Req, env: AccessEnv = process.env): boolean {
  if (isDeployedEnv(env)) return false;
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false;
  if (FORWARDING_HEADERS.some((h) => req.headers[h] !== undefined)) return false;
  const host = req.headers.host ?? '';
  if (!LOOPBACK_NAMES.has(hostName(host))) return false;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    try {
      const o = new URL(origin);
      if (o.host.toLowerCase() !== host.trim().toLowerCase() || !LOOPBACK_NAMES.has(o.hostname.toLowerCase())) {
        return false;
      }
    } catch {
      return false; // includes the literal "null" origin of sandboxed pages
    }
  }
  return true;
}

/**
 * Development servers answer local requests only, on EVERY path (final audit
 * L1): pages, Next's dev endpoints (/__nextjs_launch-editor, /_next/*) and the
 * API alike, with auth on or off. A dev server binds to 127.0.0.1, so a
 * non-local Host (DNS rebinding), a cross-site Origin or proxy forwarding
 * headers can only mean someone else's page or a proxy is driving it. Off when
 * deployed (auth decides there) and when HOST was set on purpose to expose the
 * server. Returns true when the request must be refused (403).
 */
export function refuseDevRequest(req: Req, env: AccessEnv = process.env): boolean {
  if (isDeployedEnv(env)) return false;
  if (env.HOST?.trim()) return false;
  return !isLocalRequest(req, env);
}

/**
 * Open (auth-off) dev servers answer only local requests, unless the
 * developer exposed the server on purpose with HOST. Returns true when the
 * request must be refused (403). Does not apply when deployed: there the
 * startup check (assertAuthConfigured) already decided whether open access is
 * intended. (refuseDevRequest now covers this for every path; kept as the
 * API's explicit open-mode rule.)
 */
export function refuseOpenModeRequest(req: Req, authOn: boolean, env: AccessEnv = process.env): boolean {
  if (authOn || isDeployedEnv(env)) return false;
  if (env.HOST?.trim()) return false;
  return !isLocalRequest(req, env);
}
