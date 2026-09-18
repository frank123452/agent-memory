/**
 * Public types for agent-memory.
 *
 * The design goal is that every moving part is replaceable: storage, event
 * rules, tokenizer synonyms and the optional summarizer are all injected, so
 * the library has no runtime dependencies and no opinions about your stack.
 */

export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
  /** ISO timestamp. Filled in automatically when the message is added. */
  at?: string;
}

/**
 * A durable fact about the user or the relationship.
 *
 * `pinned` entries are never evicted and are always injected into context.
 * Use `slot` for values that can only have one current truth (location, job,
 * relationship status): writing a new entry with the same slot replaces the
 * old one instead of accumulating contradictions.
 */
export interface MemoryEntry {
  id: string;
  text: string;
  category?: string;
  createdAt: string;
  pinned?: boolean;
  slot?: string;
  /** ISO timestamp of the last time this entry was replaced in place. */
  updatedAt?: string;
}

/** A single-valued piece of state, e.g. `location -> "Berlin"`. */
export interface StateSlot {
  key: string;
  value: string;
  updatedAt: string;
}

export interface RememberOptions {
  category?: string;
  pinned?: boolean;
  slot?: string;
  /** Overwrite an existing entry when the first N characters match. Default 40. */
  dedupePrefix?: number;
}

/** Pluggable persistence. Implement these two methods to back the store with Redis, S3, Postgres, ... */
export interface StorageAdapter {
  read<T>(key: string): Promise<T | null>;
  write<T>(key: string, value: T): Promise<void>;
}

/**
 * A rule that turns raw user messages into memorable events.
 *
 * This is a deliberately boring, deterministic alternative to asking an LLM to
 * decide what matters. It costs nothing, it is auditable, and it never
 * hallucinates a memory the user did not actually express.
 *
 * The built-in example rules show the pattern; see `examples/`.
 */
export interface EventRule {
  /** Stable identifier, also used as the merge/expiry bucket. */
  type: string;
  /** Returns true when this message should be recorded as this kind of event. */
  match: (message: string) => boolean;
  /** Renders the stored line. Receives a short quote from the message. */
  render: (quote: string) => string;
  /** Events of the same type inside this window update instead of appending. */
  mergeWindowDays?: number;
  /** Events older than this stop being injected into context. */
  expireDays?: number;
}

export interface EventEntry {
  type: string;
  note: string;
  /** YYYY-MM-DD */
  at: string;
}

export interface RetrievedRound {
  id: string;
  text: string;
  score: number;
}

/**
 * Every block the library injects into the prompt is configurable, so the same
 * engine can serve an English assistant, a Chinese companion, or a support bot
 * with a formal register.
 */
export interface MemoryLabels {
  factsHeader: string;
  /**
   * Stated once in the memory block to establish precedence between the
   * sections. Without it the model sees several layers of memory with equal
   * authority and has to guess which one wins when they disagree.
   */
  factsGuidance: string;
  pinnedHeader: string;
  notesHeader: string;
  eventsHeader: string;
  eventsGuidance: string;
  recalledHeader: string;
  archivedNotice: (count: number) => string;
}

export interface AgentMemoryOptions {
  /**
   * Namespace for this memory. Usually a user id, or `user:persona` when one
   * user talks to several characters and each needs separate recall.
   */
  scope: string;

  /** Defaults to an in-process store. Data is lost on restart. */
  storage?: StorageAdapter;

  /** Full turns (user+assistant pairs) kept verbatim. Default 12. */
  shortTermTurns?: number;

  /** Hard cap on retained long-term entries. Default 60. */
  maxEntries?: number;

  /** Non-pinned entries older than this are dropped on write. Default 15. */
  entryTtlDays?: number;

  /** Non-pinned entries older than this stop being injected. Default 30. */
  injectWindowDays?: number;

  /** Maximum entries injected into the prompt. Default 35. */
  maxInjected?: number;

  /**
   * Prefix non-pinned notes with the date they were recorded. Default true.
   *
   * Without a date, a note from three weeks ago and one from this morning are
   * indistinguishable once they reach the model, so it cannot tell a stale
   * observation from a current one. Pinned entries and slots are deliberately
   * never dated: they are asserted to be current by construction.
   */
  includeEntryTimestamps?: boolean;

  /** Pinned entries are capped separately so they cannot crowd out everything. Default 30. */
  maxPinned?: number;

  /** Retrieval depth when recalling archived rounds. Default 6. */
  recallTopK?: number;

  /** Rules for turning messages into events. Defaults to none. */
  events?: EventRule[];

  /**
   * Domain synonyms to widen recall. There are no built-in defaults — an
   * English map applied to Chinese text would only add noise. `DEFAULT_SYNONYMS`
   * is a reasonable starting point to copy from.
   */
  synonyms?: Record<string, string[]>;

  /** Prompt-wording overrides. Defaults to English. */
  labels?: Partial<MemoryLabels>;

  /** Cap on archived conversation rounds kept for retrieval. Default 200. */
  maxArchivedRounds?: number;

  /**
   * Optional LLM hook. When provided, `buildContext` uses it to summarize
   * dropped history. When absent, compression stays purely extractive.
   */
  summarize?: (input: { droppedText: string; query: string }) => Promise<string>;
}

export interface BuildContextOptions {
  /** The incoming user message. Used as the retrieval query. */
  query: string;
  /** Static system prompt. Emitted as the first message, kept cache-stable. */
  systemPrompt?: string;
  /** Set false to skip long-term memory injection. Default true. */
  includeMemories?: boolean;
}

export interface BuiltContext {
  /** Ready to send to the model. */
  messages: ChatMessage[];
  /** The assembled memory block, exposed for logging and debugging. */
  memoryBlock: string;
  /** How many archived turns were represented only as retrieved snippets. */
  archivedTurns: number;
}

export interface AgentMemoryStats {
  scope: string;
  entries: number;
  pinnedEntries: number;
  slots: number;
  rounds: number;
  shortTermMessages: number;
  events: number;
}
