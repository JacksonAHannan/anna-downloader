import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import {
  findBook,
  downloadBook,
  parseFastDomainIndexes,
  extractMetaInformation,
  filterBooks,
  readCSV,
  loadConfig,
  bookToString,
  bookToJSON,
  verifyDownload,
  updateCSVResult,
  selectReliableBook,
  textSimilarity,
  isPlaceholderAuthor,
  buildBookSearchQuery,
  parseFileSizeBytes,
  RateLimitError,
  Book,
  rankCandidates,
  findRowCandidates,
  applySelectedMatch,
  rejectRowMatch,
  scanMatches,
  processCSV,
  MatchCandidate,
  safeDownloadFilename,
} from './main';
import { ANNAS_CATALOG_BASE_URLS, ANNAS_DOWNLOAD_BASE_URLS } from './anna';
import { buildLocalMetadataIndex } from './localMetadata';

// Create axios mock
const mockAxios = new MockAdapter(axios);

async function createTestMetadataIndex(title: string, author: string): Promise<{ folder: string; database: string }> {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'anna-provider-order-'));
  const source = path.join(folder, 'aarecords__0.json.gz');
  const database = path.join(folder, 'index.sqlite');
  const line = JSON.stringify({ _source: { id: 'md5:0123456789abcdef0123456789abcdef', search_only_fields: {
    search_title: title, search_author: author, search_publisher: 'Test Press',
    search_most_likely_language_code: ['en'], search_extension: 'epub', search_filesize: 123456,
    search_content_type: 'book_nonfiction', search_access_types: ['aa_download'], search_score_base_rank: 42,
  } } });
  fs.writeFileSync(source, zlib.gzipSync(`${line}\n`));
  await buildLocalMetadataIndex({ sourceFiles: [source], databasePath: database });
  return { folder, database };
}

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
      .onGet(/annas-archive\.(?:gl|is)\/search/)
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
      hash: 'abc123def456abc123def456abc123de',
      downloadCount: 5234,
    });
  });

  it('should extract download counts from search results', async () => {
    const htmlFixture = fs.readFileSync(
      path.join(__dirname, '__fixtures__', 'search-results.html'),
      'utf-8'
    );

    mockAxios
      .onGet(/annas-archive\.(?:gl|is)\/search/)
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
          <a href="/md5/0123456789abcdef0123456789abcdef" class="truncate text-xl font-bold">Test Book</a>
          <div><a href="/search?q=Test%20Author">Test Author</a></div>
          <div><a href="/search?q=Test%20Pub">Test Pub</a></div>
          <div class="text-gray-800">English [en] · PDF · 5 MB</div>
        </div>
      </body>
      </html>
    `;

    mockAxios
      .onGet(/annas-archive\.(?:gl|is)\/search/)
      .reply(200, htmlWithoutDownloads);

    const books = await findBook('Test Book');

    expect(books).toHaveLength(1);
    expect(books[0].downloadCount).toBe(0);
  });

  it('should handle empty search results', async () => {
    mockAxios
      .onGet(/annas-archive\.(?:gl|is)\/search/)
      .reply(200, '<html><body></body></html>');

    const books = await findBook('NonexistentBook12345');

    expect(books).toHaveLength(0);
  });

  it('should throw error on network failure', async () => {
    mockAxios
      .onGet(/annas-archive\.(?:gl|is)\/search/)
      .networkError();

    await expect(findBook('test')).rejects.toThrow('Book search failed');
  });

  it('parses current /books/ catalog cards and derives the download MD5 from the cover', async () => {
    mockAxios.onGet(/annas-archive\.(?:gl|is)\/search/).reply(200, `
      <div class="bg-white rounded-lg shadow p-4 mb-4"><div>
        <a href="https://annas-archive.is/books/123-emma"><img src="https://covers.example/70D266A23257C234DA3DC4879DC660AC.webp"></a>
        <div><h3><a href="https://annas-archive.is/books/123-emma">Emma</a></h3>
          <div>Austen, Jane · 2011 · EPUB · 435.1 KB · Books catalog</div>
          <div>Publisher: Penguin Classics</div>
        </div>
      </div></div>`);
    await expect(findBook('Jane Austen Emma')).resolves.toEqual([expect.objectContaining({
      title: 'Emma', authors: 'Austen, Jane', publisher: 'Penguin Classics', format: 'EPUB', size: '435.1 KB',
      hash: '70d266a23257c234da3dc4879dc660ac', url: 'https://annas-archive.gl/md5/70d266a23257c234da3dc4879dc660ac',
    })]);
  });

  it('retries subtitle-heavy catalog searches with the base title', async () => {
    mockAxios.onGet(/annas-archive\.(?:gl|is)\/search/).reply((config) => config.url?.includes(encodeURIComponent('Advanced Topics'))
      ? [200, '<html><body></body></html>']
      : [200, `<div class="bg-white"><div><a href="https://annas-archive.is/books/1"><img src="https://covers/70D266A23257C234DA3DC4879DC660AC.webp"></a><div><h3><a href="https://annas-archive.is/books/1">Probabilistic Machine Learning</a></h3><div>Kevin P. Murphy · 2022 · PDF · 10 MB</div></div></div></div>`]);
    const books = await findBook('Probabilistic Machine Learning: Advanced Topics');
    expect(books).toHaveLength(1);
    expect(mockAxios.history.get).toHaveLength(2);
  });

  it('distinguishes metadata-only catalog cards from an empty search', async () => {
    mockAxios.onGet(/annas-archive\.(?:gl|is)\/search/).reply(200, `<div class="bg-white"><div><div><h3><a href="https://annas-archive.is/books/1">Metadata only</a></h3><div>An Author · 2020 · PDF · 1 MB</div></div></div></div>`);
    await expect(findBook('Metadata only')).rejects.toThrow('catalog match found, but none exposes an MD5');
  });

  it('explains that a search 403 is browser verification, not the download quota', async () => {
    mockAxios.onGet(/annas-archive\.(?:gl|is)\/search/).reply(403, '<title>DDoS-Guard</title>');
    await expect(findBook('test')).rejects.toThrow('browser verification challenge');
  });

  it('falls back to the next configured catalog origin after a blocked domain', async () => {
    const fallback = 'https://annas-archive-fallback.example';
    ANNAS_CATALOG_BASE_URLS.push(fallback);
    try {
      mockAxios.onGet(new RegExp(`${new URL(ANNAS_CATALOG_BASE_URLS[0]).hostname.replace(/\./g, '\\.')}\\/search`)).reply(403, '<title>DDoS-Guard</title>');
      mockAxios.onGet(new RegExp(`${new URL(fallback).hostname.replace(/\./g, '\\.')}\\/search`)).reply(200, fs.readFileSync(path.join(__dirname, '__fixtures__', 'search-results.html'), 'utf-8'));

      await expect(findBook('The Demon Haunted World')).resolves.toHaveLength(3);
    } finally {
      ANNAS_CATALOG_BASE_URLS.pop();
    }
  });

  it('catalog parser rejects malformed hashes instead of arbitrary paths', async () => {
    mockAxios.onGet(/annas-archive\.gl\/search/).reply(200, `
      <div><a href="/md5/not-an-md5" class="truncate text-xl font-bold">Unsafe result</a>
      <div class="text-gray-800">English [en] Â· PDF Â· 1 MB</div></div>`);
    await expect(findBook('Unsafe result')).resolves.toEqual([]);
  });

  it('catalog client rejects redirects that leave the configured origin', async () => {
    mockAxios.onGet(/untrusted\.example\/search/).reply(302, '', { location: 'https://credential-capture.example/search?q=test' });
    await expect(findBook('test', new Set(), 0, 0, ['https://untrusted.example'], 'untrusted_catalog'))
      .rejects.toThrow('leave its configured origin');
    expect(mockAxios.history.get).toHaveLength(1);
  });

  it('catalog client omits credentials and application secrets', async () => {
    mockAxios.onGet(/untrusted\.example\/search/).reply(200, '<html><body></body></html>');
    await findBook('Jane Austen Emma', new Set(), 0, 0, ['https://untrusted.example'], 'untrusted_catalog');
    const request = mockAxios.history.get[0];
    expect(request.url).toContain('/search?q=Jane%20Austen%20Emma');
    expect(request.headers?.Authorization).toBeUndefined();
    expect(request.headers?.Cookie).toBeUndefined();
    expect(request.headers?.Referer).toBeUndefined();
  });

  it('catalog mode limits untrusted row candidates to PDF/EPUB and labels them', async () => {
    const htmlFixture = fs.readFileSync(path.join(__dirname, '__fixtures__', 'search-results.html'), 'utf-8');
    mockAxios.onGet(/annas-archive\.is\/search/).reply(200, htmlFixture);
    const candidates = await findRowCandidates(
      { author: 'Carl Sagan', title: 'The Demon Haunted World' },
      { secretKey: 'unused', outputFolder: '.', untrustedCatalogSearch: true }
    );
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((candidate) => ['pdf', 'epub'].includes(candidate.book.format.toLowerCase()))).toBe(true);
    expect(candidates.every((candidate) => candidate.book.searchSource === 'untrusted_catalog')).toBe(true);
  });

  it('catalog search stays disabled without explicit opt-in', async () => {
    await expect(findRowCandidates(
      { author: 'Jane Austen', title: 'Emma' },
      { secretKey: 'unused', outputFolder: '.' }
    )).rejects.toThrow('No metadata search provider is enabled');
    expect(mockAxios.history.get).toHaveLength(0);
  });

  it('uses a usable local metadata match without contacting an enabled fallback', async () => {
    const { folder, database } = await createTestMetadataIndex('The Demon Haunted World', 'Carl Sagan');
    mockAxios.onGet(/annas-archive\.is\/search/).reply(200, '<html><body></body></html>');
    try {
      const candidates = await findRowCandidates(
        { author: 'Carl Sagan', title: 'The Demon Haunted World' },
        { secretKey: 'unused', outputFolder: '.', metadataIndex: database, untrustedCatalogSearch: true }
      );
      expect(candidates[0]?.book.searchSource).toBe('local_metadata');
      expect(mockAxios.history.get).toHaveLength(0);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it('uses an enabled fallback only after local metadata has no usable match', async () => {
    const { folder, database } = await createTestMetadataIndex('An Unrelated Quantum Mechanics Manual', 'Different Author');
    const htmlFixture = fs.readFileSync(path.join(__dirname, '__fixtures__', 'search-results.html'), 'utf-8');
    mockAxios.onGet(/annas-archive\.is\/search/).reply(200, htmlFixture);
    try {
      const candidates = await findRowCandidates(
        { author: 'Carl Sagan', title: 'The Demon Haunted World' },
        { secretKey: 'unused', outputFolder: '.', metadataIndex: database, untrustedCatalogSearch: true }
      );
      expect(candidates[0]?.book.searchSource).toBe('untrusted_catalog');
      expect(mockAxios.history.get.some((request) => request.url?.includes('/search'))).toBe(true);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
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
  const config = { secretKey: 'test', outputFolder: './test', preferredLanguage: 'English' };
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

describe('rankCandidates and preferred-publisher boost', () => {
  const config = { secretKey: 'test', outputFolder: './test', preferredPublisher: 'Penguin' };
  const makeBook = (title: string, authors: string, publisher = ''): Book => ({
    title, authors, language: 'English [en]', format: 'PDF', size: '1 MB',
    publisher, url: '', hash: title, downloadCount: 0,
  });

  it('ranks a preferred-publisher edition above an equal-confidence other edition', () => {
    const penguin = makeBook('Beowulf: An Epic Poem', 'Anonymous', 'Penguin Classics');
    const other = makeBook('Beowulf: An Epic Poem', 'Anonymous', 'Random House');
    const ranked = rankCandidates([other, penguin], config, 'Beowulf: An Epic Poem', 'Anonymous');
    expect(ranked[0].book).toBe(penguin);
    // The boost only affects ordering — reported confidence must stay identical for equal matches.
    expect(ranked[0].confidence).toBe(ranked[1].confidence);
  });

  it('does not let the preference boost override a clearly better non-preferred match', () => {
    const weakPenguin = makeBook('Greek Tragedy: A Literary History', 'Unknown', 'Penguin Classics');
    const strongMatch = makeBook('The Complete Plays of Aeschylus', 'Aeschylus', 'Oxford University Press');
    const ranked = rankCandidates([weakPenguin, strongMatch], config, 'The Complete Plays of Aeschylus', 'Aeschylus');
    expect(ranked[0].book).toBe(strongMatch);
  });

  it('matches the preference case-insensitively anywhere in the publisher name', () => {
    const penguin = makeBook('Emma', 'Jane Austen', 'penguin classics');
    const other = makeBook('Emma', 'Jane Austen', 'Random House');
    const ranked = rankCandidates([other, penguin], config, 'Emma', 'Jane Austen');
    expect(ranked[0].book).toBe(penguin);
  });

  it('applies no boost at all when no preferred publisher is configured', () => {
    const noPreferenceConfig = { secretKey: 'test', outputFolder: './test' };
    const penguin = makeBook('Beowulf: An Epic Poem', 'Anonymous', 'Penguin Classics');
    const other = makeBook('Beowulf: An Epic Poem', 'Anonymous', 'Random House');
    other.downloadCount = 10; // give the non-Penguin edition the only tiebreaker signal
    const ranked = rankCandidates([penguin, other], noPreferenceConfig, 'Beowulf: An Epic Poem', 'Anonymous');
    expect(ranked[0].book).toBe(other);
  });

  it('flags isExactMatch only for a token-exact title and author', () => {
    const exact = makeBook('Emma', 'Jane Austen');
    const closeButNotExact = makeBook('Emma: A Novel', 'Jane Austen');
    const [rankedExact, rankedClose] = rankCandidates([closeButNotExact, exact], config, 'Emma', 'Jane Austen');
    expect(rankedExact.book).toBe(exact);
    expect(rankedExact.isExactMatch).toBe(true);
    expect(rankedClose.isExactMatch).toBe(false);
  });

  it('flags isExactMatch on title alone for placeholder authors', () => {
    const [ranked] = rankCandidates([makeBook('Beowulf', 'Seamus Heaney')], config, 'Beowulf', 'Anonymous');
    expect(ranked.isExactMatch).toBe(true);
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

  it('searches real-author books by title and leaves author validation to ranking', () => {
    expect(isPlaceholderAuthor('Jane Austen')).toBe(false);
    expect(buildBookSearchQuery('Jane Austen', 'Emma')).toBe('Emma');
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
    fs.writeFileSync(csvPath, 'author,title,notes\nJannis Mossmann,Botswana in the Modern World-System,keep me\n');
    try {
      updateCSVResult(csvPath, 0, { status: 'failed', error: 'No reliable match', matched_title: 'Wrong title', matched_author: 'Wrong author', match_confidence: '31' });
      expect(readCSV(csvPath)[0]).toMatchObject({ status: 'failed', error: 'No reliable match', matched_title: 'Wrong title', match_confidence: '31', notes: 'keep me' });
    } finally {
      fs.unlinkSync(csvPath);
    }
  });
});

describe('applySelectedMatch and rejectRowMatch', () => {
  let csvPath: string;

  beforeEach(() => {
    csvPath = path.join(__dirname, '__fixtures__', 'test-match-selection-temp.csv');
    fs.writeFileSync(csvPath, 'author,title\nJane Austen,Emma\n');
  });

  afterEach(() => {
    fs.rmSync(csvPath, { force: true });
  });

  it('persists the exact chosen edition as durable, download-ready columns', () => {
    const candidate: MatchCandidate = {
      book: { title: 'Emma', authors: 'Jane Austen', publisher: 'Penguin Classics', language: 'English [en]', format: 'EPUB', size: '1.2 MB', url: 'https://annas-archive.gl/md5/emmahash', hash: 'emmahash', downloadCount: 4200 },
      titleScore: 1, authorScore: 1, confidence: 1, isExactMatch: true,
    };
    applySelectedMatch(csvPath, 0, candidate);
    const row = readCSV(csvPath)[0];
    expect(row).toMatchObject({
      status: 'matched', matched_title: 'Emma', matched_author: 'Jane Austen', match_confidence: '100',
      selected_hash: 'emmahash', selected_url: 'https://annas-archive.gl/md5/emmahash',
      selected_publisher: 'Penguin Classics', selected_format: 'EPUB', selected_size: '1.2 MB',
    });
  });

  it('marks a row rejected and clears any selected edition', () => {
    const candidate: MatchCandidate = {
      book: { title: 'Emma', authors: 'Jane Austen', publisher: '', language: 'English [en]', format: 'EPUB', size: '1.2 MB', url: '', hash: 'emmahash', downloadCount: 0 },
      titleScore: 1, authorScore: 1, confidence: 1, isExactMatch: true,
    };
    applySelectedMatch(csvPath, 0, candidate);
    rejectRowMatch(csvPath, 0);
    const row = readCSV(csvPath)[0];
    expect(row.status).toBe('rejected');
    expect(row.selected_hash).toBe('');
  });
});

describe('scanMatches', () => {
  let csvPath: string;

  beforeEach(() => {
    mockAxios.reset();
    csvPath = path.join(__dirname, '__fixtures__', 'test-scan-temp.csv');
  });

  afterEach(() => {
    fs.rmSync(csvPath, { force: true });
  });

  it('requires review even for an exact match from the untrusted catalog', async () => {
    fs.writeFileSync(csvPath, 'author,title\nCarl Sagan,The Demon Haunted World\n');
    const htmlFixture = fs.readFileSync(path.join(__dirname, '__fixtures__', 'search-results.html'), 'utf-8');
    mockAxios.onGet(/annas-archive\.(?:gl|is)\/search/).reply(200, htmlFixture);

    const events: Array<{ rowIndex: number; status: string }> = [];
    await scanMatches(csvPath, { secretKey: 'test', outputFolder: './test', untrustedCatalogSearch: true }, {
      onEvent: (event) => events.push({ rowIndex: event.rowIndex, status: event.status }),
    });

    const row = readCSV(csvPath)[0];
    expect(row.status).toBe('pending_review');
    expect(row.selected_hash).toBeFalsy();
    expect(events.some((event) => event.status === 'needs_review')).toBe(true);
  });

  it('defers a non-exact match to pending_review with candidates for the user to pick from', async () => {
    fs.writeFileSync(csvPath, 'author,title\nCarl Sagan,The Demon Haunted World: Science and Skepticism\n');
    const htmlFixture = fs.readFileSync(path.join(__dirname, '__fixtures__', 'search-results.html'), 'utf-8');
    mockAxios.onGet(/annas-archive\.(?:gl|is)\/search/).reply(200, htmlFixture);

    let candidateCount = 0;
    await scanMatches(csvPath, { secretKey: 'test', outputFolder: './test', preferredPublisher: 'Penguin', untrustedCatalogSearch: true }, {
      onEvent: (event) => { if (event.status === 'needs_review') candidateCount = event.candidates?.length || 0; },
    });

    const row = readCSV(csvPath)[0];
    expect(row.status).toBe('pending_review');
    expect(row.selected_hash).toBeFalsy();
    expect(candidateCount).toBeGreaterThan(0);
  });

  it('skips rows already downloaded, rejected, or matched', async () => {
    fs.writeFileSync(csvPath, 'author,title,status\nA,B,downloaded\nC,D,rejected\nE,F,matched\n');
    mockAxios.onGet(/annas-archive\.(?:gl|is)\/search/).reply(200, '<html><body></body></html>');

    const events: Array<{ rowIndex: number }> = [];
    await scanMatches(csvPath, { secretKey: 'test', outputFolder: './test' }, { onEvent: (event) => events.push({ rowIndex: event.rowIndex }) });

    expect(events).toHaveLength(0);
    expect(mockAxios.history.get.filter((request) => request.url?.includes('/search')).length).toBe(0);
  });

  it('resumes scanning at the requested row and preserves earlier failures', async () => {
    fs.writeFileSync(csvPath, 'author,title,status,error\nA,B,failed,keep this result\nC,D,,\n');
    mockAxios.onGet(/annas-archive\.(?:gl|is)\/search/).reply(200, '<html><body></body></html>');

    const events: Array<{ rowIndex: number }> = [];
    await scanMatches(csvPath, { secretKey: 'test', outputFolder: './test', untrustedCatalogSearch: true }, {
      startIndex: 1,
      onEvent: (event) => events.push({ rowIndex: event.rowIndex }),
    });

    const rows = readCSV(csvPath);
    expect(rows[0]).toMatchObject({ status: 'failed', error: 'keep this result' });
    expect(events.every((event) => event.rowIndex >= 1)).toBe(true);
  });

  it('does not rescan a durably selected edition after a failed download', async () => {
    fs.writeFileSync(csvPath, 'author,title,status,selected_hash\nA,B,failed,alreadyselected\n');
    mockAxios.onGet(/annas-archive\.(?:gl|is)\/search/).reply(200, '<html><body></body></html>');

    await scanMatches(csvPath, { secretKey: 'test', outputFolder: './test' });

    expect(mockAxios.history.get.filter((request) => request.url?.includes('/search'))).toHaveLength(0);
    expect(readCSV(csvPath)[0]).toMatchObject({ status: 'failed', selected_hash: 'alreadyselected' });
  });

  it('requires review for a high-confidence untrusted-catalog match', async () => {
    // "Carl E. Sagan" vs the fixture's "Carl Sagan" scores ~93% confidence but is not a token-exact author match.
    fs.writeFileSync(csvPath, 'author,title\nCarl E. Sagan,The Demon Haunted World\n');
    const htmlFixture = fs.readFileSync(path.join(__dirname, '__fixtures__', 'search-results.html'), 'utf-8');
    mockAxios.onGet(/annas-archive\.(?:gl|is)\/search/).reply(200, htmlFixture);

    await scanMatches(csvPath, { secretKey: 'test', outputFolder: './test', untrustedCatalogSearch: true }, {});

    const row = readCSV(csvPath)[0];
    expect(row.status).toBe('pending_review');
    expect(row.selected_hash).toBeFalsy();
  });

  it('requires an exact match before auto-accepting once a preferred publisher is configured', async () => {
    fs.writeFileSync(csvPath, 'author,title\nCarl E. Sagan,The Demon Haunted World\n');
    const htmlFixture = fs.readFileSync(path.join(__dirname, '__fixtures__', 'search-results.html'), 'utf-8');
    mockAxios.onGet(/annas-archive\.(?:gl|is)\/search/).reply(200, htmlFixture);

    let candidateCount = 0;
    await scanMatches(csvPath, { secretKey: 'test', outputFolder: './test', preferredPublisher: 'Penguin', untrustedCatalogSearch: true }, {
      onEvent: (event) => { if (event.status === 'needs_review') candidateCount = event.candidates?.length || 0; },
    });

    const row = readCSV(csvPath)[0];
    expect(row.status).toBe('pending_review');
    expect(row.selected_hash).toBeFalsy();
    expect(candidateCount).toBeGreaterThan(0);
  });
});

describe('readCSV', () => {
  it('accepts a UTF-8 BOM before the author header', () => {
    const csvPath = path.join(__dirname, '__fixtures__', 'test-bom-temp.csv');
    fs.writeFileSync(csvPath, '\uFEFFauthor,title\nJane Jacobs,The Economy of Cities\n');
    try {
      expect(readCSV(csvPath)[0]).toMatchObject({ author: 'Jane Jacobs', title: 'The Economy of Cities' });
    } finally {
      fs.unlinkSync(csvPath);
    }
  });

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
    delete process.env.ANNA_METADATA_INDEX;
    delete process.env.ENABLE_UNTRUSTED_CATALOG_SEARCH;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should load configuration from environment variables', () => {
    process.env.ANNAS_SECRET_KEY = 'test-secret-key';
    process.env.OUTPUT_FOLDER = './test-downloads';
    process.env.PREFERRED_LANGUAGE = 'English';
    process.env.MAX_DOWNLOADS = '5';

    const config = loadConfig();

    expect(config).toEqual({
      secretKey: 'test-secret-key',
      outputFolder: './test-downloads',
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

  it('loads and resolves a configured local metadata index path', () => {
    process.env.ANNAS_SECRET_KEY = 'test-secret-key';
    process.env.ANNA_METADATA_INDEX = './metadata.sqlite';

    expect(loadConfig().metadataIndex).toBe(path.resolve('./metadata.sqlite'));
  });

  it('only enables the untrusted catalog through an affirmative environment flag', () => {
    process.env.ANNAS_SECRET_KEY = 'test-secret-key';
    process.env.ENABLE_UNTRUSTED_CATALOG_SEARCH = 'true';
    expect(loadConfig().untrustedCatalogSearch).toBe(true);
    process.env.ENABLE_UNTRUSTED_CATALOG_SEARCH = 'false';
    expect(loadConfig().untrustedCatalogSearch).toBeUndefined();
  });

  it('should throw error when secret key is missing', () => {
    delete process.env.ANNAS_SECRET_KEY;

    expect(() => {
      loadConfig();
    }).toThrow('ANNAS_SECRET_KEY environment variable is required');
  });

  it('allows metadata-only scanning without a download secret', () => {
    delete process.env.ANNAS_SECRET_KEY;
    const config = loadConfig({ requireSecretKey: false });
    expect(config.secretKey).toBe('');
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

  it('rejects invalid MAX_DOWNLOADS values instead of silently disabling the limit', () => {
    process.env.ANNAS_SECRET_KEY = 'test-secret-key';
    process.env.MAX_DOWNLOADS = 'invalid';
    expect(() => loadConfig()).toThrow('MAX_DOWNLOADS must be a positive integer');
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
      .reply(200, { download_url: 'https://example.com/download/file.pdf' });

    // Mock the actual file download with a readable stream
    const { Readable } = require('stream');
    const mockStream = new Readable();
    mockStream.push('%PDF-1.7 mock file content');
    mockStream.push(null); // end of stream

    mockAxios
      .onGet('https://example.com/download/file.pdf')
      .reply(200, mockStream, { 'content-type': 'application/pdf' });

    const tmpDir = fs.mkdtempSync(path.join(__dirname, 'test-downloads-'));

    try {
      const downloadedPath = await downloadBook(book, 'test-secret', tmpDir);
      expect(mockAxios.history.get).toHaveLength(2);

      // Verify file was created
      const expectedFile = path.join(tmpDir, 'Test Book-testhash12.pdf');
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
    mockAxios.onGet(/fast_download\.json/).reply(200, { download_url: 'https://example.com/empty.pdf' });
    mockAxios.onGet('https://example.com/empty.pdf').reply(() => [200, Readable.from([]), { 'content-length': '0' }]);
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
      expect(mockAxios.history.get.slice(0, 3).map((request) => request.params?.domain_index)).toEqual([6, 7, 1]);
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

  it('rotates to a different signed mirror when the first server is unavailable', async () => {
    const book: Book = {
      title: 'Mirror Rotation Book', authors: 'Test Author', publisher: '', language: 'English',
      format: 'PDF', size: '7 B', url: '', hash: 'rotation-hash', downloadCount: 0,
    };
    const { Readable } = require('stream');
    mockAxios.onGet(/fast_download\.json/).reply((request) => [200, {
      download_url: request.params?.domain_index === 6
        ? 'https://unavailable.example/book.pdf'
        : 'https://responsive.example/book.pdf',
    }]);
    mockAxios.onGet('https://unavailable.example/book.pdf').networkError();
    mockAxios.onGet('https://responsive.example/book.pdf')
      .reply(() => [200, Readable.from(['content']), { 'content-type': 'application/pdf', 'content-length': '7' }]);
    const tmpDir = fs.mkdtempSync(path.join(__dirname, 'test-mirror-rotation-'));
    try {
      await expect(downloadBook(book, 'test-secret', tmpDir)).resolves.toContain('Mirror Rotation Book-rotationha.pdf');
      const apiRequests = mockAxios.history.get.filter((request) => request.url?.includes('fast_download.json'));
      expect(apiRequests.map((request) => request.params?.domain_index)).toEqual([6, 7]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('falls back to the next configured download origin', async () => {
    const fallback = 'https://annas-download-fallback.example';
    ANNAS_DOWNLOAD_BASE_URLS.push(fallback);
    const book: Book = { title: 'Fallback Book', authors: 'Author', publisher: '', language: 'English', format: 'pdf', size: '1 MB', url: '', hash: 'fallbackhash', downloadCount: 0 };
    const { Readable } = require('stream');
    mockAxios.onGet(new RegExp(`${new URL(ANNAS_DOWNLOAD_BASE_URLS[0]).hostname.replace(/\./g, '\\.')}.*fast_download`)).networkError();
    mockAxios.onGet(new RegExp(`${new URL(fallback).hostname.replace(/\./g, '\\.')}.*fast_download`)).reply(200, { download_url: 'https://files.example/fallback.pdf' });
    mockAxios.onGet('https://files.example/fallback.pdf').reply(() => [200, Readable.from(['%PDF-1.7 fallback content']), { 'content-type': 'application/pdf' }]);
    const tmpDir = fs.mkdtempSync(path.join(__dirname, 'test-download-fallback-'));
    try {
      await expect(downloadBook(book, 'test-secret', tmpDir)).resolves.toContain('Fallback Book-fallbackha.pdf');
    } finally {
      ANNAS_DOWNLOAD_BASE_URLS.pop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

describe('fast download server preferences', () => {
  it('uses responsive fallback indexes when no override is configured', () => {
    expect(parseFastDomainIndexes(undefined)).toEqual([6, 7, 1, 2, 8, 9, 0]);
    expect(parseFastDomainIndexes('')).toEqual([6, 7, 1, 2, 8, 9, 0]);
  });

  it('normalizes configured indexes without duplicates or invalid values', () => {
    expect(parseFastDomainIndexes('7, 6, 7, nope, -1, 101')).toEqual([7, 6]);
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
    fs.writeFileSync(filePath, '%PDF-1.7 test content');

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

  it('rejects a non-PDF payload saved with a PDF extension', () => {
    const filePath = path.join(tmpDir, 'not-a-book.pdf');
    fs.writeFileSync(filePath, '<html>gateway error</html>');
    expect(verifyDownload(filePath)).toBe(false);
  });

  it('should return false when file access fails', () => {
    // Use an invalid path that will cause an error
    const result = verifyDownload('/invalid/path/\0/file.pdf');
    expect(result).toBe(false);
  });
});

describe('safeDownloadFilename', () => {
  it('bounds UTF-8 names and includes a collision-resistant edition suffix', () => {
    const filename = safeDownloadFilename('📚'.repeat(200), 'PDF', 'abcdef1234567890');
    expect(Buffer.byteLength(filename, 'utf8')).toBeLessThanOrEqual(180);
    expect(filename).toMatch(/-abcdef1234\.pdf$/);
  });

  it('avoids Windows reserved device names', () => {
    expect(safeDownloadFilename('CON', 'epub', 'abcdef')).toBe('_CON-abcdef.epub');
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
        untrustedCatalogSearch: true,
      };

      // All searches return empty results (will fail - no books found)
      mockAxios.onGet(/annas-archive\.(?:gl|is)\/search/).reply(200, '<html><body></body></html>');

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
        untrustedCatalogSearch: true,
      };

      // Mock searches - should only search for books without "downloaded" status
      mockAxios.onGet(/annas-archive\.(?:gl|is)\/search/).reply(200, '<html><body></body></html>');

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
        untrustedCatalogSearch: true,
      };

      // Mock empty search results (no books found)
      mockAxios.onGet(/annas-archive\.(?:gl|is)\/search/).reply(200, '<html><body></body></html>');

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
        untrustedCatalogSearch: true,
      };

      // All searches return empty (will fail)
      mockAxios.onGet(/annas-archive\.(?:gl|is)\/search/).reply(200, '<html><body></body></html>');

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
    mockAxios.onGet(/annas-archive\.(?:gl|is)\/search/).reply(200, '<html><body></body></html>');

    const events: Array<{ rowIndex: number }> = [];
    await processCSV(testCsvPath, { secretKey: 'test-key', outputFolder: downloadDir, untrustedCatalogSearch: true }, {
      startIndex: 2,
      onEvent: (event) => events.push({ rowIndex: event.rowIndex }),
    });

    const rows = readCSV(testCsvPath);
    expect(rows[0].status || '').toBe('');
    expect(rows[1].status || '').toBe('');
    expect(rows[2].status).toBe('failed');
    expect(events.every((event) => event.rowIndex >= 2)).toBe(true);
  });

  it("downloads a row's pre-selected match directly, without searching", async () => {
    fs.writeFileSync(testCsvPath, [
      'author,title,status,selected_hash,selected_title,selected_authors,selected_format,selected_size,selected_url',
      'Jane Austen,Emma,matched,emmahash,Emma,Jane Austen,pdf,1 MB,https://annas-archive.gl/md5/emmahash',
    ].join('\n'));

    mockAxios.onGet(/fast_download\.json/).reply(200, { download_url: 'https://example.com/emma.pdf' });
    const { Readable } = require('stream');
    const stream = new Readable();
    stream.push('%PDF-1.7 mock file content');
    stream.push(null);
    mockAxios.onGet('https://example.com/emma.pdf').reply(200, stream, { 'content-type': 'application/pdf' });

    // Uses the statically-imported processCSV (bound at file load) rather than a dynamic
    // import — the `loadConfig` tests upstream call jest.resetModules(), which would otherwise
    // cause a fresh './main' import to pull in a fresh 'axios' instance that this file's
    // mockAxios (bound to the original 'axios' instance) can no longer intercept.
    await processCSV(testCsvPath, { secretKey: 'test-key', outputFolder: downloadDir });

    expect(mockAxios.history.get.some((request) => request.url?.includes('/search'))).toBe(false);
    const rows = readCSV(testCsvPath);
    expect(rows[0].status).toBe('downloaded');
  });
});
