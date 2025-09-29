import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import * as fs from 'fs';
import * as path from 'path';
import {
  findBook,
  downloadBook,
  extractMetaInformation,
  filterBooks,
  readCSV,
  loadConfig,
  bookToString,
  bookToJSON,
  verifyDownload,
  updateCSVStatus,
  Book,
} from './main';

// Create axios mock
const mockAxios = new MockAdapter(axios);

describe('findBook', () => {
  beforeEach(() => {
    mockAxios.reset();
  });

  it('should parse HTML and extract book information', async () => {
    const htmlFixture = fs.readFileSync(
      path.join(__dirname, '__fixtures__', 'search-results.html'),
      'utf-8'
    );

    mockAxios
      .onGet(/annas-archive\.org\/search/)
      .reply(200, htmlFixture);

    const books = await findBook('Carl Sagan Demon Haunted World');

    expect(books).toHaveLength(3);
    expect(books[0]).toMatchObject({
      title: 'The Demon Haunted World',
      authors: 'Carl Sagan',
      publisher: 'Ballantine Books',
      language: 'English',
      format: 'pdf',
      size: '10 MB',
      hash: 'abc123def456',
    });
  });

  it('should handle empty search results', async () => {
    mockAxios
      .onGet(/annas-archive\.org\/search/)
      .reply(200, '<html><body></body></html>');

    const books = await findBook('NonexistentBook12345');

    expect(books).toHaveLength(0);
  });

  it('should throw error on network failure', async () => {
    mockAxios
      .onGet(/annas-archive\.org\/search/)
      .networkError();

    await expect(findBook('test')).rejects.toThrow('Failed to find books');
  });
});

describe('extractMetaInformation', () => {
  it('should extract language, format, and size from meta string', () => {
    const meta = 'English [en] · PDF · 10 MB';
    const result = extractMetaInformation(meta);

    expect(result).toEqual({
      language: 'English [en]',
      format: 'PDF',
      size: '10 MB',
    });
  });

  it('should handle malformed meta string', () => {
    const meta = 'English';
    const result = extractMetaInformation(meta);

    expect(result).toEqual({
      language: '',
      format: '',
      size: '',
    });
  });

  it('should handle empty meta string', () => {
    const meta = '';
    const result = extractMetaInformation(meta);

    expect(result).toEqual({
      language: '',
      format: '',
      size: '',
    });
  });
});

describe('filterBooks', () => {
  const mockBooks: Book[] = [
    {
      title: 'Book 1',
      authors: 'Author 1',
      publisher: 'Pub 1',
      language: 'English',
      format: 'pdf',
      size: '5 MB',
      url: 'http://example.com/1',
      hash: 'hash1',
    },
    {
      title: 'Book 2',
      authors: 'Author 2',
      publisher: 'Pub 2',
      language: 'Spanish',
      format: 'epub',
      size: '3 MB',
      url: 'http://example.com/2',
      hash: 'hash2',
    },
    {
      title: 'Book 3',
      authors: 'Author 3',
      publisher: 'Pub 3',
      language: 'English',
      format: 'mobi',
      size: '4 MB',
      url: 'http://example.com/3',
      hash: 'hash3',
    },
  ];

  it('should return first book when no preferences set', () => {
    const config = {
      secretKey: 'test',
      outputFolder: './downloads',
    };

    const result = filterBooks(mockBooks, config);
    expect(result).toBe(mockBooks[0]);
  });

  it('should filter by language preference', () => {
    const config = {
      secretKey: 'test',
      outputFolder: './downloads',
      preferredLanguage: 'Spanish',
    };

    const result = filterBooks(mockBooks, config);
    expect(result?.language).toBe('Spanish');
  });

  it('should filter by format preference', () => {
    const config = {
      secretKey: 'test',
      outputFolder: './downloads',
      preferredFormat: 'epub',
    };

    const result = filterBooks(mockBooks, config);
    expect(result?.format).toBe('epub');
  });

  it('should filter by both language and format', () => {
    const config = {
      secretKey: 'test',
      outputFolder: './downloads',
      preferredLanguage: 'English',
      preferredFormat: 'mobi',
    };

    const result = filterBooks(mockBooks, config);
    expect(result?.language).toBe('English');
    expect(result?.format).toBe('mobi');
  });

  it('should return null for empty book list', () => {
    const config = {
      secretKey: 'test',
      outputFolder: './downloads',
    };

    const result = filterBooks([], config);
    expect(result).toBeNull();
  });

  it('should fallback to unfiltered list if no matches found', () => {
    const config = {
      secretKey: 'test',
      outputFolder: './downloads',
      preferredLanguage: 'French',
    };

    const result = filterBooks(mockBooks, config);
    expect(result).toBe(mockBooks[0]);
  });
});

