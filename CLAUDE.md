# CLAUDE.md

Repository guidance for coding agents and contributors.

## Project

Anna Downloader is a local TypeScript application with a React UI. It imports CSV reading lists, reconciles them against an existing library, matches editions using a local SQLite metadata index before any enabled network fallback, and tracks verified downloads. The list builder supports several server-side LLM providers.

## Commands

```bash
npm ci
npm run check
npm run ui
npm run metadata:cli -- search --database ./metadata/index.sqlite --title "Example title"
```

Node.js 22.13 or newer is required. Use synthetic fixtures in tests and never commit `.env`, CSV catalogues, metadata databases, downloaded files, or credentials.

## Architecture

- `main.ts`: CSV state, provider ordering, matching, download routing, and verification.
- `localMetadata.ts`: metadata-dump ingestion and SQLite FTS search.
- `anna.ts`: exact-origin configuration and trusted-download URL validation.
- `server.ts`: loopback-only HTTP API, session state, folder selection, and SSE progress.
- `library.ts`: conservative reconciliation against files already on disk.
- `llm.ts`: server-side LLM provider adapters and structured list generation.
- `ui/src/`: React interface and state restoration.

## Security invariants

- Query a configured local metadata index before any fallback.
- Never silently fall back when the local database is missing or corrupt.
- Untrusted catalog access must remain opt-in, credential-free, response-bounded, same-origin, and search-only.
- Accept strict MD5 identifiers and rebuild candidate links on an explicitly trusted download origin.
- Never auto-accept untrusted-catalog matches.
- Keep the HTTP service bound to loopback and reject non-local hosts and origins.
- Persist `downloaded` only after the exact file written by the attempt passes verification.

Run `npm run check` after changes. Add focused tests for provider ordering and every changed security boundary.
