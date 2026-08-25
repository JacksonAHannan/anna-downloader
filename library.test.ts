import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CSVRow } from './main';
import { normalizeLibraryTitle, reconcileRowsWithLibrary } from './library';

describe('existing library reconciliation', () => {
  const temporaryFolders: string[] = [];

  afterEach(() => {
    temporaryFolders.splice(0).forEach((folder) => fs.rmSync(folder, { recursive: true, force: true }));
  });

  function library(): string {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'anna-library-'));
    temporaryFolders.push(folder);
    return folder;
  }

  it('matches current downloader filenames by their edition hash recursively', () => {
    const folder = library();
    const nested = path.join(folder, 'Urbanism');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'Different title-1234567890.epub'), 'book');
    const rows: CSVRow[] = [{ author: 'Jane Jacobs', title: 'The Death and Life of Great American Cities', status: 'matched', selected_hash: '1234567890abcdef' }];

    const result = reconcileRowsWithLibrary(rows, folder);

    expect(result).toMatchObject({ filesScanned: 1, newlyDownloaded: 1, hashMatches: 1, titleMatches: 0 });
    expect(rows[0]).toMatchObject({ status: 'downloaded', error: '', download_route: 'existing_library' });
  });

  it('matches legacy filenames by conservative punctuation-insensitive titles', () => {
    const folder = library();
    fs.writeFileSync(path.join(folder, 'The Death and Life of Great American Cities.PDF'), 'book');
    const rows: CSVRow[] = [{ author: 'Jane Jacobs', title: 'The Death & Life of Great American Cities', status: 'matched' }];

    const result = reconcileRowsWithLibrary(rows, folder);

    expect(result).toMatchObject({ newlyDownloaded: 1, hashMatches: 0, titleMatches: 1 });
    expect(rows[0].status).toBe('downloaded');
  });

  it('does not guess from short generic titles or overwrite rejected rows', () => {
    const folder = library();
    fs.writeFileSync(path.join(folder, 'Algebra.pdf'), 'book');
    fs.writeFileSync(path.join(folder, 'A Clearly Identifiable Book.pdf'), 'book');
    const rows: CSVRow[] = [
      { author: 'First Author', title: 'Algebra', status: 'matched' },
      { author: 'Second Author', title: 'A Clearly Identifiable Book', status: 'rejected' },
    ];

    expect(reconcileRowsWithLibrary(rows, folder).newlyDownloaded).toBe(0);
    expect(rows.map((row) => row.status)).toEqual(['matched', 'rejected']);
  });

  it('normalizes accents, punctuation, and spacing consistently', () => {
    expect(normalizeLibraryTitle('  L’étrange—ville: A Study  ')).toBe('l etrange ville a study');
  });
});
