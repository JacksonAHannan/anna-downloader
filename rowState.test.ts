import { describe, expect, it } from '@jest/globals';
import { adjacentReviewRow, importedRowToRow, nextUnresolvedReviewRow, reviewRowIndexes } from './ui/src/rowState';

describe('UI row restoration', () => {
  it('restores downloaded CSV rows as completed with full progress', () => {
    expect(importedRowToRow({ author: 'Jane Jacobs', title: 'The Economy of Cities', status: ' Downloaded ' })).toMatchObject({
      status: 'completed',
      progress: 100,
    });
  });

  it('restores a selected edition after a failed download as a durable match', () => {
    expect(importedRowToRow({
      author: 'Jane Jacobs', title: 'The Economy of Cities', status: 'failed', error: 'network timeout',
      selected_hash: 'abc123', selected_format: 'EPUB', selected_size: '2.9 MB',
    })).toMatchObject({
      status: 'failed',
      matchState: 'matched',
      selectedHash: 'abc123',
      format: 'EPUB',
      message: 'network timeout',
    });
  });

  it('does not count a rejected row as a completed download', () => {
    expect(importedRowToRow({ author: 'Nobody', title: 'No Match', status: 'rejected' })).toMatchObject({
      status: 'skipped',
      progress: 0,
      matchState: 'rejected',
    });
  });
});

describe('focused match review navigation', () => {
  const rows = [
    importedRowToRow({ author: 'A', title: 'One', status: 'matched' }),
    importedRowToRow({ author: 'B', title: 'Two', status: 'pending_review' }),
    importedRowToRow({ author: 'C', title: 'Three', status: 'matched' }),
    importedRowToRow({ author: 'D', title: 'Four', status: 'pending_review' }),
  ];

  it('collects only partial matches that need a decision', () => {
    expect(reviewRowIndexes(rows)).toEqual([1, 3]);
  });

  it('cycles through reviews without requiring list navigation', () => {
    expect(adjacentReviewRow([1, 3], 1, 1)).toBe(3);
    expect(adjacentReviewRow([1, 3], 3, 1)).toBe(1);
    expect(adjacentReviewRow([1, 3], 1, -1)).toBe(3);
  });

  it('advances after a decision and finishes when no reviews remain', () => {
    expect(nextUnresolvedReviewRow([1, 3, 8], 3)).toBe(8);
    expect(nextUnresolvedReviewRow([1, 3], 3)).toBe(1);
    expect(nextUnresolvedReviewRow([3], 3)).toBeUndefined();
  });
});