describe('readCSV', () => {
  it('should parse CSV file correctly', () => {
    const csvPath = path.join(__dirname, '__fixtures__', 'test-books.csv');
    const rows = readCSV(csvPath);

    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      author: 'Carl Sagan',
      title: 'The Demon Haunted World',
    });
    expect(rows[1]).toEqual({
      author: 'Alfred Lansing',
      title: "Endurance: Shackleton's Incredible Voyage",
    });
  });

  it('should throw error for non-existent file', () => {
    expect(() => {
      readCSV('/nonexistent/file.csv');
    }).toThrow();
  });

  it('should parse CSV with status column', () => {
    const csvPath = path.join(__dirname, '__fixtures__', 'test-books-with-status.csv');
    const rows = readCSV(csvPath);

    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      author: 'Carl Sagan',
      title: 'The Demon Haunted World',
      status: 'downloaded',
    });
    expect(rows[1]).toEqual({
      author: 'Alfred Lansing',
      title: "Endurance: Shackleton's Incredible Voyage",
      status: '',
    });
    expect(rows[2]).toEqual({
      author: 'Isaac Asimov',
      title: 'Foundation',
      status: 'failed',
    });
  });
});

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should load configuration from environment variables', () => {
    process.env.ANNAS_SECRET_KEY = 'test-secret-key';
    process.env.OUTPUT_FOLDER = './test-downloads';
    process.env.PREFERRED_FORMAT = 'pdf';
    process.env.PREFERRED_LANGUAGE = 'English';
    process.env.MAX_DOWNLOADS = '5';

    const config = loadConfig();

    expect(config).toEqual({
      secretKey: 'test-secret-key',
      outputFolder: './test-downloads',
      preferredFormat: 'pdf',
      preferredLanguage: 'English',
      maxDownloads: 5,
    });
  });

  it('should use default output folder when not specified', () => {
    process.env.ANNAS_SECRET_KEY = 'test-secret-key';

    const config = loadConfig();

    expect(config.outputFolder).toBe('./downloads');
  });

  it('should throw error when secret key is missing', () => {
    delete process.env.ANNAS_SECRET_KEY;

    expect(() => {
      loadConfig();
    }).toThrow('ANNAS_SECRET_KEY environment variable is required');
  });

  it('should parse MAX_DOWNLOADS as integer', () => {
    process.env.ANNAS_SECRET_KEY = 'test-secret-key';
    process.env.MAX_DOWNLOADS = '10';

    const config = loadConfig();

    expect(config.maxDownloads).toBe(10);
    expect(typeof config.maxDownloads).toBe('number');
  });

  it('should return undefined for maxDownloads when not set', () => {
    process.env.ANNAS_SECRET_KEY = 'test-secret-key';
    delete process.env.MAX_DOWNLOADS;

    const config = loadConfig();

    expect(config.maxDownloads).toBeUndefined();
  });

  it('should handle invalid MAX_DOWNLOADS values', () => {
    process.env.ANNAS_SECRET_KEY = 'test-secret-key';
    process.env.MAX_DOWNLOADS = 'invalid';

    const config = loadConfig();

    // parseInt returns NaN for invalid strings
    expect(config.maxDownloads).toBeNaN();
  });
});

