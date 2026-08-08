# Anna Downloader Product Specification

## 1. Product summary

Anna Downloader is a local TypeScript application with a browser-based UI for building, reviewing, and processing CSV reading lists. It uses Google Books for catalogue discovery and metadata, searches `annas-archive.gl` for downloadable editions, chooses editions using title-and-author relevance, tracks each row throughout the run, and maintains an exportable catalogue of books that have been successfully acquired.

The product should favor correctness and resumability over maximizing download volume. It must never mark a book as owned unless the exact file written by that attempt has been verified as non-empty and complete.

## 2. Goals

The program must let a user:

1. Build CSV reading lists from Google Books searches.
2. Import an existing CSV from the local computer.
3. See which rows are already marked as downloaded and skip them automatically.
4. Find the most relevant eligible Anna's Archive edition for each row.
5. Automatically download high-confidence matches and defer ambiguous matches for review.
6. See search, review, download, progress, completion, pause, skip, and failure states per book.
7. Resume a list without redownloading owned books.
8. Export an updated CSV catalogue containing durable statuses and diagnostics.
9. Stop safely when Anna's Archive's daily fast-download allowance is exhausted.

## 3. Operating assumptions and boundaries

- The application runs locally. API keys and download credentials remain on the Node server and are never exposed to browser code.
- Anna's Archive integration targets `https://annas-archive.gl`.
- The user is responsible for ensuring that downloads are lawful. Public-domain material such as *Pride and Prejudice* is the standard end-to-end test content.
- Slow-download pages may require manual DDoS-Guard verification. The application must not claim that it can bypass or automate a manual challenge.
- Browser security prevents the application from silently overwriting the originally selected local CSV. The application therefore maintains a working copy and provides an explicit updated-CSV export.

## 4. Configuration

The application reads configuration from `.env`.

| Variable | Required | Purpose |
|---|---:|---|
| `ANNAS_SECRET_KEY` | Yes for fast downloads | Authenticates Anna's Archive fast-download requests. |
| `GOOGLE_BOOKS_KEY` | Yes for list building | Authenticates Google Books API searches. |
| `OUTPUT_FOLDER` | No | Destination for verified book files. |
| `PREFERRED_FORMAT` | No | Required edition format when set, normally `pdf`. |
| `PREFERRED_LANGUAGE` | No | Preferred edition language, normally English. |
| `MAX_DOWNLOADS` | No | Maximum successful downloads in one run. Failures do not consume this limit. |
| `UI_PORT` | No | Local web-server port. |

Secrets must not appear in logs, CSV exports, frontend bundles, error messages, or screenshots.

## 5. CSV contract

### 5.1 Required input fields

Each row represents one requested work.

| Column | Required | Description |
|---|---:|---|
| `author` | Yes | One or more authors. |
| `title` | Yes | Requested title. |
| `status` | No | Durable processing/ownership state. |

Author names may be written naturally as `Jane Austen` or `Austen, Jane`. Multiple authors must be separated with semicolons, for example:

```csv
author,title
William L. Cleveland; Martin Bunton,A History of the Modern Middle East
```

Semicolons are author separators. Commas remain valid inside a quoted CSV field.

### 5.2 Managed diagnostic fields

The working catalogue may add these columns:

| Column | Meaning |
|---|---|
| `status` | Current durable state. |
| `error` | Human-readable reason for failure, pause, or skip. |
| `matched_title` | Anna edition title selected or proposed. |
| `matched_author` | Anna edition author metadata. |
| `match_confidence` | Integer percentage from 0 to 100. |

### 5.3 Status semantics

Status comparisons must ignore casing and surrounding whitespace.

| Status | Meaning |
|---|---|
| blank / `Not started` | Eligible for processing. |
| `matched` | A candidate was found but is not yet owned. |
| `pending_review` | A lower-confidence match is deferred to the review phase. |
| `downloaded` | The exact downloaded file was verified; this row is owned and must be skipped on later runs. |
| `failed` | Processing failed for a non-quota reason and may be retried. |
| `skipped` | The user declined the proposed candidate; the book is not owned. |

Only `downloaded` is an ownership assertion. UI labels such as “Completed” or “Skipped” must not be written as `downloaded` unless verification succeeded.

## 6. Google Books list builder

