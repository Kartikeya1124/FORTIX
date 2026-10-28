/**
 * PostgreSQL connection string normalization and TLS/SSL configuration helpers.
 * Safely handles special characters (such as unencoded '@' in passwords) and
 * resolves appropriate TLS settings for local, Docker, and cloud providers
 * (Supabase, Supavisor pooler, Neon, RDS, Cloud SQL).
 */

export function normalizeDatabaseUrl(rawUrl?: string): string {
  if (!rawUrl) return '';
  let trimmed = rawUrl.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }

  const schemeMatch = trimmed.match(/^(postgres(?:ql)?:\/\/)(.*)$/i);
  if (!schemeMatch) {
    return trimmed;
  }

  const [, scheme, rest] = schemeMatch;
  const pathStartMatch = rest.search(/[/?#]/);
  const authority = pathStartMatch === -1 ? rest : rest.slice(0, pathStartMatch);
  const suffix = pathStartMatch === -1 ? '' : rest.slice(pathStartMatch);

  const lastAtIdx = authority.lastIndexOf('@');
  if (lastAtIdx === -1) {
    return `${scheme}${rest}`;
  }

  const userinfo = authority.slice(0, lastAtIdx);
  const hostport = authority.slice(lastAtIdx + 1);
  const colonIdx = userinfo.indexOf(':');
  if (colonIdx === -1) {
    return `${scheme}${userinfo}@${hostport}${suffix}`;
  }

  const username = userinfo.slice(0, colonIdx);
  const rawPassword = userinfo.slice(colonIdx + 1);
  // Percent-encode any unencoded '@' characters inside password while keeping existing %XX intact
  const safePassword = rawPassword.replace(/@/g, '%40');

  return `${scheme}${username}:${safePassword}@${hostport}${suffix}`;
}

export function isLocalDatabaseHost(connectionString: string): boolean {
  try {
    const normalized = normalizeDatabaseUrl(connectionString);
    const parsed = new URL(normalized);
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === 'postgres';
  } catch {
    return (
      connectionString.includes('localhost') ||
      connectionString.includes('127.0.0.1') ||
      connectionString.includes('@postgres:')
    );
  }
}

export function resolvePostgresSslOption(
  connectionString: string
): boolean | 'verify-full' | { rejectUnauthorized: boolean } {
  const lower = connectionString.toLowerCase();
  if (lower.includes('sslmode=disable') || lower.includes('ssl=false')) {
    return false;
  }
  if (isLocalDatabaseHost(connectionString) && !lower.includes('sslmode=require')) {
    return false;
  }
  if (lower.includes('sslmode=verify-full')) {
    return 'verify-full';
  }
  // Enforce encrypted TLS transport while tolerating managed pooler CAs (e.g. Supabase Supavisor)
  return { rejectUnauthorized: false };
}
