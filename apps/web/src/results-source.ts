import { readString, type Row } from './api';

/**
 * F3: the delivery source, from the structured brief record.
 *
 * A brief produced from a 赛博沙盘 session carries `sourceSessionId` and the tasks it spawned
 * carry the brief's `correlationId`. That pair is the only reliable ownership signal; a title
 * or goal containing the word "赛博沙盘" is prose, not data.
 */
export interface ResultSource {
  readonly briefId: string;
  readonly sessionId: string;
  readonly title: string;
}

export function resultSourceOf(
  briefs: readonly Row[],
  correlationId: string | null,
): ResultSource | null {
  if (correlationId === null || correlationId === '') return null;
  const brief = briefs.find(
    (row) =>
      readString(row['correlationId'], '') === correlationId &&
      readString(row['sourceSessionId'], '') !== '',
  );
  if (brief === undefined) return null;
  return {
    briefId: readString(brief['briefId'], ''),
    sessionId: readString(brief['sourceSessionId'], ''),
    title: readString(brief['title'], ''),
  };
}