The UI must provide a “Build a book list” workspace backed by the Google Books API.

### Required search modes

- Any keyword
- Topic or genre (`subject`)
- Author
- Title
- Publisher
- ISBN

### Result behavior

- Display title, all authors, publication date, publisher, categories, description, and cover when available.
- Allow selection of individual results.
- Provide “Select all” for all currently loaded results.
- Support configurable page size and loading additional results.
- Export selected results as an `author,title` CSV.
- Allow selected results to be sent directly to the downloader.
- Join multiple Google Books authors using `; `.
- Handle non-JSON upstream responses without exposing `Unexpected token '<'` to the user; show a meaningful API/server error instead.

## 7. CSV import and catalogue behavior

When a CSV is selected:

1. Validate that every row has non-empty `author` and `title` values.
2. Preserve existing status and diagnostic columns.
3. Treat any normalized `downloaded` status as owned.
4. Render owned rows as skipped/completed with 100% progress.
5. Never search or download an owned row.
6. Copy the selected CSV into the application's runtime catalogue.

During processing, every terminal or resumable state must be written immediately to the runtime CSV. A crash or restart should lose at most the currently active attempt, not the completed catalogue history.

The UI must provide “Save updated CSV,” returning all original rows plus the current status and diagnostic fields. The suggested filename should append `-updated` to the selected filename.

## 8. Edition search and matching

### 8.1 Search

- Query `annas-archive.gl` using both requested author and title.
- Parse all available search results into a normalized edition model containing title, authors, language, format, size, URL/hash, publisher, and popularity when available.
- If `PREFERRED_FORMAT` is set, use this order: preferred format under 50 MB, other formats under 50 MB, larger/unknown-size preferred-format editions, then larger/unknown-size other formats. A formatless result must never create an extensionless output file.
- Apply the preferred language when matching eligible editions.

### 8.2 Relevance scoring

Matching must use both title and author evidence, with title weighted more heavily. Normalization should ignore case, punctuation, diacritics, common stop words, and author-name ordering differences where practical.

The system must reject thematically related but incorrect works. For example, a search for *Botswana in the Modern World-System* must not download a generic work about the modern world-system.

### 8.3 Confidence policy

- A match strictly greater than 90% downloads automatically.
- A match at or below 90% that still meets the minimum reliable-match threshold is deferred for review.
- Unreliable matches are marked `failed` with `No reliable match`, including the best proposed title, author, and confidence when available.
- The application must continue evaluating later CSV rows while review candidates accumulate.
- Review candidates appear at the end of the visible queue after automatic candidates have been evaluated.
- Confirm downloads the displayed edition. Skip declines it without marking the book as owned.
- Candidate ranking should allow later eligible candidates to be considered when a better-ranked candidate is unusable.

## 9. Download workflow

### 9.1 Fast download

1. Request an authenticated fast-download URL for the selected hash.
2. Attempt the returned partner URL.
3. If local DNS returns `ENOTFOUND`, resolve the mirror through public DNS-over-HTTPS and retry while preserving the original hostname for TLS verification.
4. Never expose the secret key in errors or persisted data.

### 9.2 Slow fallback

- When fast download is unavailable, probe the edition's listed slow-partner routes in order.
- Reject HTML, DDoS challenge pages, and other non-file responses.
- A manual browser verification requirement is a blocked fallback, not a successful download.
- Do not attempt to bypass CAPTCHA or DDoS-Guard protections.

### 9.3 Daily quota

When the fast-download service returns HTTP 429 and no automated slow partner succeeds:

1. Stop the whole run immediately.
2. Set the UI run state to “Daily limit reached.”
3. Return the active row to `Not started` rather than `failed`.
4. Leave all remaining rows pending.
5. Preserve all verified `downloaded` rows.
6. Allow a later run to resume after the quota resets.

Do not repeatedly probe every remaining book after quota exhaustion.

## 10. File writing and verification

- Sanitize Windows-invalid filename characters while preserving readable titles.
- Require a non-empty extension derived from the selected edition format.
- Write each response to `<final-name>.part` first.
- Track byte-level progress when `Content-Length` is available.
- Reject zero-byte output.
- If `Content-Length` is available, reject a byte-count mismatch.
- Remove incomplete `.part` files after failure or cancellation.
- Rename the completed partial file to its final name only after validation.
- Return and verify the exact path written by the current attempt. Never reconstruct a path and accidentally validate an older, similarly named file.
- Mark the CSV row `downloaded` only after the exact final file exists and has non-zero content.

