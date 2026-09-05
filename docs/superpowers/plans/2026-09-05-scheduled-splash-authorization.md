# Scheduled & Immediate Splash Authorization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add immediate splash-authorization revoke and time-based scheduling (one-off actions + bounded auto-renew) across the AWS stack and the Next.js dashboard.

**Architecture:** Stage 1 generalises the existing `extendOne()` Lambda function into `setAuthorization(clientId, authorized)` and exposes revoke routes — no new AWS resources. Stage 2 adds a `radius-auth-schedules` DynamoDB table plus a sweeper Lambda on a 5-minute EventBridge tick that scans for due rows and calls the same shared primitive, so scheduled and manual actions can never diverge.

**Tech Stack:** Terraform ~>5.0 AWS provider, Node.js 18 Lambda (arm64), DynamoDB, EventBridge, Next.js 16 / React 19 server actions on Cloudflare Workers, Tailwind 4.

**Spec:** `docs/superpowers/specs/2026-09-05-scheduled-splash-authorization-design.md`

## Global Constraints

- **Two repositories.** Infra paths are relative to `/Users/joshua/Downloads/DEV/ICS-Projects/PROD/radius-auth-ssid-ver2/infrastructure/`. Frontend paths are relative to `/Users/joshua/Downloads/DEV/ICS-Projects/PROD/WIFI_CLIENT_EXTEND_DASHBOARD_V2/`. Each repo commits separately.
- **`SET` and `ADD` in a DynamoDB UpdateExpression are space-separated, never comma-separated.** A comma is a syntax error.
- **Records are never deleted by new code.** Revoke updates; schedule cancel sets `Enabled = false`.
- **All new stored timestamps are UTC ISO 8601 (`toISOString()`, `Z` suffix).** The sweeper's DynamoDB filter compares `NextRunAt` as a *string*, so mixing `+08:00` and `Z` offsets would break lexicographic ordering and fire jobs at the wrong time. Existing `ExpirationTimestamp` stays SGT — do not change it.
- **No new npm dependencies in either repo.** Lambda uses the AWS SDK already bundled in the runtime plus `node:crypto` for uuid; frontend uses React/Next only.
- **Node's built-in test runner** (`node --test`) for Lambda unit tests. No framework, no config.
- **Runtime `nodejs18.x`, `architectures = ["arm64"]`** for any new Lambda, matching existing functions.
- **Cloudflare Access must be enabled before Stage 1 reaches production.** Task 6 gates this.

---

## File Structure

**Infra repo:**

| Path | Responsibility |
|---|---|
| `lambda-src/shared/meraki.js` | NEW — `setAuthorization()`, secret cache, SGT/UTC helpers. Required by both handlers. |
| `lambda-src/dashboard/index.js` | MODIFY — routing only; business logic moves to shared. Adds revoke + schedule routes. |
| `lambda-src/sweeper/index.js` | NEW (Stage 2) — EventBridge handler; scan due rows, act, advance state. |
| `lambda-src/shared/schedule-logic.js` | NEW (Stage 2) — pure functions: next-run advance, EndsAt boundary. Unit-tested. |
| `lambda-src/shared/*.test.js` | NEW — `node --test` self-checks for the pure logic. |
| `dashboard-api.tf` | MODIFY — archive both handler dir + shared dir; widen DynamoDB policy. |
| `schedules.tf` | NEW (Stage 2) — table, sweeper Lambda, EventBridge rule, IAM, alarm. |
| `variables.tf` / `outputs.tf` | MODIFY — `autorenew_lead_days`, schedules table name output. |

**Frontend repo:**

| Path | Responsibility |
|---|---|
| `lib/types.ts` | MODIFY — `RevokeResult`, `Schedule`, `ScheduleKind`, `ScheduleAction`. |
| `app/actions.ts` | MODIFY — `revokeClient`, `bulkRevoke`, then schedule CRUD actions. |
| `components/ClientsTable.tsx` | MODIFY — revoke button, bulk revoke, schedule button + badge. |
| `components/ScheduleDialog.tsx` | NEW (Stage 2) — create-schedule form. |
| `app/schedules/page.tsx` | NEW (Stage 2) — list + cancel all rules. |

**Why `shared/` is a sibling directory:** `archive_file` in `dashboard-api.tf` currently zips `lambda-src/dashboard` with `source_dir`. Since both handlers need the shared module, each function's zip is built from a `source_dir` one level up with the other handler excluded — Task 1 changes this to explicit `source` blocks so each zip contains exactly `index.js` + `shared/`.

---

## Stage 1 — Immediate revoke

### Task 1: Extract shared Meraki module

**Files:**
- Create: `lambda-src/shared/meraki.js`
- Create: `lambda-src/shared/meraki.test.js`
- Modify: `lambda-src/dashboard/index.js` (remove extracted code, require the module)
- Modify: `dashboard-api.tf:96-100` (archive_file block)

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `setAuthorization(clientId, authorized) → Promise<{clientId, newExpiration?, lastRenewed?, revokedAt?}>`
  - `merakiUtcToSGT(utcStr) → string`
  - `getAllClients() → Promise<Item[]>`, `getClient(clientId) → Promise<Item|null>`, `deleteOne(clientId) → Promise<void>`
  - `dynamo` (DynamoDBDocumentClient), `TABLE_NAME`

- [ ] **Step 1: Write the failing test for the pure helper**

Create `lambda-src/shared/meraki.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { merakiUtcToSGT } = require('./meraki');

test('merakiUtcToSGT converts Meraki UTC format to SGT ISO 8601', () => {
    assert.strictEqual(
        merakiUtcToSGT('2026-04-24 04:49:29 UTC'),
        '2026-04-24T12:49:29+08:00'
    );
});

test('merakiUtcToSGT rolls the date forward across midnight', () => {
    assert.strictEqual(
        merakiUtcToSGT('2026-04-24 20:30:00 UTC'),
        '2026-04-25T04:30:00+08:00'
    );
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/joshua/Downloads/DEV/ICS-Projects/PROD/radius-auth-ssid-ver2/infrastructure/lambda-src
node --test shared/
```

Expected: FAIL — `Cannot find module './meraki'`.

- [ ] **Step 3: Create the shared module**

Create `lambda-src/shared/meraki.js`. Move these **verbatim** from `lambda-src/dashboard/index.js`: the three `require` lines, the `dynamo`/`sm` clients, the config constants, `_cachedApiKey`/`getMerakiApiKey()`, `getSsidNumber()`, `merakiUtcToSGT()`, `getAllClients()`, `getClient()`, `deleteOne()`. Then replace `extendOne()` with:

