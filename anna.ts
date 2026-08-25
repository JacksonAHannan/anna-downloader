function normalizeBaseURL(value: string, variableName: string): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error(`${variableName} contains an invalid URL: ${value}`); }
  if (url.protocol !== 'https:') throw new Error(`${variableName} entries must use HTTPS.`);
  if (url.username || url.password) throw new Error(`${variableName} entries cannot contain credentials.`);
  if (url.port && url.port !== '443') throw new Error(`${variableName} entries cannot use a custom port.`);
  if (url.pathname !== '/' || url.search || url.hash) throw new Error(`${variableName} entries must be origins without paths, queries, or fragments.`);
  return url.origin;
}

export function parseAnnaBaseURLs(value: string | undefined, fallback: string, variableName = 'Anna base URL'): string[] {
  const entries = (value || fallback).split(',').map((entry) => entry.trim()).filter(Boolean);
  const normalized = entries.map((entry) => normalizeBaseURL(entry, variableName));
  return [...new Set(normalized)];
}

function configuredBaseURLs(pluralName: string, singularName: string, fallback: string): string[] {
  const configured = [process.env[pluralName], process.env[singularName]].filter((value): value is string => Boolean(value?.trim())).join(',');
  return parseAnnaBaseURLs(configured || undefined, fallback, pluralName);
}

export const ANNAS_CATALOG_BASE_URLS = configuredBaseURLs('ANNAS_BASE_URLS', 'ANNAS_BASE_URL', 'https://annas-archive.gl');
export const ANNAS_DOWNLOAD_BASE_URLS = configuredBaseURLs('ANNAS_DOWNLOAD_BASE_URLS', 'ANNAS_DOWNLOAD_BASE_URL', 'https://annas-archive.gl');
/**
 * Search-only origins that the operator has explicitly chosen to treat as
 * untrusted HTML catalogs. These hosts are deliberately excluded from
 * ANNAS_TRUSTED_HOSTS and can never become download origins through this list.
 */
export const UNTRUSTED_CATALOG_BASE_URLS = configuredBaseURLs(
  'UNTRUSTED_CATALOG_BASE_URLS',
  'UNTRUSTED_CATALOG_BASE_URL',
  'https://annas-archive.is'
);

function explicitTrustedHosts(): string[] {
  return (process.env.ANNAS_TRUSTED_HOSTS || '').split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    if (!/^[a-z0-9.-]+$/i.test(entry)) throw new Error('ANNAS_TRUSTED_HOSTS must contain comma-separated hostnames without paths or wildcards.');
    return entry.toLowerCase().replace(/\.$/, '');
  });
}

export const ANNAS_TRUSTED_HOSTS = new Set([
  ...ANNAS_CATALOG_BASE_URLS,
  ...ANNAS_DOWNLOAD_BASE_URLS,
].map((value) => new URL(value).hostname.toLowerCase()).concat(explicitTrustedHosts()));

export function isTrustedAnnaURL(value: string, expectedPath?: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
    if (!ANNAS_TRUSTED_HOSTS.has(url.hostname.toLowerCase())) return false;
    return expectedPath === undefined || url.pathname === expectedPath;
  } catch {
    return false;
  }
}
