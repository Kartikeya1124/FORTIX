import { URL } from 'url';
import dns from 'dns';
import net from 'net';
import http from 'http';
import https from 'https';

// Cache for DNS resolution results to optimize high-throughput proxy requests
interface DnsCacheEntry {
  isSafe: boolean;
  resolvedIps: string[];
  cachedAt: number;
}
const DNS_CACHE = new Map<string, DnsCacheEntry>();
const DNS_CACHE_TTL_MS = 10000; // 10-second DNS cache TTL

export function clearDnsCache() {
  DNS_CACHE.clear();
}

/**
 * List of forbidden hostnames and domain suffixes.
 */
const FORBIDDEN_HOST_PATTERNS: (string | RegExp)[] = [
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata',
  'metadata.internal',
  'instance-data',
  'instance-data.ec2.internal',
  'kubernetes.default',
  'kubernetes.default.svc',
  'kubernetes.default.svc.cluster.local',
  'host.docker.internal',
  'gateway.docker.internal',
  'docker.for.mac.localhost',
  'docker.for.win.localhost',
  /\.localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /\.lan$/i,
  /\.corp$/i,
  /\.home$/i,
  /\.invalid$/i,
  /\.test$/i,
  /\.onion$/i,
  /^fortix-demo-api\.(?!internal$)/i,
];

export function stripTrailingDots(host: string): string {
  return host.trim().replace(/\.+$/, '');
}

export function isAllowedDemoApiUrl(parsed: URL): boolean {
  if (parsed.username || parsed.password) {
    return false;
  }
  const cleanHost = stripTrailingDots(parsed.hostname.toLowerCase());
  if (cleanHost !== 'fortix-demo-api' && cleanHost !== 'fortix-demo-api.internal') {
    return false;
  }
  const isTestEnv = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
  if (cleanHost === 'fortix-demo-api.internal' && isTestEnv) {
    return true;
  }
  // Strictly lock demo API allowlist to official demo ports (3001 / 4000 / default) to prevent localhost port scanning
  if (parsed.port !== '' && parsed.port !== '3001' && parsed.port !== '4000') {
    return false;
  }
  if (process.env.START_DEMO_API === 'false') {
    return false;
  }
  return true;
}

/**
 * Parses numeric/encoded IPv4 representations:
 * - Dotted octal: "0177.0.0.1" -> "127.0.0.1"
 * - Dotted hex: "0x7f.0.0.1" -> "127.0.0.1"
 * - Decimal integer: "2130706433" -> "127.0.0.1"
 * - Hex integer: "0x7f000001" -> "127.0.0.1"
 * - Octal integer: "017700000001" -> "127.0.0.1"
 * - Shortened forms: "127.1" -> "127.0.0.1", "10.1" -> "10.0.0.1"
 */
