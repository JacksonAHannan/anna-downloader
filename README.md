# Anna's Archive Downloader

A TypeScript utility for batch downloading books from Anna's Archive using a CSV input file.

## Features

- **Batch processing** - Process multiple books from a CSV file
- **Preliminary match review** - Scan every row for the best edition before downloading anything; only exact matches are picked automatically, everything else waits for you to choose from the top 10
- **Smart filtering** - Filter by preferred format (pdf, epub, mobi) and language
- **Publisher preference** - Set a preferred publisher (e.g. Penguin) in the UI or `.env`; matching editions rank slightly higher among otherwise-comparable candidates
- **Format-aware fallback** - Prefers PDFs under 50 MB, then other small formats, then larger PDFs, then larger alternative formats
- **Progress tracking** - CSV status updates track download progress
- **Resume capability** - Automatically skips already downloaded books
- **Row-based starts** - Begin a run at any 1-based CSV row without processing earlier entries
- **Alternative matching** - Skips unsuitable search results and rotates to the next reliable edition
- **Rate limit handling** - Handles 429 responses gracefully
- **Download verification** - Validates file completeness and PDF/EPUB signatures
- **Configurable limits** - Set maximum downloads per run

## Prerequisites

- Node.js 20 or newer
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
| `ANNAS_SECRET_KEY` | Yes | - | Your Anna's Archive API key for fast downloads |
| `ANNAS_BASE_URL` | No | `https://annas-archive.is` | Search catalog host |
| `ANNAS_DOWNLOAD_BASE_URL` | No | `https://annas-archive.gl` | MD5 member-download API host |
| `GOOGLE_BOOKS_KEY` | For list builder | - | Google Books API key used by the local search service |
| `OUTPUT_FOLDER` | No | `./downloads` | Directory for downloaded books |
| `PREFERRED_FORMAT` | No | - | Filter by format (pdf, epub, mobi) |
| `PREFERRED_LANGUAGE` | No | - | Filter by language (English, Spanish, etc.) |
| `PREFERRED_PUBLISHER` | No | - | Editions from a publisher containing this text rank higher (e.g., `Penguin`); also editable from the web UI |
| `MAX_DOWNLOADS` | No | unlimited | Maximum books to download per run |

## Usage

### Local web interface

Build and start the browser interface:

```bash
npm run ui
```

Then open [http://127.0.0.1:4173](http://127.0.0.1:4173). The service binds only to the local machine. Choose a CSV from your computer, review the parsed queue, and select **Start downloads**. The interface reports search, download, completion, skipped, and failure states for each row, including byte-level progress when the download server provides a content length. The secret key remains on the local Node server and is never sent to the browser.

Before downloading, you can select **Scan matches** to preview and choose editions ahead of time. Set a **Preferred publisher** (e.g. `Penguin`) to rank matching editions higher; with a preference set, only token-exact title/author matches are picked automatically and everything else is marked for review with its top 10 candidates (title, authors, publisher, language, format, size, popularity, and match confidence — matching editions are flagged). Leave the field blank and scanning behaves like a normal download run, auto-accepting any match above 80% confidence. Click a row's **Change match**/**Review again** link to open its candidate list, **Select** an edition, or **Reject** the title if nothing is acceptable. Once chosen, that exact edition is what **Start downloads** fetches — no re-searching. Scanning and downloading can't run at the same time.

The **Build a book list** tab searches Google Books by keyword, topic/genre, author, title, publisher, or ISBN. Select individual results or all currently loaded results, then either download an `author,title` CSV or send the selection directly to the downloader. Multiple authors are written with semicolons.

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

The script automatically adds a `status` column, plus diagnostic columns (`error`, `matched_title`, `matched_author`, `match_confidence`) and, once a preliminary match has been chosen, `selected_*` columns describing the exact edition to download:

| Status | Meaning |
|--------|---------|
| (empty) | Not yet processed |
| `matched` | A specific edition has been chosen (automatically or via match review) but not yet downloaded |
| `pending_review` | Scanned, but no exact match — awaiting your pick from the top 10 in the UI |
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
