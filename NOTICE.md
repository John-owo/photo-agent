# Third-party provenance

The Lightroom adapter consumes the local `lightroom-mcp-john` fork, which is
derived from `Automaat/lightroom-mcp` and remains a separately maintained MIT
licensed project. This repository does not reimplement or silently relicense
that backend.

The adapter is intentionally configured with an executable path instead of
vendoring Lightroom plugin files. Record the backend package version and Git
SHA in every session manifest when they are available.