```js
/**
 * Sets a client's Meraki splash authorization on or off, then records the
 * result in DynamoDB. Throws on any failure so callers decide how to handle it.
 *
 * authorized=true  → Meraki returns expiresAt/authorizedAt; we store them.
 * authorized=false → Meraki returns no expiry; we set expiry to now and stamp
 *                    RevokedAt, so the row reads as expired everywhere.
 */
async function setAuthorization(clientId, authorized) {
    const client = await getClient(clientId);
    if (!client) throw new Error(`Client not found: ${clientId}`);

    const merakiId = client.MerakiClientID || client.ClientID;
    const ssid     = client.SSID || 'ICS-Staff';
    const ssidNum  = getSsidNumber(ssid);

    if (!ssidNum) {
        throw new Error(`No SSID number mapping for "${ssid}". Update the SSID_MAP variable.`);
    }

    const apiKey = await getMerakiApiKey();
    const url    = `${MERAKI_BASE}/networks/${MERAKI_NETWORK_ID}/clients/${merakiId}/splashAuthorizationStatus`;

    console.log(`${authorized ? 'Extending' : 'Revoking'} ${clientId} on SSID "${ssid}" (number ${ssidNum})`);

    const res = await fetch(url, {
        method:  'PUT',
        headers: {
            Authorization:  `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Accept:         'application/json',
        },
        body: JSON.stringify({ ssids: { [ssidNum]: { isAuthorized: authorized } } }),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Meraki API ${res.status}: ${text}`);
    }

    const data     = await res.json();
    const ssidData = data.ssids?.[ssidNum];

    if (!authorized) {
        // Meraki returns no expiresAt when deauthorizing — do not validate it.
        if (ssidData?.isAuthorized) throw new Error('Meraki still reports the client as authorized');
        const now = new Date().toISOString();
        await dynamo.send(new UpdateCommand({
            TableName: TABLE_NAME,
            Key: { ClientID: clientId },
            UpdateExpression:
                'SET ExpirationTimestamp = :now, RevokedAt = :now, LastUpdated = :now ' +
                'ADD RevokeCount :one',
            ExpressionAttributeValues: { ':now': now, ':one': 1 },
        }));
        console.log(`Revoked ${clientId}`);
        return { clientId, revokedAt: now };
    }

    if (!ssidData?.isAuthorized) throw new Error('Meraki did not confirm authorization in response');
    if (!ssidData.expiresAt)     throw new Error('Meraki response missing expiresAt');
    if (!ssidData.authorizedAt)  throw new Error('Meraki response missing authorizedAt');

    const newExpiration = merakiUtcToSGT(ssidData.expiresAt);
    const lastRenewed   = merakiUtcToSGT(ssidData.authorizedAt);

    await dynamo.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { ClientID: clientId },
        UpdateExpression:
            'SET ExpirationTimestamp = :exp, LastUpdated = :lu, LastRenewed = :lr ' +
            'ADD RenewalCount :one',
        ExpressionAttributeValues: {
            ':exp': newExpiration,
            ':lu':  new Date().toISOString(),
            ':lr':  lastRenewed,
            ':one': 1,
        },
    }));

    console.log(`Extended ${clientId}: expires ${newExpiration}`);
    return { clientId, newExpiration, lastRenewed };
}

module.exports = {
    setAuthorization, merakiUtcToSGT, getAllClients, getClient, deleteOne,
    dynamo, TABLE_NAME,
};
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test shared/
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Rewrite the dashboard handler to consume the module**

In `lambda-src/dashboard/index.js`, delete everything above `// ── HTTP response helpers ──` and replace with:

```js
'use strict';

/**
 * Dashboard API — Lambda Handler (routing only).
 * Business logic lives in ../shared/meraki.js, shared with the sweeper so
 * scheduled and manual actions cannot drift apart.
 */

const {
    setAuthorization, getAllClients, deleteOne,
} = require('../shared/meraki');
```

Then replace every `extendOne(x)` call with `setAuthorization(x, true)`. Leave the response helpers and handler body otherwise untouched for now.

- [ ] **Step 6: Update the archive so each zip carries the shared module**

In `dashboard-api.tf`, replace the `archive_file` block at lines 96-100:

```hcl
data "archive_file" "dashboard_lambda_zip" {
  type        = "zip"
  output_path = "${path.module}/.terraform/dashboard-lambda-package.zip"

  source {
    content  = file("${path.module}/lambda-src/dashboard/index.js")
    filename = "index.js"
  }

  source {
    content  = file("${path.module}/lambda-src/shared/meraki.js")
    filename = "shared/meraki.js"
  }
}
```

`handler` stays `index.handler`; the `require('../shared/meraki')` resolves because `shared/` sits beside `index.js` in the zip root.

- [ ] **Step 7: Validate the Terraform and confirm no resource changes beyond the redeploy**

```bash
cd /Users/joshua/Downloads/DEV/ICS-Projects/PROD/radius-auth-ssid-ver2/infrastructure
terraform validate && terraform plan
```

Expected: `Success!`, and a plan showing **only** `aws_lambda_function.dashboard_api` updated in place (`source_code_hash` changed). If any other resource shows a change, stop and investigate.

- [ ] **Step 8: Apply and smoke-test that extend still works**

```bash
terraform apply
curl -s "$(terraform output -raw dashboard_api_url)/clients" | head -c 300
```

Expected: JSON array of clients. This proves the refactor did not break the existing path before any new behaviour is added.

- [ ] **Step 9: Commit**

```bash
git add lambda-src/shared/meraki.js lambda-src/shared/meraki.test.js lambda-src/dashboard/index.js dashboard-api.tf
git commit -m "refactor: extract shared Meraki module, generalise extend to setAuthorization"
```

---

### Task 2: Revoke routes in the Lambda

**Files:**
- Modify: `lambda-src/dashboard/index.js` (handler body)
- Modify: `dashboard-api.tf:1-13` (header comment)

**Interfaces:**
- Consumes: `setAuthorization(clientId, authorized)` from Task 1.
- Produces: `POST /clients/{clientId}/revoke` → `{success, clientId, revokedAt}`; `POST /clients/bulk-revoke` → `{succeeded: [{clientId, revokedAt}], failed: [{clientId, error}]}`.

- [ ] **Step 1: Add the single-revoke route**

In `exports.handler`, immediately after the existing `extendMatch` block:

```js
        // ── POST /clients/{clientId}/revoke ───────────────────────────────────
        const revokeMatch = rawPath.match(/^\/clients\/(.+)\/revoke$/);
        if (method === 'POST' && revokeMatch) {
            const clientId = decodeURIComponent(revokeMatch[1]);
            const result   = await setAuthorization(clientId, false);
            return ok({ success: true, ...result });
        }
```

Order matters: this must sit **before** the `DELETE /clients/{id}` matcher, which uses `[^/]+` and so will not collide, but keeping revoke adjacent to extend keeps the file readable.

- [ ] **Step 2: Add the bulk-revoke route**

After the `bulk-extend` block:

```js
        // ── POST /clients/bulk-revoke ─────────────────────────────────────────
        if (method === 'POST' && rawPath === '/clients/bulk-revoke') {
            const body = typeof event.body === 'string'
                ? JSON.parse(event.body)
                : (event.body ?? {});

            const { clientIds } = body;
            if (!Array.isArray(clientIds) || clientIds.length === 0) {
                return clientError('clientIds must be a non-empty array');
            }

            console.log(`Bulk revoking ${clientIds.length} client(s)`);

            const results   = await Promise.allSettled(clientIds.map(id => setAuthorization(id, false)));
            const succeeded = [];
            const failed    = [];

            results.forEach((r, i) => {
                if (r.status === 'fulfilled') {
                    succeeded.push(r.value);
                } else {
                    console.error(`Failed to revoke ${clientIds[i]}: ${r.reason?.message}`);
                    failed.push({ clientId: clientIds[i], error: r.reason?.message ?? 'Unknown error' });
                }
            });

            console.log(`Bulk revoke complete: ${succeeded.length} OK, ${failed.length} failed`);
            return ok({ succeeded, failed });
        }
```

- [ ] **Step 3: Update both route-list comments**

Add to the header comment in `lambda-src/dashboard/index.js` and to `dashboard-api.tf` lines 4-9:

```
#   POST   /clients/{clientId}/revoke    — revoke one client's authorization
#   POST   /clients/bulk-revoke          — revoke many clients in parallel
```

- [ ] **Step 4: Apply and verify against a throwaway client**

```bash
terraform apply
API=$(terraform output -raw dashboard_api_url)
# Pick a disposable client ID from the list first — do NOT use a real user's device.
curl -s -X POST "$API/clients/<THROWAWAY_ID>/revoke" | jq
```

Expected: `{"success":true,"clientId":"…","revokedAt":"2026-…Z"}`. Then confirm in the Meraki dashboard that the client shows as unauthorized, and `curl "$API/clients"` shows that row with `ExpirationTimestamp` in the past.

- [ ] **Step 5: Record the `expiresAt` semantics finding**

While you have a throwaway client, resolve the spec's flagged assumption: note its current `ExpirationTimestamp`, `POST .../extend`, and compare the new expiry against *now + 90 days*.

Append the answer to the spec's assumption block in `docs/superpowers/specs/2026-09-05-scheduled-splash-authorization-design.md` (frontend repo) — one line: `VERIFIED 2026-xx-xx: Meraki returns now + 90 days` (or the observed behaviour). Task 8 depends on this.

