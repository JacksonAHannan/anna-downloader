import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import { buildLocalMetadataIndex, searchLocalMetadata } from './localMetadata';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredOption(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`Missing required option --${name}`);
  return path.resolve(value);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  do { value /= 1024; unit += 1; } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(2)} ${units[unit]}`;
}

async function indexCommand(): Promise<void> {
  const source = requiredOption('source');
  const database = requiredOption('database');
  const shard = option('shard');
  const maxRecords = option('max-records') ? Number(option('max-records')) : undefined;
  if (maxRecords !== undefined && (!Number.isInteger(maxRecords) || maxRecords <= 0)) throw new Error('--max-records must be a positive integer.');
  if (fs.existsSync(database) && !process.argv.includes('--append')) throw new Error(`Database already exists: ${database}. Use a new path or pass --append.`);

  const elasticsearchFolder = path.basename(source).toLowerCase() === 'elasticsearch' ? source : path.join(source, 'elasticsearch');
  const shardPattern = /^aarecords__(\d+)\.json\.gz$/;
  const sourceFiles = fs.readdirSync(elasticsearchFolder)
    .filter((name) => shardPattern.test(name) && (shard === undefined || shardPattern.exec(name)?.[1] === shard))
    .sort((left, right) => Number(shardPattern.exec(left)?.[1]) - Number(shardPattern.exec(right)?.[1]))
    .map((name) => path.join(elasticsearchFolder, name));
  if (!sourceFiles.length) throw new Error(`No matching aarecords JSON shards found in ${elasticsearchFolder}.`);

  const result = await buildLocalMetadataIndex({
    sourceFiles,
    databasePath: database,
    maxRecords,
    onProgress: (progress) => {
      const elapsedSeconds = Math.max(0.001, progress.elapsedMs / 1000);
      const rate = Math.round(progress.recordsRead / elapsedSeconds);
      process.stdout.write(`\r${progress.recordsRead.toLocaleString()} read | ${progress.recordsInserted.toLocaleString()} indexed | ${rate.toLocaleString()} records/s`);
    },
  });
  process.stdout.write('\n');
  console.log(`Index ready: ${database}`);
  console.log(`${result.recordsInserted.toLocaleString()} records in ${formatBytes(result.databaseBytes)} after ${(result.elapsedMs / 1000).toFixed(1)} seconds.`);
}

function searchCommand(): void {
  const database = requiredOption('database');
  const title = option('title');
  if (!title) throw new Error('Missing required option --title');
  const author = option('author') ?? '';
  const limit = option('limit') ? Number(option('limit')) : 10;
  const startedAt = performance.now();
  const results = searchLocalMetadata(database, title, author, limit);
  console.log(JSON.stringify({ query: { title, author }, elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100, results }, null, 2));
}

interface BenchmarkRow {
  title?: string;
  author?: string;
}

function benchmarkCommand(): void {
  const database = requiredOption('database');
  const csvPath = requiredOption('csv');
  const rows = parse(fs.readFileSync(csvPath), {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as BenchmarkRow[];
  const queries = rows.filter((row) => row.title?.trim()).map((row) => ({
    title: row.title!.trim(),
    author: row.author?.trim() ?? '',
  }));
  const startedAt = performance.now();
  let strong = 0;
  let usable = 0;
  const weak: Array<Record<string, unknown>> = [];
  for (const query of queries) {
    const top = searchLocalMetadata(database, query.title, query.author, 1)[0];
    if (top?.confidence >= 0.8) strong += 1;
    if (top?.confidence >= 0.65) usable += 1;
    else weak.push({
      ...query,
      confidence: top ? Math.round(top.confidence * 1000) / 1000 : 0,
      matchedTitle: top?.title ?? '',
      matchedAuthor: top?.author ?? '',
    });
  }
  const elapsedMs = performance.now() - startedAt;
  console.log(JSON.stringify({
    database,
    csv: csvPath,
    queries: queries.length,
    strongMatches: strong,
    usableMatches: usable,
    weakOrMissing: weak.length,
    elapsedMs: Math.round(elapsedMs * 100) / 100,
    averageQueryMs: Math.round((elapsedMs / Math.max(1, queries.length)) * 100) / 100,
    weak,
  }, null, 2));
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'index') await indexCommand();
  else if (command === 'search') searchCommand();
  else if (command === 'benchmark') benchmarkCommand();
  else throw new Error('Usage: metadata:cli -- index|search|benchmark [options]');
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
