import { URL } from 'url';
import dns from 'dns';
import net from 'net';

export interface SecurityGuardOptions {
  allowDemoApi?: boolean;
  dnsTimeoutMs?: number;
  dnsCacheTtlMs?: number;
  customResolver?: (hostname: string) => Promise<{ address: string; family: number }[]>;
}

export interface ValidationResult {
  isValid: boolean;
  hostname: string;
  targetUrl?: string;
  resolvedIps: string[];
  reason?: string;
  errorCode?: 'INVALID_URL' | 'UNSUPPORTED_PROTOCOL' | 'FORBIDDEN_HOSTNAME' | 'RESTRICTED_IP' | 'DNS_RESOLUTION_FAILED' | 'DNS_TIMEOUT';
}

export interface IpClassification {
  isRestricted: boolean;
  type?: 'loopback' | 'private' | 'link-local' | 'cloud-metadata' | 'cgnat' | 'multicast' | 'reserved' | 'test-net' | 'unspecified' | 'invalid';
  canonicalIp?: string;
}

/**
 * Known internal and dangerous hostnames/suffixes.
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

/**
 * Cache for DNS resolution to optimize high-throughput proxy requests and defend against rapid rebinding.
 */
interface DnsCacheEntry {
  isValid: boolean;
  resolvedIps: string[];
  reason?: string;
  cachedAt: number;
}

export class SecurityGuard {
  private dnsCache = new Map<string, DnsCacheEntry>();
  private defaultOptions: Required<SecurityGuardOptions>;

  constructor(options?: SecurityGuardOptions) {
    this.defaultOptions = {
      allowDemoApi: options?.allowDemoApi ?? true,
      dnsTimeoutMs: options?.dnsTimeoutMs ?? 5000,
      dnsCacheTtlMs: options?.dnsCacheTtlMs ?? 15000,
      customResolver: options?.customResolver ?? (async (hostname: string) => {
        const records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
        return records.map(r => ({ address: r.address, family: r.family }));
      }),
    };
  }

  /**
   * Clears the DNS cache.
   */
  public clearCache(): void {
    this.dnsCache.clear();
  }