- [ ] **Step 6: Commit**

```bash
git add lambda-src/dashboard/index.js dashboard-api.tf
git commit -m "feat: add single and bulk revoke routes"
```

---

### Task 3: Revoke server actions and types

**Files:**
- Modify: `lib/types.ts`
- Modify: `app/actions.ts`

**Interfaces:**
- Consumes: the two routes from Task 2.
- Produces: `revokeClient(clientId) → Promise<RevokeResult>`, `bulkRevoke(clientIds) → Promise<BulkRevokeResponse>`, and the `Client.RevokedAt` / `Client.RevokeCount` fields.

- [ ] **Step 1: Add the types**

In `lib/types.ts`, add to the `Client` interface after `RenewalCount`:

```ts
  RevokedAt?: string;
  RevokeCount?: number;
```

And append:

```ts
export interface RevokeResult {
  clientId: string;
  revokedAt?: string;
  error?: string;
}

export interface BulkRevokeResponse {
  succeeded?: Array<{ clientId: string; revokedAt: string }>;
  failed?: Array<{ clientId: string; error?: string }>;
}
```

- [ ] **Step 2: Add the server actions**

In `app/actions.ts`, extend the type import with `BulkRevokeResponse` and `RevokeResult`, then add after `extendClient`:

```ts
export async function revokeClient(clientId: string): Promise<RevokeResult> {
  return apiFetch<RevokeResult>(
    `/clients/${encodeURIComponent(clientId)}/revoke`,
    { method: 'POST', body: {} }
  );
}
```

and after `bulkExtend`:

```ts
export async function bulkRevoke(clientIds: string[]): Promise<BulkRevokeResponse> {
  if (clientIds.length === 0) return { succeeded: [], failed: [] };
  return apiFetch<BulkRevokeResponse>('/clients/bulk-revoke', {
    method: 'POST',
    body: { clientIds },
  });
}
```

- [ ] **Step 3: Typecheck**

```bash
cd /Users/joshua/Downloads/DEV/ICS-Projects/PROD/WIFI_CLIENT_EXTEND_DASHBOARD_V2
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/types.ts app/actions.ts
git commit -m "feat: add revoke server actions"
```

---

### Task 4: Row-level revoke button

**Files:**
- Modify: `components/ClientsTable.tsx` (`RowProps`, `ClientRow`, main component)

**Interfaces:**
- Consumes: `revokeClient` from Task 3.
- Produces: `onRevoke: (id: string) => void` in `RowProps`; `confirmRevokeId` state pattern reused by Task 5.

- [ ] **Step 1: Extend `RowProps` and the import**

Add `revokeClient as revokeClientAction` to the existing `@/app/actions` import. In the `RowProps` interface add:

```ts
  isPendingRevoke: boolean;
  onRequestRevoke: (id: string) => void;
  onCancelRevoke: () => void;
  onConfirmRevoke: (id: string) => void;
```

- [ ] **Step 2: Add the button to `ClientRow`**

Destructure the four new props, then insert between the Extend button (ends line ~215) and the delete block:

```tsx
          {isPendingRevoke ? (
            <span className="inline-flex items-center gap-1">
              <button
                type="button"
                onClick={() => onConfirmRevoke(client.ClientID)}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium bg-amber-600 text-white hover:bg-amber-700 transition-colors"
              >
                Cut off?
              </button>
              <button
                type="button"
                onClick={onCancelRevoke}
                className="px-2 py-1.5 rounded-md text-xs font-medium text-gray-500 hover:text-gray-800 hover:bg-gray-100 transition-colors"
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => onRequestRevoke(client.ClientID)}
              disabled={isLoading || isPendingDelete}
              title="Immediately deauthorize this device on Meraki"
              className="inline-flex items-center px-3 py-1.5 rounded-md text-xs font-medium text-amber-700 border border-amber-300 hover:bg-amber-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Revoke
            </button>
          )}
```

- [ ] **Step 3: Add state, timer, and handler in the main component**

Beside `confirmDeleteId` (line 263):

```tsx
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
```

Extend the existing auto-cancel effect (lines 274-283) to clear both — change the condition to `if (confirmDeleteId || confirmRevokeId)`, have the timeout call both setters, and add `confirmRevokeId` to the dependency array.

Add the handlers beside `handleRequestDelete` (line 378):

```tsx
  const handleRequestRevoke = useCallback((id: string) => setConfirmRevokeId(id), []);
  const handleCancelRevoke = useCallback(() => setConfirmRevokeId(null), []);

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
```

- [ ] **Step 4: Pass the props at the `ClientRow` call site**

In the `<ClientRow ... />` JSX inside `tbody`, add:

```tsx
                  isPendingRevoke={confirmRevokeId === c.ClientID}
                  onRequestRevoke={handleRequestRevoke}
                  onCancelRevoke={handleCancelRevoke}
                  onConfirmRevoke={handleConfirmRevoke}
```

- [ ] **Step 5: Typecheck and eyeball it**

```bash
npx tsc --noEmit && npm run dev
```

Open `http://localhost:3001`. Confirm: Revoke shows a "Cut off?" confirm, cancels itself after 4 s, and on confirm the row's status badge flips to Expired without a page reload.

- [ ] **Step 6: Commit**

```bash
git add components/ClientsTable.tsx
git commit -m "feat: add per-row revoke with confirmation"
```

---

### Task 5: Bulk revoke

**Files:**
- Modify: `components/ClientsTable.tsx` (bulk state + action bar)

**Interfaces:**
- Consumes: `bulkRevoke` from Task 3; the bulk-bar pattern at lines 634-706.
- Produces: nothing downstream.

- [ ] **Step 1: Widen the bulk state unions**

Lines 261-262 become:

```tsx
  const [bulkAction, setBulkAction] = useState<'extend' | 'revoke' | 'delete' | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState<'extend' | 'revoke' | 'delete' | null>(null);
```

- [ ] **Step 2: Add the handler**

After `handleBulkExtend` (ends line 471):

```tsx
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
```

Add `bulkRevoke as bulkRevokeAction` to the actions import.

- [ ] **Step 3: Add the bulk bar control**

The bar currently hides the Extend button when `bulkConfirm !== 'delete'`. Generalise: change that guard and the "✕ Clear" guard from `bulkConfirm !== 'delete'` to `bulkConfirm === null`, then insert a revoke control after the Extend button:

```tsx
          {bulkConfirm === 'revoke' ? (
            <span className="flex items-center gap-2">
              <span className="text-xs text-amber-300">
                Cut off {selected.size} device{selected.size !== 1 ? 's' : ''} now?
              </span>
              <button
                type="button"
                onClick={handleBulkRevoke}
                disabled={bulkAction !== null}
                className="flex items-center gap-1.5 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-white text-sm font-medium px-4 py-1.5 rounded-full transition-colors"
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
                className="text-gray-400 hover:text-white text-sm"
              >
                Cancel
              </button>
            </span>
          ) : bulkConfirm === null ? (
            <button
              type="button"
              onClick={() => setBulkConfirm('revoke')}
              disabled={bulkAction !== null}
              className="flex items-center gap-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-1.5 rounded-full transition-colors"
            >
              Revoke Selected
            </button>
          ) : null}
```

Wrap the existing delete control in the same `bulkConfirm === 'delete' ? … : bulkConfirm === null ? … : null` shape so exactly one confirmation can be open at a time.

- [ ] **Step 4: Verify in the browser**

```bash
npx tsc --noEmit && npm run dev
```

Select 2+ rows. Confirm: asking for Revoke hides Extend and Delete; cancelling restores all three; confirming updates every selected row's badge to Expired.

- [ ] **Step 5: Commit**

```bash
git add components/ClientsTable.tsx
git commit -m "feat: add bulk revoke to the selection bar"
```

---

### Task 6: Cloudflare Access gate (Stage 1 release blocker)

**Files:** none — configuration only.

**Interfaces:** none.

- [ ] **Step 1: Put the Worker behind Access**

