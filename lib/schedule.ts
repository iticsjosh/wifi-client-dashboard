/** Pure schedule helpers, kept free of React and 'use server' so they stay testable. */

import type { BulkScheduleResponse } from './types';

/**
 * Local form value (browser zone) → UTC ISO 8601.
 *
 * The two input shapes MUST be parsed differently — do not collapse this:
 *   • `datetime-local` yields "YYYY-MM-DDTHH:mm", which the spec parses as
 *     *local* wall-clock time. Correct as-is.
 *   • `date` yields a bare "YYYY-MM-DD", which the spec parses as *UTC
 *     midnight* — 8 h early in SGT, and for "today" already in the past, which
 *     the Lambda rejects outright.
 * So a date-only value gets an explicit local end-of-day time appended, which
 * also matches the UI copy ("access continues through this date").
 * Detected from the string, not a flag, so it is correct for any caller.
 */
export function toUtc(local: string): string {
  return new Date(local.includes('T') ? local : `${local}T23:59:59`).toISOString();
}

/**
 * Fold per-client settled results into the { succeeded, failed } shape the
 * other bulk actions already return, so the toast copy stays uniform.
 * `clientIds[i]` must correspond to `results[i]`.
 */
export function settleBulk(
  clientIds: string[],
  results: PromiseSettledResult<unknown>[]
): BulkScheduleResponse {
  const succeeded: string[] = [];
  const failed: BulkScheduleResponse['failed'] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') succeeded.push(clientIds[i]);
    else failed.push({ clientId: clientIds[i], error: errorMessage(r.reason) });
  });
  return { succeeded, failed };
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