export function parseNumericIpv4(host: string): string | null {
  const trimmed = stripTrailingDots(host).toLowerCase();
  if (!trimmed) return null;

  // 1. Single integer string (decimal, hex "0x...", octal "0...")
  if (/^(0x[0-9a-f]+|0[0-7]+|[0-9]+)$/.test(trimmed)) {
    let intVal: number;
    if (trimmed.startsWith('0x')) {
      intVal = parseInt(trimmed, 16);
    } else if (trimmed.startsWith('0') && trimmed.length > 1 && !trimmed.includes('8') && !trimmed.includes('9')) {
      intVal = parseInt(trimmed, 8);
    } else {
      intVal = parseInt(trimmed, 10);
    }

    if (isNaN(intVal) || intVal < 0 || intVal > 0xffffffff) return null;
    const b1 = (intVal >>> 24) & 255;
    const b2 = (intVal >>> 16) & 255;
    const b3 = (intVal >>> 8) & 255;
    const b4 = intVal & 255;
    return `${b1}.${b2}.${b3}.${b4}`;
  }

  // 2. Dotted notation (1 to 4 parts)
  const parts = trimmed.split('.');
  if (parts.length >= 1 && parts.length <= 4) {
    const parsedParts: number[] = [];
    for (const part of parts) {
      if (!part) return null;
      let val: number;
      if (part.startsWith('0x')) {
        val = parseInt(part, 16);
      } else if (part.startsWith('0') && part.length > 1 && !part.includes('8') && !part.includes('9')) {
        val = parseInt(part, 8);
      } else if (/^[0-9]+$/.test(part)) {
        val = parseInt(part, 10);
      } else {
        return null;
      }
      if (isNaN(val) || val < 0) return null;
      parsedParts.push(val);
    }

    if (parsedParts.length === 4) {
      if (parsedParts.some((p) => p > 255)) return null;
      return parsedParts.join('.');
    } else if (parsedParts.length === 3) {
      const [a, b, c] = parsedParts;
      if (a > 255 || b > 255 || c > 0xffff) return null;
      return `${a}.${b}.${(c >>> 8) & 255}.${c & 255}`;
    } else if (parsedParts.length === 2) {
      const [a, b] = parsedParts;
      if (a > 255 || b > 0xffffff) return null;
      return `${a}.${(b >>> 16) & 255}.${(b >>> 8) & 255}.${b & 255}`;
    }
  }

  return null;
}

/**
 * Checks if an IPv4 address is in a private, loopback, link-local, or restricted range.
 */
export function isRestrictedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true; // Invalid IPv4 -> unsafe
  }

  const [b0, b1, b2, b3] = parts;

  if (b0 === 0) return true;
  if (b0 === 10) return true;
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;
  if (b0 === 127) return true;
  if (b0 === 169 && b1 === 254) return true;
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
  if (b0 === 192 && b1 === 0 && b2 === 0) return true;
  if (b0 === 192 && b1 === 0 && b2 === 2) return true;
  if (b0 === 192 && b1 === 88 && b2 === 99) return true;
  if (b0 === 192 && b1 === 168) return true;
  if (b0 === 198 && (b1 === 18 || b1 === 19)) return true;
  if (b0 === 198 && b1 === 51 && b2 === 100) return true;
  if (b0 === 203 && b1 === 0 && b2 === 113) return true;
  if (b0 >= 224 && b0 <= 239) return true;
  if (b0 >= 240) return true;
  if (b0 === 100 && b1 === 100 && b2 === 100 && b3 === 200) return true;

  return false;
}

function decodeEmbeddedIpv4Suffix(embedded: string): string | null {
  if (net.isIPv4(embedded)) return embedded;
  const parsedNumeric = parseNumericIpv4(embedded);
  if (parsedNumeric) return parsedNumeric;

  const hexParts = embedded.split(':');
  if (hexParts.length === 2) {
    const high = parseInt(hexParts[0], 16);
    const low = parseInt(hexParts[1], 16);
    if (!isNaN(high) && !isNaN(low) && high >= 0 && high <= 0xffff && low >= 0 && low <= 0xffff) {
      const b0 = (high >>> 8) & 255;
      const b1 = high & 255;
      const b2 = (low >>> 8) & 255;
      const b3 = low & 255;
      return `${b0}.${b1}.${b2}.${b3}`;
    }
  }
  return null;
}

/**
 * Checks if an IPv6 address is in a private, loopback, link-local, ULA, NAT64, 6to4, Teredo, or restricted range.
 */
