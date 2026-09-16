/**
 * Self-check for the pure schedule helpers. No framework:
 *   TZ=Asia/Singapore node --test lib/schedule.test.ts
 * TZ matters — `toUtc` converts from the browser's local zone, and the whole
 * point of the date-only branch is that it lands at local, not UTC, midnight.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { batch, rangeIds, SCHEDULE_BATCH, settleBulk, toUtc } from './schedule.ts';

test('toUtc keeps datetime-local wall-clock time in the local zone', () => {
  // 14:30 SGT (UTC+8) is 06:30 UTC the same day.
  assert.equal(toUtc('2026-09-14T14:30'), '2026-09-14T06:30:00.000Z');
});

test('toUtc pushes a date-only value to local end of day, not UTC midnight', () => {
  // The bug this guards: `new Date('2026-09-14')` is UTC midnight, i.e. 08:00
  // SGT on the 14th — for "today" that is already past and the Lambda rejects
  // it. 23:59:59 SGT on the 14th is 15:59:59 UTC, still the 14th.
  assert.equal(toUtc('2026-09-14'), '2026-09-14T15:59:59.000Z');
});

test('settleBulk splits fulfilled from rejected, preserving client ids', () => {
  const out = settleBulk(
    ['a', 'b', 'c'],
    [
      { status: 'fulfilled', value: {} },
      { status: 'rejected', reason: new Error('boom') },
      { status: 'fulfilled', value: {} },
    ]
  );
  assert.deepEqual(out.succeeded, ['a', 'c']);
  assert.deepEqual(out.failed, [{ clientId: 'b', error: 'boom' }]);
});

test('settleBulk stringifies a non-Error rejection', () => {
  const out = settleBulk(['a'], [{ status: 'rejected', reason: 'nope' }]);
  assert.deepEqual(out.failed, [{ clientId: 'a', error: 'nope' }]);
});

test('settleBulk handles the all-failed case the dialog branches on', () => {
  const out = settleBulk(['a'], [{ status: 'rejected', reason: new Error('x') }]);
  assert.equal(out.succeeded.length, 0);
});

test('batch splits into full chunks plus a short remainder, losing nothing', () => {
  assert.deepEqual(batch([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(batch([], 3), []);
  assert.deepEqual(batch([1, 2], 5), [[1, 2]]);
});

test('every batch stays under the Cloudflare free-plan subrequest cap', () => {
  // The bug this guards: one subrequest per client, and a request that asks for
  // a 51st is refused by the runtime — the "50 scheduled, 250 failed" report.
  const ids = Array.from({ length: 300 }, (_, i) => `c${i}`);
  const batches = batch(ids, SCHEDULE_BATCH);
  assert.ok(batches.every((b) => b.length < 50));
  assert.equal(batches.flat().length, 300);
});

test('rangeIds covers the span inclusively, in either drag direction', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(rangeIds(ids, 1, 3), ['b', 'c', 'd']);
  assert.deepEqual(rangeIds(ids, 3, 1), ['b', 'c', 'd']);
  assert.deepEqual(rangeIds(ids, 2, 2), ['c']);
});
