/** Pure client-row helpers, shared by the desktop table and the mobile cards. */

export type Status = 'active' | 'expiring' | 'expired';

const ONE_DAY_MS = 86_400_000;
const FOURTEEN_DAYS_MS = 14 * ONE_DAY_MS;

export function getStatus(expiration: string | undefined, now: number): Status {
  if (!expiration) return 'expired';
  const ms = new Date(expiration).getTime() - now;
  if (ms < 0) return 'expired';
  if (ms < FOURTEEN_DAYS_MS) return 'expiring';
  return 'active';
}

const dateFormatter = new Intl.DateTimeFormat('en-SG', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Asia/Singapore',
});

export function formatDate(ts?: string): string {
  if (!ts) return '—';
  try {
    return dateFormatter.format(new Date(ts));
  } catch {
    return ts;
  }
}

export function daysUntil(ts: string, now: number): string {
  const days = Math.ceil((new Date(ts).getTime() - now) / ONE_DAY_MS);
  if (days < 0) return `${Math.abs(days)}d ago`;
  if (days === 0) return 'today';
  return `in ${days}d`;
}