## 11. User interface

### 11.1 Main workspaces

- “Download CSV”
- “Build a book list”

### 11.2 Download queue

For every row show:

- Requested title and author
- Proposed matched title when available
- Match confidence
- Selected format
- Current status
- Progress bar and percentage
- Detailed failure or pause message
- Confirm/Skip controls while awaiting review

The summary must show total, completed/owned, in progress, and failed counts. Previously downloaded rows count as completed for catalogue purposes but remain visibly labeled as skipped to communicate that no new network request was made.

### 11.3 Run controls

- Start downloads
- Stop safely
- Confirm or skip a proposed edition
- Save updated CSV
- Clear/select another CSV when no run is active

The frontend must parse API responses defensively. If the server returns HTML or another unexpected content type, present a meaningful local-server error rather than a raw JSON parser exception.

## 12. Error handling and diagnostics

Persist actionable errors at row level, including:

- No results found
- No reliable match
- Selected edition lacks the preferred format
- Fast-download API error
- DNS resolution failure and retry outcome
- HTTP 429 quota pause
- Slow-partner HTTP status or HTML challenge response
- Empty or incomplete file
- Download verification failure
- User skip or stop

Errors must distinguish “not owned” from “owned.” A failed or skipped row must never display as a successful download.

## 13. Resume and recovery

- Re-importing an updated catalogue must skip every `downloaded` row.
- Failed, paused, matched, pending-review, and not-started rows remain eligible for later processing.
- Stopping a run aborts the active request, resolves pending confirmation waits, cleans partial files, and preserves completed rows.
- A new run must clear stale transient UI messages without erasing durable CSV diagnostics.

## 14. Acceptance criteria

The product is acceptable when all of the following are demonstrably true:

1. Importing a CSV containing `downloaded`, `Downloaded`, or whitespace-padded equivalents skips those rows without an Anna search.
2. A verified download immediately writes `downloaded` to the runtime catalogue.
3. “Save updated CSV” exports every input row and its latest status.
4. A greater-than-90% match downloads without confirmation.
5. A 90% match is deferred, not auto-downloaded.
6. Deferred reviews occur only after automatic candidates have been evaluated.
7. A weak thematic match is not downloaded.
8. A formatless candidate is rejected when PDF is required.
9. A zero-byte, truncated, or HTML response is never marked downloaded.
10. Local DNS failure can retry a resolvable fast mirror through public DNS.
11. HTTP 429 pauses the run and leaves unfinished rows resumable.
12. Existing verified files and catalogue statuses survive a restart.
13. Google Books search supports all specified query modes, selection, Select All, CSV export, and direct use in the downloader.
14. The browser UI produces no relevant console errors during import, review, export, stop, or normal completion flows.
15. *Pride and Prejudice* can be used as the public-domain end-to-end test without relying on copyrighted test material.

## 15. Data-quality rules for ownership reconciliation

When reconciling a catalogue against an existing output folder:

- Ignore directories, `.part` files, and zero-byte files.
- Normalize filename punctuation and casing before comparison.
- Prefer exact catalogue history and persisted `matched_title` evidence over fuzzy filename-only inference.
- Treat ambiguous generic filenames such as `ECONOMICS.PDF` as owned only when runtime match history ties them to a specific row.
- Do not infer ownership solely from topical similarity.
- Report counts of catalogue rows, owned matches, ambiguous files, duplicate author/title keys, and missing required values.

## 16. Known limitations and future considerations

- Anna's Archive domain structure, HTML, mirrors, quotas, and anti-bot behavior may change and require parser maintenance.
- Manual slow-download challenges cannot be completed unattended. A future workflow may open the relevant page for explicit user action, but must not bypass the challenge.
- Filename-based folder reconciliation is inherently weaker than a durable manifest containing source hash, final path, byte size, and completion timestamp. Adding such a manifest is recommended.
- A future catalogue format may add `downloaded_path`, `source_hash`, `downloaded_at`, and `verified_size` while preserving CSV compatibility.
- Large CSVs may benefit from queue virtualization and indexed catalogue lookups, but correctness takes priority over this optimization.
