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
