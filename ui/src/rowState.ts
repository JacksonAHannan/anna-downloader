export type Status = 'queued' | 'searching' | 'awaiting_confirmation' | 'downloading' | 'completed' | 'failed' | 'skipped';
export type MatchState = 'idle' | 'scanning' | 'matched' | 'needs_review' | 'rejected' | 'failed';
export type CandidateBook = { title: string; authors: string; publisher: string; language: string; format: string; size: string; url: string; hash: string; downloadCount: number; searchSource?: 'local_metadata' | 'untrusted_catalog' | 'catalog' | 'preselected' };
export type MatchCandidate = { book: CandidateBook; titleScore: number; authorScore: number; confidence: number; isExactMatch: boolean };
export type Row = { author: string; title: string; status: Status; progress: number; format?: string; size?: string; message?: string; matchTitle?: string; matchAuthors?: string; matchPublisher?: string; confidence?: number; matchState?: MatchState; candidates?: MatchCandidate[]; selectedHash?: string };
export type ImportedRow = { author: string; title: string; status?: string; error?: string; matched_title?: string; matched_author?: string; match_confidence?: string; selected_hash?: string; selected_publisher?: string; selected_format?: string; selected_size?: string; selected_source?: string };

export function importedRowToRow(row: ImportedRow): Row {
  const normalizedStatus = row.status?.trim().toLowerCase();
  const downloaded = normalizedStatus === 'downloaded';
  const rejected = normalizedStatus === 'rejected';
  const matchState: MatchState | undefined = rejected
    ? 'rejected'
    : normalizedStatus === 'pending_review'
      ? 'needs_review'
      : normalizedStatus === 'matched' || Boolean(row.selected_hash)
        ? 'matched'
        : undefined;
  const restoredStatus: Status = downloaded
    ? 'completed'
    : rejected
      ? 'skipped'
      : normalizedStatus === 'failed'
        ? 'failed'
        : 'queued';

  return {
    author: row.author,
    title: row.title,
    status: restoredStatus,
    progress: downloaded ? 100 : 0,
    message: row.error || undefined,
    matchTitle: row.matched_title || undefined,
    matchAuthors: row.matched_author || undefined,
    matchPublisher: row.selected_publisher || undefined,
    confidence: row.match_confidence ? Number(row.match_confidence) / 100 : undefined,
    matchState,
    selectedHash: row.selected_hash || undefined,
    format: row.selected_format || undefined,
    size: row.selected_size || undefined,
  };
}

export function reviewRowIndexes(rows: Row[]): number[] {
  return rows.flatMap((row, index) => row.matchState === 'needs_review' ? [index] : []);
}

export function adjacentReviewRow(indexes: number[], current: number, direction: -1 | 1): number | undefined {
  if (!indexes.length) return undefined;
  const position = indexes.indexOf(current);
  if (position < 0) return indexes[0];
  return indexes[(position + direction + indexes.length) % indexes.length];
}

export function nextUnresolvedReviewRow(indexes: number[], current: number): number | undefined {
  const remaining = indexes.filter((index) => index !== current);
  return remaining.find((index) => index > current) ?? remaining[0];
}
