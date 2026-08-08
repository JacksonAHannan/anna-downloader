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
  updateCSVResult,
  selectReliableBook,
  textSimilarity,
  isPlaceholderAuthor,
  buildBookSearchQuery,
  parseFileSizeBytes,
  RateLimitError,
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
      .onGet(/annas-archive\.gl\/search/)
      .reply(200, htmlFixture);

    const books = await findBook('Carl Sagan Demon Haunted World');

    expect(books).toHaveLength(3);
    expect(books[0]).toMatchObject({
      title: 'The Demon Haunted World',
      authors: 'Carl Sagan',
      publisher: 'Ballantine Books',
      language: 'English [en]',
      format: 'PDF',
      size: '10 MB',
      hash: 'abc123def456',
      downloadCount: 5234,
    });
  });

  it('should extract download counts from search results', async () => {
    const htmlFixture = fs.readFileSync(
      path.join(__dirname, '__fixtures__', 'search-results.html'),
      'utf-8'
    );

    mockAxios
      .onGet(/annas-archive\.gl\/search/)
      .reply(200, htmlFixture);

    const books = await findBook('Carl Sagan Demon Haunted World');

    expect(books).toHaveLength(3);
    expect(books[0].downloadCount).toBe(5234);
    expect(books[1].downloadCount).toBe(2891);
    expect(books[2].downloadCount).toBe(1042);
  });

  it('should handle missing download counts', async () => {
    const htmlWithoutDownloads = `
      <!DOCTYPE html>
      <html>
      <body>
        <div>
          <a href="/md5/test123" class="truncate text-xl font-bold">Test Book</a>
          <div><a href="/search?q=Test%20Author">Test Author</a></div>
          <div><a href="/search?q=Test%20Pub">Test Pub</a></div>
          <div class="text-gray-800">English [en] · PDF · 5 MB</div>
        </div>
      </body>
      </html>
    `;

    mockAxios
      .onGet(/annas-archive\.gl\/search/)
      .reply(200, htmlWithoutDownloads);

    const books = await findBook('Test Book');

    expect(books).toHaveLength(1);
    expect(books[0].downloadCount).toBe(0);
  });

  it('should handle empty search results', async () => {
    mockAxios
      .onGet(/annas-archive\.gl\/search/)
      .reply(200, '<html><body></body></html>');

    const books = await findBook('NonexistentBook12345');

    expect(books).toHaveLength(0);
  });

  it('should throw error on network failure', async () => {
    mockAxios
      .onGet(/annas-archive\.gl\/search/)
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
      downloadCount: 1000,
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
      downloadCount: 5000,
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
      downloadCount: 3000,
    },
  ];

  it('should return the most popular sub-50-MB book when no preferences are set', () => {
    const config = {
      secretKey: 'test',
      outputFolder: './downloads',
    };

    const result = filterBooks(mockBooks, config);
    // Should return Book 2 (Spanish, 5000 downloads) as it has the highest download count
    expect(result).toBe(mockBooks[1]);
    expect(result?.downloadCount).toBe(5000);
  });

  it('should rank eligible books by download popularity', () => {
    const config = {
      secretKey: 'test',
      outputFolder: './downloads',
    };

    const result = filterBooks(mockBooks, config);
    expect(result?.title).toBe('Book 2');
    expect(result?.downloadCount).toBe(5000);
  });

  it('should filter by language preference', () => {
    const config = {
      secretKey: 'test',
      outputFolder: './downloads',
      preferredLanguage: 'Spanish',
    };

    const result = filterBooks(mockBooks, config);
    expect(result?.language).toBe('Spanish');
    expect(result?.downloadCount).toBe(5000);
  });

  it('should filter by language then rank by download popularity', () => {
    const booksWithMultipleEnglish: Book[] = [
      {
        title: 'English Book 1',
        authors: 'Author A',
        publisher: 'Pub A',
        language: 'English',
        format: 'pdf',
        size: '5 MB',
        url: 'http://example.com/a',
        hash: 'hashA',
        downloadCount: 2000,
      },
      {
        title: 'Spanish Book',
        authors: 'Author B',
        publisher: 'Pub B',
        language: 'Spanish',
        format: 'epub',
        size: '3 MB',
        url: 'http://example.com/b',
        hash: 'hashB',
        downloadCount: 10000,
      },
      {
        title: 'English Book 2',
        authors: 'Author C',
        publisher: 'Pub C',
        language: 'English',
        format: 'mobi',
        size: '4 MB',
        url: 'http://example.com/c',
        hash: 'hashC',
        downloadCount: 8000,
      },
    ];

    const config = {
      secretKey: 'test',
      outputFolder: './downloads',
      preferredLanguage: 'English',
    };

    const result = filterBooks(booksWithMultipleEnglish, config);
    // Should return English Book 2 (8000 downloads) not English Book 1 (2000 downloads)
    expect(result?.title).toBe('English Book 2');
    expect(result?.downloadCount).toBe(8000);
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
    expect(result?.downloadCount).toBe(3000);
  });

  it('ignores format preference when ranking by popularity', () => {
    const booksWithMultipleFormats: Book[] = [
      { title: 'PDF Book 1', authors: 'Author A', publisher: 'Pub A', language: 'English', format: 'pdf', size: '2 MB', url: 'http://example.com/a', hash: 'hashA', downloadCount: 1500 },
      { title: 'PDF Book 2', authors: 'Author B', publisher: 'Pub B', language: 'English', format: 'pdf', size: '3 MB', url: 'http://example.com/b', hash: 'hashB', downloadCount: 7500 },
      { title: 'EPUB Book', authors: 'Author C', publisher: 'Pub C', language: 'English', format: 'epub', size: '4 MB', url: 'http://example.com/c', hash: 'hashC', downloadCount: 9000 },
    ];
    const config = { secretKey: 'test', outputFolder: './downloads', preferredFormat: 'pdf' };

    expect(filterBooks(booksWithMultipleFormats, config)?.title).toBe('EPUB Book');
  });

  it('should return null for empty book list', () => {
    const config = {
      secretKey: 'test',
      outputFolder: './downloads',
    };

    const result = filterBooks([], config);
    expect(result).toBeNull();
  });

  it('should fallback to the most popular eligible unfiltered book if no matches are found', () => {
    const config = {
      secretKey: 'test',
      outputFolder: './downloads',
      preferredLanguage: 'French',
    };

    const result = filterBooks(mockBooks, config);
    // Should fallback to all books and return most downloaded (Book 2 with 5000 downloads)
    expect(result).toBe(mockBooks[1]);
    expect(result?.downloadCount).toBe(5000);
  });
});

