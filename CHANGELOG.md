# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- 44 tests covering the public API, compression, persistence, malformed
  persisted documents and failing storage.

[Unreleased]: https://github.com/frank123452/agent-memory/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/frank123452/agent-memory/releases/tag/v0.1.0
