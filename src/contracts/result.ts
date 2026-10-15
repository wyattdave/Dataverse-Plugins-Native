import type { Completeness, Diagnostic, JsonValue, ResultStatus, ValidationPhase } from './common.js';
import { SHA256_PATTERN } from './patterns.js';
import { diagnosticSchema } from './plan.js';
import { REASON_CODES, type ReasonCode } from './reasonCodes.js';
import { arr, int, lit, nullable, obj, opaque, str, type Schema } from './schema.js';

export const RESULT_SCHEMA_VERSION = 'adapter.result/v1';

export type OperationOutcomeStatus = 'blocked' | 'not-started' | 'completed' | 'failed' | 'outcome_unknown';

export interface OperationOutcome {
  operationId: string;
  kind: string;
  status: OperationOutcomeStatus;
  dispatched: boolean;
  reasonCodes: ReasonCode[];
}

export interface CommandResult {
  schemaVersion: typeof RESULT_SCHEMA_VERSION;
  command: string;
  status: ResultStatus;
  exitCode: number;
  reasonCodes: ReasonCode[];
  executionReadiness: 'blocked';
  planId: string | null;
  planHash: string | null;
  validation: ValidationPhase[];
  operations: OperationOutcome[];
  journalReference: string | null;
  runId: string;
  generatedAt: string;
  tool: { name: string; version: string };
  target: { fingerprint: string | null; effectiveEnvironmentClass: 'unknown' };
  principal: { fingerprint: string | null; status: 'unresolved' };
  completeness: Completeness | 'not-applicable';
  capabilityFingerprint: string;
  diagnostics: Diagnostic[];
  data: JsonValue | null;
}

const reasonCode = () => str({ enum: REASON_CODES });

export const resultSchema: Schema = obj({
  schemaVersion: lit(RESULT_SCHEMA_VERSION, 'SCHEMA_VERSION_UNSUPPORTED'),
  command: str({ pattern: /^[a-z]+( [a-z]+)?$/ }),
  status: str({ enum: ['succeeded', 'blocked', 'failed', 'partial', 'outcome_unknown'] }),
  exitCode: int({ min: 0, max: 5 }),
  reasonCodes: arr(reasonCode(), { maxItems: 200 }),
  executionReadiness: str({ enum: ['blocked'] }),
  planId: nullable(str({ pattern: SHA256_PATTERN })),
  planHash: nullable(str({ pattern: SHA256_PATTERN })),
  validation: arr(
    obj(
      {
        phase: str({ enum: ['schema', 'policy', 'metadata-bindings', 'host', 'preflight', 'read-back', 'integrity', 'approval'] }),
        status: str({ enum: ['passed', 'failed', 'skipped', 'unknown'] }),
        reason: reasonCode(),
      },
      ['reason'],
    ),
    { maxItems: 20 },
  ),
  operations: arr(
    obj({
      operationId: str({ maxLength: 64 }),
      kind: str({ maxLength: 64 }),
      status: str({ enum: ['blocked', 'not-started', 'completed', 'failed', 'outcome_unknown'] }),
      dispatched: { t: 'boolean' },
      reasonCodes: arr(reasonCode(), { maxItems: 50 }),
    }),
    { maxItems: 100 },
  ),
  journalReference: nullable(str({ maxLength: 512 })),
  runId: str({ pattern: /^[0-9a-f-]{36}$/ }),
  generatedAt: str({ timestamp: true }),
  tool: obj({ name: str({ maxLength: 64 }), version: str({ maxLength: 32 }) }),
  target: obj({ fingerprint: nullable(str({ pattern: SHA256_PATTERN })), effectiveEnvironmentClass: str({ enum: ['unknown'] }) }),
  principal: obj({ fingerprint: nullable(str({ pattern: SHA256_PATTERN })), status: str({ enum: ['unresolved'] }) }),
  completeness: str({ enum: ['complete', 'partial', 'unknown', 'not-applicable'] }),
  capabilityFingerprint: str({ pattern: SHA256_PATTERN }),
  diagnostics: arr(diagnosticSchema, { maxItems: 1000 }),
  data: opaque(),
});
