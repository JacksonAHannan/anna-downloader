import 'dotenv/config';
import axios from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import * as https from 'https';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';

// Constants
const ANNAS_BASE_URL = 'https://annas-archive.gl';
const ANNAS_SEARCH_ENDPOINT = `${ANNAS_BASE_URL}/search?q=`;
const ANNAS_DOWNLOAD_ENDPOINT = `${ANNAS_BASE_URL}/dyn/api/fast_download.json`;

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
}

interface FastDownloadResponse {
  download_url?: string;
  error?: string;
}

export interface CSVRow {
  author: string;
  title: string;
  status?: string;
  error?: string;
  matched_title?: string;
  matched_author?: string;
  match_confidence?: string;
  download_route?: string;
  average_speed?: string;
}

export interface TransferInfo {
  route: 'fast' | 'slow';
  bytesPerSecond: number;
}

const FAST_DOWNLOAD_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 20_000;
const STALL_TIMEOUT_MS = 30_000;
const SPEED_CHECK_AFTER_MS = 30_000;
const MIN_TRANSFER_BYTES_PER_SECOND = 32 * 1024;

function formatTransferSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
  return `${Math.round(bytesPerSecond / 1024)} KB/s`;
}

export interface Config {
  secretKey: string;
  outputFolder: string;
  preferredFormat?: string;
  preferredLanguage?: string;
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

/**
 * Find books by search query
 */
export async function findBook(query: string): Promise<Book[]> {
  const encodedQuery = encodeURIComponent(query);
  const fullURL = `${ANNAS_SEARCH_ENDPOINT}${encodedQuery}`;

  try {
    const response = await axios.get(fullURL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    const $ = cheerio.load(response.data);
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
      const hash = link.replace('/md5/', '');

      const book: Book = {
        language: language.trim(),
        format: format.trim().replace(/[\[\]]/g, ''), // Remove brackets
        size: size.trim(),
        title: title.trim(),
        publisher: publisher.trim(),
        authors: authors.trim(),
        url: new URL(link, fullURL).href,
        hash: hash,
        downloadCount: downloadCount,
      };

      bookList.push(book);
    });

    return bookList;
  } catch (error: any) {
    // Check for 429 rate limit
    if (error.response?.status === 429) {
      const retryAfter = error.response.headers['retry-after']
        ? parseInt(error.response.headers['retry-after'], 10)
        : undefined;
      throw new RateLimitError('Rate limit exceeded (429)', retryAfter);
    }
    throw new Error(`Failed to find books: ${error}`);
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
    return stats.size > 0;
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
  const apiURL = `${ANNAS_DOWNLOAD_ENDPOINT}?md5=${book.hash}&key=${secretKey}`;
  const extension = book.format.trim().replace(/^\.+/, '');
  if (!extension) throw new Error('Failed to download book: The selected edition does not specify a file format');
  const filename = `${book.title}.${extension}`.replace(/[<>:"/\\|?*]/g, '').trim();
  const filePath = path.join(folderPath, filename);
  const partialPath = `${filePath}.part`;
  const failures: string[] = [];

  const getDownloadResponse = async (downloadUrl: string) => {
    try {
      return await axios.get(downloadUrl, { responseType: 'stream' as const, signal, timeout: REQUEST_TIMEOUT_MS });
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
        timeout: REQUEST_TIMEOUT_MS,
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
  for (let attempt = 1; attempt <= FAST_DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      const apiResp = await axios.get<FastDownloadResponse>(apiURL, { signal, timeout: REQUEST_TIMEOUT_MS });
      if (!apiResp.data.download_url) {
        const message = apiResp.data.error || 'Fast-download URL unavailable';
        if (/\b(?:daily\s+)?limit\b|\bquota\b|too many fast downloads/i.test(message)) throw new RateLimitError(message);
        throw new Error(message);
      }
      return await attemptUrl(apiResp.data.download_url, 'fast');
    } catch (error: any) {
      if (optionsAbort(error, signal)) throw error;
      if (error instanceof RateLimitError) throw error;
      if (error.response?.status === 429) {
        const retryAfter = error.response.headers?.['retry-after'] ? Number(error.response.headers['retry-after']) : undefined;
        throw new RateLimitError(error.response.data?.error || 'Fast-download limit reached (429)', retryAfter);
      }
      failures.push(`fast attempt ${attempt}: ${error.message || error}`);
      if (error.response?.status === 401 || error.response?.status === 403) break;
      if (attempt < FAST_DOWNLOAD_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }

  // Probe the slow partner links exposed on the edition page in order.
  try {
    const editionResponse = await axios.get(book.url || `${ANNAS_BASE_URL}/md5/${book.hash}`, { signal });
    const page = cheerio.load(editionResponse.data);
    const slowUrls = [...new Set(page('a[href^="/slow_download/"]').map((_index, element) => new URL(page(element).attr('href')!, ANNAS_BASE_URL).toString()).get())];
    for (const slowUrl of slowUrls) {
      try { return await attemptUrl(slowUrl, 'slow'); }
      catch (error: any) {
        if (optionsAbort(error, signal)) throw error;
        failures.push(`slow: ${error.message || error}`);
      }
    }
    if (!slowUrls.length) failures.push('slow: no slow partner links were available');
  } catch (error: any) {
    if (optionsAbort(error, signal)) throw error;
    failures.push(`slow probe: ${error.message || error}`);
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

  const records = parse(fileContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as CSVRow[];

  return records;
}

/**
 * Update CSV file with status for a specific row
 */
export function updateCSVStatus(
  csvPath: string,
  rowIndex: number,
  status: string
): void {
  const rows = readCSV(csvPath);

  // Update the status for the specified row
  if (rowIndex >= 0 && rowIndex < rows.length) {
    rows[rowIndex].status = status;
  }

  // Write back to CSV
  const output = stringify(rows, {
    header: true,
    columns: ['author', 'title', 'status'],
  });

  fs.writeFileSync(csvPath, output, 'utf-8');
}

export function updateCSVResult(
  csvPath: string,
  rowIndex: number,
  result: Partial<Pick<CSVRow, 'status' | 'error' | 'matched_title' | 'matched_author' | 'match_confidence' | 'download_route' | 'average_speed'>>
): void {
  const rows = readCSV(csvPath);
  if (rowIndex >= 0 && rowIndex < rows.length) Object.assign(rows[rowIndex], result);
  const output = stringify(rows, {
    header: true,
    columns: ['author', 'title', 'status', 'error', 'matched_title', 'matched_author', 'match_confidence', 'download_route', 'average_speed'],
  });
  fs.writeFileSync(csvPath, output, 'utf-8');
}

/**
 * Load configuration from environment variables
 */
export function loadConfig(): Config {
  const secretKey = process.env.ANNAS_SECRET_KEY;
  const outputFolder = process.env.OUTPUT_FOLDER || './downloads';
  const maxDownloads = process.env.MAX_DOWNLOADS ? parseInt(process.env.MAX_DOWNLOADS, 10) : undefined;

  if (!secretKey) {
    throw new Error('ANNAS_SECRET_KEY environment variable is required');
  }

  // Create output folder if it doesn't exist
  if (!fs.existsSync(outputFolder)) {
    fs.mkdirSync(outputFolder, { recursive: true });
  }

  return {
    secretKey,
    outputFolder,
    preferredFormat: process.env.PREFERRED_FORMAT,
    preferredLanguage: process.env.PREFERRED_LANGUAGE,
    maxDownloads,
  };
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

  for (let i = 0; i < startIndex; i++) {
    options.onEvent?.({ rowIndex: i, status: 'queued', progress: 0, message: `Before selected start row ${startIndex + 1}` });
  }

  for (let i = startIndex; i < rows.length; i++) {
    if (options.signal?.aborted) break;
    const row = rows[i];
    const bookNum = i + 1;

    // Skip if already downloaded
    if (row.status?.trim().toLowerCase() === 'downloaded') {
      console.log(`[${bookNum}/${totalBooks}] Skipping "${row.title}" by ${row.author} (already downloaded)`);
      options.onEvent?.({ rowIndex: i, status: 'skipped', progress: 100 });
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
      // Search for the book
      options.onEvent?.({ rowIndex: i, status: 'searching', progress: 0 });
      const query = buildBookSearchQuery(row.author, row.title);
      const books = await findBook(query);

      if (books.length === 0) {
        console.log(`  ❌ No results found\n`);
        updateCSVResult(csvPath, i, { status: 'failed', error: 'No results found', matched_title: '', matched_author: '', match_confidence: '' });
        options.onEvent?.({ rowIndex: i, status: 'failed', progress: 0, message: 'No results found' });
        failCount++;
        continue;
      }

      // Filter and select best match
      const selection = selectReliableBook(books, config, row.title, row.author);
      const selectedBook = selection.book;
      if (!selectedBook) {
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

      updateCSVResult(csvPath, i, { status: 'matched', error: '', matched_title: selectedBook.title, matched_author: selectedBook.authors, match_confidence: String(Math.round(selection.confidence * 100)) });
      // Matches above 80% download automatically. Lower reliable matches are
      // deferred so the automatic matching pass can continue to the next row.
      if (options.confirmMatch && selection.confidence <= 0.8) {
        pendingReviews.push({ rowIndex: i, book: selectedBook, confidence: selection.confidence });
        options.onEvent?.({ rowIndex: i, status: 'queued', progress: 0, message: 'Review deferred until automatic matches finish', format: selectedBook.format, size: selectedBook.size, matchTitle: selectedBook.title, matchAuthors: selectedBook.authors, confidence: selection.confidence });
        continue;
      }
      if (options.confirmMatch && selection.confidence > 0.8) {
        options.onEvent?.({ rowIndex: i, status: 'searching', progress: 0, message: 'High-confidence match; downloading automatically', format: selectedBook.format, size: selectedBook.size, matchTitle: selectedBook.title, matchAuthors: selectedBook.authors, confidence: selection.confidence });
      }
      console.log(`  📚 Found: ${selectedBook.format} (${selectedBook.size})`);

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
        updateCSVResult(csvPath, i, { status: 'Not started', error: error.message });
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
        updateCSVResult(csvPath, rowIndex, { status: 'Not started', error: error.message });
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
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: node main.ts <csv-file-path>');
    console.error('\nEnvironment variables:');
    console.error('  ANNAS_SECRET_KEY (required) - Your Anna\'s Archive secret key');
    console.error('  OUTPUT_FOLDER (optional) - Download destination (default: ./downloads)');
    console.error('  PREFERRED_FORMAT (optional) - Preferred format (e.g., pdf, epub)');
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
  return isPlaceholderAuthor(author) ? title.trim() : `${author.trim()} ${title.trim()}`.trim();
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

export function selectReliableBook(
  books: Book[],
  config: Config,
  expectedTitle: string,
  expectedAuthor: string,
  threshold = 0.62
): MatchSelection {
  const titleOnly = isPlaceholderAuthor(expectedAuthor);
  let filtered = [...books];
  if (config.preferredLanguage) {
    const preference = config.preferredLanguage.toLowerCase();
    const matching = filtered.filter((book) => book.language.toLowerCase().startsWith(preference));
    if (matching.length) filtered = matching;
  }
  filtered = filtered.filter((book) => book.format.trim());

  const rankedByConfidence = filtered.map((book) => {
    const titleScore = textSimilarity(expectedTitle, book.title);
    const authorScore = titleOnly ? 0 : textSimilarity(expectedAuthor, book.authors);
    const confidence = titleOnly ? titleScore : (titleScore * 0.8) + (authorScore * 0.2);
    return { book, titleScore, authorScore, confidence };
  }).sort((left, right) => right.confidence - left.confidence || right.book.downloadCount - left.book.downloadCount);
  const bestCandidate = rankedByConfidence[0];
  if (!bestCandidate) return { book: null, confidence: 0, titleScore: 0, authorScore: 0, bestCandidate: null };

  const reliable = rankedByConfidence
    .filter((candidate) => candidate.titleScore >= 0.6 && candidate.confidence >= threshold);
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
