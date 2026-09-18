# agent-memory

[![CI](https://github.com/frank123452/agent-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/frank123452/agent-memory/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](./package.json)

**Long-term memory, retrieval and history compression for LLM agents — with zero dependencies, zero embeddings and zero cost per query.**

Most agent memory libraries assume you have an embedding model, a vector database and a budget for a summarization call on every turn. `agent-memory` assumes you have none of those and still need the assistant to remember what the user told it last week.

It ships as four small primitives you can use together or separately:

- a **tokenizer** that handles CJK properly (no dictionary, no segmentation dependency)
- a **BM25 index** over character n-grams, for recall with no API calls
- a **memory store** with pinned facts, single-value slots and automatic retention
- a **compressor** that fits long conversations into a context window without the model forgetting they happened

```ts
import { AgentMemory, FileStorage } from "agent-memory";

const memory = new AgentMemory({
  scope: "user-42",
  storage: new FileStorage("./.memory"),
});

await memory.remember("Sister is called Mia", { pinned: true });
await memory.addTurn({ role: "user", content: "Mia's birthday is next week" });

const { messages } = await memory.buildContext({
  systemPrompt: "You are a helpful assistant.",
  query: "when is my sister's birthday?",
});
```

---

## Why this exists

I built a conversational product where users talked to the same character for months. Every existing option was wrong for it:

- **Send the whole history.** Hits the context limit, and the cost per turn grows without bound.
- **Truncate to the last N turns.** The model confidently says "I don't think you've mentioned your sister" about something the user said an hour ago. This is the failure users actually notice and resent.
- **Summarize with an LLM every turn.** Doubles latency and cost, and the summaries drift — details the user cares about quietly disappear.
- **Embeddings + vector DB.** The right answer for a large document corpus. Overkill for one user's chat history, and it makes every recall a network round trip.

What worked was a hybrid: keep the newest turns verbatim, retrieve older ones lexically, and always tell the model that older turns exist. That is what this library packages up.

---

## Install

```bash
npm install agent-memory
```

Requires Node 18+. No runtime dependencies. Ships as ESM with full type declarations.

---

## Quick start

### 1. Facts with different lifetimes

Not every fact should live forever at the same priority. A user's name must never be evicted; "has a cold this week" should disappear on its own.

```ts
// Never expires, always injected.
await memory.remember("Name is Alex", { pinned: true });

// Expires after the retention window (default 15 days).
await memory.remember("Has a cold this week", { category: "health" });
```

### 2. Slots — one current truth

The classic bug: the user moves city, and now the memory contains both `lives in Berlin` and `lives in Lisbon`. A slot holds exactly one value, so writing it again replaces it.

```ts
await memory.setState("location", "Berlin");
await memory.setState("location", "Lisbon");

await memory.getState("location"); // "Lisbon"
```

`setState` is sugar for `remember(..., { pinned: true, slot: key })`. Anything you would phrase as "current X" is a slot.

### 3. Retrieval without embeddings

```ts
const hits = await memory.retrieve("猫 生病", 3);
// => [{ text: "user: 我的猫生病了，很担心\nassistant: 要不要带它去看兽医", score: 4.12 }]
```

BM25 over character n-grams. No vector database, no embedding API, no network call. Add domain synonyms when literal matching is not enough:

```ts
const memory = new AgentMemory({
  scope: "user-42",
  synonyms: { anxious: ["worried", "nervous", "stressed"] },
});
```

### 4. Turning messages into events

A small deterministic ruleset is often better than an LLM classifier, especially on a safety-relevant path: an LLM will occasionally invent a crisis that never happened, and a rule will not.

```ts
import { DEFAULT_EVENT_RULES } from "agent-memory";

const memory = new AgentMemory({
  scope: "user-42",
  events: DEFAULT_EVENT_RULES,
});

await memory.addTurn({ role: "user", content: "I've had insomnia all week" });
await memory.getEvents();
// => [{ type: "sleep", note: 'They have not been sleeping well: "..."', at: "2026-09-18" }]
```

Repeats inside the merge window refresh the existing entry rather than appending, so "work is stressful" every Monday does not become thirty near-identical memories.

### 5. Building the prompt

```ts
const { messages, memoryBlock, archivedTurns } = await memory.buildContext({
  systemPrompt: SYSTEM_PROMPT,
  query: userMessage,
});
```

The layout is deliberate:

```
[ system ]  your static prompt      <- stable prefix, cacheable by the provider
[ system ]  memory block            <- volatile, changes each turn
[ ...    ]  conversation            <- newest turns verbatim, older ones compressed
```

Putting the volatile block after the static one keeps the provider's prompt cache useful across turns. `archivedTurns` tells you how much history was compressed away.

### 6. Custom wording

Every injected block is configurable, so nothing forces English phrasing into your product.

```ts
new AgentMemory({
  scope: "user-42",
  labels: {
    factsHeader: "你记得这些关于 TA 的事",
    pinnedHeader: "重要",
    notesHeader: "日常",
    archivedNotice: (n) => `你们之前还聊过 ${n} 轮，具体内容已归档。`,
  },
});
```

---

## Design decisions

**Recall is lexical by default.** For a single user's conversation history, "what did we say about X" is mostly a lexical question, and BM25 answers it in microseconds for free. Reach for embeddings when you need paraphrase matching across long documents.

**CJK is tokenized with character n-grams.** Chinese, Japanese and Korean have no spaces, so a whitespace tokenizer produces one token per sentence and BM25 stops working. Real segmentation needs a dictionary (`jieba`, `kuromoji`) — a heavy dependency, and a separate one per language. Character n-grams need no dictionary and degrade gracefully on names and slang that no dictionary contains. The range is configurable; the default is 2–4.

**Truncation always announces itself.** When history is compressed, a system message states how many turns were omitted, even when retrieval found nothing relevant. Without it the model asserts that the user never mentioned something — the single most damaging and most easily avoided memory failure.

**Events are rules, not a classifier.** On a path that can feed a crisis-escalation workflow, a false positive is worse than a false negative. Rules are auditable, testable and free. Bring your own via `events`.

**Storage is two methods.** `read` and `write`. Back it with Redis, Postgres or S3 without touching library code. `FileStorage` is included for single-box deployments and is safe under concurrency (writes per key are serialized).

**Retention is automatic.** Non-pinned entries leave the injected block after `injectWindowDays` and are dropped entirely after `entryTtlDays`. Nobody has to curate the memory list by hand, and the injected block stays small.

---

## API

### `new AgentMemory(options)`

| Option | Default | Purpose |
| --- | --- | --- |
| `scope` | *required* | Namespace, usually a user id |
| `storage` | `MemoryStorage` | Persistence adapter |
| `shortTermTurns` | `12` | Turns kept verbatim before compression |
| `maxEntries` | `60` | Cap on retained entries |
| `maxPinned` | `30` | Cap on pinned entries |
| `entryTtlDays` | `15` | Drop non-pinned entries after this |
| `injectWindowDays` | `30` | Stop injecting non-pinned entries after this |
| `maxInjected` | `35` | Max entries placed in the prompt |
| `recallTopK` | `6` | Retrieval depth |
| `maxArchivedRounds` | `200` | Archived rounds kept for retrieval |
| `events` | `[]` | Event rules |
| `synonyms` | `{}` | Query expansion map |
| `labels` | English | Prompt wording |
| `summarize` | — | Optional LLM hook for dropped history |

### Methods

```ts
addTurn(message)                  // push a turn, record events, trim buffer
addTurns(messages)
setMessages(messages)             // replace buffer from client-supplied history
getMessages()

remember(text, options?)          // -> MemoryEntry | null
rememberMany(items)
forget(id)                        // -> boolean
getEntries()

setState(key, value)              // single-value slot, pinned
getState(key)                     // -> string | null
getStates()                       // -> Record<string, string>

recordEvents(message)             // -> string[] notes added
getEvents()

retrieve(query, topK?)            // -> RetrievedRound[]
compress(history, query)          // -> { messages, archivedTurns }
formatMemoryBlock()               // -> string
buildContext({ query, systemPrompt?, includeMemories? })

stats()
clear()
```

### Standalone primitives

```ts
import { tokenize, Bm25Index, RecallIndex, MemoryStorage, FileStorage } from "agent-memory";
```

`RecallIndex` is a convenience wrapper around `Bm25Index` that tokenizes for you and maintains an incremental document set.

---

## Development

```bash
npm install
npm run build      # tsc -> dist/
npm test           # build, then node --test test/
npm run typecheck  # strict + noUncheckedIndexedAccess, no emit
```

In restricted environments where the test runner cannot spawn child processes, run the suite in-process instead:

```bash
npm run test:fast
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the design constraints this library is expected to keep.

---

## Scope and limitations

Being explicit about what this does not do:

- **Not semantic.** Paraphrase with no lexical overlap will not be recalled. That is the price of zero-cost retrieval. Add synonyms for your domain, or pair this with an embedding index for the queries that need it.
- **No multi-hop reasoning.** It recalls passages; it does not build a knowledge graph.
- **No summarization without you.** The optional `summarize` hook is where an LLM goes if you want abstractive compression; by default compression is purely extractive.
- **In-memory index.** The BM25 index is rebuilt from the archived rounds on load. Fine to tens of thousands of rounds; use a real search engine beyond that.

---

## License

MIT