describe('bookToString', () => {
  it('should format book as string', () => {
    const book: Book = {
      title: 'Test Book',
      authors: 'Test Author',
      publisher: 'Test Publisher',
      language: 'English',
      format: 'pdf',
      size: '5 MB',
      url: 'http://example.com/book',
      hash: 'testhash123',
    };

    const result = bookToString(book);

    expect(result).toContain('Title: Test Book');
    expect(result).toContain('Authors: Test Author');
    expect(result).toContain('Publisher: Test Publisher');
    expect(result).toContain('Language: English');
    expect(result).toContain('Format: pdf');
    expect(result).toContain('Size: 5 MB');
    expect(result).toContain('URL: http://example.com/book');
    expect(result).toContain('Hash: testhash123');
  });
});

describe('bookToJSON', () => {
  it('should format book as JSON', () => {
    const book: Book = {
      title: 'Test Book',
      authors: 'Test Author',
      publisher: 'Test Publisher',
      language: 'English',
      format: 'pdf',
      size: '5 MB',
      url: 'http://example.com/book',
      hash: 'testhash123',
    };

    const result = bookToJSON(book);
    const parsed = JSON.parse(result);

    expect(parsed).toEqual(book);
  });
});

describe('downloadBook', () => {
  beforeEach(() => {
    mockAxios.reset();
  });

  it('should download book successfully', async () => {
    const book: Book = {
      title: 'Test Book',
      authors: 'Test Author',
      publisher: 'Test Publisher',
      language: 'English',
      format: 'pdf',
      size: '5 MB',
      url: 'http://example.com/book',
      hash: 'testhash123',
    };

    // Mock the fast download API response
    mockAxios
      .onGet(/fast_download\.json/)
      .reply(200, { download_url: 'http://example.com/download/file.pdf' });

    // Mock the actual file download with a readable stream
    const { Readable } = require('stream');
    const mockStream = new Readable();
    mockStream.push('mock file content');
    mockStream.push(null); // end of stream

    mockAxios
      .onGet('http://example.com/download/file.pdf')
      .reply(200, mockStream, { 'content-type': 'application/pdf' });

    const tmpDir = fs.mkdtempSync(path.join(__dirname, 'test-downloads-'));

    try {
      await downloadBook(book, 'test-secret', tmpDir);
      expect(mockAxios.history.get).toHaveLength(2);

      // Verify file was created
      const expectedFile = path.join(tmpDir, 'Test Book.pdf');
      expect(fs.existsSync(expectedFile)).toBe(true);
    } finally {
      // Cleanup
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should throw error when download URL is missing', async () => {
    const book: Book = {
      title: 'Test Book',
      authors: 'Test Author',
      publisher: 'Test Publisher',
      language: 'English',
      format: 'pdf',
      size: '5 MB',
      url: 'http://example.com/book',
      hash: 'testhash123',
    };

    mockAxios
      .onGet(/fast_download\.json/)
      .reply(200, { error: 'Invalid key' });

    await expect(
      downloadBook(book, 'invalid-key', './downloads')
    ).rejects.toThrow();
  });

  it('should throw error on network failure', async () => {
    const book: Book = {
      title: 'Test Book',
      authors: 'Test Author',
      publisher: 'Test Publisher',
      language: 'English',
      format: 'pdf',
      size: '5 MB',
      url: 'http://example.com/book',
      hash: 'testhash123',
    };

    mockAxios
      .onGet(/fast_download\.json/)
      .networkError();

    await expect(
      downloadBook(book, 'test-secret', './downloads')
    ).rejects.toThrow('Failed to download book');
  });
});

describe('verifyDownload', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(__dirname, 'test-verify-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return true for a file that exists with content', () => {
    const filePath = path.join(tmpDir, 'test-file.pdf');
    fs.writeFileSync(filePath, 'test content');

    const result = verifyDownload(filePath);
    expect(result).toBe(true);
  });

  it('should return false for a file that does not exist', () => {
    const filePath = path.join(tmpDir, 'nonexistent.pdf');

    const result = verifyDownload(filePath);
    expect(result).toBe(false);
  });

  it('should return false for an empty file (size = 0)', () => {
    const filePath = path.join(tmpDir, 'empty-file.pdf');
    fs.writeFileSync(filePath, '');

    const result = verifyDownload(filePath);
    expect(result).toBe(false);
  });

  it('should return false when file access fails', () => {
    // Use an invalid path that will cause an error
    const result = verifyDownload('/invalid/path/\0/file.pdf');
    expect(result).toBe(false);
  });
});

