import { type TokenizeOptions, expandTokens, tokenize } from "./tokenizer.js";

/**
 * Okapi BM25 over character n-grams.
 *
 * No embeddings, no vector database, no API calls, no network. For meeting
 * notes, chat history and support tickets this is usually within a few points
 * of a small embedding model on recall@5 — and it costs nothing per query,
 * which matters when retrieval runs on every single turn.
 *
 * Reach for embeddings when you need genuine paraphrase matching across long
 * documents. Reach for this when you need "what did we say about X" over a
 * user's own conversation history.
 */

export interface Bm25Document {
  id: string;
  text: string;
  tokens: string[];
}

export interface Bm25Hit {
  id: string;
  text: string;
  score: number;
}

export interface Bm25Options {
  /** Term-frequency saturation. Default 1.5. */
  k1?: number;
  /** Length normalization, 0 = off, 1 = full. Default 0.75. */
  b?: number;
}

export class Bm25Index {
  private readonly documents: Bm25Document[];
  private readonly documentFrequency: Map<string, number>;
  private readonly averageLength: number;
  private readonly k1: number;
  private readonly b: number;

  constructor(documents: Bm25Document[], options: Bm25Options = {}) {
    this.documents = documents;
    this.k1 = options.k1 ?? 1.5;
    this.b = options.b ?? 0.75;

    this.documentFrequency = new Map();
    let totalLength = 0;

    for (const doc of documents) {
      totalLength += doc.tokens.length;
      for (const token of new Set(doc.tokens)) {
        this.documentFrequency.set(
          token,
          (this.documentFrequency.get(token) ?? 0) + 1,
        );
      }
    }

    this.averageLength =
      documents.length === 0 ? 0 : totalLength / documents.length;
  }

  get size(): number {
    return this.documents.length;
  }

  private score(
    queryTokens: readonly string[],
    doc: Bm25Document,
  ): number {
    if (this.averageLength === 0 || queryTokens.length === 0) return 0;

    const termFrequency = new Map<string, number>();
    for (const token of doc.tokens) {
      termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
    }

    let score = 0;
    const total = this.documents.length;

    for (const token of queryTokens) {
      const frequency = termFrequency.get(token);
      if (!frequency) continue;

      const df = this.documentFrequency.get(token) ?? 1;
      const idf = Math.log((total - df + 0.5) / (df + 0.5) + 1);
      const numerator = frequency * (this.k1 + 1);
      const denominator =
        frequency + this.k1 * (1 - this.b + this.b * (doc.tokens.length / this.averageLength));

      score += idf * (numerator / denominator);
    }

    return score;
  }

  search(queryTokens: readonly string[], topK = 5): Bm25Hit[] {
    if (queryTokens.length === 0) return [];

    const hits: Bm25Hit[] = [];
    for (const doc of this.documents) {
      const score = this.score(queryTokens, doc);
      if (score > 0) hits.push({ id: doc.id, text: doc.text, score });
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, Math.max(0, topK));
  }
}

/**
 * Small convenience wrapper so callers do not have to remember to tokenize
 * before indexing and after querying.
 */
export class RecallIndex {
  private readonly documents: Map<string, Bm25Document> = new Map();
  private readonly options: TokenizeOptions;
  private synonyms: Record<string, string[]>;
  private index: Bm25Index | null = null;

  constructor(options: {
    tokenize?: TokenizeOptions;
    synonyms?: Record<string, string[]>;
  } = {}) {
    this.options = options.tokenize ?? {};
    this.synonyms = options.synonyms ?? {};
  }

  get size(): number {
    return this.documents.size;
  }

  add(id: string, text: string): void {
    this.documents.set(id, {
      id,
      text,
      tokens: tokenize(text, this.options),
    });
    this.index = null;
  }

  addMany(items: Array<{ id: string; text: string }>): void {
    for (const item of items) this.add(item.id, item.text);
  }

  /** Keeps only the most recently added `limit` documents. */
  trim(limit: number): void {
    if (this.documents.size <= limit) return;
    const excess = this.documents.size - limit;
    let removed = 0;
    for (const id of this.documents.keys()) {
      this.documents.delete(id);
      removed++;
      if (removed >= excess) break;
    }
    this.index = null;
  }

  setSynonyms(synonyms: Record<string, string[]>): void {
    this.synonyms = synonyms;
  }

  clear(): void {
    this.documents.clear();
    this.index = null;
  }

  private ensureIndex(): Bm25Index {
    if (!this.index) {
      this.index = new Bm25Index([...this.documents.values()]);
    }
    return this.index;
  }

  search(query: string, topK = 5): Bm25Hit[] {
    if (this.documents.size === 0) return [];
    const queryTokens = expandTokens(
      tokenize(query, this.options),
      this.synonyms,
    );
    return this.ensureIndex().search(queryTokens, topK);
  }
}
