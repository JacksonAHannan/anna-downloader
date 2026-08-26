import 'dotenv/config';
import axios from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import * as https from 'https';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { ANNAS_CATALOG_BASE_URLS, ANNAS_DOWNLOAD_BASE_URLS, UNTRUSTED_CATALOG_BASE_URLS, isTrustedAnnaURL } from './anna';
import { searchLocalMetadata } from './localMetadata';

// Constants

function optionsAbort(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted || axios.isCancel(error));
}

// Interfaces
export interface Book {
  language: string;
  format: string;
  size: string;
  title: string;
  publisher: string;
  authors: string;
  url: string;
  hash: string;
  downloadCount: number;
  /** Internal Anna metadata relevance rank; unlike downloadCount, this is never shown as a usage statistic. */
  sourceRank?: number;
  /** Provenance is carried into review and CSV state; it never grants network trust. */
  searchSource?: 'local_metadata' | 'untrusted_catalog' | 'catalog' | 'preselected';
}

interface FastDownloadResponse {
  download_url?: string;
  error?: string;
}

export interface CSVRow {
  [column: string]: string | undefined;
  author: string;
  title: string;
  status?: string;
  error?: string;
  matched_title?: string;
  matched_author?: string;
  match_confidence?: string;
  download_route?: string;
  average_speed?: string;
  selected_hash?: string;
  selected_url?: string;
  selected_title?: string;
  selected_authors?: string;
  selected_publisher?: string;
  selected_language?: string;
  selected_format?: string;
  selected_size?: string;
  selected_source?: string;
}

export interface TransferInfo {
  route: 'fast' | 'slow';
  bytesPerSecond: number;
}

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_CATALOG_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_CATALOG_REDIRECTS = 2;
const FILE_REQUEST_TIMEOUT_MS = 45_000;
const STALL_TIMEOUT_MS = 30_000;
const SPEED_CHECK_AFTER_MS = 30_000;
const MIN_TRANSFER_BYTES_PER_SECOND = 32 * 1024;
const MAX_DOWNLOAD_BASENAME_BYTES = 180;

export function parseFastDomainIndexes(value: string | undefined): number[] {
  const configured = String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(Number)
    .filter((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 100);
  const indexes = configured.length ? configured : [6, 7, 1, 2, 8, 9, 0];
  return [...new Set(indexes)];
}

const FAST_DOWNLOAD_DOMAIN_INDEXES = parseFastDomainIndexes(process.env.ANNAS_FAST_DOMAIN_INDEXES);

function formatTransferSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
  return `${Math.round(bytesPerSecond / 1024)} KB/s`;
}

export function safeDownloadFilename(title: string, extension: string, hash: string): string {
  const cleanExtension = extension.toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
  const suffix = `-${hash.replace(/[^a-z0-9]/gi, '').slice(0, 10) || 'download'}.${cleanExtension}`;
  let stem = title.normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/[. ]+$/g, '').trim() || 'Untitled';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = `_${stem}`;
  while (Buffer.byteLength(stem + suffix, 'utf8') > MAX_DOWNLOAD_BASENAME_BYTES && stem.length > 1) {
    stem = stem.slice(0, -1).replace(/[. ]+$/g, '');
  }
  return `${stem}${suffix}`;
}

export interface Config {
  secretKey: string;
  outputFolder: string;
  preferredLanguage?: string;
  /** Editions from a publisher whose name contains this text rank slightly higher. See rankCandidates. */
  preferredPublisher?: string;
  /** SQLite FTS index built from the downloaded Anna metadata dump. */
  metadataIndex?: string;
  /** Explicit operator consent to query a third-party, untrusted HTML catalog. */
  untrustedCatalogSearch?: boolean;
  maxDownloads?: number;
}

/**
 * Custom error for rate limiting (429 responses)
 */
export class RateLimitError extends Error {
  retryAfter?: number;

  constructor(message: string, retryAfter?: number) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

export class SearchAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchAccessError';
  }
}

export class CatalogMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogMetadataError';
  }
}

export class SearchProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchProviderConfigurationError';
  }
}

/**
 * Extract metadata information from meta string
 */
export function extractMetaInformation(meta: string): {
  language: string;
  format: string;
  size: string;
} {
  // New format: "English [en] · EPUB · 0.4MB"
  const parts = meta.split(' · ');
  if (parts.length < 3) {
    return { language: '', format: '', size: '' };
  }

  return {
    language: parts[0],
    format: parts[1],
    size: parts[2],
  };
}

type SearchSource = NonNullable<Book['searchSource']>;

