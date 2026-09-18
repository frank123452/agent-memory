/**
 * agent-memory — dependency-free long-term memory for LLM agents.
 *
 * Published as `@frank123452/agent-memory`. The unscoped `agent-memory` name on
 * npm is held by an unrelated empty package.
 *
 * ```ts
 * import { AgentMemory, FileStorage } from "@frank123452/agent-memory";
 *
 * const memory = new AgentMemory({
 *   scope: "user-42",
 *   storage: new FileStorage("./.memory"),
 * });
 *
 * await memory.addTurn({ role: "user", content: "My sister is called Mia." });
 * await memory.remember("Sister is called Mia", { pinned: true });
 *
 * const context = await memory.buildContext({
 *   systemPrompt: "You are a helpful assistant.",
 *   query: "what is my sister's name?",
 * });
 * ```
 */

export { AgentMemory, DEFAULT_LABELS } from "./store.js";
export { MemoryStorage, FileStorage } from "./storage.js";

export { Bm25Index, RecallIndex } from "./bm25.js";
export type { Bm25Document, Bm25Hit, Bm25Options } from "./bm25.js";

export { DEFAULT_STOP_WORDS, expandTokens, isCjk, tokenize } from "./tokenizer.js";
export type { TokenizeOptions } from "./tokenizer.js";

export { applyEventRules, formatEventBlock, pruneEvents, shorten } from "./events.js";
export type { ApplyEventRulesResult } from "./events.js";

export { dateKey, daysAgo, daysBetween, newId, simpleHash } from "./dates.js";

export { DEFAULT_EVENT_RULES, DEFAULT_SYNONYMS } from "./presets.js";

export type {
  AgentMemoryOptions,
  AgentMemoryStats,
  BuildContextOptions,
  BuiltContext,
  ChatMessage,
  EventEntry,
  EventRule,
  MemoryEntry,
  MemoryLabels,
  RememberOptions,
  RetrievedRound,
  Role,
  StateSlot,
  StorageAdapter,
} from "./types.js";
