'use client';

import { useState } from 'react';
import { cancelSchedule } from '@/app/actions';
import type { Schedule } from '@/lib/types';

function formatSgt(ts?: string): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-SG', {
    timeZone: 'Asia/Singapore',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function describe(s: Schedule): string {
  if (s.Kind === 'autorenew') return `Auto-renew until ${formatSgt(s.EndsAt)}`;
  return s.Action === 'revoke' ? 'Cut off access' : 'Renew once';
}

export default function SchedulesList({ initial }: { initial: Schedule[] }) {
  const [rows, setRows] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visible = showDone ? rows : rows.filter((r) => r.Enabled);

  async function cancel(id: string) {
    setBusy(id);
    setError(null);
    try {
      await cancelSchedule(id);
      // Only mutate the row once the server has confirmed. A failed cancel that
      // greyed the row out anyway would tell the user the schedule is off while
      // the sweeper still fires it on its next tick.
      setRows((p) =>
        p.map((r) => (r.ScheduleID === id ? { ...r, Enabled: false, LastResult: 'cancelled' } : r))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel the schedule.');
    } finally {
      setBusy(null);
    }
  }

  if (rows.length === 0) {
    return (
      <p className="text-sm text-gray-500 bg-white border border-gray-200 rounded-lg px-5 py-8 text-center">
        No schedules yet. Use the Schedule button on any client to create one.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {error && (
        <div
          role="alert"
          className="bg-red-50 border border-red-200 rounded-lg px-5 py-4 text-sm text-red-700"
        >
          <strong className="font-medium">Could not cancel:</strong> {error} The schedule is still
          active.
        </div>
      )}

      <label className="flex items-center gap-2 text-sm text-gray-600">
        <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
        Show finished and cancelled
      </label>

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-xs font-medium text-gray-500 uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3 text-left">Client</th>
                <th className="px-4 py-3 text-left">What</th>
                <th className="px-4 py-3 text-left">Next run</th>
                <th className="px-4 py-3 text-left">Last result</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {visible.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-500">
                    Nothing pending. Tick “Show finished and cancelled” to see past schedules.
                  </td>
                </tr>
              )}
              {visible.map((s) => (
                <tr key={s.ScheduleID} className={s.Enabled ? '' : 'opacity-50'}>
                  <td className="px-4 py-3 font-mono text-gray-700 whitespace-nowrap">{s.ClientID}</td>
                  <td className="px-4 py-3 text-gray-700">
                    {describe(s)}
                    {s.Note && <span className="block text-xs text-gray-400 mt-0.5">{s.Note}</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                    {s.Enabled ? formatSgt(s.NextRunAt) : '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {s.LastResult ?? <span className="text-gray-400">Not run yet</span>}
                    {(s.FailureCount ?? 0) > 0 && (
                      <span className="block text-xs text-red-600 mt-0.5">
                        {s.FailureCount} consecutive failure{s.FailureCount === 1 ? '' : 's'}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {s.Enabled && (
                      <button
                        type="button"
                        onClick={() => cancel(s.ScheduleID)}
                        disabled={busy === s.ScheduleID}
                        aria-label={`Cancel ${describe(s).toLowerCase()} for ${s.ClientID}`}
                        className="px-3 py-1.5 rounded-md text-xs font-medium text-red-600 border border-red-200 hover:bg-red-50 disabled:opacity-40"
                      >
                        {busy === s.ScheduleID ? 'Cancelling…' : 'Cancel'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
