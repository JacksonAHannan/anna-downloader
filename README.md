# Anna's Archive Downloader

A TypeScript utility for batch downloading books from Anna's Archive using a CSV input file.

## Features

- **Batch processing** - Process multiple books from a CSV file
- **Smart filtering** - Filter by preferred format (pdf, epub, mobi) and language
- **Format-aware fallback** - Prefers PDFs under 50 MB, then other small formats, then larger PDFs, then larger alternative formats
- **Progress tracking** - CSV status updates track download progress
- **Resume capability** - Automatically skips already downloaded books
- **Row-based starts** - Begin a run at any 1-based CSV row without processing earlier entries
- **Alternative matching** - Skips unsuitable search results and rotates to the next reliable edition
- **Rate limit handling** - Handles 429 responses gracefully
- **Download verification** - Validates files exist and have content
- **Configurable limits** - Set maximum downloads per run

## Prerequisites

- Node.js
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
| `GOOGLE_BOOKS_KEY` | For list builder | - | Google Books API key used by the local search service |
| `OUTPUT_FOLDER` | No | `./downloads` | Directory for downloaded books |
| `PREFERRED_FORMAT` | No | - | Filter by format (pdf, epub, mobi) |
| `PREFERRED_LANGUAGE` | No | - | Filter by language (English, Spanish, etc.) |
| `MAX_DOWNLOADS` | No | unlimited | Maximum books to download per run |

## Usage

### Local web interface

Build and start the browser interface:

```bash
npm run ui
```

Then open [http://localhost:4173](http://localhost:4173). Choose a CSV from your computer, review the parsed queue, and select **Start downloads**. The interface reports search, download, completion, skipped, and failure states for each row, including byte-level progress when the download server provides a content length. The secret key remains on the local Node server and is never sent to the browser.

The **Build a book list** tab searches Google Books by keyword, topic/genre, author, title, publisher, or ISBN. Select individual results or all currently loaded results, then either download an `author,title` CSV or send the selection directly to the downloader. Multiple authors are written with semicolons.

Use **Stop** to abort the active request safely. Downloaded files continue to use `OUTPUT_FOLDER` from `.env`.

### Command line

Run with the default `books.csv` file:

```bash
npm start
```

Run with a custom CSV file:

```bash
ts-node main.ts mybooks.csv
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

The script automatically adds a `status` column:

| Status | Meaning |
|--------|---------|
| (empty) | Not yet processed |
| `downloaded` | Successfully downloaded and verified |
| `failed` | Download failed or book not found |

Re-running the script will skip books marked as `downloaded`.

## Testing

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage
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
