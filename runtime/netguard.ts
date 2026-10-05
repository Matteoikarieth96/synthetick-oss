/**
 * Network address classification shared by the SSRF guard (runtime/extract.ts)
 * and the rate limiter (server/ratelimit.ts). Pure: no env, no network, so the
 * security gate (runtime/test-security.ts) exercises it offline.
 *
 * Policy: an address is "public" only if it is a globally routable unicast
 * address. Everything else (private, loopback, link-local, CGNAT, documentation,
 * multicast, reserved, and every IPv6 transition form that can smuggle an IPv4
 * address) is blocked. Unparseable input fails closed.
 */
import { isIP } from 'node:net';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import type http from 'node:http';

type Bytes = number[];

/** Parse a dotted-quad IPv4 string into 4 bytes; null when not canonical. */
function parseV4(s: string): Bytes | null {
  if (isIP(s) !== 4) return null;
  return s.split('.').map(Number);
}

/** Parse an IPv6 string (incl. "::" compression, embedded dotted tail, %zone) into 16 bytes. */
function parseV6(raw: string): Bytes | null {
  const s = raw.split('%')[0]!;
  if (isIP(s) !== 6) return null;
  let tail: Bytes = [];
  let head = s;
  // An embedded IPv4 tail ("::ffff:1.2.3.4") is two 16-bit groups.
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dotted) {
    const v4 = parseV4(dotted[1]!);
    if (!v4) return null;
    tail = v4;
    head = s.slice(0, s.length - dotted[1]!.length);
    // "::1.2.3.4" leaves a dangling ":" or "::"; normalize to a trailing group boundary.
    head = head.endsWith('::') ? head : head.replace(/:$/, '');
  }
  const groupsToBytes = (groups: string[]): Bytes =>
    groups.flatMap((g) => {
      const n = Number.parseInt(g || '0', 16);
      return [(n >> 8) & 0xff, n & 0xff];
    });
  const want = 16 - tail.length;
  let bytes: Bytes;
  if (head.includes('::')) {
    const [l = '', r = ''] = head.split('::');
    const left = l ? groupsToBytes(l.split(':')) : [];
    const right = r ? groupsToBytes(r.split(':')) : [];
    const fill = want - left.length - right.length;
    if (fill < 0) return null;
    bytes = [...left, ...new Array<number>(fill).fill(0), ...right];
  } else {
    bytes = groupsToBytes(head ? head.split(':') : []);
  }
  bytes = [...bytes, ...tail];
  return bytes.length === 16 ? bytes : null;
}

/** True for any IPv4 address that is not globally routable unicast. */
function isNonPublicV4(b: Bytes): boolean {
  const [a, b1, b2] = [b[0]!, b[1]!, b[2]!];
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 ||
    a >= 224 || // multicast, reserved, broadcast
    (a === 100 && b1 >= 64 && b1 <= 127) || // CGNAT 100.64/10
    (a === 169 && b1 === 254) ||
    (a === 172 && b1 >= 16 && b1 <= 31) ||
    (a === 192 && b1 === 0 && b2 === 0) || // IETF protocol assignments 192.0.0/24
    (a === 192 && b1 === 0 && b2 === 2) || // TEST-NET-1
    (a === 192 && b1 === 88 && b2 === 99) || // 6to4 relay anycast
    (a === 192 && b1 === 168) ||
    (a === 198 && (b1 === 18 || b1 === 19)) || // benchmarking
    (a === 198 && b1 === 51 && b2 === 100) || // TEST-NET-2
    (a === 203 && b1 === 0 && b2 === 113) // TEST-NET-3
  );
}

