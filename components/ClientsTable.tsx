'use client';

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';
import {
  bulkDelete as bulkDeleteAction,
  bulkExtend as bulkExtendAction,
  bulkRevoke as bulkRevokeAction,
  deleteClient as deleteClientAction,
  extendClient as extendClientAction,
  getClients as getClientsAction,
  getSchedules as getSchedulesAction,
  revokeClient as revokeClientAction,
} from '@/app/actions';
import { getStatus, type Status } from '@/lib/clients';
import type { Client } from '@/lib/types';
import { ClientCard, ClientRow, type RowProps } from './ClientRow';
import ScheduleDialog from './ScheduleDialog';
import { Spinner, Toast } from './ui';

type SortField = 'ClientName' | 'ExpirationTimestamp' | 'ConnectionTimestamp' | 'SSID';
type StatusFilter = 'all' | Status;

function SortButton({
  field,
  current,
  dir,
  onClick,
  children,
}: {
  field: SortField;
  current: SortField;
  dir: 'asc' | 'desc';
  onClick: (f: SortField) => void;
  children: React.ReactNode;
}) {
  const active = field === current;
  return (
    <button
      type="button"
      onClick={() => onClick(field)}
      className="flex items-center gap-1 hover:text-gray-700 focus:outline-none"
    >
      {children}
      {/* Geometric-shape triangles, not the arrow block — U+2195 renders as an
          emoji on iOS and as tofu where font coverage is thin. */}
      <span className={`text-[9px] ${active ? 'text-gray-600' : 'text-gray-300'}`}>
        {active && dir === 'desc' ? '▼' : '▲'}
      </span>
    </button>
  );
}

