import * as fs from 'fs';
import * as path from 'path';
import { stringify } from 'csv-stringify/sync';
import type { CSVRow } from './main';

const BOOK_FILE_EXTENSIONS = new Set([
  '.azw', '.azw3', '.chm', '.djvu', '.epub', '.fb2', '.html', '.lit', '.m4b',
  '.mobi', '.pdf', '.rar', '.rtf', '.txt', '.zip',
  // Retain compatibility with files created before language metadata was
  // separated reliably from the format field.
  '.french fr', '.german de', '.hindihi',
]);

export interface LibraryReconciliation {
  libraryFolder: string;
  filesScanned: number;
  existingDownloaded: number;
  newlyDownloaded: number;
  hashMatches: number;
  titleMatches: number;
}

export function normalizeLibraryTitle(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isStrongTitleKey(value: string): boolean {
  if (value.length < 12) return false;
  const words = value.split(' ');
  return words.length >= 2 || value.length >= 16;
}

function listBookFiles(folder: string): string[] {
  const files: string[] = [];
  const pending = [folder];
  while (pending.length) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && BOOK_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        try {
          if (fs.statSync(entryPath).size > 0) files.push(entryPath);
        } catch {
          // A file can disappear or become inaccessible during a large scan.
        }
      }
    }
  }
  return files;
}

function serializeRows(rows: CSVRow[]): string {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  if (!columns.includes('status')) columns.push('status');
  if (!columns.includes('error')) columns.push('error');
  if (!columns.includes('download_route')) columns.push('download_route');
  if (!columns.includes('average_speed')) columns.push('average_speed');
  return stringify(rows, { header: true, columns });
}

export function reconcileRowsWithLibrary(rows: CSVRow[], libraryFolder: string): LibraryReconciliation {
  const resolvedFolder = path.resolve(libraryFolder);
  const existingDownloaded = rows.filter((row) => row.status?.trim().toLowerCase() === 'downloaded').length;
  const result: LibraryReconciliation = {
    libraryFolder: resolvedFolder,
    filesScanned: 0,
    existingDownloaded,
    newlyDownloaded: 0,
    hashMatches: 0,
    titleMatches: 0,
  };
  if (!fs.existsSync(resolvedFolder) || !fs.statSync(resolvedFolder).isDirectory()) return result;

  const files = listBookFiles(resolvedFolder);
  result.filesScanned = files.length;
  const hashPrefixes = new Set<string>();
  const titleKeys = new Set<string>();
  for (const file of files) {
    const basename = path.basename(file, path.extname(file));
    const hashMatch = basename.match(/-([a-f0-9]{10})$/i);
    if (hashMatch) hashPrefixes.add(hashMatch[1].toLowerCase());
    const withoutHash = hashMatch ? basename.slice(0, -hashMatch[0].length) : basename;
    const titleKey = normalizeLibraryTitle(withoutHash);
    if (isStrongTitleKey(titleKey)) titleKeys.add(titleKey);
  }

  for (const row of rows) {
    const currentStatus = row.status?.trim().toLowerCase();
    if (currentStatus === 'downloaded' || currentStatus === 'rejected') continue;
    const hashPrefix = row.selected_hash?.replace(/[^a-f0-9]/gi, '').slice(0, 10).toLowerCase();
    const hashMatched = Boolean(hashPrefix && hashPrefixes.has(hashPrefix));
    const candidateTitles = [row.selected_title, row.title]
      .filter((value): value is string => Boolean(value?.trim()))
      .map(normalizeLibraryTitle)
      .filter(isStrongTitleKey);
    const titleMatched = !hashMatched && candidateTitles.some((title) => titleKeys.has(title));
    if (!hashMatched && !titleMatched) continue;

    row.status = 'downloaded';
    row.error = '';
    row.download_route = 'existing_library';
    row.average_speed = '';
    result.newlyDownloaded += 1;
    if (hashMatched) result.hashMatches += 1;
    else result.titleMatches += 1;
  }
  return result;
}

export function writeCSVRows(csvPath: string, rows: CSVRow[]): void {
  const output = serializeRows(rows);
  const temporaryPath = `${csvPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, output, 'utf-8');
    fs.renameSync(temporaryPath, csvPath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

export function reconcileCSVFile(csvPath: string, libraryFolder: string, parseRows: (content: string) => CSVRow[]): LibraryReconciliation {
  const rows = parseRows(fs.readFileSync(csvPath, 'utf-8'));
  const result = reconcileRowsWithLibrary(rows, libraryFolder);
  if (result.newlyDownloaded > 0) writeCSVRows(csvPath, rows);
  return result;
}
