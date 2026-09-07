'use client';

import { memo } from 'react';
import type { Status } from '@/lib/clients';

export const StatusBadge = memo(function StatusBadge({ status }: { status: Status }) {
  const map = {
    active: { bg: 'bg-green-50 text-green-700 ring-green-600/20', label: 'Active' },
    expiring: { bg: 'bg-amber-50 text-amber-800 ring-amber-600/20', label: 'Expiring' },
    expired: { bg: 'bg-red-50 text-red-700 ring-red-600/20', label: 'Expired' },
  } as const;
  const { bg, label } = map[status];
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ring-1 ring-inset whitespace-nowrap ${bg}`}
    >
      {label}
    </span>
  );
});

export const ScheduledBadge = memo(function ScheduledBadge() {
  return (
    <span
      title="This client has an active schedule"
      className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-50 text-indigo-700 ring-1 ring-inset ring-indigo-600/20 whitespace-nowrap"
    >
      ⏱ Scheduled
    </span>
  );
});

export function Spinner() {
  return (
    <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

export function Toast({ type, message }: { type: 'success' | 'error'; message: string }) {
  return (
    <div
      role="status"
      className={`fixed top-4 inset-x-4 sm:inset-x-auto sm:right-4 z-50 flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg text-white text-sm sm:max-w-sm ${
        type === 'success' ? 'bg-green-600' : 'bg-red-600'
      }`}
    >
      <span aria-hidden="true">{type === 'success' ? '✓' : '✕'}</span>
      <span>{message}</span>
    </div>
  );
}
