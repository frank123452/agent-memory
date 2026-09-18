const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` in UTC. */
export function dateKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`. Returns 0 for unparseable input. */
export function daysBetween(from: string, to: string): number {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.floor((end - start) / MS_PER_DAY);
}

/** Whole days elapsed since an ISO timestamp. Returns 0 for unparseable input. */
export function daysAgo(iso: string, now: Date = new Date()): number {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 0;
  return Math.floor((now.getTime() - then) / MS_PER_DAY);
}

export function newId(prefix = "m"): string {
  const random =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

/**
 * Cheap non-cryptographic hash. Used to detect conversation rounds that have
 * already been archived, so re-compressing the same history is idempotent.
 */
export function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(36);
}
