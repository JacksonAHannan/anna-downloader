# Anna's Archive Downloader

A local TypeScript application for matching CSV reading lists to book metadata, reviewing editions, and managing verified downloads.

> This project is unaffiliated with Anna's Archive or any catalog provider. You are responsible for complying with copyright law, provider terms, and the laws that apply where you live. Use it only for material you are legally permitted to access.

## Features

- **Batch processing** - Process multiple books from a CSV file
- **Preliminary match review** - Scan every row before downloading; usable local matches may be selected automatically while untrusted-catalog results always wait for review
- **Smart filtering** - Filter by preferred language and reject editions without a usable format
- **Publisher preference** - Set a preferred publisher (e.g. Penguin) in the UI or `.env`; matching editions rank slightly higher among otherwise-comparable candidates
- **Format-aware fallback** - Prefers PDFs under 50 MB, then other small formats, then larger PDFs, then larger alternative formats
- **Progress tracking** - CSV status updates track download progress
- **Resume capability** - Automatically skips already downloaded books
- **Existing-library reconciliation** - On CSV import, recursively checks a configured library folder for editions already on disk
- **Row-based starts** - Begin a run at any 1-based CSV row without processing earlier entries
- **Alternative matching** - Skips unsuitable search results and rotates to the next reliable edition
- **Local metadata search** - Searches a compact, cross-platform SQLite index built from Anna's metadata dump, avoiding automated catalog title queries
- **Contained web fallback** - Optionally extracts MD5 leads from an explicitly configured untrusted catalog without trusting it as a download origin
- **Rate limit handling** - Handles 429 responses gracefully
- **Download verification** - Validates file completeness and PDF/EPUB signatures
- **Configurable limits** - Set maximum downloads per run

## Prerequisites

- Node.js 22.13 or newer
- Anna's Archive secret key (for fast downloads)

## Installation