/** True for any IPv6 address that is not globally routable unicast. */
function isNonPublicV6(b: Bytes): boolean {
  const word = (i: number) => (b[i * 2]! << 8) | b[i * 2 + 1]!;
  const firstFiveZero = [0, 1, 2, 3, 4].every((i) => word(i) === 0);
  if (firstFiveZero) {
    // ::/96 covers "::" (unspecified), "::1" (loopback) and the deprecated
    // IPv4-compatible form "::a.b.c.d"; ::ffff:0:0/96 is the IPv4-mapped form.
    // Mapped addresses are judged by their embedded IPv4; the whole ::/96
    // block is non-public (nothing routable lives there).
    if (word(5) === 0) return true;
    if (word(5) === 0xffff) return isNonPublicV4(b.slice(12, 16));
  }
  // NAT64 well-known 64:ff9b::/96 and local-use 64:ff9b:1::/48: the embedded
  // IPv4 is reachable through a translator, so block the whole prefix.
  if (word(0) === 0x64 && word(1) === 0xff9b && (word(2) === 0 || word(2) === 1)) return true;
  // 6to4 2002::/16 embeds an IPv4 in bits 16..47; deprecated, block wholesale.
  if (word(0) === 0x2002) return true;
  // Teredo 2001::/32 (obfuscated embedded IPv4), documentation 2001:db8::/32 and
  // 3fff::/20, ORCHID v2 2001:20::/28, benchmarking 2001:2::/48.
  if (word(0) === 0x2001 && (word(1) === 0 || word(1) === 0xdb8 || (word(1) & 0xfff0) === 0x20 || word(1) === 2)) {
    return true;
  }
  if (word(0) === 0x3fff && (word(1) & 0xf000) === 0) return true;
  if (word(0) === 0x0100 && word(1) === 0 && word(2) === 0 && word(3) === 0) return true; // discard 100::/64
  const first = b[0]!;
  if ((first & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (first === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (first === 0xfe && (b[1]! & 0xc0) === 0xc0) return true; // fec0::/10 site-local (deprecated)
  if (first === 0xff) return true; // multicast
  // Only 2000::/3 is global unicast today; everything else is reserved.
  return (first & 0xe0) !== 0x20;
}

/** True when `ip` is NOT a globally routable unicast address (or is not an IP at all). */
export function isPrivateAddress(ip: string): boolean {
  const s = ip.trim().replace(/^\[|\]$/g, '');
  const v4 = parseV4(s);
  if (v4) return isNonPublicV4(v4);
  const v6 = parseV6(s);
  if (v6) return isNonPublicV6(v6);
  return true; // unparseable: fail closed
}

/** Loopback only (127/8, ::1, ::ffff:127/8): the local-development check. */
export function isLoopbackAddress(ip: string | undefined | null): boolean {
  if (!ip) return false;
  const s = ip.trim().replace(/^\[|\]$/g, '');
  const v4 = parseV4(s);
  if (v4) return v4[0] === 127;
  const v6 = parseV6(s);
  if (!v6) return false;
  const loop6 = v6.slice(0, 15).every((x) => x === 0) && v6[15] === 1;
  const mapped = v6.slice(0, 10).every((x) => x === 0) && v6[10] === 0xff && v6[11] === 0xff;
  return loop6 || (mapped && v6[12] === 127);
}

/**
 * Hostname-level check for URLs: well-known internal names plus literal IPs.
 * `raw` is a URL hostname (IPv6 literals arrive bracketed). WHATWG URL parsing
 * has already canonicalized exotic IPv4 spellings (0x7f.1, 2130706433) to
 * dotted-quad form by the time a hostname reaches here.
 */
export function isPrivateHostname(raw: string): boolean {
  // Any number of trailing dots is the same absolute name ("localhost.." too).
  let host = raw.toLowerCase().replace(/^\[|\]$/g, '');
  while (host.endsWith('.')) host = host.slice(0, -1);
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal'
  )
    return true;
  if (isIP(host)) return isPrivateAddress(host);
  // A dotted-numeric name that is not a canonical IPv4 literal is malformed
  // input to the resolver: refuse it rather than guess.
  if (/^[\d.]+$/.test(host)) return true;
  return false;
}

/** Thrown when a connection would reach a non-public address. */
export class BlockedAddressError extends Error {
  constructor(message = 'For safety, links to local or private network addresses cannot be loaded.') {
    super(message);
    this.name = 'BlockedAddressError';
  }
}

type LookupCb = (err: Error | null, address: string | LookupAddress[], family?: number) => void;

/**
 * `lookup` hook for node:http(s) requests: resolves the name, then refuses to
 * connect if ANY resolved address is non-public. Because the socket connects
 * to exactly the address validated here, this closes the DNS-rebinding window
 * that a separate pre-flight resolution leaves open.
 */
export function safeLookup(
  hostname: string,
  options: { all?: boolean; family?: number | string; hints?: number } | undefined,
  cb: LookupCb,
): void {
  dnsLookup(hostname, { ...(options ?? {}), all: true, verbatim: true } as never, (err, addrs) => {
    if (err) return cb(err, '');
    const list = addrs as unknown as LookupAddress[];
    if (!list.length || list.some((a) => isPrivateAddress(a.address))) {
      return cb(new BlockedAddressError(), '');
    }
    if (options?.all) return cb(null, list);
    cb(null, list[0]!.address, list[0]!.family);
  });
}

/**
 * Node never calls the `lookup` hook for an IP-literal host, so safeLookup
 * alone cannot cover `http://127.0.0.1/`. Literals are therefore checked with
 * the same address policy before any socket exists (audit N7).
 */
export function assertPublicLiteralHost(hostname: string): void {
  const h = hostname.replace(/^\[|\]$/g, '');
  if (isIP(h) && isPrivateAddress(h)) throw new BlockedAddressError();
}

/**
 * Second layer for outbound requests: once the socket is connected, refuse it
 * (and destroy the request) when the peer is not a public address, whatever
 * path led there (literal host, odd resolver, hook skipped).
 */
export function refuseNonPublicPeer(req: http.ClientRequest): void {
  req.on('socket', (socket) => {
    const check = () => {
      if (isPrivateAddress(socket.remoteAddress ?? '')) req.destroy(new BlockedAddressError());
    };
    if (socket.connecting) socket.once('connect', check);
    else check();
  });
}
