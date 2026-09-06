'use server';

/**
 * Server Actions that talk directly to the AWS API Gateway behind
 * `DASHBOARD_API_URL`. These replace the previous `/api/clients/*` proxy
 * routes — saving one network hop per user action.
 *
 * All actions execute inside the Cloudflare Worker (workerd) at request time
 * and never expose `DASHBOARD_API_URL` to the browser.
 */

import type {
  BulkDeleteResponse,
  BulkExtendResponse,
  BulkRevokeResponse,
  Client,
  CreateScheduleInput,
  ExtendResult,
  RevokeResult,
  Schedule,
} from '@/lib/types';

const REQUEST_TIMEOUT_MS = 10_000;

/** Resolve the API Gateway URL at call time so missing-env failures don't break `next build`. */
function apiUrl(): string {
  const url = process.env.DASHBOARD_API_URL;
  if (!url) {
    throw new Error(
      'DASHBOARD_API_URL is not set. Add it in Cloudflare → Worker → Settings → Variables & Secrets.'
    );
  }
  return url;
}

/** Thin wrapper around `fetch` with timeout, JSON body handling, and structured errors. */
async function apiFetch<T>(
  path: string,
  init: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; cache?: RequestCache } = {}
): Promise<T> {
  const { method = 'GET', body, cache = 'no-store' } = init;

  // The API's only gate. API Gateway has no authorizer, so a request without
  // this header is refused with a 403 by the Lambda before any routing.
  // Missing here would mean every action fails — surface it as a config error
  // rather than a stream of 403s.
  const apiKey = process.env.DASHBOARD_API_KEY;
  if (!apiKey) {
    throw new Error(
      'DASHBOARD_API_KEY is not set. Add it in Cloudflare → Pages → Settings → Variables & Secrets.'
    );
  }

  const headers: Record<string, string> = { 'X-Dashboard-Key': apiKey };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${apiUrl()}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  // Try to parse JSON regardless of status so callers see structured errors.
  const text = await res.text();
  const data = text ? safeJson(text) : null;

  if (!res.ok) {
    const message =
      (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : null) ?? `Request to ${path} failed (${res.status})`;
    throw new Error(message);
  }

  return data as T;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/** Fetch all clients. Used by the server-rendered dashboard page and the client refresh button. */
export async function getClients(): Promise<Client[]> {
  return apiFetch<Client[]>('/clients');
}

// ─── Single-client actions ────────────────────────────────────────────────────

export async function extendClient(clientId: string): Promise<ExtendResult> {
  return apiFetch<ExtendResult>(
    `/clients/${encodeURIComponent(clientId)}/extend`,
    { method: 'POST', body: {} }
  );
}

export async function revokeClient(clientId: string): Promise<RevokeResult> {
  return apiFetch<RevokeResult>(
    `/clients/${encodeURIComponent(clientId)}/revoke`,
    { method: 'POST', body: {} }
  );
}

export async function deleteClient(clientId: string): Promise<{ ok: true }> {
  await apiFetch<unknown>(`/clients/${encodeURIComponent(clientId)}`, {
    method: 'DELETE',
  });
  return { ok: true };
}

// ─── Bulk actions ─────────────────────────────────────────────────────────────

export async function bulkExtend(clientIds: string[]): Promise<BulkExtendResponse> {
  if (clientIds.length === 0) return { succeeded: [], failed: [] };
  return apiFetch<BulkExtendResponse>('/clients/bulk-extend', {
    method: 'POST',
    body: { clientIds },
  });
}

export async function bulkRevoke(clientIds: string[]): Promise<BulkRevokeResponse> {
  if (clientIds.length === 0) return { succeeded: [], failed: [] };
  return apiFetch<BulkRevokeResponse>('/clients/bulk-revoke', {
    method: 'POST',
    body: { clientIds },
  });
}

export async function bulkDelete(clientIds: string[]): Promise<BulkDeleteResponse> {
  if (clientIds.length === 0) return { succeeded: [], failed: [] };
  return apiFetch<BulkDeleteResponse>('/clients/bulk-delete', {
    method: 'POST',
    body: { clientIds },
  });
}

// ─── Schedules ────────────────────────────────────────────────────────────────

export async function getSchedules(): Promise<Schedule[]> {
  return apiFetch<Schedule[]>('/schedules');
}

export async function createSchedule(input: CreateScheduleInput): Promise<Schedule> {
  return apiFetch<Schedule>('/schedules', { method: 'POST', body: input });
}

export async function cancelSchedule(scheduleId: string): Promise<{ ok: true }> {
  await apiFetch<unknown>(`/schedules/${encodeURIComponent(scheduleId)}`, {
    method: 'DELETE',
  });
  return { ok: true };
}