export function isRestrictedIpv6(ip: string): boolean {
  let cleanIp = ip.trim().toLowerCase();
  if (cleanIp.startsWith('[') && cleanIp.endsWith(']')) {
    cleanIp = cleanIp.slice(1, -1);
  }

  // Reject any zone index (e.g. fe80::1%eth0 or %25eth0)
  if (cleanIp.includes('%')) {
    return true;
  }

  // Canonicalize expanded/uncompressed IPv6 representations (e.g. 0000:0000:0000:0000:0000:ffff:7f00:0001 -> ::ffff:7f00:1)
  try {
    const canonicalUrl = new URL(`http://[${cleanIp}]/`);
    if (canonicalUrl.hostname.startsWith('[') && canonicalUrl.hostname.endsWith(']')) {
      cleanIp = canonicalUrl.hostname.slice(1, -1).toLowerCase();
    }
  } catch {
    // Keep cleanIp for explicit pattern checks below; invalid forms fail closed if unmatched
    if (!net.isIPv6(cleanIp)) {
      return true;
    }
  }

  // 1. IPv4-mapped IPv6 (::ffff:w.x.y.z / ::ffff:xxxx:yyyy) and IPv4-translated (::ffff:0:w.x.y.z)
  const ipv4MappedMatch = cleanIp.match(/^(?:::ffff:(?:0:)?|(?:0+:){5}ffff:(?:0+:)? )([0-9a-f.:]+)$/i) ||
    cleanIp.match(/^(?:::ffff:(?:0:)?|0:0:0:0:0:ffff:(?:0:)?)([0-9a-f.:]+)$/i);
  if (ipv4MappedMatch) {
    const decoded = decodeEmbeddedIpv4Suffix(ipv4MappedMatch[1]);
    return decoded ? isRestrictedIpv4(decoded) : true;
  }

  // 2. NAT64 Well-Known Prefix RFC 6052 (64:ff9b::/96 and 64:ff9b:1::/48)
  if (cleanIp.startsWith('64:ff9b:')) {
    const suffixMatch = cleanIp.match(/^64:ff9b:(?:1:)?(?::|0*:)*([0-9a-f.:]+)$/i);
    if (suffixMatch) {
      const decoded = decodeEmbeddedIpv4Suffix(suffixMatch[1]);
      if (decoded) return isRestrictedIpv4(decoded);
    }
    return true;
  }

  // 3. IPv4-compatible IPv6 (deprecated): ::192.168.1.1 or ::7f00:1
  if (cleanIp !== '::' && cleanIp !== '::1' && cleanIp.startsWith('::')) {
    const rest = cleanIp.slice(2);
    const decoded = decodeEmbeddedIpv4Suffix(rest);
    if (decoded) {
      return isRestrictedIpv4(decoded);
    }
  }

  // 4. Loopback and Unspecified
  if (cleanIp === '::1' || cleanIp === '0:0:0:0:0:0:0:1' || /^0*(:0*)*:1$/.test(cleanIp)) {
    return true;
  }
  if (cleanIp === '::' || cleanIp === '0:0:0:0:0:0:0:0' || /^0*(:0*)*$/.test(cleanIp)) {
    return true;
  }

  // 5. Unique Local Addresses (ULA) RFC 4193: fc00::/7
  if (/^f[cd][0-9a-f]{0,2}:/i.test(cleanIp) || cleanIp.startsWith('fc') || cleanIp.startsWith('fd')) {
    return true;
  }

  // 6. Link-Local Unicast RFC 4291: fe80::/10
  if (/^fe[89ab][0-9a-f]?:?/i.test(cleanIp) || cleanIp.startsWith('fe80:')) {
    return true;
  }

  // 7. Site-Local (deprecated) RFC 3879: fec0::/10
  if (/^fe[c-f][0-9a-f]?:?/i.test(cleanIp) || cleanIp.startsWith('fec0:')) {
    return true;
  }

  // 8. Multicast RFC 4291: ff00::/8
  if (cleanIp.startsWith('ff')) {
    return true;
  }

  // 9. Documentation RFC 3849: 2001:db8::/32
  if (cleanIp.startsWith('2001:db8:') || cleanIp.startsWith('2001:0db8:')) {
    return true;
  }

  // 10. Teredo Tunneling RFC 4380: 2001:0000::/32
  if (cleanIp.startsWith('2001:0:') || cleanIp.startsWith('2001:0000:') || cleanIp === '2001::') {
    return true;
  }

  // 11. Discard prefix RFC 6666: 100::/64
  if (cleanIp.startsWith('100::') || cleanIp.startsWith('0100::')) {
    return true;
  }

  // 12. 6to4 prefix RFC 3056 (2002::/16) - decode embedded IPv4
  if (cleanIp.startsWith('2002:')) {
    const parts = cleanIp.split(':');
    if (parts.length >= 2) {
      const p1 = parseInt(parts[1] || '0', 16);
      const p2 = parseInt(parts[2] || '0', 16);
      if (!isNaN(p1) && !isNaN(p2)) {
        const b0 = (p1 >>> 8) & 255;
        const b1 = p1 & 255;
        const b2 = (p2 >>> 8) & 255;
        const b3 = p2 & 255;
        if (isRestrictedIpv4(`${b0}.${b1}.${b2}.${b3}`)) {
          return true;
        }
      } else {
        return true;
      }
    }
  }

  return false;
}

