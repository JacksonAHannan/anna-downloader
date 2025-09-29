import axios from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { parse } from 'csv-parse/sync';

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
}

interface FastDownloadResponse {
  download_url?: string;
  error?: string;
}

interface CSVRow {
  author: string;
  title: string;
}

interface Config {
  secretKey: string;
  outputFolder: string;
  preferredFormat?: string;
  preferredLanguage?: string;
}

/**
 * Extract metadata information from meta string
 */
function extractMetaInformation(meta: string): {
  language: string;
  format: string;
  size: string;
} {
  const parts = meta.split(', ');
  if (parts.length < 5) {
    return { language: '', format: '', size: '' };
  }

  return {
    language: parts[0],
    format: parts[1],
    size: parts[3],
  };
}

/**
 * Find books by search query
 */
export async function findBook(query: string): Promise<Book[]> {
  const encodedQuery = encodeURIComponent(query);
  const fullURL = `${ANNAS_SEARCH_ENDPOINT}${encodedQuery}`;

  console.log(`Visiting URL: ${fullURL}`);

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
      const $parent = $el.parent();

      const meta = $parent
        .find('div.relative.top-\\[-1\\].pl-4.grow.overflow-hidden > div')
        .eq(0)
        .text();
      const title = $parent
        .find('div.relative.top-\\[-1\\].pl-4.grow.overflow-hidden > h3')
        .text();
      const publisher = $parent
        .find('div.relative.top-\\[-1\\].pl-4.grow.overflow-hidden > div')
        .eq(1)
        .text();
      const authors = $parent
        .find('div.relative.top-\\[-1\\].pl-4.grow.overflow-hidden > div')
        .eq(2)
        .text();

      const { language, format, size } = extractMetaInformation(meta);

      const link = $el.attr('href') || '';
      const hash = link.replace('/md5/', '');

      const book: Book = {
        language: language.trim(),
        format: format.trim().substring(1), // Remove leading bracket
        size: size.trim(),
        title: title.trim(),
        publisher: publisher.trim(),
        authors: authors.trim(),
        url: new URL(link, fullURL).href,
        hash: hash,
      };

      bookList.push(book);
    });

    return bookList;
  } catch (error) {
    throw new Error(`Failed to find books: ${error}`);
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
  } catch (error) {
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
  }) as CSVRow[];

  return records;
}

/**
 * Load configuration from environment variables
 */
export function loadConfig(): Config {
  const secretKey = process.env.ANNAS_SECRET_KEY;
  const outputFolder = process.env.OUTPUT_FOLDER || './downloads';

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
  };
}

/**
 * Filter books based on preferences
 */
function filterBooks(books: Book[], config: Config): Book | null {
  if (books.length === 0) return null;

  let filtered = books;

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

  // Return first match
  return filtered[0] || null;
}

/**
 * Process CSV and download all books
 */
export async function processCSV(csvPath: string, config: Config): Promise<void> {
  const rows = readCSV(csvPath);
  console.log(`Found ${rows.length} books to download\n`);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const bookNum = i + 1;

    console.log(`[${bookNum}/${rows.length}] Processing: "${row.title}" by ${row.author}`);

    try {
      // Search for the book
      const query = `${row.author} ${row.title}`;
      const books = await findBook(query);

      if (books.length === 0) {
        console.log(`  ❌ No results found\n`);
        failCount++;
        continue;
      }

      // Filter and select best match
      const selectedBook = filterBooks(books, config);
      if (!selectedBook) {
        console.log(`  ❌ No matching books found after filtering\n`);
        failCount++;
        continue;
      }

      console.log(`  📚 Found: ${selectedBook.format} (${selectedBook.size})`);

      // Download the book
      await downloadBook(selectedBook, config.secretKey, config.outputFolder);
      console.log(`  ✅ Downloaded successfully\n`);
      successCount++;
    } catch (error) {
      console.log(`  ❌ Error: ${error}\n`);
      failCount++;
    }

    // Add a small delay between requests
    if (i < rows.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  console.log('='.repeat(50));
  console.log(`Download complete: ${successCount} succeeded, ${failCount} failed`);
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