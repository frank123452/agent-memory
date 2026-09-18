/**
 * Tokenization with first-class CJK support.
 *
 * Why this exists: Chinese, Japanese and Korean text has no spaces, so a
 * whitespace tokenizer returns one enormous token per sentence and BM25
 * degenerates into "does the query look like the document". Proper word
 * segmentation needs a dictionary (jieba, kuromoji, ...) which is a heavy
 * dependency and a per-language problem.
 *
 * Character n-grams are the pragmatic middle ground: they need no dictionary,
 * they degrade gracefully on names and slang that no dictionary has, and for
 * short conversational recall they measurably beat whitespace tokenization.
 * The trade-off is index size, so the n-gram range is configurable and very
 * common function words are dropped.
 */

export const DEFAULT_STOP_WORDS: ReadonlySet<string> = new Set([
  // Chinese function words and fillers
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一",
  "一个", "上", "也", "很", "到", "说", "要", "去", "你", "会", "着",
  "没有", "看", "好", "自己", "这", "他", "她", "它", "们", "那", "什么",
  "吗", "啊", "吧", "呢", "哦", "嗯", "哈", "啦", "哟", "嘛", "呀",
  "让", "给", "把", "被", "从", "对", "与", "以", "及", "或",
  "过", "还", "但", "而", "因", "所", "如", "果", "虽", "然",
  "可以", "知道", "觉得", "应该", "可能", "因为", "所以", "如果",
  "这个", "那个", "这些", "那些", "这里", "那里", "怎么", "为什么",
  "我们", "你们", "他们", "现在", "已经", "一下", "有点", "一点",
  // English function words
  "the", "a", "an", "and", "or", "but", "if", "of", "to", "in", "on", "at",
  "is", "are", "was", "were", "be", "been", "am", "do", "does", "did",
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us",
  "my", "your", "his", "its", "our", "their", "this", "that", "these",
  "for", "with", "as", "by", "from", "so", "not", "no", "yes", "just",
]);

export interface TokenizeOptions {
  /** Shortest n-gram for CJK runs. Default 2. */
  ngramMin?: number;
  /** Longest n-gram for CJK runs. Default 4. */
  ngramMax?: number;
  /** CJK runs shorter than this also emit single characters. Default 12. */
  shortRunThreshold?: number;
  /** Words to drop. Pass `new Set()` to disable filtering entirely. */
  stopWords?: ReadonlySet<string>;
}

const CJK =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

export function isCjk(char: string): boolean {
  return CJK.test(char);
}

function isWordChar(char: string): boolean {
  return /[a-zA-Z0-9]/.test(char);
}

/**
 * Splits text into CJK runs and latin/digit words, then expands CJK runs into
 * n-grams. Returns a de-duplicated token list (order is not meaningful — BM25
 * only uses term frequencies).
 */
export function tokenize(text: string, options: TokenizeOptions = {}): string[] {
  const ngramMin = Math.max(1, options.ngramMin ?? 2);
  const ngramMax = Math.max(ngramMin, options.ngramMax ?? 4);
  const shortRunThreshold = options.shortRunThreshold ?? 12;
  const stopWords = options.stopWords ?? DEFAULT_STOP_WORDS;

  const lower = text.toLowerCase();
  const tokens: string[] = [];

  let buffer = "";
  let bufferIsCjk = false;

  const flush = (): void => {
    if (buffer.length === 0) return;
    const run = buffer;
    const wasCjk = bufferIsCjk;
    buffer = "";

    if (!wasCjk) {
      if (run.length <= 32 && !stopWords.has(run)) tokens.push(run);
      return;
    }

    // CJK run: emit character n-grams across the whole run.
    for (let n = ngramMin; n <= ngramMax; n++) {
      if (run.length < n) continue;
      for (let i = 0; i + n <= run.length; i++) {
        const gram = run.slice(i, i + n);
        if (!stopWords.has(gram)) tokens.push(gram);
      }
    }

    // Very short runs produce few n-grams, so single characters carry the
    // signal instead. Only useful for short messages, hence the threshold.
    if (run.length < shortRunThreshold) {
      for (const char of run) {
        if (!stopWords.has(char)) tokens.push(char);
      }
    }
  };

  for (const char of lower) {
    if (isCjk(char)) {
      if (!bufferIsCjk) flush();
      bufferIsCjk = true;
      buffer += char;
    } else if (isWordChar(char)) {
      if (bufferIsCjk) flush();
      bufferIsCjk = false;
      buffer += char;
    } else {
      flush();
    }
  }
  flush();

  return [...new Set(tokens)];
}

/**
 * Widens a token list with domain synonyms.
 *
 * BM25 is a literal matcher. A user who says "layoffs" when the memory says
 * "fired" gets no recall at all. A small hand-written synonym map closes most
 * of that gap for a given domain, without any embedding cost.
 */
export function expandTokens(
  tokens: string[],
  synonyms: Record<string, string[]> = {},
): string[] {
  const expanded = new Set(tokens);
  for (const token of tokens) {
    const extra = synonyms[token];
    if (!extra) continue;
    for (const value of extra) expanded.add(value);
  }
  return [...expanded];
}