In the Cloudflare dashboard: Zero Trust → Access → Applications → Add a self-hosted application pointing at the deployed Worker hostname. Add a policy allowing your Google Workspace domain, with Google as the IdP.

- [ ] **Step 2: Verify enforcement**

Open the Worker URL in a private window. Expected: the Google sign-in interstitial, not the dashboard.

- [ ] **Step 3: Record it**

Add one line to the spec's Security section: `ENABLED <date> — <application name>`. Commit that edit.

> ⚠️ **Do not skip.** After Task 5 the unauthenticated URL can deauthorize every device on the network.

---

## Stage 2 — Scheduling

### Task 7: Pure schedule logic

The only genuinely tricky code in this plan, so it is isolated from all I/O and tested first. `advanceSchedule()` decides what happens to a row after it fires; nothing in it touches AWS.

**Files:**
- Create: `lambda-src/shared/schedule-logic.js`
- Create: `lambda-src/shared/schedule-logic.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `newScheduleId() → string`
  - `dueFilter(nowIso) → {FilterExpression, ExpressionAttributeValues, ExpressionAttributeNames}`
  - `advanceSchedule(schedule, outcome, nowIso, leadDays) → Decision`

  where `Decision` is `{ disable: boolean, nextRunAt: string | null, spawnRevokeAt: string | null, failureCount: number }`.

- [ ] **Step 1: Write the failing tests**

Create `lambda-src/shared/schedule-logic.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { advanceSchedule } = require('./schedule-logic');

const NOW = '2026-09-05T04:00:00.000Z';

test('a successful once job disables itself', () => {
    const d = advanceSchedule(
        { Kind: 'once', Action: 'revoke', FailureCount: 0 },
        { ok: true }, NOW, 7
    );
    assert.strictEqual(d.disable, true);
    assert.strictEqual(d.nextRunAt, null);
    assert.strictEqual(d.spawnRevokeAt, null);
});

test('a failed once job stays enabled and counts the failure', () => {
    const d = advanceSchedule(
        { Kind: 'once', Action: 'revoke', FailureCount: 2 },
        { ok: false }, NOW, 7
    );
    assert.strictEqual(d.disable, false);
    assert.strictEqual(d.failureCount, 3);
});

test('a once job disables after 5 consecutive failures', () => {
    const d = advanceSchedule(
        { Kind: 'once', Action: 'revoke', FailureCount: 4 },
        { ok: false }, NOW, 7
    );
    assert.strictEqual(d.failureCount, 5);
    assert.strictEqual(d.disable, true);
});

test('autorenew schedules the next run one lead time before the new expiry', () => {
    const d = advanceSchedule(
        { Kind: 'autorenew', Action: 'extend', EndsAt: '2027-06-30T16:00:00.000Z', FailureCount: 0 },
        { ok: true, newExpiration: '2026-12-04T04:49:29+08:00' }, NOW, 7
    );
    // 2026-12-04T04:49:29+08:00 is 2026-11-26T20:49:29Z minus 7 days
    assert.strictEqual(d.nextRunAt, '2026-11-27T20:49:29.000Z');
    assert.strictEqual(d.disable, false);
    assert.strictEqual(d.spawnRevokeAt, null);
});

test('autorenew whose next run would pass EndsAt stops and spawns a revoke at EndsAt', () => {
    const d = advanceSchedule(
        { Kind: 'autorenew', Action: 'extend', EndsAt: '2027-06-30T16:00:00.000Z', FailureCount: 0 },
        { ok: true, newExpiration: '2027-08-10T04:00:00+08:00' }, NOW, 7
    );
    assert.strictEqual(d.disable, true);
    assert.strictEqual(d.spawnRevokeAt, '2027-06-30T16:00:00.000Z');
});

test('a failed autorenew retries without advancing NextRunAt', () => {
    const d = advanceSchedule(
        { Kind: 'autorenew', Action: 'extend', EndsAt: '2027-06-30T16:00:00.000Z', FailureCount: 0 },
        { ok: false }, NOW, 7
    );
    assert.strictEqual(d.nextRunAt, null);
    assert.strictEqual(d.disable, false);
    assert.strictEqual(d.failureCount, 1);
});

