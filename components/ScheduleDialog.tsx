'use client';

import { useEffect, useState } from 'react';
import { bulkCreateSchedule, createSchedule } from '@/app/actions';
import { toUtc } from '@/lib/schedule';
import type { Client, ScheduleKind, ScheduleAction } from '@/lib/types';

export default function ScheduleDialog({
  clients,
  onClose,
  onCreated,
}: {
  clients: Client[];
  onClose: () => void;
  onCreated: (message: string, type?: 'success' | 'error') => void;
}) {
  const [kind, setKind] = useState<ScheduleKind>('once');
  const [action, setAction] = useState<ScheduleAction>('revoke');
  const [when, setWhen] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const single = clients.length === 1;
  const label = single
    ? clients[0].ClientName || clients[0].ClientID
    : `${clients.length} clients`;

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

    // One kind/action/time applies to every selected client.
    const input =
      kind === 'once'
        ? { kind, action, runAt: toUtc(when), note: note || undefined }
        : { kind, action: 'extend' as const, endsAt: toUtc(when), note: note || undefined };
    const verb = kind === 'once' ? `Scheduled ${action}` : 'Auto-renew enabled';

    try {
      if (single) {
        await createSchedule({ ...input, clientId: clients[0].ClientID });
        onCreated(`${verb} for ${label}`);
        onClose();
        return;
      }

      const { succeeded, failed } = await bulkCreateSchedule(
        clients.map((c) => c.ClientID),
        input
      );
      // Partial failure still closes — the successes are real and the toast
      // carries the count, matching how bulk extend/revoke behave.
      if (succeeded.length === 0) {
        setError(failed[0]?.error ?? 'Could not create the schedules.');
        return;
      }
      onCreated(
        `${verb} for ${succeeded.length} client${succeeded.length !== 1 ? 's' : ''}` +
          (failed.length > 0 ? `, ${failed.length} failed` : '')
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
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 sm:px-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Schedule an action for ${label}`}
        className="bg-white rounded-t-2xl sm:rounded-lg shadow-xl w-full sm:max-w-md p-5 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-gray-900">Schedule an action</h2>
        <p className="text-sm text-gray-500 mt-0.5">{label}</p>

        {!single && (
          <p className="mt-1.5 text-xs text-gray-400 line-clamp-2">
            {clients.map((c) => c.ClientName || c.ClientID).join(', ')}
          </p>
        )}

        <form onSubmit={submit} className="mt-4 space-y-4">
          <fieldset>
            <legend className="text-xs font-medium text-gray-700 mb-1.5">What should happen?</legend>
            <div className="space-y-1.5">
              {[
                { k: 'once' as const, a: 'revoke' as const, text: 'Cut off access at a set time' },
                { k: 'once' as const, a: 'extend' as const, text: 'Renew once at a set time' },
                { k: 'autorenew' as const, a: 'extend' as const, text: 'Keep renewing until a date' },
              ].map((o) => (
                <label key={`${o.k}-${o.a}`} className="flex items-center gap-2 py-1 text-sm text-gray-700">
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
              className="mt-1 w-full border border-gray-300 rounded-md px-3 py-2 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
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
              className="mt-1 w-full border border-gray-300 rounded-md px-3 py-2 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </label>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : single ? 'Schedule' : `Schedule ${clients.length}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
