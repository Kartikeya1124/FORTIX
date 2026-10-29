import { Request } from 'express';

function safeMultiDecode(value: string): { decoded: string; malformedEncoding: boolean } {
  let current = value;
  let malformedEncoding = false;

  for (let pass = 0; pass < 2; pass++) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      current = next;
    } catch {
      malformedEncoding = true;
      break;
    }
  }

  return { decoded: current.toLowerCase(), malformedEncoding };
}

function collectRequestStrings(input: unknown, bucket: string[], depth = 0): void {
  if (depth > 4 || bucket.length > 50 || input === null || input === undefined) return;
  if (typeof input === 'string') {
    if (input.length > 0) bucket.push(input.slice(0, 4096));
    return;
  }
  if (Array.isArray(input)) {
    for (const item of input) collectRequestStrings(item, bucket, depth + 1);
    return;
  }
  if (typeof input === 'object') {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      bucket.push(k.slice(0, 256));
      collectRequestStrings(v, bucket, depth + 1);
    }
  }
}

const PATH_TRAVERSAL_PATTERNS = [
  /(?:^|[\\/])\.\.(?:[\\/]|$)/i,
  /\.\.%2f/i,
  /\.\.%5c/i,
  /%2e%2e/i,
  /\/etc\/passwd/i,
];

const INJECTION_PATTERNS = [
  /<\s*script\b/i,
  /javascript\s*:/i,
  /\bon(?:error|load|mouseover|focus)\s*=/i,
  /\bunion\s+(?:all\s+)?select\b/i,
  /\bselect\s+.+\s+from\b/i,
  /['"`]\s*(?:or|and)\s+['"`0-9a-z_]+\s*=\s*['"`0-9a-z_]+/i,
  /\bor\s+1\s*=\s*1\b/i,
  /;\s*(?:drop|alter|truncate)\s+table\b/i,
];

export function detectThreats(req: Request): string[] {
  const threats = new Set<string>();
  const rawUrl = String(req.originalUrl || req.url || '');
  const { decoded: decodedUrl, malformedEncoding } = safeMultiDecode(rawUrl);

  const inspectionSurfaces: string[] = [rawUrl.toLowerCase(), decodedUrl];

  collectRequestStrings(req.query, inspectionSurfaces);
  collectRequestStrings(req.body, inspectionSurfaces);

  const inspectedHeaders = ['user-agent', 'x-probe', 'referer'];
  for (const h of inspectedHeaders) {
    const val = req.headers?.[h];
    if (typeof val === 'string' && val.length > 0) {
      inspectionSurfaces.push(val.toLowerCase());
      inspectionSurfaces.push(safeMultiDecode(val).decoded);
    }
  }

  for (const surface of inspectionSurfaces) {
    if (PATH_TRAVERSAL_PATTERNS.some((re) => re.test(surface))) {
      threats.add('PATH_TRAVERSAL');
    }
    if (INJECTION_PATTERNS.some((re) => re.test(surface))) {
      threats.add('INJECTION_PATTERN');
    }
  }

  // Malformed percent-encoding combined with traversal dots is blocked instead of crashing with URIError 500
  if (malformedEncoding && /\.\.|%c0%af|%c1%9c/i.test(rawUrl)) {
    threats.add('PATH_TRAVERSAL');
  }

  return Array.from(threats);
}
