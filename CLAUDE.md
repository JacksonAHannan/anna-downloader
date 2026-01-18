# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Anna's Archive Downloader - A TypeScript utility that batch downloads books from Anna's Archive using a CSV input file. The application searches for books, filters by preferred format/language, and downloads them automatically.

## Commands

```bash
# Install dependencies
npm install

# Run the application (compiles and runs)
npm start                    # Uses books.csv by default

# Run with a specific CSV file
ts-node main.ts mybooks.csv

# Run tests
npm test                     # Run all tests
npm run test:watch           # Watch mode for development
npm run test:coverage        # Run with coverage report

# Run a single test file or pattern
npx jest main.test.ts
npx jest -t "filterBooks"    # Run tests matching pattern
```

## Core Architecture

### Single-File Design
The entire application is contained in `main.ts` with a linear processing flow:
1. CSV parsing → search queries
2. Web scraping (Cheerio) → book metadata extraction
3. Fast download API → file streaming to disk

### Key Components

- **findBook()**: Scrapes Anna's Archive search results, extracts book metadata from HTML using Cheerio selectors (targeting `/md5/` links and specific CSS classes). Handles 429 rate limit responses.
- **downloadBook()**: Two-step download process via Anna's Archive Fast Download API, requires secret key authentication
- **verifyDownload()**: Validates downloaded files exist and have non-zero size
- **updateCSVStatus()**: Writes status ("downloaded"/"failed") back to CSV file for each book
- **processCSV()**: Main orchestrator that iterates through CSV rows, skips already downloaded books, handles filtering, verifies downloads, updates CSV status, respects MAX_DOWNLOADS limit, and manages download flow with rate limiting (1s delay between requests)
- **filterBooks()**: Applies user preferences (format/language) to search results, then sorts by download count (most popular first) and returns the best match

### Data Flow
CSV (author, title) → Search query → Book[] → filterBooks() → Selected Book → API call → Stream download

## Environment Configuration

Configuration via `.env` file (see `.env.example`):
- `ANNAS_SECRET_KEY` (required): Anna's Archive API key for fast downloads
- `OUTPUT_FOLDER` (optional): Download directory, defaults to `./downloads`
- `PREFERRED_FORMAT` (optional): Filter by format (pdf, epub, mobi)
- `PREFERRED_LANGUAGE` (optional): Filter by language (English, Spanish, etc.)
- `MAX_DOWNLOADS` (optional): Maximum number of books to download, defaults to unlimited

Config loaded via `loadConfig()` which validates required vars and creates output directory.

## CSV Format

The script expects a CSV file path as the first argument:
```csv
author,title
Carl Sagan,The Demon Haunted World
Alfred Lansing,Endurance: Shackleton's Incredible Voyage
```

The CSV file will be automatically updated with a "status" column tracking each book:
- Empty: Not yet processed
- "downloaded": Successfully downloaded and verified
- "failed": Download failed or not found

Re-running the script will skip books marked as "downloaded".

## Web Scraping Details

The scraper targets Anna's Archive's specific HTML structure:
- Book links: `a[href^="/md5/"]`
- Metadata extracted from nested divs with Tailwind classes
- Hash extracted from MD5 URL path
- Meta string format: `language · format · size` (split by ` · `)

If Anna's Archive changes their HTML structure, update selectors in `findBook()` function.

## Testing

Tests use Jest with ts-jest and axios-mock-adapter for HTTP mocking. Test fixtures are in `__fixtures__/`:
- `search-results.html`: Mock HTML for search result parsing tests
- `test-books.csv` / `test-books-with-status.csv`: Sample CSV files for CSV parsing tests