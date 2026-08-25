import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as zlib from 'zlib';
import { DatabaseSync } from 'node:sqlite';

export interface LocalMetadataRecord {
  md5: string;
  title: string;
  author: string;
  publisher: string;
  language: string;
  extension: string;
  filesize: number;
  contentType: string;
  isbn13: string;
  hasAaDownload: boolean;
  hasExternalDownload: boolean;
  sourceRank: number;
}

export interface LocalMetadataCandidate extends LocalMetadataRecord {
  titleScore: number;
  authorScore: number;
  confidence: number;
  ftsRank: number;
}

export interface IndexProgress {
  file: string;
  filesCompleted: number;
  filesTotal: number;
  recordsRead: number;
  recordsInserted: number;
  recordsSkipped: number;
  malformedRecords: number;
  elapsedMs: number;
}

export interface BuildIndexOptions {
  sourceFiles: string[];
  databasePath: string;
  maxRecords?: number;
  batchSize?: number;
  progressEvery?: number;
  onProgress?: (progress: IndexProgress) => void;
}

interface AnnaMetadataLine {
  _source?: {
    id?: unknown;
    search_only_fields?: Record<string, unknown>;
  };
}

const STOP_WORDS = new Set(['a', 'an', 'and', 'by', 'for', 'in', 'of', 'on', 'the', 'to', 'with']);

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function firstString(value: unknown): string {
  if (Array.isArray(value)) return stringValue(value.find((entry) => typeof entry === 'string'));
  return stringValue(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean) : [];
}

export function metadataTokens(value: string): string[] {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)
    .filter((token) => token && !STOP_WORDS.has(token));
}

function textSimilarity(expected: string, candidate: string): number {
  const expectedTokens = new Set(metadataTokens(expected));
  const candidateTokens = new Set(metadataTokens(candidate));
  if (!expectedTokens.size || !candidateTokens.size) return 0;
  const intersection = [...expectedTokens].filter((token) => candidateTokens.has(token)).length;
  const coverage = intersection / expectedTokens.size;
  const union = new Set([...expectedTokens, ...candidateTokens]).size;
  return (coverage * 0.7) + ((intersection / union) * 0.3);
}

function isPlaceholderAuthor(author: string): boolean {
  return /\banonymous\b|\btradition(?:al)?\b/i.test(author);
}

export function parseAnnaMetadataLine(line: string): LocalMetadataRecord | null {
  const parsed = JSON.parse(line) as AnnaMetadataLine;
  const source = parsed._source;
  const fields = source?.search_only_fields;
  const id = stringValue(source?.id);
  const md5 = id.match(/^md5:([a-f0-9]{32})$/i)?.[1]?.toLowerCase() ?? '';
  const title = stringValue(fields?.search_title);
  if (!md5 || !title) return null;

  const accessTypes = stringArray(fields?.search_access_types);
  return {
    md5,
    title,
    author: stringValue(fields?.search_author),
    publisher: stringValue(fields?.search_publisher),
    language: firstString(fields?.search_most_likely_language_code),
    extension: stringValue(fields?.search_extension).toLowerCase(),
    filesize: numberValue(fields?.search_filesize),
    contentType: stringValue(fields?.search_content_type),
    isbn13: firstString(fields?.search_isbn13),
    hasAaDownload: accessTypes.includes('aa_download'),
    hasExternalDownload: accessTypes.includes('external_download'),
    sourceRank: numberValue(fields?.search_score_base_rank),
  };
}

function openDatabase(databasePath: string, readOnly = false): DatabaseSync {
  return new DatabaseSync(databasePath, { readOnly, timeout: 10_000 });
}

