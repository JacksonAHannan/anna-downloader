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
    const meta = 'English, [pdf], something, 10 MB, 1996';
    const result = extractMetaInformation(meta);

    expect(result).toEqual({
      language: 'English',
      format: '[pdf]',
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

    const config = loadConfig();

    expect(config).toEqual({
      secretKey: 'test-secret-key',
      outputFolder: './test-downloads',
      preferredFormat: 'pdf',
      preferredLanguage: 'English',
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