```bash
npm install
```

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANNAS_SECRET_KEY` | For downloads | - | Anna's Archive API key for fast downloads; local scanning does not require it |
| `ANNA_METADATA_INDEX` | Recommended | - | SQLite index built from local metadata; it is always queried before any enabled web fallback |
| `ANNAS_DOWNLOAD_BASE_URL` | No | `https://annas-archive.gl` | MD5 member-download API host |
| `ENABLE_UNTRUSTED_CATALOG_SEARCH` | No | `false` | Affirmative opt-in used only when local metadata has no sufficiently close match |
| `UNTRUSTED_CATALOG_BASE_URL` | No | `https://annas-archive.is` | Search-only origin for opt-in untrusted mode; never added to trusted download hosts |
| `UNTRUSTED_CATALOG_BASE_URLS` | No | - | Optional comma-separated search-only fallback origins |
| `ANNAS_DOWNLOAD_BASE_URLS` | No | - | Comma-separated member-download origins tried in order before `ANNAS_DOWNLOAD_BASE_URL` |
| `ANNAS_TRUSTED_HOSTS` | No | - | Extra exact hostnames accepted for candidate links; wildcards are rejected |
| `ANNAS_FAST_DOMAIN_INDEXES` | No | `6,7,1,2,8,9,0` | Anna fast-download server indexes tried in order; rotates signed mirror URLs when one partner is unavailable |
| `OPENAI_API_KEY` / `OPENAI_KEY` | For list builder | - | OpenAI API key used to generate curated book lists |
| Other provider keys | No | - | `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `COHERE_API_KEY`, or `PERPLEXITY_API_KEY` |
| `OUTPUT_FOLDER` | No | `./downloads` | Directory for downloaded books |
| `UI_PORT` | No | `4173` | Loopback-only web interface port |
| `LIBRARY_SCAN_FOLDER` | No | `OUTPUT_FOLDER` | Existing library root scanned recursively on CSV import to restore downloaded statuses |
| `PREFERRED_LANGUAGE` | No | - | Filter by language (English, Spanish, etc.) |
| `PREFERRED_PUBLISHER` | No | - | Editions from a publisher containing this text rank higher (e.g., `Penguin`); also editable from the web UI |
| `MAX_DOWNLOADS` | No | unlimited | Maximum books to download per run |

### Build the local metadata index

Build one SQLite index from all downloaded `aarecords__*.json.gz` shards. The source may be either the torrent root or its `elasticsearch` directory:

```powershell
npm run metadata:cli -- index --source "./metadata" --database "./metadata/anna-metadata.sqlite"
```

Then set the completed database in `.env` and restart the app:

```dotenv
ANNA_METADATA_INDEX=./metadata/anna-metadata.sqlite
```

Indexes built by versions before 1.0 used the platform-dependent SQLite FTS5 module. Rebuild an older index once with the current CLI before moving it to another operating system.

For a bounded smoke test, add `--shard 0 --max-records 1000000`. You can benchmark any `author,title` CSV against an index without modifying the CSV:

```powershell
npm run metadata:cli -- benchmark --database "./metadata/anna-metadata.sqlite" --csv "./reading-list.csv"
```

Interrupted builds can retain their committed rows. Restart with `--append --skip-records N`, where `N` is a previous `read` checkpoint from the build output. Using an earlier checkpoint is safe: the MD5 uniqueness constraint discards the overlap. Secondary search indexes are deferred until ingestion completes, so large builds avoid maintaining them row by row.

### Opt in to the untrusted catalog fallback

If you cannot use a local metadata index, or want a fallback for rows with no usable local match, you can explicitly enable the search-only fallback:

```dotenv
ANNA_METADATA_INDEX=
ENABLE_UNTRUSTED_CATALOG_SEARCH=true
UNTRUSTED_CATALOG_BASE_URL=https://annas-archive.is
```

This origin is unaffiliated and must be treated as hostile. The client sends only a title query with generic `User-Agent`/`Accept` headers: it does not send API keys, cookies, credentials, or a referrer. Redirects must remain on the exact configured origin, HTML responses are capped at 5 MB, and only strict 32-character hexadecimal MD5 values are accepted. Candidate links are rebuilt on `ANNAS_DOWNLOAD_BASE_URL`; the untrusted host is never trusted for downloads. Results are limited to PDF/EPUB, visibly labeled in the UI, and require a manual selection even when the title and author match exactly. Set `ENABLE_UNTRUSTED_CATALOG_SEARCH=false` at any time as the kill switch, then restart the app.

Provider order is strict: the configured local index is queried and ranked first. A web fallback is contacted only when the local index returns no candidate that satisfies the normal match threshold. If the local database is missing or corrupt, the scan fails visibly instead of silently sending the title elsewhere.

## Usage

### Local web interface

Build and start the browser interface:

```bash
npm run ui
```

Then open [http://127.0.0.1:4173](http://127.0.0.1:4173). The service binds only to the local machine. Choose a CSV from your computer, review the parsed queue, and select **Start downloads**. The interface reports search, download, completion, skipped, and failure states for each row, including byte-level progress when the download server provides a content length. The secret key remains on the local Node server and is never sent to the browser.

Before downloading, you can select **Scan matches** to preview and choose editions ahead of time. Set a **Preferred publisher** (e.g. `Penguin`) to rank matching editions higher; with a preference set, only token-exact title/author matches from trusted local metadata are picked automatically and everything else is marked for review with its top 10 candidates (title, authors, publisher, language, format, size, popularity, source, and match confidence — matching editions are flagged). Leave the field blank and local-metadata scanning auto-accepts matches above 80% confidence. Untrusted-catalog results are never auto-accepted. Click a row's **Change match**/**Review again** link to open its candidate list, **Select** an edition, or **Reject** the title if nothing is acceptable. Once chosen, that exact edition is what **Start downloads** fetches — no re-searching. Scanning and downloading can't run at the same time.

The **Build a book list** tab uses a configured LLM provider to generate a curated reading list from a natural-language request. Choose a provider and model, specify the number of books, review or deselect suggestions, then download an `author,title` CSV or send the selection directly to the downloader. Generate-more requests exclude titles already in the current list. API keys remain on the local server.

Use **Stop** to abort the active request safely. Downloaded files continue to use `OUTPUT_FOLDER` from `.env`.

### Command line

Build once, then pass the CSV path after `--`:

```bash
npm run build
npm start -- books.csv
```

Run with a custom CSV file:

```bash
npm start -- mybooks.csv
```

## CSV Format

### Input

Create a CSV file with `author` and `title` columns:

```csv
author,title
Carl Sagan,The Demon Haunted World
Alfred Lansing,Endurance: Shackleton's Incredible Voyage
```

### Output

The script automatically adds a `status` column, plus diagnostic columns (`error`, `matched_title`, `matched_author`, `match_confidence`) and, once a preliminary match has been chosen, `selected_*` columns describing the exact edition and its source:

| Status | Meaning |
|--------|---------|
| (empty) | Not yet processed |
| `matched` | A specific edition has been chosen (automatically or via match review) but not yet downloaded |
| `pending_review` | Scanned and awaiting your pick from the top candidates; all untrusted-catalog results use this state |
| `rejected` | You reviewed the candidates and none were acceptable; never re-processed |
| `downloaded` | Successfully downloaded and verified |
| `failed` | Download failed or book not found |

Re-running the script will skip books marked as `downloaded` or `rejected`.

## Testing

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage

# Type-check, test, and build everything (also used by CI)
npm run check
```

## Scheduled Downloads (macOS)

To run the downloader automatically every day (useful for working around rate limits), you can set up a launchd job.

### Setup

1. Create the launchd plist file at `~/Library/LaunchAgents/com.anna-downloader.daily.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.anna-downloader.daily</string>
    <key>ProgramArguments</key>
    <array>
        <string>/path/to/anna-downloader/run-downloader.sh</string>
        <string>/path/to/reading-list.csv</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>3</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardErrorPath</key>
    <string>/path/to/anna-downloader/logs/error.log</string>
    <key>StandardOutPath</key>
    <string>/path/to/anna-downloader/logs/downloader.log</string>
</dict>
</plist>
```

2. Update the paths in the plist to match your installation directory.

3. Load the job:

```bash
launchctl load ~/Library/LaunchAgents/com.anna-downloader.daily.plist
```

### Management Commands

```bash
# Verify the job is loaded
launchctl list | grep anna

# Trigger a run immediately
launchctl start com.anna-downloader.daily

# Check logs
tail -f logs/downloader.log

# Stop the scheduled job
launchctl unload ~/Library/LaunchAgents/com.anna-downloader.daily.plist

# Restart after making changes to the plist
launchctl unload ~/Library/LaunchAgents/com.anna-downloader.daily.plist
launchctl load ~/Library/LaunchAgents/com.anna-downloader.daily.plist
```

## Security and contributions

See [SECURITY.md](SECURITY.md) for private vulnerability reporting and the local-only deployment boundary. Contribution setup and review expectations are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

No open-source license has been selected. The repository is currently published as `UNLICENSED`; choose and add a license before inviting redistribution or reuse.