test('autorenew past its EndsAt disables without acting again', () => {
    const d = advanceSchedule(
        { Kind: 'autorenew', Action: 'extend', EndsAt: '2026-01-01T00:00:00.000Z', FailureCount: 0 },
        { ok: true, newExpiration: '2026-12-04T04:49:29+08:00' }, NOW, 7
    );
    assert.strictEqual(d.disable, true);
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd /Users/joshua/Downloads/DEV/ICS-Projects/PROD/radius-auth-ssid-ver2/infrastructure/lambda-src
node --test shared/
```

Expected: FAIL — `Cannot find module './schedule-logic'`.

- [ ] **Step 3: Implement**

Create `lambda-src/shared/schedule-logic.js`:

```js
'use strict';

/**
 * Pure scheduling decisions — no AWS calls, no clock reads. Everything the
 * sweeper needs to know about "what happens to this row after it fires".
 *
 * All timestamps in and out are UTC ISO 8601 (Z). NextRunAt is compared as a
 * string in DynamoDB, so a mixed-offset value would sort wrongly and fire at
 * the wrong time.
 */

const { randomUUID } = require('node:crypto');

const MAX_CONSECUTIVE_FAILURES = 5;
const DAY_MS = 86_400_000;

function newScheduleId() {
    return randomUUID();
}

/** DynamoDB Scan filter for rows that are enabled and due. */
function dueFilter(nowIso) {
    return {
        FilterExpression: '#enabled = :true AND #next <= :now',
        ExpressionAttributeNames: { '#enabled': 'Enabled', '#next': 'NextRunAt' },
        ExpressionAttributeValues: { ':true': true, ':now': nowIso },
    };
}

/**
 * @param schedule  the DynamoDB row that just fired
 * @param outcome   {ok: boolean, newExpiration?: string}
 * @param nowIso    UTC ISO 8601
 * @param leadDays  how far before expiry autorenew acts
 * @returns {{disable: boolean, nextRunAt: string|null, spawnRevokeAt: string|null, failureCount: number}}
 */
function advanceSchedule(schedule, outcome, nowIso, leadDays) {
    const prior = Number(schedule.FailureCount ?? 0);

    if (!outcome.ok) {
        const failureCount = prior + 1;
        // Leave NextRunAt in the past so the next tick retries, until the cap.
        return {
            disable: failureCount >= MAX_CONSECUTIVE_FAILURES,
            nextRunAt: null,
            spawnRevokeAt: null,
            failureCount,
        };
    }

    if (schedule.Kind === 'once') {
        return { disable: true, nextRunAt: null, spawnRevokeAt: null, failureCount: 0 };
    }

    // autorenew
    const endsAt = new Date(schedule.EndsAt).getTime();

    if (new Date(nowIso).getTime() >= endsAt) {
        return { disable: true, nextRunAt: null, spawnRevokeAt: null, failureCount: 0 };
    }

    const nextRunMs = new Date(outcome.newExpiration).getTime() - leadDays * DAY_MS;

    if (nextRunMs >= endsAt) {
        // This renewal overshoots the end date. Let it stand so the device keeps
        // working, and hand EndsAt to a one-off revoke so it goes off on time.
        return {
            disable: true,
            nextRunAt: null,
            spawnRevokeAt: new Date(endsAt).toISOString(),
            failureCount: 0,
        };
    }

    return {
        disable: false,
        nextRunAt: new Date(nextRunMs).toISOString(),
        spawnRevokeAt: null,
        failureCount: 0,
    };
}

module.exports = { newScheduleId, dueFilter, advanceSchedule, MAX_CONSECUTIVE_FAILURES };
```

- [ ] **Step 4: Run to verify they pass**

```bash
node --test shared/
```

Expected: PASS, 9 tests (2 from Task 1 + 7 here).

- [ ] **Step 5: Commit**

```bash
git add lambda-src/shared/schedule-logic.js lambda-src/shared/schedule-logic.test.js
git commit -m "feat: add pure schedule advance logic with unit tests"
```

---

### Task 8: Schedules table and sweeper infrastructure

**Files:**
- Create: `lambda-src/sweeper/index.js`
- Create: `schedules.tf`
- Modify: `variables.tf` (append), `outputs.tf` (append), `dashboard-api.tf` (DynamoDB policy)

**Interfaces:**
- Consumes: `setAuthorization` (Task 1); `advanceSchedule`, `dueFilter`, `newScheduleId` (Task 7).
- Produces: table `radius-auth-schedules`; env var `SCHEDULES_TABLE_NAME` on both Lambdas; Terraform output `schedules_table_name`.

> **Prerequisite:** Task 2 Step 5 must be recorded. If Meraki extends from the existing expiry rather than issuing now + 90 days, the `advanceSchedule` tests in Task 7 still hold (they take `newExpiration` as given), but re-check the lead-time default before applying.

- [ ] **Step 1: Write the sweeper handler**

Create `lambda-src/sweeper/index.js`:

```js
'use strict';

/**
 * Schedule Sweeper — runs every 5 minutes on EventBridge.
 *
 * Scans radius-auth-schedules for enabled rows whose NextRunAt has passed,
 * performs each row's action through the same setAuthorization() the dashboard
 * uses, then advances or disables the row.
 *
 * Missed ticks self-heal: the filter is `NextRunAt <= now`, so an outage means
 * late execution, never a skipped one.
 */

const { UpdateCommand, ScanCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { setAuthorization, dynamo }               = require('../shared/meraki');
const { advanceSchedule, dueFilter, newScheduleId } = require('../shared/schedule-logic');

const SCHEDULES_TABLE = process.env.SCHEDULES_TABLE_NAME;
const LEAD_DAYS       = Number(process.env.AUTORENEW_LEAD_DAYS || 7);

async function findDue(nowIso) {
    const items = [];
    let lastKey;
    do {
        const resp = await dynamo.send(new ScanCommand({
            TableName: SCHEDULES_TABLE,
            ExclusiveStartKey: lastKey,
            ...dueFilter(nowIso),
        }));
        if (resp.Items) items.push(...resp.Items);
        lastKey = resp.LastEvaluatedKey;
    } while (lastKey);
    return items;
}

/** Applies a Decision from advanceSchedule to the row, plus any spawned revoke job. */
async function applyDecision(schedule, decision, outcome, nowIso) {
    const sets = ['LastRunAt = :now', 'LastResult = :res', 'FailureCount = :fc'];
    const values = {
        ':now': nowIso,
        ':res': outcome.ok ? 'ok' : (outcome.error ?? 'failed').slice(0, 500),
        ':fc':  decision.failureCount,
        ':one': 1,
    };

    if (decision.disable)         { sets.push('Enabled = :false');   values[':false'] = false; }
    if (decision.nextRunAt)       { sets.push('NextRunAt = :next');   values[':next']  = decision.nextRunAt; }

    await dynamo.send(new UpdateCommand({
        TableName: SCHEDULES_TABLE,
        Key: { ScheduleID: schedule.ScheduleID },
        UpdateExpression: `SET ${sets.join(', ')} ADD RunCount :one`,
        ExpressionAttributeValues: values,
    }));

    if (decision.spawnRevokeAt) {
        await dynamo.send(new PutCommand({
            TableName: SCHEDULES_TABLE,
            Item: {
                ScheduleID:   newScheduleId(),
                Kind:         'once',
                Action:       'revoke',
                ClientID:     schedule.ClientID,
                NextRunAt:    decision.spawnRevokeAt,
                Enabled:      true,
                RunCount:     0,
                FailureCount: 0,
                CreatedAt:    nowIso,
                Note:         `Auto-created: enforces EndsAt of schedule ${schedule.ScheduleID}`,
            },
        }));
        console.log(`Spawned EndsAt revoke for ${schedule.ClientID} at ${decision.spawnRevokeAt}`);
    }
}

async function runOne(schedule, nowIso) {
    let outcome;
    try {
        const result = await setAuthorization(schedule.ClientID, schedule.Action === 'extend');
        outcome = { ok: true, newExpiration: result.newExpiration };
    } catch (e) {
        console.error(`Schedule ${schedule.ScheduleID} failed: ${e.message}`);
        outcome = { ok: false, error: e.message };
    }

    const decision = advanceSchedule(schedule, outcome, nowIso, LEAD_DAYS);
    await applyDecision(schedule, decision, outcome, nowIso);
    return outcome.ok;
}

exports.handler = async () => {
    const nowIso = new Date().toISOString();
    const due    = await findDue(nowIso);

    if (due.length === 0) {
        console.log('No schedules due');
        return { processed: 0 };
    }

    console.log(`Processing ${due.length} due schedule(s)`);
    const results = await Promise.allSettled(due.map(s => runOne(s, nowIso)));

    const ok     = results.filter(r => r.status === 'fulfilled' && r.value).length;
    const failed = due.length - ok;

    console.log(`Sweep complete: ${ok} OK, ${failed} failed`);
    return { processed: due.length, ok, failed };
};
```

- [ ] **Step 2: Add the Terraform variable**

Append to `variables.tf`:

```hcl
variable "schedules_table_name" {
  description = "DynamoDB table name for scheduled authorization actions"
  type        = string
  default     = "radius-auth-schedules"
}

variable "autorenew_lead_days" {
  description = "How many days before expiry an autorenew schedule fires. Primarily retry headroom — a larger value gives more sweeper ticks to recover from an outage before a user is affected."
  type        = number
  default     = 7
}
```

- [ ] **Step 3: Write `schedules.tf`**

Create `schedules.tf`:

```hcl
# ============================================================
# Scheduling — schedules table + sweeper Lambda
#
# One EventBridge rule ticks the sweeper every 5 minutes. The sweeper scans
# for enabled rows whose NextRunAt has passed and acts on each through the
# same shared setAuthorization() the dashboard API uses.
#
# Rows are never deleted — cancelling sets Enabled = false.
# ============================================================

resource "aws_dynamodb_table" "schedules" {
  name         = var.schedules_table_name
  billing_mode = "PAY_PER_REQUEST"

  hash_key = "ScheduleID"

  attribute {
    name = "ScheduleID"
    type = "S"
  }

  # No GSI on Enabled/NextRunAt: at hundreds of rows a filtered Scan costs less
  # than an index and is one less moving part.
  # ponytail: revisit past ~5k schedules — add a GSI on Enabled.

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  tags = {
    Name = var.schedules_table_name
  }
}

# ── IAM: Sweeper Lambda Role ──────────────────────────────

resource "aws_iam_role" "sweeper_lambda_role" {
  name               = "${var.project}-sweeper-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.dashboard_lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "sweeper_basic_execution" {
  role       = aws_iam_role.sweeper_lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_policy" "sweeper_dynamodb" {
  name        = "${var.project}-sweeper-dynamodb"
  description = "Sweeper reads/updates client records and manages schedule rows."

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ClientTableReadUpdate"
        Effect = "Allow"
        Action = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.client_tracking.arn
      },
      {
        Sid    = "SchedulesTableReadWrite"
        Effect = "Allow"
        Action = ["dynamodb:Scan", "dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:PutItem"]
        Resource = aws_dynamodb_table.schedules.arn
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "sweeper_dynamodb" {
  role       = aws_iam_role.sweeper_lambda_role.name
  policy_arn = aws_iam_policy.sweeper_dynamodb.arn
}

resource "aws_iam_role_policy_attachment" "sweeper_secrets" {
  role       = aws_iam_role.sweeper_lambda_role.name
  policy_arn = aws_iam_policy.dashboard_lambda_secrets.arn
}

# ── CloudWatch ────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "sweeper_logs" {
  name              = "/aws/lambda/${var.project}-schedule-sweeper"
  retention_in_days = 30
}

resource "aws_cloudwatch_metric_alarm" "sweeper_errors" {
  alarm_name          = "${var.project}-schedule-sweeper-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "The schedule sweeper is throwing — scheduled renewals and revokes may not be running."
  alarm_actions       = [aws_sns_topic.alarms.arn]

  dimensions = {
    FunctionName = aws_lambda_function.schedule_sweeper.function_name
  }
}

# ── Lambda ────────────────────────────────────────────────

data "archive_file" "sweeper_lambda_zip" {
  type        = "zip"
  output_path = "${path.module}/.terraform/sweeper-lambda-package.zip"

  source {
    content  = file("${path.module}/lambda-src/sweeper/index.js")
    filename = "index.js"
  }

  source {
    content  = file("${path.module}/lambda-src/shared/meraki.js")
    filename = "shared/meraki.js"
  }

  source {
    content  = file("${path.module}/lambda-src/shared/schedule-logic.js")
    filename = "shared/schedule-logic.js"
  }
}

resource "aws_lambda_function" "schedule_sweeper" {
  function_name    = "${var.project}-schedule-sweeper"
  description      = "Runs due scheduled splash-authorization actions every 5 minutes"
  filename         = data.archive_file.sweeper_lambda_zip.output_path
  source_code_hash = data.archive_file.sweeper_lambda_zip.output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs18.x"
  architectures    = ["arm64"]
  role             = aws_iam_role.sweeper_lambda_role.arn
  timeout          = 300 # a sweep may touch many clients, each a Meraki round-trip
  memory_size      = 256

  environment {
    variables = {
      DYNAMODB_TABLE_NAME                 = aws_dynamodb_table.client_tracking.name
      SCHEDULES_TABLE_NAME                = aws_dynamodb_table.schedules.name
      MERAKI_SECRET_ARN                   = aws_secretsmanager_secret.meraki_api_key.arn
      MERAKI_NETWORK_ID                   = var.meraki_network_id
      SSID_MAP                            = var.ssid_map
      AUTORENEW_LEAD_DAYS                 = var.autorenew_lead_days
      AWS_NODEJS_CONNECTION_REUSE_ENABLED = "1"
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.sweeper_basic_execution,
    aws_iam_role_policy_attachment.sweeper_dynamodb,
    aws_iam_role_policy_attachment.sweeper_secrets,
    aws_cloudwatch_log_group.sweeper_logs,
  ]
}

# ── EventBridge: 5-minute tick ────────────────────────────

resource "aws_cloudwatch_event_rule" "sweeper_tick" {
  name                = "${var.project}-schedule-sweeper-tick"
  description         = "Fires the schedule sweeper every 5 minutes"
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_target" "sweeper" {
  rule      = aws_cloudwatch_event_rule.sweeper_tick.name
  target_id = "schedule-sweeper"
  arn       = aws_lambda_function.schedule_sweeper.arn
}

resource "aws_lambda_permission" "sweeper_eventbridge" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.schedule_sweeper.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.sweeper_tick.arn
}
```

- [ ] **Step 4: Give the dashboard Lambda access to the schedules table**

In `dashboard-api.tf`, add a second statement to `aws_iam_policy.dashboard_lambda_dynamodb`:

```hcl
      {
        Sid    = "SchedulesTableReadWrite"
        Effect = "Allow"
        Action = [
          "dynamodb:Scan",
          "dynamodb:GetItem",
          "dynamodb:UpdateItem",
          "dynamodb:PutItem",
        ]
        Resource = aws_dynamodb_table.schedules.arn
      }
```

and add to its `environment.variables`:

```hcl
      SCHEDULES_TABLE_NAME = aws_dynamodb_table.schedules.name
```

- [ ] **Step 5: Add the output**

Append to `outputs.tf`:

```hcl
output "schedules_table_name" {
  description = "DynamoDB table holding scheduled authorization actions"
  value       = aws_dynamodb_table.schedules.name
}
```

- [ ] **Step 6: Plan and apply**

```bash
cd /Users/joshua/Downloads/DEV/ICS-Projects/PROD/radius-auth-ssid-ver2/infrastructure
terraform validate && terraform plan
```

Expected additions: 1 table, 1 Lambda, 1 role, 2 policies + 3 attachments, 1 log group, 1 alarm, 1 event rule, 1 target, 1 permission. Expected changes: the dashboard Lambda (policy + env var). No destroys — if you see one, stop.

```bash
terraform apply
```

- [ ] **Step 7: Verify the sweeper runs clean on an empty table**

```bash
aws lambda invoke --function-name radius-auth-schedule-sweeper /tmp/out.json && cat /tmp/out.json
```

Expected: `{"processed":0}`. Then confirm the tick is live:

```bash
aws logs tail /aws/lambda/radius-auth-schedule-sweeper --since 10m
```

Expected: a "No schedules due" line roughly every 5 minutes.

- [ ] **Step 8: Commit**

```bash
git add lambda-src/sweeper/index.js schedules.tf variables.tf outputs.tf dashboard-api.tf
git commit -m "feat: add schedules table and 5-minute sweeper Lambda"
```

---

### Task 9: Schedule CRUD routes

Validation lives here rather than in the UI: this is the trust boundary, and the sweeper acts unattended on whatever these routes store.

**Files:**
- Create: `lambda-src/shared/validate-schedule.js`
- Create: `lambda-src/shared/validate-schedule.test.js`
- Modify: `lambda-src/dashboard/index.js`, `dashboard-api.tf` (archive + header comment)

**Interfaces:**
- Consumes: `newScheduleId` (Task 7); `dynamo` (Task 1).
- Produces: `validateScheduleInput(body, nowIso) → {ok: true, item} | {ok: false, error}`; routes `GET /schedules`, `POST /schedules`, `DELETE /schedules/{id}`.

- [ ] **Step 1: Write the failing validation tests**

Create `lambda-src/shared/validate-schedule.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validateScheduleInput } = require('./validate-schedule');

const NOW = '2026-09-05T04:00:00.000Z';
const OK = { kind: 'once', action: 'revoke', clientId: 'aa:bb:cc', runAt: '2026-09-06T04:00:00.000Z' };

test('accepts a valid once job and normalises timestamps to UTC', () => {
    const r = validateScheduleInput({ ...OK, runAt: '2026-09-06T12:00:00+08:00' }, NOW);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.item.NextRunAt, '2026-09-06T04:00:00.000Z');
    assert.strictEqual(r.item.Enabled, true);
    assert.strictEqual(r.item.FailureCount, 0);
});

test('rejects an unknown kind', () => {
    const r = validateScheduleInput({ ...OK, kind: 'policy' }, NOW);
    assert.strictEqual(r.ok, false);
});

test('rejects a missing clientId', () => {
    const r = validateScheduleInput({ ...OK, clientId: '' }, NOW);
    assert.strictEqual(r.ok, false);
});

test('rejects a once job scheduled in the past', () => {
    const r = validateScheduleInput({ ...OK, runAt: '2026-09-04T04:00:00.000Z' }, NOW);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /past/i);
});