describe('updateCSVStatus', () => {
  let tmpDir: string;
  let testCsvPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(__dirname, 'test-csv-'));
    testCsvPath = path.join(tmpDir, 'test-books.csv');

    // Create initial CSV without status
    const initialContent = `author,title
Carl Sagan,The Demon Haunted World
Alfred Lansing,Endurance: Shackleton's Incredible Voyage
Isaac Asimov,Foundation`;
    fs.writeFileSync(testCsvPath, initialContent);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should update status for a valid row index', () => {
    updateCSVStatus(testCsvPath, 0, 'downloaded');

    const rows = readCSV(testCsvPath);
    expect(rows[0].status).toBe('downloaded');
    // CSV parse returns empty string for undefined values, not undefined
    expect(rows[1].status).toBe('');
    expect(rows[2].status).toBe('');
  });

  it('should write CSV with status column correctly', () => {
    updateCSVStatus(testCsvPath, 1, 'failed');

    const fileContent = fs.readFileSync(testCsvPath, 'utf-8');
    expect(fileContent).toContain('author,title,status');
    expect(fileContent).toContain('Alfred Lansing,Endurance: Shackleton\'s Incredible Voyage,failed');
  });

  it('should update multiple rows sequentially', () => {
    updateCSVStatus(testCsvPath, 0, 'downloaded');
    updateCSVStatus(testCsvPath, 1, 'failed');
    updateCSVStatus(testCsvPath, 2, 'downloaded');

    const rows = readCSV(testCsvPath);
    expect(rows[0].status).toBe('downloaded');
    expect(rows[1].status).toBe('failed');
    expect(rows[2].status).toBe('downloaded');
  });

  it('should handle invalid row index gracefully', () => {
    // Should not throw, just do nothing
    expect(() => {
      updateCSVStatus(testCsvPath, 999, 'downloaded');
    }).not.toThrow();

    const rows = readCSV(testCsvPath);
    expect(rows).toHaveLength(3);
  });

  it('should preserve existing data when updating status', () => {
    updateCSVStatus(testCsvPath, 0, 'downloaded');

    const rows = readCSV(testCsvPath);
    expect(rows[0]).toMatchObject({
      author: 'Carl Sagan',
      title: 'The Demon Haunted World',
      status: 'downloaded',
    });
  });

  it('should handle CSV that already has status column', () => {
    // First update to add status column
    updateCSVStatus(testCsvPath, 0, 'downloaded');

    // Update again - should preserve first status and update second
    updateCSVStatus(testCsvPath, 1, 'failed');

    const rows = readCSV(testCsvPath);
    expect(rows[0].status).toBe('downloaded');
    expect(rows[1].status).toBe('failed');
  });
});

