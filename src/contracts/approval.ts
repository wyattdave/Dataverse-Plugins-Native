import { GUID_PATTERN, OPERATION_ID_PATTERN, SHA256_PATTERN } from './patterns.js';
import { OPERATION_EFFECTS, type OperationEffect, type PlanOperationKind } from './plan.js';
import { arr, isPlainObject, lit, nullable, obj, str, type Schema } from './schema.js';
import type { TargetIdentity } from './target.js';

export const APPROVAL_SCHEMA_VERSION = 'adapter.approval/v1';

/**
 * Detached approval envelope. It references one exact planHash; issuance and expiry live here,
 * never inside the semantic plan hash.
 */
export interface ApprovalEnvelope {
  schemaVersion: typeof APPROVAL_SCHEMA_VERSION;
  planId: string;
  planHash: string;
  target: TargetIdentity | null;
  operations: { id: string; kind: PlanOperationKind; effects: OperationEffect[] }[];
  approver: { fingerprint: string };
  principal: { fingerprint: string | null };
  issuedAt: string;
  expiresAt: string;
  approvalHash: string;
}

const sha = () => str({ pattern: SHA256_PATTERN });

export const approvalSchema: Schema = obj({
  schemaVersion: lit(APPROVAL_SCHEMA_VERSION, 'SCHEMA_VERSION_UNSUPPORTED'),
  planId: sha(),
  planHash: sha(),
  target: nullable(
    obj({
      tenantId: str({ pattern: GUID_PATTERN }),
      environmentId: str({ pattern: GUID_PATTERN }),
      organizationId: str({ pattern: GUID_PATTERN }),
      organizationUrl: str({ minLength: 9, maxLength: 256 }),
    }),
  ),
  operations: arr(
    obj({
      id: str({ pattern: OPERATION_ID_PATTERN }),
      kind: str({
        enum: [
          'function.create',
          'function.signature.change',
          'function.update.source',
          'function.update.metadata',
          'function.solution.associate',
        ],
      }),
      effects: arr(str({ enum: OPERATION_EFFECTS }), { maxItems: 20 }),
    }),
    {
      minItems: 1,
      maxItems: 20,
      unique: { key: (item) => (isPlainObject(item) ? String(item['id']) : JSON.stringify(item)), code: 'AMBIGUOUS_IDENTIFIER' },
    },
  ),
  approver: obj({ fingerprint: sha() }),
  principal: obj({ fingerprint: nullable(sha()) }),
  issuedAt: str({ timestamp: true }),
  expiresAt: str({ timestamp: true }),
  approvalHash: sha(),
});
