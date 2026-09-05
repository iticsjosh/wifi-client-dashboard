# Scheduled & Immediate Splash Authorization — Design

Date: 2026-09-05
Status: approved, not yet implemented

## Problem

The dashboard can renew a Meraki splash authorization, and nothing else. Two
gaps:

1. **No way to cut access off.** Revoking a device today means deleting its
   DynamoDB row, which does not touch Meraki — the device stays authorized on
   the network until its 90-day expiry.
2. **No way to act later.** Every renewal is a person clicking a button at the
   right moment. Long-lived devices need someone to remember for 90 days.

## Scope

In scope:

- Immediate revoke, single and bulk (Stage 1).
- One-off scheduled actions: extend or revoke at a chosen time (Stage 2).
- Recurring auto-renew with a mandatory end date (Stage 2).

Explicitly out of scope:

- **SSID / group policy rules.** Considered and dropped: a rule acts on clients
  that do not exist when it is written, and a wrong SSID name silently affects
  every device on the network. Revisit once one-off and auto-renew have run in
  production.
- **Application-level auth.** Handled as configuration, not code — the Worker
  goes behind Cloudflare Access with Google Workspace as IdP. See Security.

## Two repositories

| Repo | Role |
|---|---|
| `radius-auth-ssid-ver2/infrastructure/` | Terraform, DynamoDB, both Lambdas, API Gateway |
| `WIFI_CLIENT_EXTEND_DASHBOARD_V2/` | Next.js on Cloudflare Workers, server actions, UI |

The frontend never calls AWS APIs directly. It calls API Gateway through server
actions in `app/actions.ts`; `DASHBOARD_API_URL` stays a Worker secret.

## Staging

**Stage 1 — immediate revoke.** Self-contained, useful on its own, and it
builds the `setAuthorization()` primitive the sweeper depends on. The sweeper is
therefore written against code already proven in production.

**Stage 2 — schedules table, sweeper Lambda, schedule UI.**

---

## Stage 1: Immediate revoke

### Shared primitive

`extendOne(clientId)` in `lambda-src/dashboard/index.js` becomes
`setAuthorization(clientId, authorized)`.

- `authorized: true` — today's behaviour, unchanged.
- `authorized: false` — `PUT` with `{ ssids: { [n]: { isAuthorized: false } } }`.

Meraki returns no `expiresAt` when deauthorizing, so the response validation
that currently requires `expiresAt` and `authorizedAt` must apply only to the
`true` path.

DynamoDB write on revoke:

```
SET ExpirationTimestamp = :now, RevokedAt = :now, LastUpdated = :now
ADD RevokeCount :one
```

`SET` and `ADD` are space-separated, never comma-separated — a comma is a
DynamoDB syntax error. The row is kept, consistent with the never-delete rule
documented in `dynamodb.tf`.

Setting `ExpirationTimestamp` to now makes a revoked row render as `expired`
with no frontend change: `getStatus()` in `ClientsTable.tsx` already derives
status from that field alone.

### Routes

Added to the dashboard Lambda, mirroring the extend pair:

- `POST /clients/{clientId}/revoke`
- `POST /clients/bulk-revoke` — body `{ clientIds: string[] }`, returns
  `{ succeeded, failed }` via `Promise.allSettled`, identical in shape to
  `bulk-extend`.

### Frontend

- `revokeClient()` and `bulkRevoke()` in `app/actions.ts`, modelled on
  `extendClient` / `bulkExtend`.
- A `Revoke` button in `ClientRow` beside `Extend`; amber, sitting visually
  between extend (blue) and delete (red).
- `bulkAction` and `bulkConfirm` state widens from `'extend' | 'delete'` to
  include `'revoke'`. The existing two-step confirm and 4-second auto-cancel
  cover the destructive-action UX unchanged.

### Terraform

None. No new resources: the Lambda's DynamoDB policy already grants
`UpdateItem`, and API Gateway uses a `$default` catch-all route. `apply`
re-zips and redeploys the function.

---

## Stage 2: Scheduling

### Mechanism

One sweeper Lambda on `rate(5 minutes)`, scanning a schedules table for due
rows. Chosen over one EventBridge Scheduler entry per job because ±5 minutes is
acceptable: per-job entries would put AWS control-plane calls behind every UI
create/edit/cancel, require `scheduler:*` IAM on the API Lambda, and leave
orphaned schedules firing with no row to explain them.

### Table: `radius-auth-schedules`

PAY_PER_REQUEST, PITR enabled, SSE enabled — matching `client_tracking`.

| Field | Type | Meaning |
|---|---|---|
| `ScheduleID` | S (PK) | uuid |
| `Kind` | S | `once` \| `autorenew` |
| `Action` | S | `extend` \| `revoke`; always `extend` for `autorenew` |
| `ClientID` | S | target client |
| `NextRunAt` | S | ISO 8601 SGT — when the sweeper should act |
| `EndsAt` | S | required for `autorenew`; absent for `once` |
| `Enabled` | BOOL | cancel sets false; rows are never deleted |
| `LastRunAt` | S | audit |
| `LastResult` | S | `ok` or an error message |
| `RunCount` | N | audit |
| `FailureCount` | N | consecutive failures; reset to 0 on success |
| `CreatedAt` | S | provenance |
| `Note` | S | optional free text |

No GSI. At this scale (hundreds of rows) a filtered Scan costs less than an
index and is one less moving part.

`ponytail:` ceiling — switch to a GSI on `Enabled` past ~5k schedules.

