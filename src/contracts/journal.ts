import { GUID_PATTERN, OPERATION_ID_PATTERN, SHA256_PATTERN } from './patterns.js';
import { arr, int, lit, nullable, obj, str, type Schema } from './schema.js';

export const JOURNAL_SCHEMA_VERSION = 'adapter.journal/v1';
export const LEASE_SCHEMA_VERSION = 'adapter.lease/v1';

/**
 * Journal entry states. An entry is written durably *before* dispatch ("dispatching"), so a crash
 * after that point means the operation may have executed.
 */
export type JournalState = 'prepared' | 'dispatching' | 'completed' | 'failed-definite' | 'outcome-unknown';

export interface JournalEntry {
  sequence: number;
  operationId: string;
  state: JournalState;
  requestSha256: string | null;
  recordIds: string[];
  concurrencyToken: string | null;
  recordedAt: string;
}

/** Journals hold identifiers, hashes, and concurrency values only, never code bodies or business data. */
export interface Journal {
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  runId: string;
  target: { tenantId: string; environmentId: string; organizationId: string };
  planHash: string;
  entries: JournalEntry[];
  entriesSha256: string;
}

export interface Lease {
  schemaVersion: typeof LEASE_SCHEMA_VERSION;
  scopeKey: string;
  owner: string;
  runId: string;
  acquiredAt: string;
  expiresAt: string;
}

export const journalSchema: Schema = obj({
  schemaVersion: lit(JOURNAL_SCHEMA_VERSION, 'SCHEMA_VERSION_UNSUPPORTED'),
  runId: str({ pattern: GUID_PATTERN }),
  target: obj({
    tenantId: str({ pattern: GUID_PATTERN }),
    environmentId: str({ pattern: GUID_PATTERN }),
    organizationId: str({ pattern: GUID_PATTERN }),
  }),
  planHash: str({ pattern: SHA256_PATTERN }),
  entries: arr(
    obj({
      sequence: int({ min: 1, max: 1_000_000 }),
      operationId: str({ pattern: OPERATION_ID_PATTERN }),
      state: str({ enum: ['prepared', 'dispatching', 'completed', 'failed-definite', 'outcome-unknown'] }),
      requestSha256: nullable(str({ pattern: SHA256_PATTERN })),
      recordIds: arr(str({ pattern: GUID_PATTERN }), { maxItems: 20 }),
      concurrencyToken: nullable(str({ minLength: 1, maxLength: 128, pattern: /^[\x21-\x7e]+$/ })),
      recordedAt: str({ timestamp: true }),
    }),
    { maxItems: 10_000 },
  ),
  entriesSha256: str({ pattern: SHA256_PATTERN }),
});

export const leaseSchema: Schema = obj({
  schemaVersion: lit(LEASE_SCHEMA_VERSION, 'SCHEMA_VERSION_UNSUPPORTED'),
  scopeKey: str({ minLength: 1, maxLength: 512 }),
  owner: str({ minLength: 1, maxLength: 128 }),
  runId: str({ pattern: GUID_PATTERN }),
  acquiredAt: str({ timestamp: true }),
  expiresAt: str({ timestamp: true }),
});
