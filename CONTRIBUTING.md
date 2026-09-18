# Contributing

Thanks for considering a contribution. This is a small library and the bar is
"does it stay small and correct".

## Getting set up

```bash
npm install
npm run build
npm test
```

`npm test` builds first, so it always exercises the shipped output. If your
environment restricts child processes (some sandboxes do), run the suite
in-process instead:

```bash
npm run test:fast
```

## Before opening a pull request

- `npm run typecheck` passes. The project compiles under `strict` **and**
  `noUncheckedIndexedAccess`, and CI enforces both.
- `npm test` passes.
- New behaviour has a test. Bug fixes get a regression test named after the
  defect — the `regressions` suite exists precisely because three bugs shipped
  that the original suite did not catch.
- Public API changes are reflected in `README.md` and `CHANGELOG.md`.

## Design constraints

These are deliberate. Please open an issue before proposing changes that break
them.

1. **No runtime dependencies.** The library must install with nothing but
   itself. Dev dependencies for tooling are fine.
2. **No network calls.** Nothing in the default path may reach out to an
   embedding API or a model. The optional `summarize` hook is the only place an
   LLM is allowed, and it is opt-in.
3. **Deterministic extraction.** `EventRule` matching stays rule-based. Rules are
   auditable and testable, and a false positive on a path that can feed a safety
   escalation is worse than a false negative.
4. **Language-neutral core, configurable wording.** Any string that reaches a
   prompt goes through `MemoryLabels`. Do not hardcode English (or Chinese) in
   the control flow.
5. **Persisted state is untrusted input.** Anything read from a `StorageAdapter`
   must be validated and degrade gracefully rather than throw.

## Reporting a bug

Include the version, Node version, a minimal reproduction, and what you expected
instead. If it involves retrieval quality, include the documents and the query —
BM25 behaviour is easy to reason about with real data and hard to guess at.
