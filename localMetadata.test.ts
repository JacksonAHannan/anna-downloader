import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from '@jest/globals';
import { buildLocalMetadataIndex, parseAnnaMetadataLine, searchLocalMetadata } from './localMetadata';

const temporaryFolders: string[] = [];
afterEach(() => {
  for (const folder of temporaryFolders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

function metadataLine(md5: string, title: string, author: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    _source: {
      id: `md5:${md5}`,
      search_only_fields: {
        search_title: title,
        search_author: author,
        search_publisher: 'Test Press',
        search_most_likely_language_code: ['en'],
        search_extension: 'epub',
        search_filesize: 123456,
        search_content_type: 'book_nonfiction',
        search_isbn13: ['9780000000001'],
        search_access_types: ['aa_download'],
        search_score_base_rank: 42,
        ...overrides,
      },
    },
  });
}

describe('local Anna metadata index', () => {
  it('extracts the compact searchable record from an Anna JSON line', () => {
    const record = parseAnnaMetadataLine(metadataLine('0123456789abcdef0123456789abcdef', 'The Death and Life of Great American Cities', 'Jane Jacobs'));
    expect(record).toMatchObject({
      md5: '0123456789abcdef0123456789abcdef',
      title: 'The Death and Life of Great American Cities',
      author: 'Jane Jacobs',
      language: 'en',
      extension: 'epub',
      hasAaDownload: true,
    });
  });

  it('streams gzip records into a portable SQLite index and ranks title and author matches', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'anna-metadata-test-'));
    temporaryFolders.push(folder);
    const source = path.join(folder, 'aarecords__0.json.gz');
    const database = path.join(folder, 'index.sqlite');
    const lines = [
      metadataLine('0123456789abcdef0123456789abcdef', 'The Death and Life of Great American Cities', 'Jane Jacobs'),
      metadataLine('1123456789abcdef0123456789abcdef', 'Great Cities and Their Life', 'Another Author'),
      metadataLine('2123456789abcdef0123456789abcdef', 'The Death and Life of Great American Cities: Modern Library Edition', 'Jacobs, Jane'),
    ];
    fs.writeFileSync(source, zlib.gzipSync(`${lines.join('\n')}\n`));

    const result = await buildLocalMetadataIndex({ sourceFiles: [source], databasePath: database });
    expect(result.recordsInserted).toBe(3);
    const matches = searchLocalMetadata(database, 'The Death and Life of Great American Cities', 'Jane Jacobs', 5);
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(matches[0]).toMatchObject({ md5: '0123456789abcdef0123456789abcdef', confidence: 1 });
    expect(matches[1].title).toContain('Modern Library Edition');
  });

  it('resumes with a safe overlap and rebuilds deferred secondary indexes', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'anna-metadata-resume-test-'));
    temporaryFolders.push(folder);
    const source = path.join(folder, 'aarecords__0.json.gz');
    const database = path.join(folder, 'index.sqlite');
    const lines = [
      metadataLine('0123456789abcdef0123456789abcdef', 'First Complete Book', 'Author One'),
      metadataLine('1123456789abcdef0123456789abcdef', 'Second Complete Book', 'Author Two'),
      metadataLine('2123456789abcdef0123456789abcdef', 'Third Complete Book', 'Author Three'),
      metadataLine('3123456789abcdef0123456789abcdef', 'Fourth Complete Book', 'Author Four'),
    ];
    fs.writeFileSync(source, zlib.gzipSync(`${lines.join('\n')}\n`));

    const partial = await buildLocalMetadataIndex({ sourceFiles: [source], databasePath: database, maxRecords: 2 });
    expect(partial.recordsInserted).toBe(2);
    const resumed = await buildLocalMetadataIndex({ sourceFiles: [source], databasePath: database, skipRecords: 1 });
    expect(resumed.recordsRead).toBe(4);
    expect(resumed.recordsInserted).toBe(4);

    const db = new DatabaseSync(database, { readOnly: true });
    try {
      const metadata = Object.fromEntries((db.prepare('SELECT key, value FROM index_metadata').all() as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]));
      const indexes = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((row) => row.name));
      expect(metadata).toMatchObject({ records: '4', complete: 'true', search_backend: 'prefix_v1' });
      expect(indexes.has('records_md5')).toBe(false);
      expect(indexes.has('records_isbn13')).toBe(true);
      expect(indexes.has('record_search_title_key')).toBe(true);
    } finally {
      db.close();
    }
    expect(searchLocalMetadata(database, 'Fourth Complete Book', 'Author Four', 5)[0]).toMatchObject({
      md5: '3123456789abcdef0123456789abcdef',
      confidence: 1,
    });
  });
});