  /**
   * Validates a target URL or hostname strictly before forwarding requests.
   */
  public async validateTarget(urlOrHost: string, options?: SecurityGuardOptions): Promise<ValidationResult> {
    const opts = { ...this.defaultOptions, ...options };
    if (!urlOrHost || typeof urlOrHost !== 'string') {
      return {
        isValid: false,
        hostname: '',
        resolvedIps: [],
        reason: 'Empty or invalid URL target',
        errorCode: 'INVALID_URL',
      };
    }

    let parsedUrl: URL | null = null;
    let hostname = urlOrHost.trim();

    try {
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(urlOrHost.trim())) {
        parsedUrl = new URL(urlOrHost.trim());
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          return {
            isValid: false,
            hostname: parsedUrl.hostname || '',
            targetUrl: urlOrHost,
            resolvedIps: [],
            reason: `Unsupported protocol '${parsedUrl.protocol}'. Only HTTP and HTTPS are permitted.`,
            errorCode: 'UNSUPPORTED_PROTOCOL',
          };
        }
        if (parsedUrl.username || parsedUrl.password) {
          return {
            isValid: false,
            hostname: parsedUrl.hostname || '',
            targetUrl: urlOrHost,
            resolvedIps: [],
            reason: 'Embedded credentials in URLs are forbidden.',
            errorCode: 'INVALID_URL',
          };
        }
        hostname = parsedUrl.hostname;
      }
    } catch {
      return {
        isValid: false,
        hostname: urlOrHost,
        resolvedIps: [],
        reason: 'Malformed URL format',
        errorCode: 'INVALID_URL',
      };
    }

    // Strip square brackets and trailing DNS root dots from hostnames
    let cleanHost = hostname.toLowerCase().trim().replace(/\.+$/, '');
    if (cleanHost.startsWith('[') && cleanHost.endsWith(']')) {
      cleanHost = cleanHost.slice(1, -1);
    }

    // Demo API bypass allowlist if configured (strictly exact hostname and official demo ports 3001/4000/default)
    if (
      opts.allowDemoApi &&
      (cleanHost === 'fortix-demo-api' || cleanHost === 'fortix-demo-api.internal') &&
      (!parsedUrl || parsedUrl.port === '' || parsedUrl.port === '3001' || parsedUrl.port === '4000')
    ) {
      return {
        isValid: true,
        hostname,
        targetUrl: parsedUrl?.toString() ?? urlOrHost,
        resolvedIps: ['127.0.0.1 (demo allowlist)'],
      };
    }

    // 1. Static Hostname Evaluation
    if (this.isForbiddenHostname(cleanHost)) {
      return {
        isValid: false,
        hostname,
        targetUrl: parsedUrl?.toString() ?? urlOrHost,
        resolvedIps: [],
        reason: `Target hostname '${hostname}' is a restricted or internal domain.`,
        errorCode: 'FORBIDDEN_HOSTNAME',
      };
    }

    // 2. Direct Raw IP / Encoded IP Evaluation
    const numericIpv4 = this.parseNumericOrEncodedIp(cleanHost);
    if (numericIpv4) {
      const classification = this.classifyIpv4(numericIpv4);
      if (classification.isRestricted) {
        return {
          isValid: false,
          hostname,
          targetUrl: parsedUrl?.toString() ?? urlOrHost,
          resolvedIps: [numericIpv4],
          reason: `Target resolves directly to restricted IPv4 address '${numericIpv4}' (${classification.type}).`,
          errorCode: 'RESTRICTED_IP',
        };
      }
      return {
        isValid: true,
        hostname,
        targetUrl: parsedUrl?.toString() ?? urlOrHost,
        resolvedIps: [numericIpv4],
      };
    }

    if (net.isIPv6(cleanHost) || cleanHost.includes(':')) {
      const classification = this.classifyIpv6(cleanHost);
      if (classification.isRestricted) {
        return {
          isValid: false,
          hostname,
          targetUrl: parsedUrl?.toString() ?? urlOrHost,
          resolvedIps: [cleanHost],
          reason: `Target resolves directly to restricted IPv6 address '${cleanHost}' (${classification.type}).`,
          errorCode: 'RESTRICTED_IP',
        };
      }
      return {
        isValid: true,
        hostname,
        targetUrl: parsedUrl?.toString() ?? urlOrHost,
        resolvedIps: [cleanHost],
      };
    }

    // 3. DNS Resolution & Rebinding Protection
    const now = Date.now();
    const cached = this.dnsCache.get(cleanHost);
    if (cached && (now - cached.cachedAt) < opts.dnsCacheTtlMs) {
      return {
        isValid: cached.isValid,
        hostname,
        targetUrl: parsedUrl?.toString() ?? urlOrHost,
        resolvedIps: cached.resolvedIps,
        reason: cached.reason,
        errorCode: cached.isValid ? undefined : 'RESTRICTED_IP',
      };
    }

    try {
      const recordsPromise = opts.customResolver(cleanHost);
      let timeoutHandle: NodeJS.Timeout | null = null;
      const timeoutPromise = new Promise<{ address: string; family: number }[]>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('DNS resolution timed out')), opts.dnsTimeoutMs);
      });

      const records = await Promise.race([recordsPromise, timeoutPromise]).finally(() => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      });

      if (!records || records.length === 0) {
        this.dnsCache.set(cleanHost, {
          isValid: false,
          resolvedIps: [],
          reason: `DNS lookup yielded no records for '${cleanHost}'.`,
          cachedAt: now,
        });
        return {
          isValid: false,
          hostname,
          targetUrl: parsedUrl?.toString() ?? urlOrHost,
          resolvedIps: [],
          reason: `DNS lookup returned no A/AAAA records for '${cleanHost}'.`,
          errorCode: 'DNS_RESOLUTION_FAILED',
        };
      }

      const resolvedIps = records.map(r => r.address);

      for (const record of records) {
        const ip = record.address;
        const validation = this.validateIp(ip);
        if (validation.isRestricted) {
          const reason = `DNS resolved hostname '${hostname}' to forbidden IP '${ip}' (${validation.type}).`;
          this.dnsCache.set(cleanHost, {
            isValid: false,
            resolvedIps,
            reason,
            cachedAt: now,
          });
          return {
            isValid: false,
            hostname,
            targetUrl: parsedUrl?.toString() ?? urlOrHost,
            resolvedIps,
            reason,
            errorCode: 'RESTRICTED_IP',
          };
        }
      }

      // All resolved addresses are valid and public
      this.dnsCache.set(cleanHost, {
        isValid: true,
        resolvedIps,
        cachedAt: now,
      });

      return {
        isValid: true,
        hostname,
        targetUrl: parsedUrl?.toString() ?? urlOrHost,
        resolvedIps,
      };
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const isTimeout = errorMessage.includes('timed out');
      const reason = `DNS resolution failed for '${cleanHost}': ${errorMessage}`;
      
      this.dnsCache.set(cleanHost, {
        isValid: false,
        resolvedIps: [],
        reason,
        cachedAt: now,
      });

      return {
        isValid: false,
        hostname,
        targetUrl: parsedUrl?.toString() ?? urlOrHost,
        resolvedIps: [],
        reason,
        errorCode: isTimeout ? 'DNS_TIMEOUT' : 'DNS_RESOLUTION_FAILED',
      };
    }
  }

  /**
   * Checks if an individual IP address (IPv4 or IPv6) is restricted or private.
   */
  public validateIp(ip: string): IpClassification {
    const clean = ip.trim();
    if (!clean) return { isRestricted: true, type: 'invalid' };

    // Check for encoded / numeric IPv4
    const numericIpv4 = this.parseNumericOrEncodedIp(clean);
    if (numericIpv4) {
      return this.classifyIpv4(numericIpv4);
    }

    if (net.isIPv4(clean)) {
      return this.classifyIpv4(clean);
    }

    if (net.isIPv6(clean) || clean.includes(':')) {
      return this.classifyIpv6(clean);
    }

    return { isRestricted: true, type: 'invalid' };
  }

  /**
   * Helper to check if an IP is private, loopback, or reserved.
   */
  public isPrivateOrReservedIp(ip: string): boolean {
    return this.validateIp(ip).isRestricted;
  }

  /**
   * Evaluates hostname against blacklisted TLDs, internal patterns, and cloud metadata hostnames.
   */
  public isForbiddenHostname(host: string): boolean {
    const clean = host.toLowerCase().trim().replace(/\.+$/, '');
    if (!clean) return true;

    for (const pattern of FORBIDDEN_HOST_PATTERNS) {
      if (typeof pattern === 'string') {
        if (clean === pattern || clean === `[${pattern}]`) return true;
      } else if (pattern.test(clean)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Decodes numeric, octal, hex, and shortened IPv4 representations:
   * - 32-bit Integer: 2130706433 -> 127.0.0.1, 2852039166 -> 169.254.169.254
   * - Hex Integer: 0x7f000001 -> 127.0.0.1, 0xa9fea9fe -> 169.254.169.254
   * - Octal Integer: 017700000001 -> 127.0.0.1
   * - Dotted Octal: 0177.0.0.1 -> 127.0.0.1
   * - Dotted Hex: 0x7f.0.0.1 -> 127.0.0.1
   * - Shortened Dotted: 127.1 -> 127.0.0.1, 10.1 -> 10.0.0.1, 127.0.1 -> 127.0.0.1
   */
  public parseNumericOrEncodedIp(host: string): string | null {
    const trimmed = host.trim().toLowerCase().replace(/\.+$/, '');

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
        if (parsedParts.some(p => p > 255)) return null;
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
   * Classifies IPv4 addresses into categories and determines if they are restricted.
   */
  public classifyIpv4(ip: string): IpClassification {
    const parts = ip.split('.').map(p => parseInt(p, 10));
    if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) {
      return { isRestricted: true, type: 'invalid' };
    }

    const [b0, b1, b2, b3] = parts;

    // 0.0.0.0/8 (Broadcast/Current network)
    if (b0 === 0) return { isRestricted: true, type: 'unspecified', canonicalIp: ip };

    // 10.0.0.0/8 (Private RFC 1918)
    if (b0 === 10) return { isRestricted: true, type: 'private', canonicalIp: ip };

    // 100.64.0.0/10 (Carrier-grade NAT RFC 6598: 100.64.0.0 to 100.127.255.255)
    if (b0 === 100 && (b1 >= 64 && b1 <= 127)) {
      if (b0 === 100 && b1 === 100 && b2 === 100 && b3 === 200) {
        return { isRestricted: true, type: 'cloud-metadata', canonicalIp: ip };
      }
      return { isRestricted: true, type: 'cgnat', canonicalIp: ip };
    }

    // Alibaba Cloud metadata: 100.100.100.200
    if (b0 === 100 && b1 === 100 && b2 === 100 && b3 === 200) {
      return { isRestricted: true, type: 'cloud-metadata', canonicalIp: ip };
    }

    // 127.0.0.0/8 (Loopback RFC 1122)
    if (b0 === 127) return { isRestricted: true, type: 'loopback', canonicalIp: ip };

    // 169.254.0.0/16 (Link-local & AWS/GCP Metadata RFC 3927)
    if (b0 === 169 && b1 === 254) return { isRestricted: true, type: 'link-local', canonicalIp: ip };

    // 172.16.0.0/12 (Private RFC 1918: 172.16.0.0 to 172.31.255.255)
    if (b0 === 172 && (b1 >= 16 && b1 <= 31)) return { isRestricted: true, type: 'private', canonicalIp: ip };

    // 192.0.0.0/24 (IETF RFC 6890)
    if (b0 === 192 && b1 === 0 && b2 === 0) return { isRestricted: true, type: 'reserved', canonicalIp: ip };

    // 192.0.2.0/24 (TEST-NET-1 RFC 5737)
    if (b0 === 192 && b1 === 0 && b2 === 2) return { isRestricted: true, type: 'test-net', canonicalIp: ip };

    // 192.88.99.0/24 (6to4 Relay Anycast RFC 7526)
    if (b0 === 192 && b1 === 88 && b2 === 99) return { isRestricted: true, type: 'reserved', canonicalIp: ip };

    // 192.168.0.0/16 (Private RFC 1918)
    if (b0 === 192 && b1 === 168) return { isRestricted: true, type: 'private', canonicalIp: ip };

    // 198.18.0.0/15 (Benchmarking RFC 2544: 198.18.0.0 to 198.19.255.255)
    if (b0 === 198 && (b1 === 18 || b1 === 19)) return { isRestricted: true, type: 'test-net', canonicalIp: ip };

    // 198.51.100.0/24 (TEST-NET-2 RFC 5737)
    if (b0 === 198 && b1 === 51 && b2 === 100) return { isRestricted: true, type: 'test-net', canonicalIp: ip };

    // 203.0.113.0/24 (TEST-NET-3 RFC 5737)
    if (b0 === 203 && b1 === 0 && b2 === 113) return { isRestricted: true, type: 'test-net', canonicalIp: ip };

    // 224.0.0.0/4 (Multicast Class D)
    if (b0 >= 224 && b0 <= 239) return { isRestricted: true, type: 'multicast', canonicalIp: ip };

    // 240.0.0.0/4 (Reserved Class E: 240.0.0.0 to 255.255.255.254)
    if (b0 >= 240) return { isRestricted: true, type: 'reserved', canonicalIp: ip };

    return { isRestricted: false, canonicalIp: ip };
  }

  /**
   * Classifies IPv6 addresses into categories and determines if they are restricted.
   */
  public classifyIpv6(ip: string): IpClassification {
    let cleanIp = ip.trim().toLowerCase();
    if (cleanIp.startsWith('[') && cleanIp.endsWith(']')) {
      cleanIp = cleanIp.slice(1, -1);
    }

    // Reject IPv6 zone indices (e.g. fe80::1%eth0)
    if (cleanIp.includes('%')) {
      return { isRestricted: true, type: 'invalid' };
    }

    // Canonicalize expanded/uncompressed IPv6 representations
    try {
      const canonicalUrl = new URL(`http://[${cleanIp}]/`);
      if (canonicalUrl.hostname.startsWith('[') && canonicalUrl.hostname.endsWith(']')) {
        cleanIp = canonicalUrl.hostname.slice(1, -1).toLowerCase();
      }
    } catch {
      if (!net.isIPv6(cleanIp)) {
        return { isRestricted: true, type: 'invalid' };
      }
    }

    // 1. IPv4-mapped / IPv4-translated IPv6: ::ffff:127.0.0.1, ::ffff:7f00:1, ::ffff:0:127.0.0.1
    const ipv4MappedMatch = cleanIp.match(/^(?:::ffff:(?:0:)?|0:0:0:0:0:ffff:(?:0:)?)([0-9a-f.:]+)$/i);
    if (ipv4MappedMatch) {
      const embedded = ipv4MappedMatch[1];
      if (net.isIPv4(embedded)) {
        return this.classifyIpv4(embedded);
      }
      const parsedNumeric = this.parseNumericOrEncodedIp(embedded);
      if (parsedNumeric) {
        return this.classifyIpv4(parsedNumeric);
      }
      const hexParts = embedded.split(':');
      if (hexParts.length === 2) {
        const high = parseInt(hexParts[0], 16);
        const low = parseInt(hexParts[1], 16);
        if (!isNaN(high) && !isNaN(low)) {
          const b0 = (high >>> 8) & 255;
          const b1 = high & 255;
          const b2 = (low >>> 8) & 255;
          const b3 = low & 255;
          return this.classifyIpv4(`${b0}.${b1}.${b2}.${b3}`);
        }
      }
      return { isRestricted: true, type: 'invalid' };
    }

    // 1.5 NAT64 Well-Known Prefix RFC 6052 (64:ff9b::/96 and 64:ff9b:1::/48)
    if (cleanIp.startsWith('64:ff9b:')) {
      return { isRestricted: true, type: 'reserved', canonicalIp: cleanIp };
    }

    // 2. IPv4-compatible IPv6 (deprecated): ::192.168.1.1 or ::7f00:1
    if (cleanIp !== '::' && cleanIp !== '::1' && cleanIp.startsWith('::')) {
      const rest = cleanIp.slice(2);
      if (net.isIPv4(rest)) {
        return this.classifyIpv4(rest);
      }
      const hexParts = rest.split(':');
      if (hexParts.length === 2) {
        const high = parseInt(hexParts[0], 16);
        const low = parseInt(hexParts[1], 16);
        if (!isNaN(high) && !isNaN(low)) {
          const b0 = (high >>> 8) & 255;
          const b1 = high & 255;
          const b2 = (low >>> 8) & 255;
          const b3 = low & 255;
          return this.classifyIpv4(`${b0}.${b1}.${b2}.${b3}`);
        }
      }
    }

    // 3. Loopback (::1) and Unspecified (::)
    if (cleanIp === '::1' || cleanIp === '0:0:0:0:0:0:0:1' || /^0*(:0*)*:1$/.test(cleanIp)) {
      return { isRestricted: true, type: 'loopback', canonicalIp: '::1' };
    }
    if (cleanIp === '::' || cleanIp === '0:0:0:0:0:0:0:0' || /^0*(:0*)*$/.test(cleanIp)) {
      return { isRestricted: true, type: 'unspecified', canonicalIp: '::' };
    }

    // 4. Unique Local Addresses (ULA) RFC 4193: fc00::/7 (fc00:: to fdff:...)
    if (/^f[cd][0-9a-f]{0,2}:/i.test(cleanIp) || cleanIp.startsWith('fc') || cleanIp.startsWith('fd')) {
      return { isRestricted: true, type: 'private', canonicalIp: cleanIp };
    }

    // 5. Link-Local Unicast RFC 4291: fe80::/10 (fe80:: to febf:...)
    if (/^fe[89ab][0-9a-f]?:?/i.test(cleanIp) || cleanIp.startsWith('fe80:')) {
      return { isRestricted: true, type: 'link-local', canonicalIp: cleanIp };
    }

    // 6. Site-Local (deprecated) RFC 3879: fec0::/10
    if (/^fe[c-f][0-9a-f]?:?/i.test(cleanIp) || cleanIp.startsWith('fec0:')) {
      return { isRestricted: true, type: 'private', canonicalIp: cleanIp };
    }

    // 7. Multicast RFC 4291: ff00::/8
    if (cleanIp.startsWith('ff')) {
      return { isRestricted: true, type: 'multicast', canonicalIp: cleanIp };
    }

    // 8. Documentation RFC 3849: 2001:db8::/32
    if (cleanIp.startsWith('2001:db8:') || cleanIp.startsWith('2001:0db8:')) {
      return { isRestricted: true, type: 'test-net', canonicalIp: cleanIp };
    }

    // 8.5 Teredo Tunneling RFC 4380: 2001:0000::/32
    if (cleanIp.startsWith('2001:0:') || cleanIp.startsWith('2001:0000:') || cleanIp === '2001::') {
      return { isRestricted: true, type: 'reserved', canonicalIp: cleanIp };
    }

    // 9. Discard prefix RFC 6666: 100::/64
    if (cleanIp.startsWith('100::') || cleanIp.startsWith('0100::')) {
      return { isRestricted: true, type: 'reserved', canonicalIp: cleanIp };
    }

    // 10. 6to4 prefix (2002::/16) - decode embedded IPv4
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
          const embeddedV4 = `${b0}.${b1}.${b2}.${b3}`;
          const embeddedClass = this.classifyIpv4(embeddedV4);
          if (embeddedClass.isRestricted) {
            return { isRestricted: true, type: embeddedClass.type, canonicalIp: cleanIp };
          }
        }
      }
    }

    return { isRestricted: false, canonicalIp: cleanIp };
  }
}

// Global default singleton instance
export const securityGuard = new SecurityGuard();