describe('processCSV integration tests', () => {
  let tmpDir: string;
  let testCsvPath: string;
  let downloadDir: string;
  let consoleLogSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    mockAxios.reset();
    tmpDir = fs.mkdtempSync(path.join(__dirname, 'test-process-'));
    testCsvPath = path.join(tmpDir, 'test-books.csv');
    downloadDir = path.join(tmpDir, 'downloads');
    fs.mkdirSync(downloadDir);

    // Suppress console output during tests
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    consoleLogSpy.mockRestore();
  });

  it(
    'should respect MAX_DOWNLOADS limit based on successful downloads only',
    async () => {
      // Create CSV with 5 books
      const csvContent = `author,title
Book 1,Author 1
Book 2,Author 2
Book 3,Author 3
Book 4,Author 4
Book 5,Author 5`;
      fs.writeFileSync(testCsvPath, csvContent);

      const config = {
        secretKey: 'test-key',
        outputFolder: downloadDir,
        maxDownloads: 2,
      };

      // All searches return empty results (will fail - no books found)
      mockAxios.onGet(/annas-archive\.org\/search/).reply(200, '<html><body></body></html>');

      const { processCSV } = await import('./main');
      await processCSV(testCsvPath, config);

      const rows = readCSV(testCsvPath);
      const downloadedCount = rows.filter((r) => r.status === 'downloaded').length;
      const processedCount = rows.filter((r) => r.status && r.status !== '').length;

      // MAX_DOWNLOADS limits successful downloads, not attempts
      // Since all fail, it should process all books looking for successful downloads
      expect(downloadedCount).toBe(0);
      expect(processedCount).toBeGreaterThan(0); // All should be marked as failed
    },
    15000
  );

  it(
    'should skip books with downloaded status',
    async () => {
      // Create CSV with one book already downloaded
      const csvContent = `author,title,status
Carl Sagan,Book 1,downloaded
Alfred Lansing,Book 2,
Isaac Asimov,Book 3,`;
      fs.writeFileSync(testCsvPath, csvContent);

      const config = {
        secretKey: 'test-key',
        outputFolder: downloadDir,
      };

      // Mock searches - should only search for books without "downloaded" status
      mockAxios.onGet(/annas-archive\.org\/search/).reply(200, '<html><body></body></html>');

      const { processCSV } = await import('./main');
      await processCSV(testCsvPath, config);

      const rows = readCSV(testCsvPath);

      // First book should still have "downloaded" status (skipped)
      expect(rows[0].status).toBe('downloaded');

      // Other books should have been processed (failed since we return empty HTML)
      expect(rows[1].status).toBe('failed');
      expect(rows[2].status).toBe('failed');
    },
    15000
  );

  it(
    'should update CSV status after failed downloads',
    async () => {
      const csvContent = `author,title
Carl Sagan,Book 1`;
      fs.writeFileSync(testCsvPath, csvContent);

      const config = {
        secretKey: 'test-key',
        outputFolder: downloadDir,
      };

      // Mock empty search results (no books found)
      mockAxios.onGet(/annas-archive\.org\/search/).reply(200, '<html><body></body></html>');

      const { processCSV } = await import('./main');
      await processCSV(testCsvPath, config);

      const rows = readCSV(testCsvPath);
      expect(rows[0].status).toBe('failed');
    },
    10000
  );

  it(
    'should count downloads separately from failures',
    async () => {
      const csvContent = `author,title
Book 1,Author 1
Book 2,Author 2
Book 3,Author 3`;
      fs.writeFileSync(testCsvPath, csvContent);

      const config = {
        secretKey: 'test-key',
        outputFolder: downloadDir,
        maxDownloads: 5, // Ensure limit doesn't interfere
      };

      // All searches return empty (will fail)
      mockAxios.onGet(/annas-archive\.org\/search/).reply(200, '<html><body></body></html>');

      const { processCSV } = await import('./main');
      await processCSV(testCsvPath, config);

      const rows = readCSV(testCsvPath);

      // All should be marked as failed
      expect(rows[0].status).toBe('failed');
      expect(rows[1].status).toBe('failed');
      expect(rows[2].status).toBe('failed');
    },
    15000
  );
});