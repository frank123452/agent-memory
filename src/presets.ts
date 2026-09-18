import type { EventRule } from "./types.js";

/**
 * Rules covering the situations people most often volunteer unprompted.
 *
 * These are intentionally small and deterministic. A classifier would catch
 * more, but it would also occasionally invent a crisis that never happened —
 * unacceptable for anything that feeds a safety escalation path.
 *
 * Pass your own via `events` to change language, tone or coverage.
 */
export const DEFAULT_EVENT_RULES: EventRule[] = [
  {
    type: "overwhelmed",
    match: (m) =>
      /overwhelmed|burned out|burnt out|can'?t cope|breaking down|falling apart/i.test(
        m,
      ),
    render: (quote) => `They said they were overwhelmed: "${quote}"`,
    mergeWindowDays: 7,
    expireDays: 15,
  },
  {
    type: "lonely",
    match: (m) => /\blonely\b|\balone\b|no one to talk to|isolated/i.test(m),
    render: (quote) => `They mentioned feeling lonely: "${quote}"`,
    mergeWindowDays: 7,
    expireDays: 15,
  },
  {
    type: "sleep",
    match: (m) => /can'?t sleep|insomnia|sleepless|up all night|barely slept/i.test(m),
    render: (quote) => `They have not been sleeping well: "${quote}"`,
    mergeWindowDays: 7,
    expireDays: 15,
  },
  {
    type: "work-stress",
    match: (m) =>
      /work is|deadline|overtime|my boss|laid off|performance review|quitting my job/i.test(
        m,
      ),
    render: (quote) => `Work has been heavy: "${quote}"`,
    mergeWindowDays: 7,
    expireDays: 15,
  },
  {
    type: "good-news",
    match: (m) => /got the job|passed|promoted|engaged|it worked|so happy|best day/i.test(m),
    render: (quote) => `Something good happened: "${quote}"`,
    mergeWindowDays: 7,
    expireDays: 21,
  },
];

/**
 * A small English synonym map, showing the expected shape.
 *
 * There are no built-in defaults applied automatically: an English map would
 * only add noise to Chinese text. Copy this into `synonyms` and translate it for
 * your domain.
 */
export const DEFAULT_SYNONYMS: Record<string, string[]> = {
  job: ["work", "career", "employment", "office"],
  work: ["job", "career", "office", "deadline"],
  tired: ["exhausted", "drained", "worn out", "fatigue"],
  sad: ["unhappy", "down", "low", "miserable"],
  happy: ["glad", "pleased", "delighted", "cheerful"],
  sleep: ["sleeping", "insomnia", "rest", "nap"],
  partner: ["boyfriend", "girlfriend", "spouse", "husband", "wife"],
};