function initializeDatabase(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -262144;
    CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY,
      md5 TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      publisher TEXT NOT NULL,
      language TEXT NOT NULL,
      extension TEXT NOT NULL,
      filesize INTEGER NOT NULL,
      content_type TEXT NOT NULL,
      isbn13 TEXT NOT NULL,
      has_aa_download INTEGER NOT NULL,
      has_external_download INTEGER NOT NULL,
      source_rank INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS records_md5 ON records(md5);
    CREATE INDEX IF NOT EXISTS records_isbn13 ON records(isbn13) WHERE isbn13 <> '';
    CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
      title,
      author,
      content = 'records',
      content_rowid = 'id',
      tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE TABLE IF NOT EXISTS index_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
  `);
}

function recordArguments(record: LocalMetadataRecord): Array<string | number> {
  return [
    record.md5, record.title, record.author, record.publisher, record.language, record.extension,
    record.filesize, record.contentType, record.isbn13, Number(record.hasAaDownload),
    Number(record.hasExternalDownload), record.sourceRank,
  ];
}

export async function buildLocalMetadataIndex(options: BuildIndexOptions): Promise<IndexProgress & { databaseBytes: number }> {
  if (process.versions.node.split('.').map(Number)[0] < 22) throw new Error('Local metadata indexing requires Node.js 22.13 or newer.');
  if (!options.sourceFiles.length) throw new Error('No metadata shards were supplied.');
  for (const sourceFile of options.sourceFiles) {
    if (!fs.existsSync(sourceFile)) throw new Error(`Metadata shard not found: ${sourceFile}`);
  }
  fs.mkdirSync(path.dirname(options.databasePath), { recursive: true });

  const database = openDatabase(options.databasePath);
  initializeDatabase(database);
  const insert = database.prepare(`
    INSERT OR IGNORE INTO records (
      md5, title, author, publisher, language, extension, filesize, content_type,
      isbn13, has_aa_download, has_external_download, source_rank
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const setMetadata = database.prepare('INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)');
  const batchSize = Math.max(100, options.batchSize ?? 5_000);
  const progressEvery = Math.max(batchSize, options.progressEvery ?? 50_000);
  const startedAt = Date.now();
  let recordsRead = 0;
  let recordsInserted = 0;
  let recordsSkipped = 0;
  let malformedRecords = 0;
  let filesCompleted = 0;
  let transactionOpen = false;

  const progress = (file: string): IndexProgress => ({
    file,
    filesCompleted,
    filesTotal: options.sourceFiles.length,
    recordsRead,
    recordsInserted,
    recordsSkipped,
    malformedRecords,
    elapsedMs: Date.now() - startedAt,
  });

  try {
    database.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    for (const sourceFile of options.sourceFiles) {
      const input = fs.createReadStream(sourceFile).pipe(zlib.createGunzip());
      const lines = readline.createInterface({ input, crlfDelay: Infinity });
      for await (const line of lines) {
        if (options.maxRecords !== undefined && recordsRead >= options.maxRecords) {
          lines.close();
          input.destroy();
          break;
        }
        recordsRead += 1;
        try {
          const record = parseAnnaMetadataLine(line);
          if (!record) recordsSkipped += 1;
          else recordsInserted += Number(insert.run(...recordArguments(record)).changes);
        } catch {
          malformedRecords += 1;
        }

        if (recordsRead % batchSize === 0) {
          database.exec('COMMIT');
          transactionOpen = false;
          database.exec('BEGIN IMMEDIATE');
          transactionOpen = true;
        }
        if (recordsRead % progressEvery === 0) options.onProgress?.(progress(sourceFile));
      }
      filesCompleted += 1;
      if (options.maxRecords !== undefined && recordsRead >= options.maxRecords) break;
    }
    database.exec('COMMIT');
    transactionOpen = false;

    // Building FTS once after the bulk insert is substantially faster than maintaining it row by row.
    database.exec("INSERT INTO records_fts(records_fts) VALUES('rebuild')");
    database.exec('ANALYZE');
    setMetadata.run('records', String(recordsInserted));
    setMetadata.run('built_at', new Date().toISOString());
    setMetadata.run('source_files', JSON.stringify(options.sourceFiles));
    setMetadata.run('complete', String(options.maxRecords === undefined && filesCompleted === options.sourceFiles.length));
  } finally {
    if (transactionOpen) {
      try { database.exec('ROLLBACK'); } catch { /* database may already have closed the transaction */ }
    }
    database.close();
  }

  const finalProgress = progress(options.sourceFiles[Math.min(filesCompleted, options.sourceFiles.length) - 1] ?? '');
  options.onProgress?.(finalProgress);
  return { ...finalProgress, databaseBytes: fs.statSync(options.databasePath).size };
}

interface DatabaseCandidateRow {
  md5: string;
  title: string;
  author: string;
  publisher: string;
  language: string;
  extension: string;
  filesize: number;
  content_type: string;
  isbn13: string;
  has_aa_download: number;
  has_external_download: number;
  source_rank: number;
  fts_rank: number;
}

function ftsExpression(tokens: string[], operator: 'AND' | 'OR'): string {
  return `title : (${tokens.map((token) => `"${token}"`).join(` ${operator} `)})`;
}

export function searchLocalMetadata(databasePath: string, title: string, author = '', limit = 10): LocalMetadataCandidate[] {
  const tokens = metadataTokens(title);
  if (!tokens.length) return [];
  const database = openDatabase(databasePath, true);
  const query = database.prepare(`
    SELECT r.md5, r.title, r.author, r.publisher, r.language, r.extension, r.filesize,
           r.content_type, r.isbn13, r.has_aa_download, r.has_external_download,
           r.source_rank, bm25(records_fts, 8.0, 2.0) AS fts_rank
    FROM records_fts
    JOIN records r ON r.id = records_fts.rowid
    WHERE records_fts MATCH ?
    ORDER BY fts_rank ASC, r.has_aa_download DESC, r.source_rank DESC
    LIMIT ?
  `);
  const rows = new Map<string, DatabaseCandidateRow>();

  try {
    const candidateLimit = Math.max(50, Math.min(500, limit * 25));
    for (const operator of ['AND', 'OR'] as const) {
      for (const row of query.all(ftsExpression(tokens, operator), candidateLimit) as unknown as DatabaseCandidateRow[]) rows.set(row.md5, row);
      if (rows.size >= candidateLimit || operator === 'OR') break;
    }
  } finally {
    database.close();
  }

  const titleOnly = isPlaceholderAuthor(author);
  return [...rows.values()].map((row) => {
    const titleScore = textSimilarity(title, row.title);
    const authorScore = titleOnly ? 0 : textSimilarity(author, row.author);
    return {
      md5: row.md5,
      title: row.title,
      author: row.author,
      publisher: row.publisher,
      language: row.language,
      extension: row.extension,
      filesize: row.filesize,
      contentType: row.content_type,
      isbn13: row.isbn13,
      hasAaDownload: Boolean(row.has_aa_download),
      hasExternalDownload: Boolean(row.has_external_download),
      sourceRank: row.source_rank,
      ftsRank: row.fts_rank,
      titleScore,
      authorScore,
      confidence: titleOnly ? titleScore : (titleScore * 0.8) + (authorScore * 0.2),
    };
  }).sort((left, right) =>
    right.confidence - left.confidence
    || Number(right.hasAaDownload) - Number(left.hasAaDownload)
    || left.ftsRank - right.ftsRank
    || right.sourceRank - left.sourceRank
  ).slice(0, Math.max(1, limit));
}
