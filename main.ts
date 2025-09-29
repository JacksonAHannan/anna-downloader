import 'dotenv/config';
import axios from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';

// Constants
const ANNAS_SEARCH_ENDPOINT = 'https://annas-archive.org/search?q=';
const ANNAS_DOWNLOAD_ENDPOINT = 'https://annas-archive.org/dyn/api/fast_download.json';

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

interface CSVRow {
  author: string;
  title: string;
  status?: string;
}

interface Config {
  secretKey: string;
  outputFolder: string;
  preferredFormat?: string;
  preferredLanguage?: string;
  maxDownloads?: number;
}

/**
 * Custom error for rate limiting (429 responses)
 */
class RateLimitError extends Error {
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
  folderPath: string
): Promise<void> {
  const apiURL = `${ANNAS_DOWNLOAD_ENDPOINT}?md5=${book.hash}&key=${secretKey}`;

  try {
    // Get download URL from API
    const apiResp = await axios.get<FastDownloadResponse>(apiURL);
    const { download_url, error } = apiResp.data;

    if (!download_url) {
      throw new Error(error || 'Failed to get download URL');
    }

    // Download the file
    const downloadResp = await axios.get(download_url, {
      responseType: 'stream',
    });

    if (downloadResp.status !== 200) {
      throw new Error('Failed to download file');
    }

    // Create filename and path
    let filename = `${book.title}.${book.format}`;
    filename = filename.replace(/\//g, ''); // Remove slashes
    const filePath = path.join(folderPath, filename);

    // Write file using stream pipeline
    const writer = fs.createWriteStream(filePath);
    await pipeline(downloadResp.data, writer);
  } catch (error: any) {
    // Check for 429 rate limit
    if (error.response?.status === 429) {
      const retryAfter = error.response.headers['retry-after']
        ? parseInt(error.response.headers['retry-after'], 10)
        : undefined;
      throw new RateLimitError('Rate limit exceeded (429)', retryAfter);
    }
    throw new Error(`Failed to download book: ${error}`);
  }
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

  // Filter by format if specified
  if (config.preferredFormat) {
    const byFormat = filtered.filter(
      (b) => b.format.toLowerCase() === config.preferredFormat!.toLowerCase()
    );
    if (byFormat.length > 0) filtered = byFormat;
  }

  // Sort by download count (highest first) and return most downloaded
  filtered.sort((a, b) => b.downloadCount - a.downloadCount);

  return filtered[0] || null;
}

/**
 * Process CSV and download all books
 */
export async function processCSV(csvPath: string, config: Config): Promise<void> {
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

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const bookNum = i + 1;

    // Skip if already downloaded
    if (row.status === 'downloaded') {
      console.log(`[${bookNum}/${totalBooks}] Skipping "${row.title}" by ${row.author} (already downloaded)`);
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
      const query = `${row.author} ${row.title}`;
      const books = await findBook(query);

      if (books.length === 0) {
        console.log(`  ❌ No results found\n`);
        updateCSVStatus(csvPath, i, 'failed');
        failCount++;
        continue;
      }

      // Filter and select best match
      const selectedBook = filterBooks(books, config);
      if (!selectedBook) {
        console.log(`  ❌ No matching books found after filtering\n`);
        updateCSVStatus(csvPath, i, 'failed');
        failCount++;
        continue;
      }

      console.log(`  📚 Found: ${selectedBook.format} (${selectedBook.size})`);

      // Download the book
      await downloadBook(selectedBook, config.secretKey, config.outputFolder);

      // Verify the download
      let filename = `${selectedBook.title}.${selectedBook.format}`;
      filename = filename.replace(/\//g, '');
      const filePath = path.join(config.outputFolder, filename);

      if (verifyDownload(filePath)) {
        console.log(`  ✅ Downloaded and verified successfully\n`);
        updateCSVStatus(csvPath, i, 'downloaded');
        successCount++;
      } else {
        console.log(`  ❌ Download verification failed\n`);
        updateCSVStatus(csvPath, i, 'failed');
        failCount++;
      }
    } catch (error) {
      // Handle rate limiting
      if (error instanceof RateLimitError) {
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
        process.exit(0);
      }

      console.log(`  ❌ Error: ${error}\n`);
      updateCSVStatus(csvPath, i, 'failed');
      failCount++;
    }

    // Add a small delay between requests
    if (i < rows.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
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