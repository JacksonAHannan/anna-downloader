# Contributing

Thanks for contributing. Keep changes focused, preserve the local-only security boundary, and do not submit credentials, metadata dumps, downloaded files, or private reading lists.

## Development

1. Install Node.js 22.13 or newer.
2. Run `npm ci`.
3. Copy `.env.example` to `.env` and add only the credentials needed for your local test.
4. Run `npm run check` before opening a pull request.

Add or update tests for behavior changes. Network-facing changes should test redirect handling, credential isolation, response limits, and URL validation where applicable.

## Pull requests

Explain the user-visible behavior, security implications, and verification performed. Use synthetic fixtures; do not include real API responses containing account data or links tied to private credentials.
