import { dateKey, daysBetween } from "./dates.js";
import type { EventEntry, EventRule } from "./types.js";

const DEFAULT_MERGE_WINDOW_DAYS = 7;
const DEFAULT_EXPIRE_DAYS = 15;

export function shorten(text: string, max = 48): string {
  const collapsed = text.trim().replace(/\s+/g, " ");
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max)}…`;
}

export interface ApplyEventRulesResult {
  entries: EventEntry[];
  /** Notes that were newly recorded or refreshed by this message. */
  added: string[];
}

/**
 * Applies every matching rule to a message.
 *
 * When the same rule fires again inside its merge window the existing entry is
 * refreshed (new date, new quote) instead of appended. Without this, "I'm
 * stressed about work" every Monday becomes thirty near-identical memories and
 * drowns the context window.
 */
export function applyEventRules(
  rules: readonly EventRule[],
  message: string,
  existing: readonly EventEntry[],
  now: Date = new Date(),
): ApplyEventRulesResult {
  const text = message.trim();
  if (text.length === 0 || rules.length === 0) {
    return { entries: [...existing], added: [] };
  }

  const today = dateKey(now);
  const entries = existing.map((entry) => ({ ...entry }));
  const added: string[] = [];

  for (const rule of rules) {
    let matched = false;
    try {
      matched = rule.match(text);
    } catch {
      matched = false;
    }
    if (!matched) continue;

    const note = rule.render(shorten(text));
    const mergeWindow = rule.mergeWindowDays ?? DEFAULT_MERGE_WINDOW_DAYS;

    const index = entries.findIndex(
      (entry) =>
        entry.type === rule.type &&
        daysBetween(entry.at, today) <= mergeWindow,
    );

    const next: EventEntry = { type: rule.type, note, at: today };
    if (index >= 0) {
      entries[index] = next;
    } else {
      entries.push(next);
    }
    added.push(note);
  }

  return { entries, added };
}

/** Drops entries past their rule's expiry. Entries with no matching rule survive. */
export function pruneEvents(
  rules: readonly EventRule[],
  entries: readonly EventEntry[],
  now: Date = new Date(),
): EventEntry[] {
  const expiry = new Map<string, number>();
  for (const rule of rules) {
    expiry.set(rule.type, rule.expireDays ?? DEFAULT_EXPIRE_DAYS);
  }

  const today = dateKey(now);
  return entries.filter((entry) => {
    const days = expiry.get(entry.type);
    if (days === undefined) return true;
    return daysBetween(entry.at, today) <= days;
  });
}

export function formatEventBlock(entries: readonly EventEntry[]): string {
  if (entries.length === 0) return "";
  return entries
    .slice()
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .map((entry) => `- ${entry.note}`)
    .join("\n");
}