test('rejects an unparseable timestamp', () => {
    const r = validateScheduleInput({ ...OK, runAt: 'next tuesday' }, NOW);
    assert.strictEqual(r.ok, false);
});

test('requires endsAt on autorenew', () => {
    const r = validateScheduleInput({ kind: 'autorenew', action: 'extend', clientId: 'aa:bb:cc' }, NOW);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /endsAt/i);
});

test('accepts autorenew and sets its first run to now', () => {
    const r = validateScheduleInput(
        { kind: 'autorenew', action: 'extend', clientId: 'aa:bb:cc', endsAt: '2027-06-30T16:00:00.000Z' },
        NOW
    );
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.item.NextRunAt, NOW);
    assert.strictEqual(r.item.Action, 'extend');
});

test('forces autorenew action to extend even if the caller says revoke', () => {
    const r = validateScheduleInput(
        { kind: 'autorenew', action: 'revoke', clientId: 'aa:bb:cc', endsAt: '2027-06-30T16:00:00.000Z' },
        NOW
    );
    assert.strictEqual(r.item.Action, 'extend');
});

test('rejects autorenew whose endsAt has already passed', () => {
    const r = validateScheduleInput(
        { kind: 'autorenew', action: 'extend', clientId: 'aa:bb:cc', endsAt: '2020-01-01T00:00:00.000Z' },
        NOW
    );
    assert.strictEqual(r.ok, false);
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd /Users/joshua/Downloads/DEV/ICS-Projects/PROD/radius-auth-ssid-ver2/infrastructure/lambda-src
node --test shared/
```

Expected: FAIL — `Cannot find module './validate-schedule'`.

- [ ] **Step 3: Implement the validator**

Create `lambda-src/shared/validate-schedule.js`:

```js
'use strict';

/**
 * Validates and normalises schedule-creation input. This is the trust
 * boundary: the sweeper acts unattended on whatever gets stored, so nothing
 * beyond this point re-checks the shape.
 *
 * All timestamps are normalised to UTC ISO 8601 — NextRunAt is compared as a
 * string in DynamoDB, so mixed offsets would sort wrongly.
 */

const { newScheduleId } = require('./schedule-logic');

const KINDS   = new Set(['once', 'autorenew']);
const ACTIONS = new Set(['extend', 'revoke']);
const MAX_NOTE = 500;

function toUtcIso(value) {
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function validateScheduleInput(body, nowIso) {
    const { kind, action, clientId, runAt, endsAt, note } = body ?? {};
    const nowMs = new Date(nowIso).getTime();

    if (!KINDS.has(kind))                       return { ok: false, error: `kind must be one of: ${[...KINDS].join(', ')}` };
    if (!ACTIONS.has(action))                   return { ok: false, error: `action must be one of: ${[...ACTIONS].join(', ')}` };
    if (typeof clientId !== 'string' || !clientId.trim()) return { ok: false, error: 'clientId is required' };
    if (note !== undefined && typeof note !== 'string')   return { ok: false, error: 'note must be a string' };

    const item = {
        ScheduleID:   newScheduleId(),
        Kind:         kind,
        ClientID:     clientId.trim(),
        Enabled:      true,
        RunCount:     0,
        FailureCount: 0,
        CreatedAt:    nowIso,
    };
    if (note) item.Note = note.slice(0, MAX_NOTE);

    if (kind === 'once') {
        const at = toUtcIso(runAt);
        if (!at)                  return { ok: false, error: 'runAt must be a valid timestamp' };
        if (new Date(at).getTime() <= nowMs) return { ok: false, error: 'runAt is in the past' };
        item.Action    = action;
        item.NextRunAt = at;
        return { ok: true, item };
    }

    // autorenew: always an extend, always bounded, first check immediately
    const ends = toUtcIso(endsAt);
    if (!ends)                    return { ok: false, error: 'endsAt is required for autorenew and must be a valid timestamp' };
    if (new Date(ends).getTime() <= nowMs) return { ok: false, error: 'endsAt is in the past' };
    item.Action    = 'extend';
    item.EndsAt    = ends;
    item.NextRunAt = nowIso;
    return { ok: true, item };
}

module.exports = { validateScheduleInput };
```

- [ ] **Step 4: Run to verify they pass**

```bash
node --test shared/
```

Expected: PASS, 18 tests total.

- [ ] **Step 5: Add the routes to the handler**

In `lambda-src/dashboard/index.js`, extend the requires:

```js
const { ScanCommand, PutCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { dynamo }                                 = require('../shared/meraki');
const { validateScheduleInput }                  = require('../shared/validate-schedule');

const SCHEDULES_TABLE = process.env.SCHEDULES_TABLE_NAME;
```

Add before the final `return notFound();`:

```js
        // ── GET /schedules ────────────────────────────────────────────────────
        if (method === 'GET' && rawPath === '/schedules') {
            const items = [];
            let lastKey;
            do {
                const resp = await dynamo.send(new ScanCommand({
                    TableName: SCHEDULES_TABLE,
                    ExclusiveStartKey: lastKey,
                }));
                if (resp.Items) items.push(...resp.Items);
                lastKey = resp.LastEvaluatedKey;
            } while (lastKey);

            // Newest first — the list is a log of what someone set up.
            items.sort((a, b) => String(b.CreatedAt ?? '').localeCompare(String(a.CreatedAt ?? '')));
            return ok(items);
        }

        // ── POST /schedules ───────────────────────────────────────────────────
        if (method === 'POST' && rawPath === '/schedules') {
            const body = typeof event.body === 'string'
                ? JSON.parse(event.body)
                : (event.body ?? {});

            const result = validateScheduleInput(body, new Date().toISOString());
            if (!result.ok) return clientError(result.error);

            await dynamo.send(new PutCommand({
                TableName: SCHEDULES_TABLE,
                Item: result.item,
            }));

            console.log(`Created ${result.item.Kind} schedule ${result.item.ScheduleID} for ${result.item.ClientID}`);
            return ok(result.item);
        }

        // ── DELETE /schedules/{scheduleId} ────────────────────────────────────
        const scheduleMatch = rawPath.match(/^\/schedules\/([^/]+)$/);
        if (method === 'DELETE' && scheduleMatch) {
            const scheduleId = decodeURIComponent(scheduleMatch[1]);
            // Cancel means disable — rows are never deleted.
            await dynamo.send(new UpdateCommand({
                TableName: SCHEDULES_TABLE,
                Key: { ScheduleID: scheduleId },
                UpdateExpression: 'SET Enabled = :false, LastResult = :res',
                ExpressionAttributeValues: { ':false': false, ':res': 'cancelled' },
            }));
            console.log(`Cancelled schedule: ${scheduleId}`);
            return ok({ success: true, scheduleId });
        }
```

- [ ] **Step 6: Add the validator to the dashboard zip**

In `dashboard-api.tf`, add two more `source` blocks to `data.archive_file.dashboard_lambda_zip`:

```hcl
  source {
    content  = file("${path.module}/lambda-src/shared/schedule-logic.js")
    filename = "shared/schedule-logic.js"
  }

  source {
    content  = file("${path.module}/lambda-src/shared/validate-schedule.js")
    filename = "shared/validate-schedule.js"
  }
```

Also append the three schedule routes to the header comment block.

- [ ] **Step 7: Apply and exercise the round-trip**

```bash
terraform apply
API=$(terraform output -raw dashboard_api_url)

# Rejected — bad kind
curl -s -X POST "$API/schedules" -H 'Content-Type: application/json' \
  -d '{"kind":"policy","action":"revoke","clientId":"x","runAt":"2027-01-01T00:00:00Z"}' | jq

# Accepted — a revoke two minutes out on a throwaway client
curl -s -X POST "$API/schedules" -H 'Content-Type: application/json' \
  -d "{\"kind\":\"once\",\"action\":\"revoke\",\"clientId\":\"<THROWAWAY_ID>\",\"runAt\":\"$(date -u -v+2M +%Y-%m-%dT%H:%M:%SZ)\"}" | jq

curl -s "$API/schedules" | jq
```

Expected: a 400 with the kind error; then a created row; then it listed. Wait ~5 minutes and confirm via `aws logs tail /aws/lambda/radius-auth-schedule-sweeper --since 10m` that the sweeper ran it and the row's `Enabled` is now `false`.

- [ ] **Step 8: Commit**

```bash
git add lambda-src/shared/validate-schedule.js lambda-src/shared/validate-schedule.test.js lambda-src/dashboard/index.js dashboard-api.tf
git commit -m "feat: add schedule CRUD routes with input validation"
```

---

### Task 10: Schedule types and server actions

**Files:**
- Modify: `lib/types.ts`, `app/actions.ts`

**Interfaces:**
- Consumes: the three routes from Task 9.
- Produces: `Schedule`, `ScheduleKind`, `ScheduleAction`, `CreateScheduleInput`; `getSchedules()`, `createSchedule(input)`, `cancelSchedule(id)`.

- [ ] **Step 1: Add the types**

Append to `lib/types.ts`:

```ts
export type ScheduleKind = 'once' | 'autorenew';
export type ScheduleAction = 'extend' | 'revoke';

export interface Schedule {
  ScheduleID: string;
  Kind: ScheduleKind;
  Action: ScheduleAction;
  ClientID: string;
  /** UTC ISO 8601. */
  NextRunAt: string;
  /** UTC ISO 8601. Present on autorenew only. */
  EndsAt?: string;
  Enabled: boolean;
  RunCount?: number;
  FailureCount?: number;
  LastRunAt?: string;
  LastResult?: string;
  CreatedAt?: string;
  Note?: string;
}

export interface CreateScheduleInput {
  kind: ScheduleKind;
  action: ScheduleAction;
  clientId: string;
  /** Required for `once`. UTC ISO 8601. */
  runAt?: string;
  /** Required for `autorenew`. UTC ISO 8601. */
  endsAt?: string;
  note?: string;
}
```

- [ ] **Step 2: Add the server actions**

Append to `app/actions.ts` (extending the type import with `CreateScheduleInput` and `Schedule`):

```ts
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
```

- [ ] **Step 3: Typecheck and commit**

```bash
cd /Users/joshua/Downloads/DEV/ICS-Projects/PROD/WIFI_CLIENT_EXTEND_DASHBOARD_V2
npx tsc --noEmit
git add lib/types.ts app/actions.ts
git commit -m "feat: add schedule types and server actions"
```

---

### Task 11: Schedule dialog and row badge

**Files:**
- Create: `components/ScheduleDialog.tsx`
- Modify: `components/ClientsTable.tsx`

**Interfaces:**
- Consumes: `createSchedule`, `getSchedules` (Task 10).
- Produces: `<ScheduleDialog client onClose onCreated />`.

Note on time zones: `<input type="datetime-local">` yields a *local* wall-clock string with no offset. `new Date(local).toISOString()` interprets it in the browser's zone, which for your users is SGT — the right behaviour. Do not append a `Z`.

- [ ] **Step 1: Write the dialog**

Create `components/ScheduleDialog.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { createSchedule } from '@/app/actions';
import type { Client, ScheduleKind, ScheduleAction } from '@/lib/types';

/** Local datetime-local value (browser zone) → UTC ISO 8601. */
function toUtc(local: string): string {
  return new Date(local).toISOString();
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
```

- [ ] **Step 2: Wire it into the table**

In `components/ClientsTable.tsx`:

Add imports — `ScheduleDialog` and `getSchedules as getSchedulesAction`.

Add state and a load effect beside the other state:

```tsx
  const [scheduleFor, setScheduleFor] = useState<Client | null>(null);
  const [scheduledIds, setScheduledIds] = useState<Set<string>>(new Set());

  const loadSchedules = useCallback(async () => {
    try {
      const rows = await getSchedulesAction();
      setScheduledIds(new Set(rows.filter((r) => r.Enabled).map((r) => r.ClientID)));
    } catch {
      // A schedule-badge failure must not break the table.
    }
  }, []);

  useEffect(() => {
    loadSchedules();
  }, [loadSchedules]);
```

Add `hasSchedule: boolean` and `onSchedule: (c: Client) => void` to `RowProps`, destructure them in `ClientRow`, and render a badge next to `<StatusBadge>`:

```tsx
        {hasSchedule && (
          <span
            title="This client has an active schedule"
            className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-50 text-indigo-700 border border-indigo-200"
          >
            ⏱ Scheduled
          </span>
        )}
```

and a button in the action cell, after Revoke:

```tsx
          <button
            type="button"
            onClick={() => onSchedule(client)}
            disabled={isLoading}
            className="inline-flex items-center px-3 py-1.5 rounded-md text-xs font-medium text-indigo-700 border border-indigo-200 hover:bg-indigo-50 disabled:opacity-40 transition-colors"
          >
            Schedule
          </button>
```

Pass at the call site: `hasSchedule={scheduledIds.has(c.ClientID)}` and `onSchedule={setScheduleFor}`.

Render the dialog just before the closing `</div>` of the component:

```tsx
      {scheduleFor && (
        <ScheduleDialog
          client={scheduleFor}
          onClose={() => setScheduleFor(null)}
          onCreated={(m) => {
            showToast('success', m);
            loadSchedules();
          }}
        />
      )}
```

- [ ] **Step 3: Verify in the browser**

```bash
npx tsc --noEmit && npm run dev
```

Confirm: the dialog opens, the third option swaps the input to a date picker, a past time is rejected with the Lambda's message, and on success the row gains a ⏱ Scheduled badge without a reload.

- [ ] **Step 4: Commit**

```bash
git add components/ScheduleDialog.tsx components/ClientsTable.tsx
git commit -m "feat: add schedule dialog and scheduled badge"
```

---

### Task 12: Schedules page

**Files:**
- Create: `app/schedules/page.tsx`, `components/SchedulesList.tsx`
- Modify: `app/page.tsx` (nav link)

**Interfaces:**
- Consumes: `getSchedules`, `cancelSchedule` (Task 10).
- Produces: nothing downstream. Final task.

- [ ] **Step 1: Write the list component**

Create `components/SchedulesList.tsx`:

```tsx
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

  const visible = showDone ? rows : rows.filter((r) => r.Enabled);

  async function cancel(id: string) {
    setBusy(id);
    try {
      await cancelSchedule(id);
      setRows((p) =>
        p.map((r) => (r.ScheduleID === id ? { ...r, Enabled: false, LastResult: 'cancelled' } : r))
      );
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
```

- [ ] **Step 2: Write the page**

Create `app/schedules/page.tsx`, mirroring the error handling in `app/page.tsx`:

```tsx
import Link from 'next/link';
import { getSchedules } from '../actions';
import SchedulesList from '@/components/SchedulesList';
import type { Schedule } from '@/lib/types';

export const revalidate = 0;

export default async function SchedulesPage() {
  let schedules: Schedule[] = [];
  let fetchError: string | null = null;

  try {
    schedules = await getSchedules();
  } catch (err) {
    fetchError = err instanceof Error ? err.message : 'Failed to load schedules.';
  }

  return (
    <main className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-screen-xl mx-auto">
          <h1 className="text-xl font-semibold text-gray-900">Schedules</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Pending and past scheduled actions ·{' '}
            <Link href="/" className="text-blue-600 hover:text-blue-800">
              Back to clients
            </Link>
          </p>
        </div>
      </header>

      <div className="max-w-screen-xl mx-auto px-6 py-6">
        {fetchError ? (
          <div className="bg-red-50 border border-red-200 rounded-lg px-5 py-4 text-sm text-red-700">
            <strong className="font-medium">Could not load schedules:</strong> {fetchError}
          </div>
        ) : (
          <SchedulesList initial={schedules} />
        )}
      </div>
    </main>
  );
}
```

- [ ] **Step 3: Link it from the dashboard header**

In `app/page.tsx`, add `import Link from 'next/link';` and change the subtitle paragraph to:

```tsx
          <p className="text-sm text-gray-500 mt-0.5">
            Meraki splash page authorization manager ·{' '}
            <Link href="/schedules" className="text-blue-600 hover:text-blue-800">
              Schedules
            </Link>
          </p>
```

- [ ] **Step 4: Full verification**

```bash
npx tsc --noEmit && npm run build && npm run dev
```

Walk the whole feature: create a one-off revoke a few minutes out, see it on `/schedules` with "Not run yet", wait for the sweeper, refresh and confirm `LastResult: ok` with the client now expired on the dashboard. Then create an auto-renew, cancel it, and confirm it greys out.

- [ ] **Step 5: Deploy and commit**

```bash
npm run deploy
git add app/schedules/page.tsx components/SchedulesList.tsx app/page.tsx
git commit -m "feat: add schedules page with cancel"
```

---

## Done

Verify against the spec: revoke (single + bulk) live behind Cloudflare Access; schedules table swept every 5 minutes; one-off extend/revoke and bounded auto-renew with automatic `EndsAt` enforcement; 18 unit tests over the pure logic.
