# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2]

### Added

- Non-pinned notes are now injected with the date they were recorded. Without a
  date a note from three weeks ago and one from this morning reached the model
  looking identical, so it could not tell a stale observation from a current
  one. Pinned entries and slots are deliberately never dated: they assert
  something currently true rather than an observation made on a day.
  Configurable via `includeEntryTimestamps`.
- `MemoryLabels.factsGuidance` states the precedence between the memory
  sections. Several tiers of memory injected with equal authority leave the
  model to guess which wins when they disagree; naming the order is what removes
  the contradiction.

## [0.1.1]

### Fixed

- **The build failed for anyone installing from git.** `@types/node` was never
  declared as a devDependency. It resolved locally only because TypeScript walks
  up the directory tree and found `@types/node` hoisted into a parent project's
  `node_modules`; in a clean install there is no ancestor to borrow from, so
  `node:fs`, `node:path`, `structuredClone` and `globalThis.crypto` all failed to
  type-check and the `prepare` script aborted the install.
- `typeRoots` is now pinned to `./node_modules/@types` and `types` to `["node"]`,
  so the build can no longer silently depend on an ancestor directory again.

## [0.1.0]

### Added

- `AgentMemory`: pinned and expiring entries, single-value slots, automatic
  retention, token-aware context assembly.
- `tokenize`: CJK-aware tokenization using character n-grams, with no
  segmentation dependency.
- `Bm25Index` / `RecallIndex`: Okapi BM25 retrieval with optional synonym
  expansion, no embeddings and no network calls.
- History compression that keeps the newest turns verbatim, substitutes
  retrieval hits for older ones, and always reports how many turns were omitted.
- `EventRule` support for deterministic, auditable extraction of notable
  messages, with per-type merge windows and expiry.
- `StorageAdapter` interface with `MemoryStorage` and `FileStorage`
  implementations.
- `MemoryLabels` for emitting prompts in any language.
- `DEFAULT_EVENT_RULES` and `DEFAULT_SYNONYMS` presets.
- 46 tests covering the public API, compression, persistence, malformed
  persisted documents and failing storage.

[Unreleased]: https://github.com/frank123452/agent-memory/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/frank123452/agent-memory/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/frank123452/agent-memory/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/frank123452/agent-memory/releases/tag/v0.1.0
