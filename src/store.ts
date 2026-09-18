import { RecallIndex } from "./bm25.js";
import { daysAgo, newId, simpleHash } from "./dates.js";
import { applyEventRules, formatEventBlock, pruneEvents } from "./events.js";
import { MemoryStorage } from "./storage.js";
import type {
  AgentMemoryOptions,
  AgentMemoryStats,
  BuildContextOptions,
  BuiltContext,
  ChatMessage,
  EventEntry,
  MemoryEntry,
  MemoryLabels,
  RememberOptions,
  RetrievedRound,
  StorageAdapter,
} from "./types.js";

export const DEFAULT_LABELS: MemoryLabels = {
  factsHeader: "What you know about this person",
  factsGuidance:
    'Entries under "Always relevant" are current. Dated notes are observations from the date shown and may be outdated.',
  pinnedHeader: "Always relevant",
  notesHeader: "Remembered details",
  eventsHeader: "Recent things they told you about how they felt",
  recalledHeader: "Earlier in this conversation, related to what they just said",
  archivedNotice: (n) =>
    `They have also exchanged ${n} earlier turns that are not shown here.`,
  eventsGuidance:
    "Bring these up only when they naturally fit. Do not recite them.",
};

interface ArchivedRound {
  id: string;
  text: string;
  at: string;
  /** First characters of the user half, used to tell archived rounds from live ones. */
  userPrefix: string;
}

interface PersistedState {
  version: 1;
  entries: MemoryEntry[];
  events: EventEntry[];
  shortTerm: ChatMessage[];
  archived: ArchivedRound[];
  archivedHashes: string[];
}

const STATE_VERSION = 1;
const DEFAULT_MAX_ARCHIVED_ROUNDS = 200;
const PREFIX_LENGTH = 60;

function emptyState(): PersistedState {
  return {
    version: STATE_VERSION,
    entries: [],
    events: [],
    shortTerm: [],
    archived: [],
    archivedHashes: [],
  };
}