export default function ClientsTable({ initialClients }: { initialClients: Client[] }) {
  const [clients, setClients] = useState<Client[]>(initialClients);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ssidFilter, setSsidFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState<SortField>('ExpirationTimestamp');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [rowLoading, setRowLoading] = useState<Record<string, boolean>>({});
  const [bulkAction, setBulkAction] = useState<'extend' | 'revoke' | 'delete' | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState<'extend' | 'revoke' | 'delete' | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [isRefreshing, startRefresh] = useTransition();
  const [scheduleFor, setScheduleFor] = useState<Client[] | null>(null);
  const [scheduledIds, setScheduledIds] = useState<Set<string>>(new Set());

  const loadSchedules = useCallback(async () => {
    try {
      const rows = await getSchedulesAction();
      // Cancelled schedules come back with Enabled: false — filter is load-bearing.
      setScheduledIds(new Set(rows.filter((r) => r.Enabled).map((r) => r.ClientID)));
    } catch {
      // A schedule-badge failure must not break the table.
    }
  }, []);

  useEffect(() => {
    loadSchedules();
  }, [loadSchedules]);

  // `useDeferredValue` keeps the input box snappy while the (potentially large)
  // filter/sort recomputation runs at lower priority.
  const deferredSearch = useDeferredValue(search);

  // A single shared "now" per render avoids hundreds of `Date.now()` calls.
  const now = useMemo(() => Date.now(), [clients]);

  // Auto-cancel row-level delete/revoke confirmation after 4 s of inactivity
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (confirmDeleteId || confirmRevokeId) {
      confirmTimer.current = setTimeout(() => {
        setConfirmDeleteId(null);
        setConfirmRevokeId(null);
      }, 4000);
    }
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, [confirmDeleteId, confirmRevokeId]);

  // ── Derived state ──────────────────────────────────────────────────────────

  const ssids = useMemo(() => {
    const set = new Set<string>();
    for (const c of clients) {
      if (c.SSID) set.add(c.SSID);
    }
    return Array.from(set).sort();
  }, [clients]);

  const stats = useMemo(() => {
    let active = 0,
      expiring = 0,
      expired = 0;
    for (const c of clients) {
      const s = getStatus(c.ExpirationTimestamp, now);
      if (s === 'active') active++;
      else if (s === 'expiring') expiring++;
      else expired++;
    }
    return { total: clients.length, active, expiring, expired };
  }, [clients, now]);

  const filtered = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
    const result = clients.filter((c) => {
      if (ssidFilter !== 'all' && c.SSID !== ssidFilter) return false;
      if (statusFilter !== 'all' && getStatus(c.ExpirationTimestamp, now) !== statusFilter) return false;
      if (
        q &&
        !(
          c.ClientName?.toLowerCase().includes(q) ||
          c.MacAddress?.toLowerCase().includes(q) ||
          c.ClientID?.toLowerCase().includes(q)
        )
      ) {
        return false;
      }
      return true;
    });
    result.sort((a, b) => {
      const av =
        (sortField === 'ClientName'
          ? a.ClientName
          : sortField === 'SSID'
          ? a.SSID
          : a[sortField]) ?? '';
      const bv =
        (sortField === 'ClientName'
          ? b.ClientName
          : sortField === 'SSID'
          ? b.SSID
          : b[sortField]) ?? '';
      return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    });
    return result;
  }, [clients, ssidFilter, statusFilter, deferredSearch, sortField, sortDir, now]);

  // ── Stable callbacks (so memoized rows stay memoized) ──────────────────────

  const showToast = useCallback((type: 'success' | 'error', message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const handleSort = useCallback((field: SortField) => {
    setSortField((prev) => {
      if (prev === field) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        return prev;
      }
      setSortDir('asc');
      return field;
    });
  }, []);

  const toggleRow = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((prev) =>
      prev.size === filtered.length && filtered.length > 0
        ? new Set()
        : new Set(filtered.map((c) => c.ClientID))
    );
  }, [filtered]);

  const handleRequestDelete = useCallback((id: string) => setConfirmDeleteId(id), []);
  const handleCancelDelete = useCallback(() => setConfirmDeleteId(null), []);

  const handleRequestRevoke = useCallback((id: string) => setConfirmRevokeId(id), []);
  const handleCancelRevoke = useCallback(() => setConfirmRevokeId(null), []);

  const handleScheduleOne = useCallback((c: Client) => setScheduleFor([c]), []);

  const handleScheduleSelected = useCallback(() => {
    const picked = clients.filter((c) => selected.has(c.ClientID));
    if (picked.length > 0) setScheduleFor(picked);
  }, [clients, selected]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const handleRefresh = useCallback(() => {
    startRefresh(async () => {
      try {
        const fresh = await getClientsAction();
        setClients(fresh);
        setSelected(new Set());
      } catch {
        showToast('error', 'Refresh failed');
      }
    });
  }, [showToast]);

  const handleExtend = useCallback(
    async (clientId: string) => {
      setRowLoading((p) => ({ ...p, [clientId]: true }));
      try {
        const data = await extendClientAction(clientId);
        setClients((p) =>
          p.map((c) =>
            c.ClientID === clientId
              ? {
                  ...c,
                  ExpirationTimestamp: data.newExpiration ?? c.ExpirationTimestamp,
                  LastRenewed: data.lastRenewed ?? c.LastRenewed,
                }
              : c
          )
        );
        showToast('success', `Extended: ${clientId}`);
      } catch (err) {
        showToast('error', err instanceof Error ? err.message : 'Extension failed');
      } finally {
        setRowLoading((p) => ({ ...p, [clientId]: false }));
      }
    },
    [showToast]
  );

  const handleConfirmDelete = useCallback(
    async (clientId: string) => {
      setConfirmDeleteId(null);
      setRowLoading((p) => ({ ...p, [clientId]: true }));
      try {
        await deleteClientAction(clientId);
        setClients((p) => p.filter((c) => c.ClientID !== clientId));
        setSelected((p) => {
          const next = new Set(p);
          next.delete(clientId);
          return next;
        });
        showToast('success', `Deleted: ${clientId}`);
      } catch (err) {
        showToast('error', err instanceof Error ? err.message : 'Delete failed');
      } finally {
        setRowLoading((p) => ({ ...p, [clientId]: false }));
      }
    },
    [showToast]
  );

  const handleConfirmRevoke = useCallback(
    async (clientId: string) => {
      setConfirmRevokeId(null);
      setRowLoading((p) => ({ ...p, [clientId]: true }));
      try {
        const data = await revokeClientAction(clientId);
        const revokedAt = data.revokedAt ?? new Date().toISOString();
        setClients((p) =>
          p.map((c) =>
            c.ClientID === clientId
              ? { ...c, ExpirationTimestamp: revokedAt, RevokedAt: revokedAt }
              : c
          )
        );
        showToast('success', `Revoked: ${clientId}`);
      } catch (err) {
        showToast('error', err instanceof Error ? err.message : 'Revoke failed');
      } finally {
        setRowLoading((p) => ({ ...p, [clientId]: false }));
      }
    },
    [showToast]
  );

  const handleBulkExtend = useCallback(async () => {
    if (selected.size === 0) return;
    setBulkAction('extend');
    setBulkConfirm(null);
    try {
      const data = await bulkExtendAction(Array.from(selected));
      const succeeded = data.succeeded ?? [];
      if (succeeded.length > 0) {
        const map = new Map(succeeded.map((s) => [s.clientId, s.newExpiration]));
        setClients((p) =>
          p.map((c) => {
            const exp = map.get(c.ClientID);
            return exp ? { ...c, ExpirationTimestamp: exp } : c;
          })
        );
      }
      const ok = succeeded.length;
      const fail = data.failed?.length ?? 0;
      showToast(
        fail > 0 && ok === 0 ? 'error' : 'success',
        `${ok} extended${fail > 0 ? `, ${fail} failed` : ''}`
      );
      setSelected(new Set());
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Bulk extend failed');
    } finally {
      setBulkAction(null);
    }
  }, [selected, showToast]);

  const handleBulkRevoke = useCallback(async () => {
    if (selected.size === 0) return;
    setBulkAction('revoke');
    setBulkConfirm(null);
    try {
      const data = await bulkRevokeAction(Array.from(selected));
      const succeeded = data.succeeded ?? [];
      if (succeeded.length > 0) {
        const map = new Map(succeeded.map((s) => [s.clientId, s.revokedAt]));
        setClients((p) =>
          p.map((c) => {
            const at = map.get(c.ClientID);
            return at ? { ...c, ExpirationTimestamp: at, RevokedAt: at } : c;
          })
        );
      }
      const ok = succeeded.length;
      const fail = data.failed?.length ?? 0;
      showToast(
        fail > 0 && ok === 0 ? 'error' : 'success',
        `${ok} revoked${fail > 0 ? `, ${fail} failed` : ''}`
      );
      setSelected(new Set());
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Bulk revoke failed');
    } finally {
      setBulkAction(null);
    }
  }, [selected, showToast]);

  const handleBulkDelete = useCallback(async () => {
    if (selected.size === 0) return;
    setBulkAction('delete');
    setBulkConfirm(null);
    try {
      const ids = Array.from(selected);
      const data = await bulkDeleteAction(ids);
      const deleted = data.succeeded ?? [];
      if (deleted.length > 0) {
        const deletedSet = new Set(deleted);
        setClients((p) => p.filter((c) => !deletedSet.has(c.ClientID)));
        setSelected(new Set());
      }
      const ok = deleted.length;
      const fail = data.failed?.length ?? 0;
      showToast(
        fail > 0 && ok === 0 ? 'error' : 'success',
        `${ok} deleted${fail > 0 ? `, ${fail} failed` : ''}`
      );
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Bulk delete failed');
    } finally {
      setBulkAction(null);
    }
  }, [selected, showToast]);

  // ── Render ─────────────────────────────────────────────────────────────────

  // One props object per client, spread into either layout. The spread is what
  // keeps `memo` working — it compares the fields, not this object's identity —
  // so a selection change still re-renders only the rows that actually changed.
  const rowProps = (client: Client): RowProps => ({
    client,
    status: getStatus(client.ExpirationTimestamp, now),
    isSelected: selected.has(client.ClientID),
    isLoading: !!rowLoading[client.ClientID],
    isPendingDelete: confirmDeleteId === client.ClientID,
    isPendingRevoke: confirmRevokeId === client.ClientID,
    hasSchedule: scheduledIds.has(client.ClientID),
    onSchedule: handleScheduleOne,
    onToggleSelect: toggleRow,
    onExtend: handleExtend,
    onRequestDelete: handleRequestDelete,
    onCancelDelete: handleCancelDelete,
    onConfirmDelete: handleConfirmDelete,
    onRequestRevoke: handleRequestRevoke,
    onCancelRevoke: handleCancelRevoke,
    onConfirmRevoke: handleConfirmRevoke,
    now,
  });

  const allSelected = filtered.length > 0 && selected.size === filtered.length;
  const empty = filtered.length === 0;

  return (
    <div className="space-y-4 pb-28">
      {toast && <Toast type={toast.type} message={toast.message} />}

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Total', value: stats.total, accent: 'border-gray-200' },
          { label: 'Active', value: stats.active, accent: 'border-green-300' },
          { label: 'Expiring ≤14 days', value: stats.expiring, accent: 'border-yellow-300' },
          { label: 'Expired', value: stats.expired, accent: 'border-red-300' },
        ].map((s) => (
          <div key={s.label} className={`bg-white rounded-lg border ${s.accent} shadow-sm p-4`}>
            <p className="text-xs text-gray-500">{s.label}</p>
            <p className="text-2xl font-bold text-gray-900 mt-1">{s.value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm px-4 py-3 flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="Search name or MAC…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="border border-gray-300 rounded-md px-3 py-2 text-base sm:text-sm w-full sm:w-52 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <select
          value={ssidFilter}
          onChange={(e) => setSsidFilter(e.target.value)}
          className="flex-1 sm:flex-none border border-gray-300 rounded-md px-3 py-2 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="all">All SSIDs</option>
          {ssids.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className="flex-1 sm:flex-none border border-gray-300 rounded-md px-3 py-2 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="all">All Statuses</option>
          <option value="active">Active</option>
          <option value="expiring">Expiring Soon</option>
          <option value="expired">Expired</option>
        </select>
        <span className="text-sm text-gray-400 sm:ml-auto">
          {filtered.length} of {clients.length} shown
        </span>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={isRefreshing}
          className="text-sm text-blue-600 hover:text-blue-800 disabled:opacity-50"
        >
          {isRefreshing ? 'Refreshing…' : '↻ Refresh'}
        </button>
      </div>

      {/* Mobile: select-all + cards. Below `md` only — the table is hidden here. */}
      <div className="md:hidden space-y-3">
        {!empty && (
          <label className="flex items-center gap-2 px-1 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              className="rounded border-gray-300 w-5 h-5"
            />
            Select all {filtered.length}
          </label>
        )}
        {empty ? (
          <p className="bg-white rounded-lg border border-gray-200 py-10 text-center text-gray-400">
            No clients match the current filters.
          </p>
        ) : (
          filtered.map((client) => <ClientCard key={client.ClientID} {...rowProps(client)} />)
        )}
      </div>

      {/* Desktop: the table, unchanged in structure. */}
      <div className="hidden md:block bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-xs font-medium text-gray-500 uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3 w-10">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    className="rounded border-gray-300 w-4 h-4"
                    aria-label="Select all"
                  />
                </th>
                <th className="px-4 py-3 text-left">
                  <SortButton field="ClientName" current={sortField} dir={sortDir} onClick={handleSort}>
                    Client Name
                  </SortButton>
                </th>
                <th className="px-4 py-3 text-left">MAC Address</th>
                <th className="px-4 py-3 text-left">
                  <SortButton field="SSID" current={sortField} dir={sortDir} onClick={handleSort}>
                    SSID
                  </SortButton>
                </th>
                <th className="px-4 py-3 text-left">
                  <SortButton field="ConnectionTimestamp" current={sortField} dir={sortDir} onClick={handleSort}>
                    Connected
                  </SortButton>
                </th>
                <th className="px-4 py-3 text-left">
                  <SortButton field="ExpirationTimestamp" current={sortField} dir={sortDir} onClick={handleSort}>
                    Expires
                  </SortButton>
                </th>
                <th className="px-4 py-3 text-left">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {empty ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-gray-400">
                    No clients match the current filters.
                  </td>
                </tr>
              ) : (
                filtered.map((client) => <ClientRow key={client.ClientID} {...rowProps(client)} />)
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="fixed bottom-0 inset-x-0 sm:bottom-6 sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2 z-40 flex flex-wrap sm:flex-nowrap items-center justify-center gap-2 sm:gap-3 bg-gray-900 text-white px-4 py-3 sm:px-5 sm:rounded-full shadow-2xl">
          <span className="text-sm font-medium w-full sm:w-auto text-center shrink-0 whitespace-nowrap">
            {selected.size} client{selected.size !== 1 ? 's' : ''} selected
          </span>

          {bulkConfirm === null && (
            <>
              <button
                type="button"
                onClick={handleBulkExtend}
                disabled={bulkAction !== null}
                className="flex items-center gap-1.5 bg-blue-500 hover:bg-blue-400 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-full whitespace-nowrap transition-colors"
              >
                {bulkAction === 'extend' ? (
                  <>
                    <Spinner /> Extending…
                  </>
                ) : (
                  'Extend'
                )}
              </button>

              <button
                type="button"
                onClick={handleScheduleSelected}
                disabled={bulkAction !== null}
                className="flex items-center gap-1.5 bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-full whitespace-nowrap transition-colors"
              >
                Schedule
              </button>
            </>
          )}

          {bulkConfirm === 'revoke' ? (
            <span className="flex flex-wrap items-center justify-center gap-2">
              <span className="text-xs text-amber-300">
                Cut off {selected.size} device{selected.size !== 1 ? 's' : ''} now?
              </span>
              <button
                type="button"
                onClick={handleBulkRevoke}
                disabled={bulkAction !== null}
                className="flex items-center gap-1.5 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-full whitespace-nowrap transition-colors"
              >
                {bulkAction === 'revoke' ? (
                  <>
                    <Spinner /> Revoking…
                  </>
                ) : (
                  'Yes, Revoke'
                )}
              </button>
              <button
                type="button"
                onClick={() => setBulkConfirm(null)}
                className="text-gray-400 hover:text-white text-sm px-2 py-2 whitespace-nowrap"
              >
                Cancel
              </button>
            </span>
          ) : bulkConfirm === null ? (
            <button
              type="button"
              onClick={() => setBulkConfirm('revoke')}
              disabled={bulkAction !== null}
              className="flex items-center gap-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-full whitespace-nowrap transition-colors"
            >
              Revoke
            </button>
          ) : null}

          {bulkConfirm === 'delete' ? (
            <span className="flex flex-wrap items-center justify-center gap-2">
              <span className="text-xs text-red-300">
                Delete {selected.size} record{selected.size !== 1 ? 's' : ''}?
              </span>
              <button
                type="button"
                onClick={handleBulkDelete}
                disabled={bulkAction !== null}
                className="flex items-center gap-1.5 bg-red-500 hover:bg-red-400 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-full whitespace-nowrap transition-colors"
              >
                {bulkAction === 'delete' ? (
                  <>
                    <Spinner /> Deleting…
                  </>
                ) : (
                  'Yes, Delete'
                )}
              </button>
              <button
                type="button"
                onClick={() => setBulkConfirm(null)}
                className="text-gray-400 hover:text-white text-sm px-2 py-2 whitespace-nowrap"
              >
                Cancel
              </button>
            </span>
          ) : bulkConfirm === null ? (
            <button
              type="button"
              onClick={() => setBulkConfirm('delete')}
              disabled={bulkAction !== null}
              className="flex items-center gap-1.5 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-full whitespace-nowrap transition-colors"
            >
              Delete
            </button>
          ) : null}

          {bulkConfirm === null && (
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="text-gray-400 hover:text-white text-sm px-2 py-2 whitespace-nowrap"
            >
              ✕ Clear
            </button>
          )}
        </div>
      )}

      {scheduleFor && (
        <ScheduleDialog
          clients={scheduleFor}
          onClose={() => setScheduleFor(null)}
          onCreated={(m) => {
            showToast('success', m);
            setSelected(new Set());
            loadSchedules();
          }}
        />
      )}
    </div>
  );
}