/**
 * Checks if a hostname or raw IP is strictly forbidden.
 */
export function isForbiddenHost(host: string): boolean {
  let clean = stripTrailingDots(host.toLowerCase());
  if (!clean) return true;

  if (clean.startsWith('[') && clean.endsWith(']')) {
    return isRestrictedIpv6(clean);
  }

  // Pattern matching
  for (const pattern of FORBIDDEN_HOST_PATTERNS) {
    if (typeof pattern === 'string') {
      if (clean === pattern || clean === `[${pattern}]`) return true;
    } else if (pattern.test(clean)) {
      return true;
    }
  }

  // Check if hostname is an IPv4 or numeric IPv4
  const numericIpv4 = parseNumericIpv4(clean);
  if (numericIpv4) {
    return isRestrictedIpv4(numericIpv4);
  }

  if (net.isIPv4(clean)) {
    return isRestrictedIpv4(clean);
  }

  // Check if hostname is an IPv6
  if (net.isIPv6(clean) || clean.includes(':')) {
    return isRestrictedIpv6(clean);
  }

  return false;
}

/**
 * Synchronous static URL validator.
 * Validates protocol, absence of embedded credentials, hostname structure, numeric encodings, and raw IP ranges.
 */
export function isSafeTarget(target: string): boolean {
  try {
    if (!target || typeof target !== 'string') return false;
    const parsed = new URL(target.trim());

    // Only allow http and https protocols
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    // Reject embedded URL credentials (user:pass@host) to prevent credential confusion / SSRF parser differentials
    if (parsed.username || parsed.password) {
      return false;
    }

    const cleanHost = stripTrailingDots(parsed.hostname.toLowerCase());
    if (!cleanHost) return false;

    // Exact allowlist for internal demo test upstreams (strictly port 3001 / default only)
    if (cleanHost === 'fortix-demo-api' || cleanHost === 'fortix-demo-api.internal') {
      return isAllowedDemoApiUrl(parsed);
    }

    // Check hostname
    if (isForbiddenHost(parsed.hostname)) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Asynchronous deep target validator.
 * In addition to static checks, resolves the hostname via DNS and verifies that
 * all resolved IPv4 and IPv6 addresses are strictly public and unrestricted.
 */
export async function isSafeTargetAsync(target: string): Promise<boolean> {
  try {
    if (!isSafeTarget(target)) {
      return false;
    }

    const parsed = new URL(target.trim());
    if (isAllowedDemoApiUrl(parsed)) {
      return true;
    }

    const hostname = stripTrailingDots(parsed.hostname.toLowerCase());
    const unbracketed = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

    // If hostname is already a verified raw IP address, static check is sufficient
    if (net.isIP(unbracketed) || parseNumericIpv4(unbracketed)) {
      return true;
    }

    // Check DNS cache
    const cached = DNS_CACHE.get(unbracketed);
    const now = Date.now();
    if (cached && now - cached.cachedAt < DNS_CACHE_TTL_MS) {
      return cached.isSafe;
    }

    // Perform DNS lookup for both IPv4 and IPv6 addresses
    try {
      const records = await dns.promises.lookup(unbracketed, { all: true, verbatim: true });
      if (!records || records.length === 0) {
        DNS_CACHE.set(unbracketed, { isSafe: false, resolvedIps: [], cachedAt: now });
        return false;
      }

      for (const record of records) {
        const address = record.address;
        if (record.family === 4 || net.isIPv4(address)) {
          if (isRestrictedIpv4(address)) {
            DNS_CACHE.set(unbracketed, { isSafe: false, resolvedIps: records.map((r) => r.address), cachedAt: now });
            return false;
          }
        } else if (record.family === 6 || net.isIPv6(address)) {
          if (isRestrictedIpv6(address)) {
            DNS_CACHE.set(unbracketed, { isSafe: false, resolvedIps: records.map((r) => r.address), cachedAt: now });
            return false;
          }
        } else {
          DNS_CACHE.set(unbracketed, { isSafe: false, resolvedIps: records.map((r) => r.address), cachedAt: now });
          return false;
        }
      }

      DNS_CACHE.set(unbracketed, { isSafe: true, resolvedIps: records.map((r) => r.address), cachedAt: now });
      return true;
    } catch {
      DNS_CACHE.set(unbracketed, { isSafe: false, resolvedIps: [], cachedAt: now });
      return false;
    }
  } catch {
    return false;
  }
}

/**
 * DNS-rebinding-proof socket lookup callback for Node http.Agent / https.Agent.
 * Validates EVERY resolved IP right before TCP socket connection so a 0-TTL DNS flip
 * between validation and connection is deterministically blocked before SYN.
 */
export function safeDnsLookup(
  hostname: string,
  options: dns.LookupOptions | ((err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void),
  callback?: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void
): void {
  const cb = typeof options === 'function' ? options : callback!;
  const opts: dns.LookupOptions = typeof options === 'object' && options !== null ? options : {};
  const cleanHost = stripTrailingDots(String(hostname || '').toLowerCase());

  if (!cleanHost || isForbiddenHost(cleanHost)) {
    const err = Object.assign(new Error(`SSRF Blocked: Forbidden target host '${hostname}'`), {
      code: 'ESSRFBLOCKED',
    });
    cb(err, '');
    return;
  }

  dns.lookup(cleanHost, { all: true, verbatim: true }, (lookupErr, addresses) => {
    if (lookupErr) {
      cb(lookupErr, '');
      return;
    }

    const list = Array.isArray(addresses) ? addresses : [];
    if (list.length === 0) {
      const err = Object.assign(new Error(`DNS lookup returned no addresses for '${cleanHost}'`), {
        code: 'ENOTFOUND',
      });
      cb(err, '');
      return;
    }

    for (const entry of list) {
      const addr = entry.address;
      const restricted =
        entry.family === 4 || net.isIPv4(addr)
          ? isRestrictedIpv4(addr)
          : entry.family === 6 || net.isIPv6(addr)
          ? isRestrictedIpv6(addr)
          : true;

      if (restricted) {
        const err = Object.assign(
          new Error(`SSRF Blocked: Host '${cleanHost}' resolved to restricted IP '${addr}'`),
          { code: 'ESSRFBLOCKED' }
        );
        cb(err, '');
        return;
      }
    }

    if (opts.all) {
      cb(null, list);
    } else {
      const preferred = opts.family ? list.find((a) => a.family === opts.family) || list[0] : list[0];
      cb(null, preferred.address, preferred.family);
    }
  });
}

export const safeHttpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 100,
  lookup: safeDnsLookup as any,
});

export const safeHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 100,
  lookup: safeDnsLookup as any,
});
