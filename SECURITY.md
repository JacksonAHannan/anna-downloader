# Security policy

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could expose API keys, local files, or downloaded content. Use the repository's **Security** tab to submit a private vulnerability report through GitHub Security Advisories.

Include the affected version or commit, reproduction steps, and the expected impact. Do not include real credentials or copyrighted files in the report.

## Supported version

Security fixes are applied to the latest version on the default branch.

## Local security model

The web service binds to loopback and rejects non-local hosts and origins. Keep it behind that boundary. Never expose the port directly to a LAN or the public internet, and never commit `.env`, metadata databases, CSV catalogues, or downloaded files.