async function requestCatalogPage(fullURL: string, catalogBaseURL: string): Promise<string> {
  const allowedOrigin = new URL(catalogBaseURL).origin;
  let currentURL = new URL(fullURL);

  for (let redirectCount = 0; redirectCount <= MAX_CATALOG_REDIRECTS; redirectCount++) {
    if (currentURL.origin !== allowedOrigin || currentURL.username || currentURL.password) {
      throw new SearchAccessError('The catalog attempted to leave its configured origin. The response was rejected.');
    }
    const response = await axios.get<string>(currentURL.toString(), {
      headers: {
        // Intentionally omit Authorization, Cookie, Referer, and application secrets.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
      timeout: REQUEST_TIMEOUT_MS,
      responseType: 'text',
      maxRedirects: 0,
      maxContentLength: MAX_CATALOG_RESPONSE_BYTES,
      maxBodyLength: MAX_CATALOG_RESPONSE_BYTES,
      validateStatus: (status) => (status >= 200 && status < 300) || (status >= 300 && status < 400),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      if (!location) throw new SearchAccessError('The catalog returned a redirect without a destination.');
      if (redirectCount === MAX_CATALOG_REDIRECTS) throw new SearchAccessError('The catalog exceeded the redirect limit.');
      currentURL = new URL(location, currentURL);
      continue;
    }
    const contentType = String(response.headers['content-type'] || '').toLowerCase();
    if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      throw new SearchAccessError(`The catalog returned an unexpected response type (${contentType}).`);
    }
    return response.data;
  }
  throw new SearchAccessError('The catalog exceeded the redirect limit.');
}

/**
 * Find books by search query
 */
export async function findBook(
  query: string,
  attemptedQueries = new Set<string>(),
  catalogMatchesFound = 0,
  catalogIndex = 0,
  catalogBaseURLs: string[] = ANNAS_CATALOG_BASE_URLS,
  searchSource: SearchSource = 'catalog'
): Promise<Book[]> {
  attemptedQueries.add(query.toLowerCase());
  const encodedQuery = encodeURIComponent(query);
  const catalogBaseURL = catalogBaseURLs[catalogIndex];
  const fullURL = `${catalogBaseURL}/search?q=${encodedQuery}`;

  try {
    const html = await requestCatalogPage(fullURL, catalogBaseURL);
    const $ = cheerio.load(html);
    const bookList: Book[] = [];

    $('a[href^="/md5/"]').each((_, element) => {
      const $el = $(element);

      // Only process the main book link, not cover images
      if ($el.hasClass('custom-a') && $el.hasClass('block')) {
        return; // Skip cover image links
      }

      const $container = $el.closest('div').parent();

      // Title is in the link itself
      const title = $el.text();

      // Meta info is in the last div (contains language, format, size)
      // Extract just the text before "Save" button
      const metaDiv = $container.find('div.text-gray-800');
      const metaText = metaDiv.contents().filter((_, el) => el.type === 'text').text();
      const meta = metaText.split('·').slice(0, 3).join('·').trim();

      // Author link
      const authors = $container.find('a[href*="/search?q="]').first().text().trim();

      // Publisher link
      const publisher = $container.find('a[href*="/search?q="]').eq(1).text().trim();

      // Extract download count - look for text like "123 downloads"
      // Download count is typically in a div with download statistics
      let downloadCount = 0;
      const downloadText = $container.text().match(/(\d+(?:,\d+)?)\s*downloads?/i);
      if (downloadText) {
        downloadCount = parseInt(downloadText[1].replace(/,/g, ''), 10);
      }

      const { language, format, size } = extractMetaInformation(meta);

      const link = $el.attr('href') || '';
      const hash = link.match(/^\/md5\/([a-f0-9]{32})(?:[/?#]|$)/i)?.[1]?.toLowerCase() || '';
      if (!hash) return;

      const book: Book = {
        language: language.trim(),
        format: format.trim().replace(/[\[\]]/g, ''), // Remove brackets
        size: size.trim(),
        title: title.trim(),
        publisher: publisher.trim(),
        authors: authors.trim(),
        // Canonicalize edition links onto the configured download origin so a
        // catalog redirect/domain change cannot leave a stale untrusted URL in CSV.
        url: `${ANNAS_DOWNLOAD_BASE_URLS[0]}/md5/${hash}`,
        hash: hash,
        downloadCount: downloadCount,
        searchSource,
      };

      bookList.push(book);
    });

    // The current catalog frontend uses /books/ cards. Its cover filename is
    // the same MD5 accepted by the stable member download API on the download host.
    if (bookList.length === 0) {
      catalogMatchesFound = Math.max(catalogMatchesFound, $('h3 a[href*="/books/"]').length);
      $('h3 a[href*="/books/"]').each((_, element) => {
        const $titleLink = $(element);
        const $card = $titleLink.parents('div').filter((__, parent) => ($(parent).attr('class') || '').includes('bg-white')).first();
        const details = $titleLink.parent().next('div').text().replace(/\s+/g, ' ').trim().split('·').map((part) => part.trim());
        const imageUrl = $card.find('img').first().attr('src') || '';
        const hash = imageUrl.match(/\/([a-f0-9]{32})\.[a-z0-9]+(?:\?|$)/i)?.[1]?.toLowerCase() || '';
        if (!hash) return;
        const yearIndex = details.findIndex((part) => /^\d{4}$/.test(part));
        const format = yearIndex >= 0 ? details[yearIndex + 1] || '' : '';
        const size = yearIndex >= 0 ? details[yearIndex + 2] || '' : '';
        const publisherText = $card.find('div').filter((__, child) => $(child).text().trim().startsWith('Publisher:')).first().text().trim();
        bookList.push({
          title: $titleLink.text().trim(), authors: details[0] || '', publisher: publisherText.replace(/^Publisher:\s*/i, ''),
          language: '', format, size, hash, downloadCount: 0,
          url: `${ANNAS_DOWNLOAD_BASE_URLS[0]}/md5/${hash}`,
          searchSource,
        });
      });
    }

    if (bookList.length === 0) {
      const withoutSubtitle = query.replace(/\s*:\s*.+$/, '').trim();
      const withoutVolume = query.replace(/,?\s+Volume\s+(?:[IVX]+|\d+)(?:\s*:.*)?$/i, '').trim();
      const withoutAccents = query.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
      const meaningfulWords = withoutAccents.split(/[^a-z0-9]+/i).filter((word) => word && !new Set(['a', 'an', 'and', 'of', 'on', 'the', 'to', 'with']).has(word.toLowerCase()));
      const fallbacks = [withoutSubtitle, withoutVolume, withoutAccents];
      for (let length = Math.min(3, meaningfulWords.length - 1); length >= 2; length--) fallbacks.push(meaningfulWords.slice(0, length).join(' '));
      const fallbackQuery = fallbacks.find((candidate) => candidate && !attemptedQueries.has(candidate.toLowerCase()));
      if (fallbackQuery) return findBook(fallbackQuery, attemptedQueries, catalogMatchesFound, catalogIndex, catalogBaseURLs, searchSource);
      if (catalogMatchesFound > 0) {
        throw new CatalogMetadataError(`${catalogMatchesFound} catalog match${catalogMatchesFound === 1 ? '' : 'es'} found, but none exposes an MD5 usable by the download API`);
      }
    }

    return bookList;
  } catch (error: any) {
    const canTryNextCatalog = catalogIndex + 1 < catalogBaseURLs.length
      && (error.response?.status === 403 || error.response?.status >= 500 || ['ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET'].includes(error.code));
    if (canTryNextCatalog) return findBook(query, attemptedQueries, catalogMatchesFound, catalogIndex + 1, catalogBaseURLs, searchSource);
    // Check for 429 rate limit
    if (error.response?.status === 429) {
      const retryAfter = error.response.headers['retry-after']
        ? parseInt(error.response.headers['retry-after'], 10)
        : undefined;
      throw new RateLimitError('Rate limit exceeded (429)', retryAfter);
    }
    if (error instanceof CatalogMetadataError || error instanceof SearchAccessError) throw error;
    if (error.response?.status === 403) {
      throw new SearchAccessError('Anna\'s Archive blocked automated search with a browser verification challenge (HTTP 403). This is separate from the fast-download quota. Stop the scan and try again later, or configure an official working catalog domain with ANNAS_BASE_URL.');
    }
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      throw new Error('Book search timed out. Check your connection and retry this row.');
    }
    if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
      throw new Error('Book search could not reach Anna\'s Archive. Check DNS or internet connectivity.');
    }
    if (error.response?.status) {
      throw new Error(`Book search service returned HTTP ${error.response.status}. Retry later or verify that the search service is available.`);
    }
    throw new Error(`Book search failed: ${error.message || String(error)}`);
  }
}

/**
 * Verify that a downloaded file exists and is valid
 */
export function verifyDownload(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) {
      return false;
    }
    const stats = fs.statSync(filePath);
    if (stats.size === 0) return false;
    const extension = path.extname(filePath).toLowerCase();
    if (extension !== '.pdf' && extension !== '.epub') return true;
    const descriptor = fs.openSync(filePath, 'r');
    try {
      const signature = Buffer.alloc(5);
      const bytesRead = fs.readSync(descriptor, signature, 0, signature.length, 0);
      if (extension === '.pdf') return bytesRead >= 5 && signature.toString('ascii') === '%PDF-';
      return bytesRead >= 4 && signature.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    return false;
  }
}

/**
 * Download a book to specified folder
 */
export async function downloadBook(
  book: Book,
  secretKey: string,
  folderPath: string,
  onProgress?: (progress: number, transfer?: TransferInfo) => void,
  signal?: AbortSignal
): Promise<string> {
  const extension = book.format.trim().replace(/^\.+/, '');
  if (!extension) throw new Error('Failed to download book: The selected edition does not specify a file format');
  const filename = safeDownloadFilename(book.title, extension, book.hash);
  const filePath = path.join(folderPath, filename);
  const partialPath = `${filePath}.part`;
  const failures: string[] = [];

  const getDownloadResponse = async (downloadUrl: string) => {
    const originalURL = new URL(downloadUrl);
    if (originalURL.protocol !== 'https:' || originalURL.username || originalURL.password) {
      throw new Error('Download URL must be a credential-free HTTPS URL');
    }
    try {
      return await axios.get(downloadUrl, { responseType: 'stream' as const, signal, timeout: FILE_REQUEST_TIMEOUT_MS });
    } catch (error: any) {
      if (error.code !== 'ENOTFOUND') throw error;
      const parsed = new URL(downloadUrl);
      const dnsResponse = await axios.get('https://dns.google/resolve', { params: { name: parsed.hostname, type: 'A' }, signal });
      const address = dnsResponse.data?.Answer?.find((answer: any) => answer.type === 1)?.data;
      if (!address) throw error;
      parsed.hostname = address;
      return axios.get(parsed.toString(), {
        responseType: 'stream' as const,
        signal,
        timeout: FILE_REQUEST_TIMEOUT_MS,
        headers: { Host: new URL(downloadUrl).hostname },
        httpsAgent: new https.Agent({ servername: new URL(downloadUrl).hostname }),
      });
    }
  };

  const attemptUrl = async (downloadUrl: string, route: TransferInfo['route']): Promise<string> => {
    const downloadResp = await getDownloadResponse(downloadUrl);
    const contentType = String(downloadResp.headers['content-type'] || '').toLowerCase();
    if (downloadResp.status !== 200 || contentType.includes('text/html')) throw new Error(`Download endpoint returned ${downloadResp.status} ${contentType || 'without a file type'}`);
    const contentLength = Number(downloadResp.headers['content-length']) || 0;
    let downloadedBytes = 0;
    const startedAt = Date.now();
    let lastDataAt = startedAt;
    const monitor = setInterval(() => {
      const now = Date.now();
      const elapsedSeconds = Math.max((now - startedAt) / 1000, 0.001);
      const bytesPerSecond = downloadedBytes / elapsedSeconds;
      if (now - lastDataAt >= STALL_TIMEOUT_MS) {
        downloadResp.data.destroy(new Error(`${route} download stalled for ${STALL_TIMEOUT_MS / 1000} seconds`));
      } else if (now - startedAt >= SPEED_CHECK_AFTER_MS && bytesPerSecond < MIN_TRANSFER_BYTES_PER_SECOND) {
        downloadResp.data.destroy(new Error(`${route} download too slow (${formatTransferSpeed(bytesPerSecond)})`));
      }
    }, 5_000);
    monitor.unref?.();
    downloadResp.data.on('data', (chunk: Buffer) => {
      downloadedBytes += chunk.length;
      lastDataAt = Date.now();
      const bytesPerSecond = downloadedBytes / Math.max((lastDataAt - startedAt) / 1000, 0.001);
      if (contentLength > 0) onProgress?.(Math.min(99, Math.round((downloadedBytes / contentLength) * 100)), { route, bytesPerSecond });
    });
    try {
      await pipeline(downloadResp.data, fs.createWriteStream(partialPath));
      const writtenSize = fs.statSync(partialPath).size;
      if (writtenSize === 0) throw new Error('Downloaded file is empty');
      if (contentLength > 0 && writtenSize !== contentLength) throw new Error(`Incomplete download: expected ${contentLength} bytes but received ${writtenSize}`);
      fs.renameSync(partialPath, filePath);
      const bytesPerSecond = writtenSize / Math.max((Date.now() - startedAt) / 1000, 0.001);
      onProgress?.(100, { route, bytesPerSecond });
      console.log(`  Transfer: ${route} route at ${formatTransferSpeed(bytesPerSecond)}`);
      return filePath;
    } catch (error) {
      if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
      throw error;
    } finally {
      clearInterval(monitor);
    }
  };

  // Prefer the authenticated fast API. A confirmed quota response pauses the
  // entire run; only non-quota fast failures are eligible for slow fallback.
  for (const downloadBaseURL of ANNAS_DOWNLOAD_BASE_URLS) {
    const apiURL = `${downloadBaseURL}/dyn/api/fast_download.json`;
    for (const domainIndex of FAST_DOWNLOAD_DOMAIN_INDEXES) {
      let apiResp;
      try {
        apiResp = await axios.get<FastDownloadResponse>(apiURL, {
          params: { md5: book.hash, key: secretKey, domain_index: domainIndex },
          signal,
          timeout: REQUEST_TIMEOUT_MS,
        });
        if (!apiResp.data.download_url) {
          const message = apiResp.data.error || 'Fast-download URL unavailable';
          if (/\b(?:daily\s+)?limit\b|\bquota\b|too many fast downloads/i.test(message)) throw new RateLimitError(message);
          throw new Error(message);
        }
      } catch (error: any) {
        if (optionsAbort(error, signal)) throw error;
        if (error instanceof RateLimitError) throw error;
        if (error.response?.status === 429) {
          const retryAfter = error.response.headers?.['retry-after'] ? Number(error.response.headers['retry-after']) : undefined;
          throw new RateLimitError(error.response.data?.error || 'Fast-download limit reached (429)', retryAfter);
        }
        failures.push(`fast API ${new URL(downloadBaseURL).hostname} domain ${domainIndex}: ${error.message || error}`);
        if (error.response?.status === 401 || error.response?.status === 403) break;
        continue;
      }

      const mirrorHost = new URL(apiResp.data.download_url!).hostname;
      try {
        return await attemptUrl(apiResp.data.download_url!, 'fast');
      } catch (error: any) {
        if (optionsAbort(error, signal)) throw error;
        failures.push(`fast mirror ${mirrorHost} domain ${domainIndex}: ${error.message || error}`);
      }
    }
  }

  // Probe the slow partner links exposed on the edition page in order.
  for (const downloadBaseURL of ANNAS_DOWNLOAD_BASE_URLS) {
    try {
      const editionUrl = `${downloadBaseURL}/md5/${book.hash}`;
      if (!isTrustedAnnaURL(editionUrl, `/md5/${book.hash}`)) throw new Error('Refusing to request an untrusted edition URL');
      const editionResponse = await axios.get(editionUrl, { signal, timeout: REQUEST_TIMEOUT_MS });
      const page = cheerio.load(editionResponse.data);
      const slowUrls = [...new Set(page('a[href^="/slow_download/"]').map((_index, element) => new URL(page(element).attr('href')!, downloadBaseURL).toString()).get())];
      for (const slowUrl of slowUrls) {
        try { return await attemptUrl(slowUrl, 'slow'); }
        catch (error: any) {
          if (optionsAbort(error, signal)) throw error;
          failures.push(`slow ${new URL(downloadBaseURL).hostname}: ${error.message || error}`);
        }
      }
      if (!slowUrls.length) failures.push(`slow ${new URL(downloadBaseURL).hostname}: no slow partner links were available`);
    } catch (error: any) {
      if (optionsAbort(error, signal)) throw error;
      failures.push(`slow probe ${new URL(downloadBaseURL).hostname}: ${error.message || error}`);
    }
  }
  throw new Error(`Failed to download book: ${failures.join(' | ')}`);
}

/**
 * Convert book to string representation
 */
export function bookToString(book: Book): string {
  return `Title: ${book.title}
Authors: ${book.authors}
Publisher: ${book.publisher}
Language: ${book.language}
Format: ${book.format}
Size: ${book.size}
URL: ${book.url}
Hash: ${book.hash}`;
}

/**
 * Convert book to JSON string
 */
export function bookToJSON(book: Book): string {
  return JSON.stringify(book, null, 2);
}

/**
 * Read and parse CSV file containing book information
 */
export function readCSV(csvPath: string): CSVRow[] {
  const fileContent = fs.readFileSync(csvPath, 'utf-8');

  return parseCSVContent(fileContent);
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function displayLanguage(code: string): string {
  const names: Record<string, string> = { en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese' };
  const normalized = code.trim().toLowerCase();
  return normalized ? `${names[normalized] || code} [${code}]` : '';
}

/** Query the local Anna metadata index and return only records exposed through Anna's download service. */
export function findBookInLocalMetadata(title: string, author: string, databasePath: string, limit = 50): Book[] {
  if (!fs.existsSync(databasePath) || !fs.statSync(databasePath).isFile()) {
    throw new Error(`Local metadata index not found: ${databasePath}`);
  }
  return searchLocalMetadata(databasePath, title, author, limit)
    .filter((candidate) => candidate.hasAaDownload && candidate.extension)
    .map((candidate) => ({
      language: displayLanguage(candidate.language),
      format: candidate.extension.toUpperCase(),
      size: formatFileSize(candidate.filesize),
      title: candidate.title,
      publisher: candidate.publisher,
      authors: candidate.author,
      url: `${ANNAS_DOWNLOAD_BASE_URLS[0]}/md5/${candidate.md5}`,
      hash: candidate.md5,
      downloadCount: 0,
      sourceRank: candidate.sourceRank,
      searchSource: 'local_metadata',
    }));
}

async function findBooksForRow(
  title: string,
  author: string,
  config: Config,
  isUsable: (books: Book[]) => boolean = (books) => books.length > 0
): Promise<Book[]> {
  let localBooks: Book[] | undefined;
  if (config.metadataIndex) {
    // A configured local index is always queried first. Only a valid-but-
    // unhelpful local result set may proceed to an explicitly enabled fallback;
    // index access/corruption errors remain visible and never leak a title.
    localBooks = findBookInLocalMetadata(title, author, config.metadataIndex);
    if (isUsable(localBooks) || !config.untrustedCatalogSearch) return localBooks;
  }
  if (!config.untrustedCatalogSearch) {
    throw new SearchProviderConfigurationError(
      'No metadata search provider is enabled. Configure ANNA_METADATA_INDEX, or explicitly opt in to the untrusted catalog with ENABLE_UNTRUSTED_CATALOG_SEARCH=true.'
    );
  }
  const books = await findBook(
    buildBookSearchQuery(author, title),
    new Set<string>(),
    0,
    0,
    UNTRUSTED_CATALOG_BASE_URLS,
    'untrusted_catalog'
  );
  return books.filter((book) => ['pdf', 'epub'].includes(book.format.trim().toLowerCase()));
}

export function parseCSVContent(fileContent: string): CSVRow[] {
  return parse(fileContent, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as CSVRow[];
}

/**
 * Update CSV file with status for a specific row
 */
const MANAGED_DIAGNOSTIC_COLUMNS = [
  'status', 'error', 'matched_title', 'matched_author', 'match_confidence', 'download_route', 'average_speed',
  'selected_hash', 'selected_url', 'selected_title', 'selected_authors', 'selected_publisher', 'selected_language', 'selected_format', 'selected_size', 'selected_source',
] as const;
const MANAGED_CSV_COLUMNS = ['author', 'title', ...MANAGED_DIAGNOSTIC_COLUMNS] as const;

export function updateCSVResult(
  csvPath: string,
  rowIndex: number,
  result: Partial<Pick<CSVRow, typeof MANAGED_DIAGNOSTIC_COLUMNS[number]>>
): void {
  // Always merge into the latest on-disk copy. Long-running scans/downloads
  // must not overwrite a manual match selection made after their initial read.
  const rows = readCSV(csvPath);
  if (rowIndex >= 0 && rowIndex < rows.length) Object.assign(rows[rowIndex], result);
  const originalColumns = rows.flatMap((row) => Object.keys(row));
  const columns = [...new Set([...originalColumns, ...MANAGED_CSV_COLUMNS])];
  const output = stringify(rows, {
    header: true,
    columns,
  });
  const temporaryPath = `${csvPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, output, 'utf-8');
    fs.renameSync(temporaryPath, csvPath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

/**
 * Load configuration from environment variables
 */
export function loadConfig(options: { requireSecretKey?: boolean } = {}): Config {
  const secretKey = process.env.ANNAS_SECRET_KEY;
  const outputFolder = process.env.OUTPUT_FOLDER || './downloads';
  const maxDownloadsValue = process.env.MAX_DOWNLOADS?.trim();
  const maxDownloads = maxDownloadsValue ? Number(maxDownloadsValue) : undefined;
  const metadataIndex = process.env.ANNA_METADATA_INDEX?.trim();
  const untrustedCatalogSearch = /^(?:1|true|yes|on)$/i.test(process.env.ENABLE_UNTRUSTED_CATALOG_SEARCH?.trim() || '');

  if ((options.requireSecretKey ?? true) && !secretKey) {
    throw new Error('ANNAS_SECRET_KEY environment variable is required');
  }
  if (maxDownloads !== undefined && (!Number.isInteger(maxDownloads) || maxDownloads <= 0)) {
    throw new Error('MAX_DOWNLOADS must be a positive integer');
  }

  // Create output folder if it doesn't exist
  if (!fs.existsSync(outputFolder)) {
    fs.mkdirSync(outputFolder, { recursive: true });
  }

  const config: Config = {
    secretKey: secretKey || '',
    outputFolder,
    preferredLanguage: process.env.PREFERRED_LANGUAGE,
    preferredPublisher: process.env.PREFERRED_PUBLISHER,
    maxDownloads,
  };
  if (metadataIndex) config.metadataIndex = path.resolve(metadataIndex);
  if (untrustedCatalogSearch) config.untrustedCatalogSearch = true;
  return config;
}

/**
 * Filter books based on preferences
 */
export function filterBooks(books: Book[], config: Config): Book | null {
  if (books.length === 0) return null;

  let filtered = [...books]; // Create a copy to avoid mutating the original array

  // Filter by language if specified
  if (config.preferredLanguage) {
    const byLanguage = filtered.filter(
      (b) => b.language.toLowerCase() === config.preferredLanguage!.toLowerCase()
    );
    if (byLanguage.length > 0) filtered = byLanguage;
  }

  // Formatless results cannot produce a safe output filename.
  filtered = filtered.filter((book) => book.format.trim());

  filtered.sort((left, right) => right.downloadCount - left.downloadCount);

  return filtered[0] || null;
}

/**
 * Process CSV and download all books
 */
export async function processCSV(
  csvPath: string,
  config: Config,
  options: ProcessOptions = {}
): Promise<void> {
  const rows = readCSV(csvPath);
  const totalBooks = rows.length;
  const maxDownloads = config.maxDownloads;

  console.log(`Found ${totalBooks} books in CSV`);
  if (maxDownloads) {
    console.log(`Download limit: ${maxDownloads} books\n`);
  } else {
    console.log('No download limit set\n');
  }

  let successCount = 0;
  let failCount = 0;
  let skippedCount = 0;
  const pendingReviews: Array<{ rowIndex: number; book: Book; confidence: number }> = [];
  const startIndex = Math.min(rows.length, Math.max(0, Math.floor(options.startIndex || 0)));

  for (let i = startIndex; i < rows.length; i++) {
    if (options.signal?.aborted) break;
    // Re-read the current row so selections made while an earlier row was
    // downloading are honored instead of being replaced by this run's snapshot.
    const row = readCSV(csvPath)[i];
    const bookNum = i + 1;

    // Skip if already downloaded or explicitly rejected during match review
    const existingStatus = row.status?.trim().toLowerCase();
    if (existingStatus === 'downloaded' || existingStatus === 'rejected') {
      console.log(`[${bookNum}/${totalBooks}] Skipping "${row.title}" by ${row.author} (${existingStatus})`);
      options.onEvent?.({ rowIndex: i, status: existingStatus === 'downloaded' ? 'completed' : 'skipped', progress: existingStatus === 'downloaded' ? 100 : 0 });
      skippedCount++;
      continue;
    }

    // Check if we've reached the download limit
    if (maxDownloads && successCount >= maxDownloads) {
      console.log(`\nReached download limit of ${maxDownloads} books. Stopping.`);
      break;
    }

    console.log(`[${bookNum}/${totalBooks}] Processing: "${row.title}" by ${row.author}`);

    try {
      let selectedBook: Book;

      if (row.selected_hash) {
        // Already reviewed and chosen during a preliminary match scan — download it directly.
        selectedBook = {
          title: row.selected_title || row.title,
          authors: row.selected_authors || row.author,
          publisher: row.selected_publisher || '',
          language: row.selected_language || '',
          format: row.selected_format || '',
          size: row.selected_size || '',
          url: row.selected_url || '',
          hash: row.selected_hash,
          downloadCount: 0,
          searchSource: row.selected_source === 'untrusted_catalog' || row.selected_source === 'local_metadata'
            ? row.selected_source
            : 'preselected',
        };
        console.log(`  📚 Using pre-selected match: ${selectedBook.format} (${selectedBook.size})`);
      } else {
        // Search for the book
        options.onEvent?.({ rowIndex: i, status: 'searching', progress: 0 });
        const books = await findBooksForRow(
          row.title,
          row.author,
          config,
          (localCandidates) => Boolean(selectReliableBook(localCandidates, config, row.title, row.author).book)
        );

        if (books.length === 0) {
          console.log(`  ❌ No results found\n`);
          updateCSVResult(csvPath, i, { status: 'failed', error: 'No results found', matched_title: '', matched_author: '', match_confidence: '' });
          options.onEvent?.({ rowIndex: i, status: 'failed', progress: 0, message: 'No results found' });
          failCount++;
          continue;
        }

        // Filter and select best match
        const selection = selectReliableBook(books, config, row.title, row.author);
        const picked = selection.book;
        if (!picked) {
          console.log(`  ❌ No matching books found after filtering\n`);
          const candidate = selection.bestCandidate;
          const message = candidate
            ? `No reliable match (best: "${candidate.title}", ${Math.round(selection.confidence * 100)}% confidence)`
            : 'No matching edition found';
          updateCSVResult(csvPath, i, { status: 'failed', error: message, matched_title: candidate?.title || '', matched_author: candidate?.authors || '', match_confidence: String(Math.round(selection.confidence * 100)) });
          options.onEvent?.({ rowIndex: i, status: 'failed', progress: 0, message, matchTitle: candidate?.title, matchAuthors: candidate?.authors, confidence: selection.confidence });
          failCount++;
          continue;
        }

        updateCSVResult(csvPath, i, { status: 'matched', error: '', matched_title: picked.title, matched_author: picked.authors, match_confidence: String(Math.round(selection.confidence * 100)) });
        if (picked.searchSource === 'untrusted_catalog') {
          const message = 'Untrusted-catalog match requires manual review before download';
          updateCSVResult(csvPath, i, { status: 'pending_review', error: '', matched_title: picked.title, matched_author: picked.authors, match_confidence: String(Math.round(selection.confidence * 100)) });
          if (options.confirmMatch) pendingReviews.push({ rowIndex: i, book: picked, confidence: selection.confidence });
          options.onEvent?.({ rowIndex: i, status: 'queued', progress: 0, message, format: picked.format, size: picked.size, matchTitle: picked.title, matchAuthors: picked.authors, confidence: selection.confidence });
          continue;
        }
        // Matches above 80% download automatically. Lower reliable matches are
        // deferred so the automatic matching pass can continue to the next row.
        if (options.confirmMatch && selection.confidence <= 0.8) {
          pendingReviews.push({ rowIndex: i, book: picked, confidence: selection.confidence });
          options.onEvent?.({ rowIndex: i, status: 'queued', progress: 0, message: 'Review deferred until automatic matches finish', format: picked.format, size: picked.size, matchTitle: picked.title, matchAuthors: picked.authors, confidence: selection.confidence });
          continue;
        }
        if (options.confirmMatch && selection.confidence > 0.8) {
          options.onEvent?.({ rowIndex: i, status: 'searching', progress: 0, message: 'High-confidence match; downloading automatically', format: picked.format, size: picked.size, matchTitle: picked.title, matchAuthors: picked.authors, confidence: selection.confidence });
        }
        console.log(`  📚 Found: ${picked.format} (${picked.size})`);
        selectedBook = picked;
      }

      // Download the book
      options.onEvent?.({ rowIndex: i, status: 'downloading', progress: 0, format: selectedBook.format, size: selectedBook.size });
      let completedTransfer: TransferInfo | undefined;
      const filePath = await downloadBook(
        selectedBook,
        config.secretKey,
        config.outputFolder,
        (progress, transfer) => {
          if (transfer) completedTransfer = transfer;
          options.onEvent?.({ rowIndex: i, status: 'downloading', progress, format: selectedBook.format, size: selectedBook.size, message: transfer ? `${transfer.route} route · ${formatTransferSpeed(transfer.bytesPerSecond)}` : undefined });
        },
        options.signal
      );

      if (verifyDownload(filePath)) {
        console.log(`  ✅ Downloaded and verified successfully\n`);
        updateCSVResult(csvPath, i, { status: 'downloaded', error: '', download_route: completedTransfer?.route || '', average_speed: completedTransfer ? formatTransferSpeed(completedTransfer.bytesPerSecond) : '' });
        options.onEvent?.({ rowIndex: i, status: 'completed', progress: 100, format: selectedBook.format, size: selectedBook.size });
        successCount++;
      } else {
        console.log(`  ❌ Download verification failed\n`);
        updateCSVResult(csvPath, i, { status: 'failed', error: 'Download verification failed' });
        options.onEvent?.({ rowIndex: i, status: 'failed', progress: 0, message: 'Download verification failed' });
        failCount++;
      }
    } catch (error) {
      // Handle rate limiting
      if (error instanceof RateLimitError) {
        updateCSVResult(csvPath, i, { status: 'queued', error: error.message });
        options.onEvent?.({ rowIndex: i, status: 'queued', progress: 0, message: error.message });
        console.log(`\n${'='.repeat(50)}`);
        console.log(`⚠️  RATE LIMIT EXCEEDED (429)`);
        console.log(`Anna's Archive has rate limited this application.`);
        if (error.retryAfter) {
          console.log(`Retry after: ${error.retryAfter} seconds`);
        }
        console.log(`\nStopping downloads. Summary:`);
        console.log(`  ✅ ${successCount} succeeded`);
        console.log(`  ❌ ${failCount} failed`);
        console.log(`  ⏭️  ${skippedCount} skipped`);
        console.log(`${'='.repeat(50)}`);
        throw error;
      }

      if (options.signal?.aborted || axios.isCancel(error)) break;

      console.log(`  ❌ Error: ${error}\n`);
      const message = error instanceof Error ? error.message : String(error);
      updateCSVResult(csvPath, i, { status: 'failed', error: message });
      options.onEvent?.({ rowIndex: i, status: 'failed', progress: 0, message });
      failCount++;
    }

    // Add a small delay between requests
    if (i < rows.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  // Review lower-confidence matches after the automatic matching pass.
  for (const pending of pendingReviews) {
    if (options.signal?.aborted || (maxDownloads && successCount >= maxDownloads)) break;
    const { rowIndex, book, confidence } = pending;
    options.onEvent?.({ rowIndex, status: 'awaiting_confirmation', progress: 0, format: book.format, size: book.size, matchTitle: book.title, matchAuthors: book.authors, confidence });
    const decision = await options.confirmMatch!(rowIndex, book, confidence);
    if (options.signal?.aborted) break;
    if (decision === 'skip') {
      updateCSVResult(csvPath, rowIndex, { status: 'skipped', error: 'Skipped by user' });
      options.onEvent?.({ rowIndex, status: 'skipped', progress: 0, message: 'Skipped by user', matchTitle: book.title, matchAuthors: book.authors, confidence });
      skippedCount++;
      continue;
    }
    try {
      options.onEvent?.({ rowIndex, status: 'downloading', progress: 0, format: book.format, size: book.size, matchTitle: book.title, matchAuthors: book.authors, confidence });
      let completedTransfer: TransferInfo | undefined;
      const filePath = await downloadBook(book, config.secretKey, config.outputFolder,
        (progress, transfer) => {
          if (transfer) completedTransfer = transfer;
          options.onEvent?.({ rowIndex, status: 'downloading', progress, format: book.format, size: book.size, matchTitle: book.title, matchAuthors: book.authors, confidence, message: transfer ? `${transfer.route} route · ${formatTransferSpeed(transfer.bytesPerSecond)}` : undefined });
        }, options.signal);
      if (!verifyDownload(filePath)) throw new Error('Download verification failed');
      updateCSVResult(csvPath, rowIndex, { status: 'downloaded', error: '', download_route: completedTransfer?.route || '', average_speed: completedTransfer ? formatTransferSpeed(completedTransfer.bytesPerSecond) : '' });
      options.onEvent?.({ rowIndex, status: 'completed', progress: 100, format: book.format, size: book.size, matchTitle: book.title, matchAuthors: book.authors, confidence });
      successCount++;
    } catch (error) {
      if (options.signal?.aborted || axios.isCancel(error)) break;
      if (error instanceof RateLimitError) {
        updateCSVResult(csvPath, rowIndex, { status: 'queued', error: error.message });
        options.onEvent?.({ rowIndex, status: 'queued', progress: 0, message: error.message, matchTitle: book.title, matchAuthors: book.authors, confidence });
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      updateCSVResult(csvPath, rowIndex, { status: 'failed', error: message });
      options.onEvent?.({ rowIndex, status: 'failed', progress: 0, message, matchTitle: book.title, matchAuthors: book.authors, confidence });
      failCount++;
    }
  }
  console.log('='.repeat(50));
  console.log(`Download complete:`);
  console.log(`  ✅ ${successCount} succeeded`);
  console.log(`  ❌ ${failCount} failed`);
  console.log(`  ⏭️  ${skippedCount} skipped`);
  console.log('='.repeat(50));
}

/**
 * Search and rank editions for a single CSV row, without writing anything.
 */
export async function findRowCandidates(row: CSVRow, config: Config): Promise<MatchCandidate[]> {
  const titleOnly = isPlaceholderAuthor(row.author);
  const rankUsable = (books: Book[]) => rankCandidates(books, config, row.title, row.author)
    .filter((candidate) => candidate.titleScore >= 0.45 && candidate.confidence >= 0.45 && (titleOnly || candidate.authorScore >= 0.3))
    .slice(0, 10);
  const books = await findBooksForRow(row.title, row.author, config, (localCandidates) => rankUsable(localCandidates).length > 0);
  return rankUsable(books);
}

/** Persist a chosen edition as the durable, download-ready match for a row. */
export function applySelectedMatch(csvPath: string, rowIndex: number, candidate: MatchCandidate): void {
  updateCSVResult(csvPath, rowIndex, {
    status: 'matched',
    error: '',
    matched_title: candidate.book.title,
    matched_author: candidate.book.authors,
    match_confidence: String(Math.round(candidate.confidence * 100)),
    selected_hash: candidate.book.hash,
    selected_url: candidate.book.url,
    selected_title: candidate.book.title,
    selected_authors: candidate.book.authors,
    selected_publisher: candidate.book.publisher,
    selected_language: candidate.book.language,
    selected_format: candidate.book.format,
    selected_size: candidate.book.size,
    selected_source: candidate.book.searchSource || '',
  });
}

/** Durably record that none of the reviewed candidates were acceptable for a row. */
export function rejectRowMatch(csvPath: string, rowIndex: number, reason = 'No acceptable match found'): void {
  updateCSVResult(csvPath, rowIndex, {
    status: 'rejected',
    error: reason,
    selected_hash: '',
    selected_url: '',
    selected_title: '',
    selected_authors: '',
    selected_publisher: '',
    selected_language: '',
    selected_format: '',
    selected_size: '',
    selected_source: '',
  });
}

export type MatchStatus = 'scanning' | 'matched' | 'needs_review' | 'rejected' | 'failed';

export interface MatchEvent {
  rowIndex: number;
  status: MatchStatus;
  message?: string;
  candidates?: MatchCandidate[];
  selected?: MatchCandidate;
}

export interface ScanOptions {
  signal?: AbortSignal;
  onEvent?: (event: MatchEvent) => void;
  startIndex?: number;
}

export interface RescanReset {
  rows: CSVRow[];
  rowsReset: number;
  downloadedPreserved: number;
}

/**
 * Return a fresh scan queue while retaining confirmed files the user already
 * owns. Rejections are reset because a new provider/index may yield new choices.
 */
export function resetRowsForRescan(rows: CSVRow[]): RescanReset {
  let rowsReset = 0;
  let downloadedPreserved = 0;
  const resetFields: Partial<CSVRow> = {
    status: 'Not started',
    error: '',
    matched_title: '',
    matched_author: '',
    match_confidence: '',
    download_route: '',
    average_speed: '',
    selected_hash: '',
    selected_url: '',
    selected_title: '',
    selected_authors: '',
    selected_publisher: '',
    selected_language: '',
    selected_format: '',
    selected_size: '',
    selected_source: '',
  };
  const resetRows = rows.map((row) => {
    const status = row.status?.trim().toLowerCase();
    if (status === 'downloaded') {
      downloadedPreserved += 1;
      return { ...row };
    }
    rowsReset += 1;
    return { ...row, ...resetFields };
  });
  return { rows: resetRows, rowsReset, downloadedPreserved };
}

/**
 * Search and rank every not-yet-decided CSV row, auto-accepting exact matches and
 * leaving everything else for manual review via applySelectedMatch/rejectRowMatch.
 * Does not download anything.
 */
export async function scanMatches(csvPath: string, config: Config, options: ScanOptions = {}): Promise<void> {
  const rows = readCSV(csvPath);
  const startIndex = Math.min(rows.length, Math.max(0, Math.floor(options.startIndex || 0)));

  for (let i = startIndex; i < rows.length; i++) {
    if (options.signal?.aborted) break;
    const row = readCSV(csvPath)[i];
    const status = row.status?.trim().toLowerCase();
    if (status === 'downloaded' || status === 'rejected' || status === 'matched' || row.selected_hash) continue;

    options.onEvent?.({ rowIndex: i, status: 'scanning' });

    try {
      const candidates = await findRowCandidates(row, config);

      const top = candidates[0];
      // With no preferred publisher configured, a scan behaves like a normal download run
      // (anything above the standard 80% confidence auto-accepts). Once a preferred publisher
      // is set, only a token-exact match auto-accepts, so everything else surfaces for review —
      // giving the user a chance to notice and pick a preferred-publisher edition among the top 10.
      const autoAccept = top
        && top.book.searchSource !== 'untrusted_catalog'
        && (top.isExactMatch || (!config.preferredPublisher?.trim() && top.confidence > 0.8));

      if (candidates.length === 0) {
        const message = 'No sufficiently close downloadable match found';
        updateCSVResult(csvPath, i, { status: 'failed', error: message, matched_title: '', matched_author: '', match_confidence: '' });
        options.onEvent?.({ rowIndex: i, status: 'failed', message });
      } else if (autoAccept) {
        applySelectedMatch(csvPath, i, candidates[0]);
        options.onEvent?.({ rowIndex: i, status: 'matched', candidates, selected: candidates[0] });
      } else {
        updateCSVResult(csvPath, i, {
          status: 'pending_review',
          error: '',
          matched_title: candidates[0].book.title,
          matched_author: candidates[0].book.authors,
          match_confidence: String(Math.round(candidates[0].confidence * 100)),
        });
        options.onEvent?.({ rowIndex: i, status: 'needs_review', candidates });
      }
    } catch (error) {
      if (options.signal?.aborted) break;
      if (error instanceof RateLimitError || error instanceof SearchAccessError) {
        options.onEvent?.({ rowIndex: i, status: 'failed', message: error.message });
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      updateCSVResult(csvPath, i, { status: 'failed', error: message, matched_title: '', matched_author: '', match_confidence: '' });
      options.onEvent?.({ rowIndex: i, status: 'failed', message });
    }

    if (!config.metadataIndex && i < rows.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: node main.ts <csv-file-path>');
    console.error('\nEnvironment variables:');
    console.error('  ANNAS_SECRET_KEY (required) - Your Anna\'s Archive secret key');
    console.error('  OUTPUT_FOLDER (optional) - Download destination (default: ./downloads)');
    console.error('  PREFERRED_LANGUAGE (optional) - Preferred language (e.g., English)');
    process.exit(1);
  }

  const csvPath = args[0];

  if (!fs.existsSync(csvPath)) {
    console.error(`Error: CSV file not found: ${csvPath}`);
    process.exit(1);
  }

  try {
    const config = loadConfig();
    await processCSV(csvPath, config);
  } catch (error) {
    console.error(`Error: ${error}`);
    process.exit(1);
  }
}

// Run main function if this is the entry point
if (require.main === module) {
  main();
}

const MATCH_STOP_WORDS = new Set(['a', 'an', 'and', 'by', 'for', 'in', 'of', 'on', 'the', 'to', 'with']);

/** Author labels that describe an unknown or collective origin rather than searchable metadata. */
export function isPlaceholderAuthor(author: string): boolean {
  return /\banonymous\b|\btradition(?:al)?\b/i.test(author);
}

export function buildBookSearchQuery(author: string, title: string): string {
  // The current catalog search treats an author-plus-title string as an overly
  // narrow phrase and often returns no results. Search broadly by title, then
  // let rankCandidates validate and score the author independently.
  return title.trim();
}

export function parseFileSizeBytes(size: string): number {
  const match = size.trim().match(/^([\d.,]+)\s*(B|KB|KIB|MB|MIB|GB|GIB|TB|TIB)$/i);
  if (!match) return Number.POSITIVE_INFINITY;
  const value = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY;
  const unit = match[2].toUpperCase();
  const powers: Record<string, number> = {
    B: 0, KB: 1, KIB: 1, MB: 2, MIB: 2, GB: 3, GIB: 3, TB: 4, TIB: 4,
  };
  return value * (1024 ** powers[unit]);
}


function matchTokens(value: string): string[] {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)
    .filter((token) => token && !MATCH_STOP_WORDS.has(token));
}

export function textSimilarity(expected: string, candidate: string): number {
  const expectedTokens = new Set(matchTokens(expected));
  const candidateTokens = new Set(matchTokens(candidate));
  if (!expectedTokens.size || !candidateTokens.size) return 0;
  const intersection = [...expectedTokens].filter((token) => candidateTokens.has(token)).length;
  const coverage = intersection / expectedTokens.size;
  const union = new Set([...expectedTokens, ...candidateTokens]).size;
  return (coverage * 0.7) + ((intersection / union) * 0.3);
}

export interface MatchSelection {
  book: Book | null;
  confidence: number;
  titleScore: number;
  authorScore: number;
  bestCandidate: Book | null;
}

/** Editions from the configured preferred publisher rank slightly higher among otherwise-comparable candidates. */
const PUBLISHER_PREFERENCE_BOOST = 0.05;

export function isPreferredPublisher(publisher: string, preferredPublisher?: string): boolean {
  const preference = preferredPublisher?.trim();
  if (!preference) return false;
  return publisher.toLowerCase().includes(preference.toLowerCase());
}

export interface MatchCandidate {
  book: Book;
  titleScore: number;
  authorScore: number;
  confidence: number;
  /** Token-exact title match (and author match, unless the requested author is a placeholder like "Anonymous"). */
  isExactMatch: boolean;
}

/**
 * Rank all eligible editions for a requested title/author by relevance.
 * Filters out formatless editions and, when possible, editions outside the preferred language.
 * Sorting applies the preferred-publisher boost, but the returned `confidence` stays unboosted.
 */
export function rankCandidates(
  books: Book[],
  config: Config,
  expectedTitle: string,
  expectedAuthor: string
): MatchCandidate[] {
  const titleOnly = isPlaceholderAuthor(expectedAuthor);
  let filtered = [...books];
  if (config.preferredLanguage) {
    const preference = config.preferredLanguage.toLowerCase();
    const matching = filtered.filter((book) => book.language.toLowerCase().startsWith(preference));
    if (matching.length) filtered = matching;
  }
  filtered = filtered.filter((book) => book.format.trim());

  return filtered.map((book) => {
    const titleScore = textSimilarity(expectedTitle, book.title);
    const authorScore = titleOnly ? 0 : textSimilarity(expectedAuthor, book.authors);
    const confidence = titleOnly ? titleScore : (titleScore * 0.8) + (authorScore * 0.2);
    const isExactMatch = titleScore >= 0.999 && (titleOnly || authorScore >= 0.999);
    return { book, titleScore, authorScore, confidence, isExactMatch };
  }).sort((left, right) => {
    const leftRank = left.confidence + (isPreferredPublisher(left.book.publisher, config.preferredPublisher) ? PUBLISHER_PREFERENCE_BOOST : 0);
    const rightRank = right.confidence + (isPreferredPublisher(right.book.publisher, config.preferredPublisher) ? PUBLISHER_PREFERENCE_BOOST : 0);
    return rightRank - leftRank
      || right.book.downloadCount - left.book.downloadCount
      || (right.book.sourceRank || 0) - (left.book.sourceRank || 0);
  });
}

export function selectReliableBook(
  books: Book[],
  config: Config,
  expectedTitle: string,
  expectedAuthor: string,
  threshold = 0.62
): MatchSelection {
  const ranked = rankCandidates(books, config, expectedTitle, expectedAuthor);
  const bestCandidate = ranked[0];
  if (!bestCandidate) return { book: null, confidence: 0, titleScore: 0, authorScore: 0, bestCandidate: null };

  const reliable = ranked.filter((candidate) => candidate.titleScore >= 0.6 && candidate.confidence >= threshold);
  const selected = reliable[0];
  if (!selected) {
    return { book: null, confidence: bestCandidate.confidence, titleScore: bestCandidate.titleScore, authorScore: bestCandidate.authorScore, bestCandidate: bestCandidate.book };
  }
  return { book: selected.book, confidence: selected.confidence, titleScore: selected.titleScore, authorScore: selected.authorScore, bestCandidate: selected.book };
}

export type DownloadStatus = 'queued' | 'searching' | 'awaiting_confirmation' | 'downloading' | 'completed' | 'failed' | 'skipped';

export interface DownloadEvent {
  rowIndex: number;
  status: DownloadStatus;
  progress?: number;
  format?: string;
  size?: string;
  message?: string;
  matchTitle?: string;
  matchAuthors?: string;
  confidence?: number;
}

export interface ProcessOptions {
  signal?: AbortSignal;
  onEvent?: (event: DownloadEvent) => void;
  confirmMatch?: (rowIndex: number, book: Book, confidence: number) => Promise<'confirm' | 'skip'>;
  startIndex?: number;
}