function isPersistedState(value: unknown): value is PersistedState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PersistedState>;
  return (
    candidate.version === STATE_VERSION &&
    Array.isArray(candidate.entries) &&
    Array.isArray(candidate.events) &&
    Array.isArray(candidate.shortTerm) &&
    Array.isArray(candidate.archived) &&
    Array.isArray(candidate.archivedHashes)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMemoryEntry(value: unknown): value is MemoryEntry {
  return (
    isRecord(value) && typeof value.text === "string" && value.text.trim().length > 0
  );
}

function isEventEntry(value: unknown): value is EventEntry {
  return isRecord(value) && typeof value.note === "string" && typeof value.at === "string";
}

function isChatMessage(value: unknown): value is ChatMessage {
  return (
    isRecord(value) &&
    typeof value.content === "string" &&
    value.content.trim().length > 0
  );
}

function isArchivedRound(value: unknown): value is ArchivedRound {
  return isRecord(value) && typeof value.id === "string" && typeof value.text === "string";
}

/**
 * Long-term memory for a single conversational scope.
 *
 * One instance per user (or per user+character pair). State is loaded lazily on
 * first use and written back as a single document, so a scope stays consistent
 * no matter how many methods you call inside one turn.
 */
export class AgentMemory {
  readonly scope: string;

  private readonly storage: StorageAdapter;
  private readonly storageKey: string;
  private readonly labels: MemoryLabels;

  private readonly shortTermTurns: number;
  private readonly maxEntries: number;
  private readonly maxPinned: number;
  private readonly entryTtlDays: number;
  private readonly injectWindowDays: number;
  private readonly maxInjected: number;
  private readonly includeEntryTimestamps: boolean;
  private readonly recallTopK: number;
  private readonly maxArchivedRounds: number;
  private readonly rules: AgentMemoryOptions["events"];
  private readonly summarize: AgentMemoryOptions["summarize"];

  private state: PersistedState = emptyState();
  private index = new RecallIndex();
  /**
   * Derived lookup over `state.archivedHashes`. The array is the persisted
   * source of truth; this Set exists so de-duplication is O(1) instead of
   * scanning every historical hash on each turn.
   */
  private archivedHashes = new Set<string>();
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: AgentMemoryOptions) {
    if (!options.scope) throw new Error("AgentMemory requires a scope");

    this.scope = options.scope;
    this.storage = options.storage ?? new MemoryStorage();
    this.storageKey = `agent-memory_${options.scope}`;
    this.labels = { ...DEFAULT_LABELS, ...(options.labels ?? {}) };

    this.shortTermTurns = options.shortTermTurns ?? 12;
    this.maxEntries = options.maxEntries ?? 60;
    this.maxPinned = options.maxPinned ?? 30;
    this.entryTtlDays = options.entryTtlDays ?? 15;
    this.injectWindowDays = options.injectWindowDays ?? 30;
    this.maxInjected = options.maxInjected ?? 35;
    this.includeEntryTimestamps = options.includeEntryTimestamps ?? true;
    this.recallTopK = options.recallTopK ?? 6;
    this.maxArchivedRounds =
      options.maxArchivedRounds ?? DEFAULT_MAX_ARCHIVED_ROUNDS;
    this.rules = options.events;
    this.summarize = options.summarize;

    this.index = new RecallIndex({ synonyms: options.synonyms });
  }

  // ---------------------------------------------------------------- lifecycle

  private async load(): Promise<void> {
    if (this.loaded) return;
    const raw = await this.storage.read<unknown>(this.storageKey);
    this.state = isPersistedState(raw) ? raw : emptyState();

    // Persisted documents are user-supplied input as far as we are concerned: a
    // truncated or hand-edited file must degrade, not throw on the next render.
    this.state.entries = this.state.entries.filter(isMemoryEntry);
    this.state.events = this.state.events.filter(isEventEntry);
    this.state.shortTerm = this.state.shortTerm.filter(isChatMessage);
    this.state.archived = this.state.archived
      .filter(isArchivedRound)
      .map((round) => ({
        ...round,
        userPrefix: round.userPrefix ?? deriveUserPrefix(round.text),
      }));
    this.archivedHashes = new Set(
      this.state.archivedHashes.filter(
        (hash): hash is string => typeof hash === "string",
      ),
    );

    this.rebuildIndex();
    this.loaded = true;
  }

  private rebuildIndex(): void {
    this.index.clear();
    this.index.addMany(
      this.state.archived.map((round) => ({ id: round.id, text: round.text })),
    );
  }

  private serialize(): PersistedState {
    return {
      version: STATE_VERSION,
      entries: this.pruneEntries(this.state.entries),
      events: this.rules
        ? pruneEvents(this.rules, this.state.events)
        : this.state.events,
      shortTerm: this.state.shortTerm,
      archived: this.state.archived,
      archivedHashes: [...this.archivedHashes],
    };
  }

  /**
   * Queues a write and keeps the in-memory state in sync with what will land on
   * disk.
   *
   * The payload is cloned before it is queued. Writes are serialized but their
   * bodies execute later, so handing a live reference to the storage adapter
   * would let a subsequent mutation leak into an already-queued write. The
   * clone makes "snapshot" mean what it says.
   */
  private persist(): Promise<void> {
    this.state = this.serialize();
    const snapshot = structuredClone(this.state);
    const write = (): Promise<void> =>
      this.storage.write(this.storageKey, snapshot);
    this.writeQueue = this.writeQueue.then(write, write);
    return this.writeQueue;
  }

  // ------------------------------------------------------------------ entries

  /**
   * Applies retention policy.
   *
   * Pinned entries never expire — they are the facts a user would be annoyed to
   * repeat. Everything else falls out of the window on its own, which keeps the
   * injected block small without anyone curating it by hand.
   */
  private pruneEntries(entries: readonly MemoryEntry[]): MemoryEntry[] {
    const pinned: MemoryEntry[] = [];
    const normal: MemoryEntry[] = [];

    for (const entry of entries) {
      if (entry.pinned) {
        pinned.push(entry);
      } else if (!entry.createdAt || daysAgo(entry.createdAt) <= this.entryTtlDays) {
        normal.push(entry);
      }
    }

    const keptPinned = pinned.slice(-this.maxPinned);
    const room = Math.max(0, this.maxEntries - keptPinned.length);
    return [...keptPinned, ...normal.slice(-room)];
  }

  /** Stores a durable fact. Returns the stored entry. */
  async remember(
    text: string,
    options: RememberOptions = {},
  ): Promise<MemoryEntry | null> {
    const trimmed = text.trim();
    if (!trimmed) return null;

    await this.load();
    const now = new Date().toISOString();
    const dedupePrefix = options.dedupePrefix ?? 40;
    const entries = this.state.entries;

    // A slot has exactly one current truth. Writing it again replaces it, which
    // is what stops "lives in Berlin" and "lives in Lisbon" coexisting.
    if (options.slot) {
      const index = entries.findIndex((entry) => entry.slot === options.slot);
      if (index >= 0) {
        const previous = entries[index]!;
        const updated: MemoryEntry = {
          ...previous,
          text: trimmed,
          category: options.category ?? previous.category,
          pinned: options.pinned ?? previous.pinned,
          updatedAt: now,
        };
        entries[index] = updated;
        await this.persist();
        return updated;
      }
    }

    const key = trimmed.slice(0, dedupePrefix);
    const duplicate = entries.findIndex(
      (entry) => entry.text.slice(0, dedupePrefix) === key,
    );

    const entry: MemoryEntry = {
      id: newId("mem"),
      text: trimmed,
      category: options.category,
      pinned: options.pinned,
      slot: options.slot,
      createdAt: now,
    };

    if (duplicate >= 0) {
      entries[duplicate] = { ...entry, id: entries[duplicate]!.id };
    } else {
      entries.push(entry);
    }

    await this.persist();
    return entry;
  }

  async rememberMany(
    items: Array<{ text: string } & RememberOptions>,
  ): Promise<void> {
    for (const item of items) {
      const { text, ...rest } = item;
      await this.remember(text, rest);
    }
  }

  async forget(id: string): Promise<boolean> {
    await this.load();
    const before = this.state.entries.length;
    this.state.entries = this.state.entries.filter((entry) => entry.id !== id);
    if (this.state.entries.length === before) return false;
    await this.persist();
    return true;
  }

  async getEntries(): Promise<MemoryEntry[]> {
    await this.load();
    return [...this.state.entries];
  }

  /**
   * Sugar over `remember` with `pinned: true` and `slot: key`.
   * The value should be the value alone ("Lisbon"), not a sentence.
   */
  async setState(key: string, value: string): Promise<MemoryEntry | null> {
    return this.remember(value, { slot: key, pinned: true, category: "state" });
  }

  async getState(key: string): Promise<string | null> {
    await this.load();
    const entry = this.state.entries.find((item) => item.slot === key);
    return entry ? entry.text : null;
  }

  async getStates(): Promise<Record<string, string>> {
    await this.load();
    const result: Record<string, string> = {};
    for (const entry of this.state.entries) {
      if (entry.slot) result[entry.slot] = entry.text;
    }
    return result;
  }

  // ------------------------------------------------------------------- events

  /**
   * Scans a user message against the configured rules and records matches.
   * Returns the notes that were added or refreshed.
   */
  async recordEvents(message: string): Promise<string[]> {
    if (!this.rules || this.rules.length === 0) return [];
    await this.load();
    const { entries, added } = applyEventRules(
      this.rules,
      message,
      this.state.events,
    );
    if (added.length === 0) return [];
    this.state.events = pruneEvents(this.rules, entries);
    await this.persist();
    return added;
  }

  async getEvents(): Promise<EventEntry[]> {
    await this.load();
    return [...this.state.events];
  }

  // ------------------------------------------------------------------ archive

  /**
   * Adds a completed exchange to the retrieval archive.
   *
   * Archiving happens as turns arrive rather than at compression time, so a
   * turn is searchable the moment it falls out of the verbatim window. Hash
   * de-duplication makes this idempotent when a client replays full history.
   */
  private archiveRound(
    userContent: string,
    assistantContent: string,
    at: string,
  ): void {
    const text = `user: ${userContent}\nassistant: ${assistantContent}`;
    const hash = simpleHash(text);
    if (this.archivedHashes.has(hash)) return;

    const round: ArchivedRound = {
      id: newId("round"),
      text,
      at,
      userPrefix: userContent.slice(0, PREFIX_LENGTH),
    };

    this.archivedHashes.add(hash);
    this.state.archivedHashes.push(hash);
    this.state.archived.push(round);
    this.index.add(round.id, round.text);

    if (this.state.archived.length > this.maxArchivedRounds) {
      const excess = this.state.archived.length - this.maxArchivedRounds;
      this.state.archived.splice(0, excess);
      this.rebuildIndex();
    }
  }

  /** Archives every complete user/assistant pair in a history. */
  private archiveHistory(history: readonly ChatMessage[]): void {
    for (let i = 0; i < history.length - 1; i++) {
      const current = history[i]!;
      const next = history[i + 1]!;
      if (current.role !== "user" || next.role !== "assistant") continue;
      this.archiveRound(
        current.content,
        next.content,
        current.at ?? new Date().toISOString(),
      );
    }
  }

  // --------------------------------------------------------------- short term

  async addTurn(message: {
    role: "user" | "assistant";
    content: string;
  }): Promise<void> {
    const content = message.content.trim();
    if (!content) return;
    await this.load();

    this.state.shortTerm.push({
      role: message.role,
      content,
      at: new Date().toISOString(),
    });

    // A user turn followed by an assistant turn is a complete round: archive it
    // now so it is retrievable as soon as it leaves the verbatim window.
    const length = this.state.shortTerm.length;
    if (length >= 2) {
      const previous = this.state.shortTerm[length - 2]!;
      const latest = this.state.shortTerm[length - 1]!;
      if (previous.role === "user" && latest.role === "assistant") {
        this.archiveRound(previous.content, latest.content, previous.at ?? latest.at!);
      }
    }

    if (message.role === "user") {
      await this.recordEvents(content);
    }

    this.trimShortTerm();
    await this.persist();
  }

  async addTurns(
    messages: Array<{ role: "user" | "assistant"; content: string }>,
  ): Promise<void> {
    for (const message of messages) await this.addTurn(message);
  }

  async getMessages(): Promise<ChatMessage[]> {
    await this.load();
    return [...this.state.shortTerm];
  }

  /** Replaces the short-term buffer, e.g. when the client sends full history. */
  async setMessages(messages: ChatMessage[]): Promise<void> {
    await this.load();
    this.state.shortTerm = messages
      .filter((message) => message.content.trim().length > 0)
      .map((message) => ({
        role: message.role,
        content: message.content,
        at: message.at ?? new Date().toISOString(),
      }));
    this.archiveHistory(this.state.shortTerm);
    this.trimShortTerm();
    await this.persist();
  }

  /**
   * Keeps the newest `shortTermTurns` complete rounds.
   *
   * Trimming must never cut a round in half — an assistant reply whose question
   * has been dropped is worse than no reply at all, because the model reads it
   * as an unprovoked statement.
   */
  private trimShortTerm(): void {
    const messages = this.state.shortTerm;
    let usersSeen = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role !== "user") continue;
      usersSeen++;
      if (usersSeen === this.shortTermTurns) {
        if (i > 0) messages.splice(0, i);
        return;
      }
    }
  }

  /** The newest `shortTermTurns` rounds, starting on a user turn. */
  private takeLastTurns(history: readonly ChatMessage[]): ChatMessage[] {
    let usersSeen = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i]!.role !== "user") continue;
      usersSeen++;
      if (usersSeen === this.shortTermTurns) return history.slice(i);
    }
    return [...history];
  }

  // ---------------------------------------------------------------- retrieval

  /** Recalls archived rounds relevant to `query`. */
  async retrieve(query: string, topK = this.recallTopK): Promise<RetrievedRound[]> {
    await this.load();
    return this.index.search(query, topK);
  }

  // -------------------------------------------------------------- compression

  /**
   * Shrinks history to fit the context window.
   *
   * The newest turns stay verbatim because they carry the live thread. Older
   * turns are represented by whatever retrieval says is relevant to the current
   * message. Crucially, if retrieval finds nothing the model is still told that
   * earlier turns exist — otherwise it confidently claims this is the first
   * time you have spoken, which is the most common and most damaging failure of
   * naive truncation.
   */
  async compress(
    history: readonly ChatMessage[],
    query: string,
  ): Promise<{ messages: ChatMessage[]; archivedTurns: number }> {
    await this.load();

    const recent = this.takeLastTurns(history);
    const recentUserPrefixes = new Set(
      recent
        .filter((message) => message.role === "user")
        .map((message) => message.content.slice(0, PREFIX_LENGTH)),
    );

    const archivedById = new Map(
      this.state.archived.map((round) => [round.id, round]),
    );
    const olderRounds = this.state.archived.filter(
      (round) => !recentUserPrefixes.has(round.userPrefix),
    );
    const archivedTurns = olderRounds.length;

    if (archivedTurns === 0) {
      return { messages: recent, archivedTurns: 0 };
    }

    const hits = await this.retrieve(query, this.recallTopK);
    const olderIds = new Set(olderRounds.map((round) => round.id));
    const novel = hits.filter((hit) => olderIds.has(hit.id));

    const preamble: ChatMessage[] = [];
    if (novel.length > 0) {
      preamble.push({
        role: "system",
        content: `${this.labels.recalledHeader}:\n${novel
          .map((hit) => hit.text)
          .join("\n---\n")}`,
      });
    }

    let notice = this.labels.archivedNotice(archivedTurns);
    if (this.summarize && novel.length === 0) {
      const droppedIds = new Set(olderRounds.map((round) => round.id));
      const droppedText = this.state.archived
        .filter((round) => droppedIds.has(round.id))
        .map((round) => round.text)
        .join("\n");
      try {
        const summary = await this.summarize({ droppedText, query });
        if (summary && summary.trim()) notice = `${notice}\n${summary.trim()}`;
      } catch {
        // A failing summarizer must never break the chat turn.
      }
    }
    preamble.push({ role: "system", content: notice });

    return { messages: [...preamble, ...recent], archivedTurns };
  }

  // ------------------------------------------------------------------ context

  private selectEntries(): MemoryEntry[] {
    const pinned = this.state.entries.filter((entry) => entry.pinned);
    const normal = this.state.entries.filter(
      (entry) =>
        !entry.pinned &&
        (!entry.createdAt || daysAgo(entry.createdAt) <= this.injectWindowDays),
    );
    const room = Math.max(0, this.maxInjected - pinned.length);
    return [...pinned, ...normal.slice(-room)];
  }

  /**
   * Renders one entry.
   *
   * A slot is prefixed with its key so "Lisbon" reads as "location: Lisbon".
   * Notes carry the date they were recorded; pinned entries do not, because a
   * pinned entry asserts something that is currently true rather than an
   * observation made on a particular day.
   */
  private renderEntry(entry: MemoryEntry, withDate: boolean): string {
    const body = entry.slot ? `${entry.slot}: ${entry.text}` : entry.text;
    if (!withDate || !this.includeEntryTimestamps || !entry.createdAt) return body;
    const date = entry.createdAt.slice(0, 10);
    return date ? `[${date}] ${body}` : body;
  }

  /** Builds the memory block injected into the system prompt. */
  async formatMemoryBlock(): Promise<string> {
    await this.load();
    const sections: string[] = [];

    const entries = this.selectEntries();
    const pinned = entries.filter((entry) => entry.pinned);
    const notes = entries.filter((entry) => !entry.pinned);

    if (pinned.length > 0 || notes.length > 0) {
      const lines: string[] = [this.labels.factsHeader];
      if (pinned.length > 0) {
        lines.push(`${this.labels.pinnedHeader}:`);
        for (const entry of pinned) lines.push(`- ${this.renderEntry(entry, false)}`);
      }
      if (notes.length > 0) {
        lines.push(`${this.labels.notesHeader}:`);
        for (const entry of notes) lines.push(`- ${this.renderEntry(entry, true)}`);
      }
      if (this.labels.factsGuidance) lines.push(this.labels.factsGuidance);
      sections.push(lines.join("\n"));
    }

    if (this.state.events.length > 0) {
      sections.push(
        [
          this.labels.eventsHeader,
          formatEventBlock(this.state.events),
          this.labels.eventsGuidance,
        ].join("\n"),
      );
    }

    return sections.join("\n\n");
  }

  /**
   * Produces messages ready to send to a model.
   *
   * Layout is deliberate: the caller's static system prompt comes first so the
   * provider can cache it, then the volatile memory block, then the
   * conversation. Keeping the volatile part after the static one preserves the
   * cacheable prefix across turns.
   */
  async buildContext(options: BuildContextOptions): Promise<BuiltContext> {
    const includeMemories = options.includeMemories ?? true;
    const memoryBlock = includeMemories ? await this.formatMemoryBlock() : "";
    const { messages, archivedTurns } = await this.compress(
      await this.getMessages(),
      options.query,
    );

    const output: ChatMessage[] = [];
    if (options.systemPrompt) {
      output.push({ role: "system", content: options.systemPrompt });
    }
    if (memoryBlock) {
      output.push({ role: "system", content: memoryBlock });
    }
    output.push(...messages);

    return { messages: output, memoryBlock, archivedTurns };
  }

  // -------------------------------------------------------------------- admin

  async stats(): Promise<AgentMemoryStats> {
    await this.load();
    return {
      scope: this.scope,
      entries: this.state.entries.length,
      pinnedEntries: this.state.entries.filter((entry) => entry.pinned).length,
      slots: this.state.entries.filter((entry) => entry.slot).length,
      rounds: this.state.archived.length,
      shortTermMessages: this.state.shortTerm.length,
      events: this.state.events.length,
    };
  }

  /** Wipes everything for this scope. */
  async clear(): Promise<void> {
    await this.load();
    this.state = emptyState();
    this.rebuildIndex();
    await this.persist();
  }
}

function deriveUserPrefix(text: string): string {
  const marker = "user: ";
  if (!text.startsWith(marker)) return text.slice(0, PREFIX_LENGTH);
  const rest = text.slice(marker.length);
  const newline = rest.indexOf("\n");
  const userHalf = newline >= 0 ? rest.slice(0, newline) : rest;
  return userHalf.slice(0, PREFIX_LENGTH);
}
