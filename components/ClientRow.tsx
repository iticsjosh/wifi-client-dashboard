'use client';

import { memo } from 'react';
import { daysUntil, formatDate, type Status } from '@/lib/clients';
import type { Client } from '@/lib/types';
import { ScheduledBadge, Spinner, StatusBadge } from './ui';

export interface RowProps {
  client: Client;
  status: Status;
  isSelected: boolean;
  isLoading: boolean;
  isPendingDelete: boolean;
  isPendingRevoke: boolean;
  hasSchedule: boolean;
  onSchedule: (c: Client) => void;
  onToggleSelect: (id: string) => void;
  onExtend: (id: string) => void;
  onRequestDelete: (id: string) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (id: string) => void;
  onRequestRevoke: (id: string) => void;
  onCancelRevoke: () => void;
  onConfirmRevoke: (id: string) => void;
  now: number;
}

// Card-only action cluster. Desktop rows have no buttons — the bulk bar drives
// every action there — so this is sized for touch: 40px min height, full-width
// flex children that wrap into rows.
const s =
  'inline-flex items-center justify-center gap-1 rounded-md font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-1 px-3 py-2.5 text-sm min-h-[40px]';

function Actions({ p }: { p: RowProps }) {
  const busy = p.isLoading || p.isPendingDelete || p.isPendingRevoke;

  return (
    <>
      <button
        type="button"
        onClick={() => p.onExtend(p.client.ClientID)}
        disabled={busy}
        className={`${s} bg-blue-600 text-white hover:bg-blue-700`}
      >
        {p.isLoading ? (
          <>
            <Spinner /> Extending…
          </>
        ) : (
          'Extend'
        )}
      </button>

      {p.isPendingRevoke ? (
        <>
          <button
            type="button"
            onClick={() => p.onConfirmRevoke(p.client.ClientID)}
            className={`${s} bg-amber-600 text-white hover:bg-amber-700`}
          >
            Cut off?
          </button>
          <button
            type="button"
            onClick={p.onCancelRevoke}
            className={`${s} text-gray-500 hover:text-gray-800 hover:bg-gray-100`}
          >
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => p.onRequestRevoke(p.client.ClientID)}
          disabled={p.isLoading || p.isPendingDelete}
          title="Immediately deauthorize this device on Meraki"
          className={`${s} text-amber-700 border border-amber-300 hover:bg-amber-50`}
        >
          Revoke
        </button>
      )}

      <button
        type="button"
        onClick={() => p.onSchedule(p.client)}
        disabled={p.isLoading}
        className={`${s} text-indigo-700 border border-indigo-200 hover:bg-indigo-50`}
      >
        Schedule
      </button>

      {p.isPendingDelete ? (
        <>
          <button
            type="button"
            onClick={() => p.onConfirmDelete(p.client.ClientID)}
            className={`${s} bg-red-600 text-white hover:bg-red-700`}
          >
            Confirm?
          </button>
          <button
            type="button"
            onClick={p.onCancelDelete}
            className={`${s} text-gray-500 hover:text-gray-800 hover:bg-gray-100`}
          >
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => p.onRequestDelete(p.client.ClientID)}
          disabled={p.isLoading || p.isPendingRevoke}
          className={`${s} text-red-600 border border-red-200 hover:bg-red-50`}
        >
          Delete
        </button>
      )}
    </>
  );
}

// ─── Desktop table row ────────────────────────────────────────────────────────

export const ClientRow = memo(function ClientRow(p: RowProps) {
  const { client, status, isSelected, hasSchedule, now } = p;
  return (
    <tr className={`transition-colors ${isSelected ? 'bg-blue-50/60' : 'hover:bg-gray-50'}`}>
      <td className="px-4 py-3">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => p.onToggleSelect(client.ClientID)}
          className="rounded border-gray-300 w-4 h-4"
          aria-label={`Select ${client.ClientName ?? client.ClientID}`}
        />
      </td>
      <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">
        {client.ClientName || <span className="text-gray-400 italic">Unknown</span>}
      </td>
      <td className="px-4 py-3 font-mono text-xs text-gray-500 whitespace-nowrap">
        {client.MacAddress || client.ClientID}
      </td>
      <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
        {client.SSID || <span className="text-gray-400">—</span>}
      </td>
      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
        {formatDate(client.ConnectionTimestamp)}
      </td>
      <td className="px-4 py-3 whitespace-nowrap">
        <span className="text-gray-700">{formatDate(client.ExpirationTimestamp)}</span>
        {client.ExpirationTimestamp && (
          <span className="block text-xs text-gray-400 mt-0.5">
            {daysUntil(client.ExpirationTimestamp, now)}
          </span>
        )}
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={status} />
          {hasSchedule && <ScheduledBadge />}
        </div>
      </td>
      {/* No actions column: on desktop every action runs from the bulk bar,
          reached by selecting rows. The cards below keep their buttons. */}
    </tr>
  );
});

// ─── Mobile card ──────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 py-1">
      <dt className="text-gray-400 shrink-0">{label}</dt>
      <dd className="text-gray-700 text-right">{children}</dd>
    </div>
  );
}

export const ClientCard = memo(function ClientCard(p: RowProps) {
  const { client, status, isSelected, hasSchedule, now } = p;
  return (
    <div
      className={`rounded-lg border p-4 transition-colors ${
        isSelected ? 'border-blue-300 bg-blue-50/60' : 'border-gray-200 bg-white'
      }`}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => p.onToggleSelect(client.ClientID)}
          className="rounded border-gray-300 w-5 h-5 mt-0.5 shrink-0"
          aria-label={`Select ${client.ClientName ?? client.ClientID}`}
        />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-gray-900 truncate">
            {client.ClientName || <span className="text-gray-400 italic">Unknown</span>}
          </p>
          <p className="font-mono text-xs text-gray-500 truncate mt-0.5">
            {client.MacAddress || client.ClientID}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <StatusBadge status={status} />
          {hasSchedule && <ScheduledBadge />}
        </div>
      </div>

      <dl className="mt-3 pt-3 border-t border-gray-100 text-sm">
        <Field label="SSID">{client.SSID || '—'}</Field>
        <Field label="Connected">{formatDate(client.ConnectionTimestamp)}</Field>
        <Field label="Expires">
          {formatDate(client.ExpirationTimestamp)}
          {client.ExpirationTimestamp && (
            <span className="block text-xs text-gray-400">
              {daysUntil(client.ExpirationTimestamp, now)}
            </span>
          )}
        </Field>
      </dl>

      <div className="mt-3 flex flex-wrap gap-2">
        <Actions p={p} />
      </div>
    </div>
  );
});
