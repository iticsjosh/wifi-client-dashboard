/** Public types shared between server actions and client components. */

export interface Client {
  ClientID: string;
  ClientName?: string;
  MacAddress?: string;
  SSID?: string;
  ClientIP?: string;
  ConnectionTimestamp?: string;
  ExpirationTimestamp?: string;
  LastUpdated?: string;
  LastRenewed?: string;
  ConnectionCount?: number;
  RenewalCount?: number;
  RevokedAt?: string;
  RevokeCount?: number;
  MerakiClientID?: string;
}

export interface ExtendResult {
  newExpiration?: string;
  lastRenewed?: string;
  error?: string;
}

export interface BulkExtendResponse {
  succeeded?: Array<{ clientId: string; newExpiration: string }>;
  failed?: Array<{ clientId: string; error?: string }>;
}

export interface BulkDeleteResponse {
  succeeded?: string[];
  failed?: Array<{ clientId: string; error?: string }>;
}

export interface RevokeResult {
  clientId: string;
  revokedAt?: string;
  error?: string;
}

export interface BulkRevokeResponse {
  succeeded?: Array<{ clientId: string; revokedAt: string }>;
  failed?: Array<{ clientId: string; error?: string }>;
}

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
