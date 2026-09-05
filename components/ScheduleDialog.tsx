'use client';

import { useEffect, useState } from 'react';
import { createSchedule } from '@/app/actions';
import type { Client, ScheduleKind, ScheduleAction } from '@/lib/types';

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
function toUtc(local: string): string {
  return new Date(local.includes('T') ? local : `${local}T23:59:59`).toISOString();
}

export default function ScheduleDialog({
  client,
  onClose,
  onCreated,
}: {
  client: Client;
  onClose: () => void;
  onCreated: (message: string) => void;
}) {
  const [kind, setKind] = useState<ScheduleKind>('once');
  const [action, setAction] = useState<ScheduleAction>('revoke');
  const [when, setWhen] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const label = client.ClientName || client.ClientID;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!when) {
      setError('Pick a date and time.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createSchedule(
        kind === 'once'
          ? { kind, action, clientId: client.ClientID, runAt: toUtc(when), note: note || undefined }
          : { kind, action: 'extend', clientId: client.ClientID, endsAt: toUtc(when), note: note || undefined }
      );
      onCreated(
        kind === 'once'
          ? `Scheduled ${action} for ${label}`
          : `Auto-renew enabled for ${label}`
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the schedule.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Schedule an action for ${label}`}
        className="bg-white rounded-lg shadow-xl w-full max-w-md p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-gray-900">Schedule an action</h2>
        <p className="text-sm text-gray-500 mt-0.5">{label}</p>

        <form onSubmit={submit} className="mt-4 space-y-4">
          <fieldset>
            <legend className="text-xs font-medium text-gray-700 mb-1.5">What should happen?</legend>
            <div className="space-y-1.5">
              {[
                { k: 'once' as const, a: 'revoke' as const, text: 'Cut off access at a set time' },
                { k: 'once' as const, a: 'extend' as const, text: 'Renew once at a set time' },
                { k: 'autorenew' as const, a: 'extend' as const, text: 'Keep renewing until a date' },
              ].map((o) => (
                <label key={`${o.k}-${o.a}`} className="flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="radio"
                    name="kind"
                    checked={kind === o.k && action === o.a}
                    onChange={() => {
                      setKind(o.k);
                      setAction(o.a);
                    }}
                  />
                  {o.text}
                </label>
              ))}
            </div>
          </fieldset>

          <label className="block">
            <span className="text-xs font-medium text-gray-700">
              {kind === 'once' ? 'When' : 'Keep renewing until'}
            </span>
            <input
              type={kind === 'once' ? 'datetime-local' : 'date'}
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              required
              className="mt-1 w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {kind === 'autorenew' && (
              <span className="block text-xs text-gray-500 mt-1">
                Access continues through this date, then is cut off automatically.
              </span>
            )}
          </label>

          <label className="block">
            <span className="text-xs font-medium text-gray-700">Note (optional)</span>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              placeholder="e.g. loaner returned end of term"
              className="mt-1 w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </label>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900">
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-1.5 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Schedule'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