describe('reliable match selection', () => {
  const config = { secretKey: 'test', outputFolder: './test', preferredFormat: 'pdf', preferredLanguage: 'English' };
  const makeBook = (title: string, authors: string): Book => ({
    title, authors, language: 'English [en]', format: 'PDF', size: '1 MB',
    publisher: '', url: '', hash: title, downloadCount: 0,
  });

  it('accepts a title with a descriptive subtitle and matching authors', () => {
    const result = selectReliableBook(
      [makeBook('Studies in the Economic History of Southern Africa: Volume Two', 'Konczacki, Z. A; Parpart, Jane L; Shaw, Timothy M')],
      config,
      'Studies in the Economic History of Southern Africa',
      'Z.A. Konczacki; Jane L. Parpart; Timothy M. Shaw'
    );
    expect(result.book?.title).toContain('Studies in the Economic History');
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it('rejects a thematically related but incorrect title', () => {
    const wrong = makeBook('Geopolitics and Geoculture: Essays on the Changing World-System', 'Immanuel Wallerstein');
    const result = selectReliableBook([wrong], config, 'Botswana in the Modern World-System', 'Jannis Mossmann');
    expect(result.book).toBeNull();
    expect(result.bestCandidate).toBe(wrong);
  });

  it('rotates past an unsuitable popular result to a reliable alternative', () => {
    const wrong = makeBook('Greek Tragedy: A Literary History', 'Unknown');
    wrong.downloadCount = 50000;
    const correct = makeBook('The Complete Plays of Aeschylus', 'Aeschylus');
    correct.downloadCount = 100;
    const result = selectReliableBook([wrong, correct], config, 'The Complete Plays of Aeschylus', 'Aeschylus');
    expect(result.book).toBe(correct);
  });

  it('uses title-only confidence for anonymous and traditional works', () => {
    const result = selectReliableBook(
      [makeBook('Beowulf', 'Seamus Heaney')],
      config,
      'Beowulf',
      'Anonymous / Traditional European'
    );
    expect(result.book?.title).toBe('Beowulf');
    expect(result.authorScore).toBe(0);
    expect(result.confidence).toBe(1);
  });

  it('still rejects an incorrect title for a placeholder author', () => {
    const result = selectReliableBook(
      [makeBook('Beowulf: A Translation and Commentary', 'J. R. R. Tolkien')],
      config,
      'The Song of Roland',
      'Anonymous / Traditional European'
    );
    expect(result.book).toBeNull();
  });

  it('chooses the highest-confidence match regardless of file format or size', () => {
    const exact = makeBook('Beowulf', 'Anonymous');
    exact.format = 'EPUB';
    exact.size = '120 MB';
    exact.downloadCount = 10;
    const lessExact = makeBook('Beowulf: An Epic Poem', 'Anonymous');
    lessExact.format = 'PDF';
    lessExact.size = '900 KB';
    lessExact.downloadCount = 10000;

    const result = selectReliableBook([lessExact, exact], config, 'Beowulf', 'Anonymous');
    expect(result.book).toBe(exact);
    expect(result.confidence).toBe(1);
  });

  it('uses popularity only to break equal-confidence ties', () => {
    const lessPopular = makeBook('Beowulf', 'Anonymous');
    lessPopular.format = 'PDF';
    lessPopular.size = '1 MB';
    lessPopular.downloadCount = 10;
    const popular = makeBook('Beowulf', 'Anonymous');
    popular.format = 'EPUB';
    popular.size = '120 MB';
    popular.downloadCount = 10000;

    expect(selectReliableBook([lessPopular, popular], config, 'Beowulf', 'Anonymous').book).toBe(popular);
  });
  it('normalizes punctuation and accents in similarity comparisons', () => {
    expect(textSimilarity('García Márquez', 'Garcia-Marquez')).toBe(1);
  });

  it('rejects a formatless edition', () => {
    const formatless = makeBook('A History of the Modern Middle East: Rulers, Rebels, and Rogues', 'Betty S. Anderson');
    formatless.format = '';
    const result = selectReliableBook([formatless], config, 'A History of the Modern Middle East', 'Betty S. Anderson');
    expect(result.book).toBeNull();
    expect(result.bestCandidate).toBeNull();
  });
});

describe('book search queries', () => {
  it.each(['Anonymous', 'Anonymous / Traditional Chinese', 'Buddhist Tradition', 'Vyasa / Traditional'])(
    'searches by title when the author is a placeholder: %s',
    (author) => {
      expect(isPlaceholderAuthor(author)).toBe(true);
      expect(buildBookSearchQuery(author, 'The Book of Songs')).toBe('The Book of Songs');
    }
  );

  it('keeps a real author in the query', () => {
    expect(isPlaceholderAuthor('Jane Austen')).toBe(false);
    expect(buildBookSearchQuery('Jane Austen', 'Emma')).toBe('Jane Austen Emma');
  });
});

describe('file-size parsing', () => {
  it('normalizes size units for comparison', () => {
    expect(parseFileSizeBytes('900 KB')).toBe(900 * 1024);
    expect(parseFileSizeBytes('1.5 MB')).toBe(1.5 * 1024 * 1024);
    expect(parseFileSizeBytes('2 GiB')).toBe(2 * 1024 ** 3);
  });

  it('places missing or unrecognized sizes after known sizes', () => {
    expect(parseFileSizeBytes('')).toBe(Number.POSITIVE_INFINITY);
    expect(parseFileSizeBytes('unknown')).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('persisted CSV diagnostics', () => {
  it('writes error and proposed-match details for later inspection', () => {
    const csvPath = path.join(__dirname, '__fixtures__', 'test-diagnostics-temp.csv');
    fs.writeFileSync(csvPath, 'author,title\nJannis Mossmann,Botswana in the Modern World-System\n');
    try {
      updateCSVResult(csvPath, 0, { status: 'failed', error: 'No reliable match', matched_title: 'Wrong title', matched_author: 'Wrong author', match_confidence: '31' });
      expect(readCSV(csvPath)[0]).toMatchObject({ status: 'failed', error: 'No reliable match', matched_title: 'Wrong title', match_confidence: '31' });
    } finally {
      fs.unlinkSync(csvPath);
    }
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
    delete process.env.OUTPUT_FOLDER;

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
      downloadCount: 1234,
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
      downloadCount: 1234,
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
      downloadCount: 1234,
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
      const downloadedPath = await downloadBook(book, 'test-secret', tmpDir);
      expect(mockAxios.history.get).toHaveLength(2);

      // Verify file was created
      const expectedFile = path.join(tmpDir, 'Test Book.pdf');
      expect(downloadedPath).toBe(expectedFile);
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
      downloadCount: 1234,
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
      downloadCount: 1234,
    };

    mockAxios
      .onGet(/fast_download\.json/)
      .networkError();

    await expect(
      downloadBook(book, 'test-secret', './downloads')
    ).rejects.toThrow('Failed to download book');
  });

  it('rejects and removes an empty download instead of reporting success', async () => {
    const book: Book = {
      title: 'Empty Book', authors: 'Test Author', publisher: '', language: 'English',
      format: 'PDF', size: '0 B', url: '', hash: 'empty-hash', downloadCount: 0,
    };
    const { Readable } = require('stream');
    const emptyStream = new Readable({ read() { this.push(null); } });
    mockAxios.onGet(/fast_download\.json/).reply(200, { download_url: 'https://example.com/empty.pdf' });
    mockAxios.onGet('https://example.com/empty.pdf').reply(200, emptyStream, { 'content-length': '0' });
    const tmpDir = fs.mkdtempSync(path.join(__dirname, 'test-empty-download-'));
    try {
      await expect(downloadBook(book, 'test-secret', tmpDir)).rejects.toThrow('Downloaded file is empty');
      expect(fs.existsSync(path.join(tmpDir, 'Empty Book.PDF'))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, 'Empty Book.PDF.part'))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects editions that have no file format', async () => {
    const book: Book = {
      title: 'Formatless Book', authors: 'Test Author', publisher: '', language: 'English',
      format: '', size: '', url: '', hash: 'formatless-hash', downloadCount: 0,
    };
    const { Readable } = require('stream');
    const stream = Readable.from(['content']);
    mockAxios.onGet(/fast_download\.json/).reply(200, { download_url: 'https://example.com/book' });
    mockAxios.onGet('https://example.com/book').reply(200, stream);
    await expect(downloadBook(book, 'test-secret', './downloads')).rejects.toThrow('does not specify a file format');
  });

  it('stops immediately when the fast quota limit is confirmed', async () => {
    const book: Book = {
      title: 'Slow Book', authors: 'Test Author', publisher: '', language: 'English',
      format: 'PDF', size: '7 B', url: 'https://annas-archive.gl/md5/slow-hash', hash: 'slow-hash', downloadCount: 0,
    };
    mockAxios.onGet(/fast_download\.json/).reply(429, { error: 'Daily limit reached' });
    const tmpDir = fs.mkdtempSync(path.join(__dirname, 'test-slow-download-'));
    try {
      await expect(downloadBook(book, 'test-secret', tmpDir)).rejects.toThrow(RateLimitError);
      expect(mockAxios.history.get.some((request) => request.url === book.url)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('detects a quota message returned with HTTP 200', async () => {
    const book: Book = {
      title: 'Quota Book', authors: 'Test Author', publisher: '', language: 'English',
      format: 'PDF', size: '7 B', url: 'https://annas-archive.gl/md5/quota-hash', hash: 'quota-hash', downloadCount: 0,
    };
    mockAxios.onGet(/fast_download\.json/).reply(200, { error: 'You have reached your daily fast download quota' });
    await expect(downloadBook(book, 'test-secret', './downloads')).rejects.toThrow(RateLimitError);
    expect(mockAxios.history.get).toHaveLength(1);
  });

  it('retries the fast route before probing slow links', async () => {
    const book: Book = {
      title: 'Retry Book', authors: 'Test Author', publisher: '', language: 'English',
      format: 'PDF', size: '7 B', url: 'https://annas-archive.gl/md5/retry-hash', hash: 'retry-hash', downloadCount: 0,
    };
    const { Readable } = require('stream');
    let fastRequests = 0;
    mockAxios.onGet(/fast_download\.json/).reply(() => {
      fastRequests++;
      return fastRequests < 3
        ? [503, { error: 'Temporary fast service failure' }]
        : [200, { download_url: 'https://fast.example/retry.pdf' }];
    });
    mockAxios.onGet('https://fast.example/retry.pdf')
      .reply(200, Readable.from(['content']), { 'content-type': 'application/pdf', 'content-length': '7' });
    const tmpDir = fs.mkdtempSync(path.join(__dirname, 'test-fast-retry-'));
    const transfers: string[] = [];
    try {
      await downloadBook(book, 'test-secret', tmpDir, (_progress, transfer) => {
        if (transfer) transfers.push(transfer.route);
      });
      expect(fastRequests).toBe(3);
      expect(mockAxios.history.get.some((request) => request.url === book.url)).toBe(false);
      expect(transfers).toContain('fast');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('retries a fast mirror through public DNS when local DNS returns ENOTFOUND', async () => {
    const book: Book = {
      title: 'DNS Book', authors: 'Test Author', publisher: '', language: 'English',
      format: 'PDF', size: '7 B', url: '', hash: 'dns-hash', downloadCount: 0,
    };
    const { Readable } = require('stream');
    mockAxios.onGet(/fast_download\.json/).reply(200, { download_url: 'https://mirror.invalid/file.pdf' });
    mockAxios.onGet('https://mirror.invalid/file.pdf').reply(() => Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })));
    mockAxios.onGet('https://dns.google/resolve').reply(200, { Answer: [{ type: 1, data: '192.0.2.10' }] });
    mockAxios.onGet('https://192.0.2.10/file.pdf').reply(200, Readable.from(['content']), { 'content-type': 'application/pdf', 'content-length': '7' });
    const tmpDir = fs.mkdtempSync(path.join(__dirname, 'test-dns-download-'));
    try {
      const result = await downloadBook(book, 'test-secret', tmpDir);
      expect(fs.statSync(result).size).toBe(7);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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
      mockAxios.onGet(/annas-archive\.gl\/search/).reply(200, '<html><body></body></html>');

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
Carl Sagan,Book 1, Downloaded 
Alfred Lansing,Book 2,
Isaac Asimov,Book 3,`;
      fs.writeFileSync(testCsvPath, csvContent);

      const config = {
        secretKey: 'test-key',
        outputFolder: downloadDir,
      };

      // Mock searches - should only search for books without "downloaded" status
      mockAxios.onGet(/annas-archive\.gl\/search/).reply(200, '<html><body></body></html>');

      const { processCSV } = await import('./main');
      await processCSV(testCsvPath, config);

      const rows = readCSV(testCsvPath);

      // First book should still have "downloaded" status (skipped)
      expect(rows[0].status?.trim().toLowerCase()).toBe('downloaded');

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
      mockAxios.onGet(/annas-archive\.gl\/search/).reply(200, '<html><body></body></html>');

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
      mockAxios.onGet(/annas-archive\.gl\/search/).reply(200, '<html><body></body></html>');

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

  it('starts processing at the requested zero-based index', async () => {
    fs.writeFileSync(testCsvPath, 'author,title\nAuthor 1,Book 1\nAuthor 2,Book 2\nAuthor 3,Book 3\n');
    mockAxios.onGet(/annas-archive\.gl\/search/).reply(200, '<html><body></body></html>');

    const { processCSV } = await import('./main');
    await processCSV(testCsvPath, { secretKey: 'test-key', outputFolder: downloadDir }, { startIndex: 2 });

    const rows = readCSV(testCsvPath);
    expect(rows[0].status || '').toBe('');
    expect(rows[1].status || '').toBe('');
    expect(rows[2].status).toBe('failed');
  });
});
