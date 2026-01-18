# Anna's Archive Downloader

A TypeScript utility for batch downloading books from Anna's Archive using a CSV input file.

## Features

- **Batch processing** - Process multiple books from a CSV file
- **Smart filtering** - Filter by preferred format (pdf, epub, mobi) and language
- **Popularity sorting** - Selects the most downloaded version when multiple matches exist
- **Progress tracking** - CSV status updates track download progress
- **Resume capability** - Automatically skips already downloaded books
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
| `OUTPUT_FOLDER` | No | `./downloads` | Directory for downloaded books |
| `PREFERRED_FORMAT` | No | - | Filter by format (pdf, epub, mobi) |
| `PREFERRED_LANGUAGE` | No | - | Filter by language (English, Spanish, etc.) |
| `MAX_DOWNLOADS` | No | unlimited | Maximum books to download per run |

## Usage

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