### Sweeper Lambda: `radius-auth-schedule-sweeper`

Each tick:

1. Scan for `Enabled = true AND NextRunAt <= now`.
2. For each due row, call the shared `setAuthorization()`. Scheduled and manual
   actions therefore cannot drift apart.
3. Advance state per Kind (below).
4. Stamp `LastRunAt`, `LastResult`, `RunCount`.

All rows processed with `Promise.allSettled` — one failure never aborts the
batch.

**Missed ticks self-heal.** The query is `<= now`, not `== now`, so a Lambda or
Meraki outage means late execution, never a skipped one. A failure leaves
`NextRunAt` in the past, so the next tick retries. `FailureCount` disables a row
after 5 consecutive failures so a permanently broken schedule does not retry
forever.

### Kind: `once`

Fires, then sets `Enabled = false`. `Action` may be `extend` or `revoke`.

### Kind: `autorenew`

Renews when the client's expiry is within the lead time (default 7 days, a
Terraform variable).

**The lead time's real job is retry headroom** — 7 days is roughly 2,000
sweeper ticks in which to recover from an outage before a user notices. The
cost of renewing early is the unused days discarded (renew at day 83, lose 7),
about one extra renewal cycle per year. Negligible.

**`EndsAt` enforcement.** Meraki sets each new expiry to *now + 90 days*, so
the final renewal before `EndsAt` always overshoots it — for a rule ending
2027-06-30, a 2027-05-12 renewal would run to 2027-08-10, six weeks past
intent. Three options were considered:

1. Renew anyway, and auto-create a `once`/`revoke` job at `EndsAt`. ← chosen
2. Skip the overshooting renewal — the device dies weeks early and silently.
   Rejected: fails toward a support ticket.
3. Accept the overshoot. Rejected: defeats the mandatory end date.

Option 1 needs no new machinery: `EndsAt` becomes an automatic `once` +
`revoke` row, reusing Stage 1's revoke and the `once` kind. `EndsAt` then means
exactly what it says — continuous access up to that moment, then off.

⚠️ **Assumption to verify during implementation.** This assumes Meraki's
`expiresAt` is *now + 90 days* rather than an extension of the existing expiry.
Verify with a single call against a throwaway client. The design does not
change either way, but the overshoot arithmetic above does.

### Code sharing

`setAuthorization()` and the Meraki/DynamoDB helpers move to
`lambda-src/shared/meraki.js`, required by both handlers. Each `archive_file`
zips its own handler directory plus the shared module — no Lambda layer at this
size.

### Terraform: `schedules.tf`

- `aws_dynamodb_table.schedules`
- `aws_lambda_function.schedule_sweeper` + log group
- `aws_cloudwatch_event_rule` (`rate(5 minutes)`) + target + `aws_lambda_permission`
- IAM policy: sweeper gets DynamoDB RW on both tables, Secrets Manager read on
  the Meraki key
- Dashboard Lambda's DynamoDB policy widens to include the schedules table
- New variable: `autorenew_lead_days` (default 7)
- New output: schedules table name

Existing CloudWatch alarm patterns in `cloudwatch.tf` extend to the sweeper's
error metric.

### API routes

- `GET /schedules` — all rows, newest first
- `POST /schedules` — create; validates Kind/Action/ClientID and that
  `autorenew` carries `EndsAt`
- `DELETE /schedules/{scheduleID}` — sets `Enabled = false`, does not delete

### Frontend

- `getSchedules()`, `createSchedule()`, `cancelSchedule()` in `app/actions.ts`.
- A `Schedule` button per row opens a dialog: *revoke at [datetime]*, *extend at
  [datetime]*, or *auto-renew until [date]*.
- Rows with an active schedule show a clock badge beside the status badge.
- A `/schedules` page lists all rules with Cancel — the single place to see and
  undo everything, rather than hunting through the client table.

---

## Security

The dashboard currently has no authentication. Anyone with the Worker URL can
extend, delete, and — after Stage 1 — revoke every device on the network.
Scheduling raises the stakes: a rule set once keeps acting.

**Resolution: Cloudflare Access in front of the Worker**, Google Workspace as
IdP. Configuration, not code, and it covers the existing actions as well as the
new ones. This must be in place before Stage 1 ships.

`DASHBOARD_API_URL` remains a Worker secret and is never exposed to the
browser. API Gateway itself stays publicly reachable — Access protects the
dashboard, not the API. A shared-secret header between Worker and Lambda is the
natural follow-up if that matters.

## Testing

- **Unit, no framework** — assert-based self-checks on the pure logic: the
  `NextRunAt` advance rules per Kind, `EndsAt` boundary handling, and
  `merakiUtcToSGT`.
- **Integration** — one throwaway client through the full path: revoke, verify
  in Meraki; schedule a `once` extend two minutes out, confirm the sweeper acts;
  create an `autorenew` with a near-term `EndsAt` and confirm the auto-created
  revoke job appears.
- The `expiresAt` semantics check above is a prerequisite for the autorenew
  tests.

## Risks

| Risk | Mitigation |
|---|---|
| Meraki `expiresAt` semantics differ from assumption | Verify before building autorenew; arithmetic changes, design does not |
| Sweeper and dashboard drift apart | Single shared `setAuthorization()` |
| Broken schedule retries forever | `FailureCount` disables after 5 consecutive failures |
| Bulk revoke hits Meraki rate limits | `Promise.allSettled` already isolates failures; add throttling if observed |
| `terraform.tfstate` is local, not remote | Pre-existing. Flagged, not addressed here |
