import type { Completeness, Diagnostic } from './common.js';
import {
  GUID_PATTERN,
  LOCALE_PATTERN,
  OPERATION_ID_PATTERN,
  SHA256_PATTERN,
  UNIQUE_NAME_PATTERN,
} from './patterns.js';
import { REASON_CODES, type ReasonCode } from './reasonCodes.js';
import { arr, int, lit, nullable, obj, str, type Schema } from './schema.js';
import { observedFunctionSchema, type EnvironmentClass, type ObservedFunction, type SourceNormalization } from './snapshot.js';
import type { LogicalNameRef, ParameterSpec, SpecKind } from './spec.js';
import type { TargetIdentity } from './target.js';

export const PLAN_SCHEMA_VERSION = 'adapter.plan/v1';
export const PLAN_ID_VERSION = 'adapter.planid/v1';
export const PLANNER_ID = 'dv-native.planner';
/** Proposed initial approval TTL (30 minutes); bounded by policy and evidence validity. */
export const MAX_APPROVAL_TTL_SECONDS = 1800;

export type ChangeImpact = 'non-breaking' | 'breaking' | 'unknown';
export type ObservedStatus = 'present' | 'absent' | 'unknown' | 'ambiguous';

export type PlanOperationKind =
  | 'function.create'
  | 'function.signature.change'
  | 'function.update.source'
  | 'function.update.metadata'
  | 'function.solution.associate';

export const OPERATION_EFFECTS = [
  'callers-may-break',
  'definition-created',
  'definition-persisted',
  'may-activate-behavior',
  'may-initialize-connector-authentication',
  'metadata-persisted',
  'server-derived-state-recomputed',
  'signature-changed',
  'solution-membership-changed',
] as const;
export type OperationEffect = (typeof OPERATION_EFFECTS)[number];

export interface PlanChange {
  path: string;
  change: 'added' | 'removed' | 'modified';
  impact: ChangeImpact;
  reasonCode: ReasonCode | null;
}

export interface PlanOperation {
  id: string;
  kind: PlanOperationKind;
  status: 'blocked';
  reasonCodes: ReasonCode[];
  effects: OperationEffect[];
  preconditions: string[];
  dependsOn: string[];
}

export interface PlanPrecondition {
  id: string;
  status: 'unmet' | 'unknown';
  reasonCode: ReasonCode;
}

export interface DesiredProjection {
  kind: SpecKind;
  uniqueName: string;
  displayName: string;
  binding: 'unbound';
  solution: { uniqueName: string; publisherPrefix: string };
  parameters: ParameterSpec[];
  formula: { sha256: string; normalization: SourceNormalization; dialect: string; locale: string };
  tableReferences: LogicalNameRef[];
  connectionReferences: LogicalNameRef[];
}

export interface Plan {
  schemaVersion: typeof PLAN_SCHEMA_VERSION;
  canonicalizationVersion: string;
  planner: { id: typeof PLANNER_ID; version: string };
  planState: 'draft';
  executionReadiness: 'blocked';
  approvalEligible: false;
  maxApprovalTtlSeconds: number;
  target: {
    expected: TargetIdentity | null;
    observed: TargetIdentity | null;
    fingerprint: string | null;
    expectedEnvironmentClass: 'sandbox' | null;
    claimedEnvironmentClass: EnvironmentClass | null;
    effectiveEnvironmentClass: 'unknown';
    classificationReason: ReasonCode;
  };
  principal: { fingerprint: string | null; status: 'unresolved' };
  policy: { id: string; fingerprint: string };
  provider: { id: string; version: string };
  capabilities: { profileId: string; fingerprint: string };
  evidence: {
    specSha256: string;
    snapshotSha256: string | null;
    snapshotSource: 'synthetic' | 'manual' | 'live-read' | null;
    snapshotAcquiredAt: string | null;
    completeness: Completeness;
    evidenceFingerprints: string[];
  };
  desired: { sourceSha256: string; projection: DesiredProjection };
  observed: { status: ObservedStatus; projection: ObservedFunction | null };
  changes: PlanChange[];
  operations: PlanOperation[];
  preconditions: PlanPrecondition[];
  verification: { strategy: 'read-back'; invokesFunction: false; checks: string[]; status: 'unproven' };
  blockingReasons: ReasonCode[];
  diagnostics: Diagnostic[];
  planId: string;
  planHash: string;
}

const sha = () => str({ pattern: SHA256_PATTERN });
const reasonCode = () => str({ enum: REASON_CODES });
const targetIdentitySchema = obj({
  tenantId: str({ pattern: GUID_PATTERN }),
  environmentId: str({ pattern: GUID_PATTERN }),
  organizationId: str({ pattern: GUID_PATTERN }),
  organizationUrl: str({ minLength: 9, maxLength: 256 }),
});
const logicalNameRefs = arr(obj({ logicalName: str({ pattern: /^[a-z][a-z0-9_]{0,63}$/ }) }), { maxItems: 50 });

export const diagnosticSchema: Schema = obj(
  {
    code: reasonCode(),
    severity: str({ enum: ['error', 'warning', 'info'] }),
    phase: str({ enum: ['schema', 'policy', 'metadata-bindings', 'host', 'preflight', 'read-back', 'integrity', 'approval'] }),
    path: str({ maxLength: 512 }),
    message: str({ maxLength: 1000 }),
  },
  ['path'],
);

export const planSchema: Schema = obj({
  schemaVersion: lit(PLAN_SCHEMA_VERSION, 'SCHEMA_VERSION_UNSUPPORTED'),
  canonicalizationVersion: lit('adapter.c14n/v1', 'SCHEMA_VERSION_UNSUPPORTED'),
  planner: obj({ id: lit(PLANNER_ID), version: str({ pattern: /^\d+\.\d+\.\d+$/ }) }),
  planState: str({ enum: ['draft'] }),
  executionReadiness: str({ enum: ['blocked'] }),
  approvalEligible: lit(false),
  maxApprovalTtlSeconds: int({ min: 1, max: MAX_APPROVAL_TTL_SECONDS }),
  target: obj({
    expected: nullable(targetIdentitySchema),
    observed: nullable(targetIdentitySchema),
    fingerprint: nullable(sha()),
    expectedEnvironmentClass: nullable(str({ enum: ['sandbox'] })),
    claimedEnvironmentClass: nullable(str({ enum: ['sandbox', 'production', 'unknown'] })),
    effectiveEnvironmentClass: str({ enum: ['unknown'] }),
    classificationReason: reasonCode(),
  }),
  principal: obj({ fingerprint: nullable(sha()), status: str({ enum: ['unresolved'] }) }),
  policy: obj({ id: str({ maxLength: 64 }), fingerprint: sha() }),
  provider: obj({ id: str({ maxLength: 64 }), version: str({ maxLength: 32 }) }),
  capabilities: obj({ profileId: str({ maxLength: 64 }), fingerprint: sha() }),
  evidence: obj({
    specSha256: sha(),
    snapshotSha256: nullable(sha()),
    snapshotSource: nullable(str({ enum: ['synthetic', 'manual', 'live-read'] })),
    snapshotAcquiredAt: nullable(str({ timestamp: true })),
    completeness: str({ enum: ['complete', 'partial', 'unknown'] }),
    evidenceFingerprints: arr(sha(), { maxItems: 100 }),
  }),
  desired: obj({
    sourceSha256: sha(),
    projection: obj({
      kind: str({ enum: ['function', 'automated'] }),
      uniqueName: str({ pattern: UNIQUE_NAME_PATTERN }),
      displayName: str({ minLength: 1, maxLength: 100 }),
      binding: str({ enum: ['unbound'] }),
      solution: obj({ uniqueName: str({ maxLength: 64 }), publisherPrefix: str({ maxLength: 8 }) }),
      parameters: arr(obj({ name: str({ maxLength: 100 }), direction: str({ enum: ['input', 'output'] }), type: str({ maxLength: 64 }) }), {
        maxItems: 64,
      }),
      formula: obj({
        sha256: sha(),
        normalization: str({ enum: ['lf', 'none'] }),
        dialect: str({ maxLength: 64 }),
        locale: str({ pattern: LOCALE_PATTERN }),
      }),
      tableReferences: logicalNameRefs,
      connectionReferences: logicalNameRefs,
    }),
  }),
  observed: obj({
    status: str({ enum: ['present', 'absent', 'unknown', 'ambiguous'] }),
    projection: nullable(observedFunctionSchema),
  }),
  changes: arr(
    obj({
      path: str({ maxLength: 256 }),
      change: str({ enum: ['added', 'removed', 'modified'] }),
      impact: str({ enum: ['non-breaking', 'breaking', 'unknown'] }),
      reasonCode: nullable(reasonCode()),
    }),
    { maxItems: 200 },
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
      status: str({ enum: ['blocked'] }),
      reasonCodes: arr(reasonCode(), { minItems: 1, maxItems: 50 }),
      effects: arr(str({ enum: OPERATION_EFFECTS }), { maxItems: 20 }),
      preconditions: arr(str({ maxLength: 64 }), { maxItems: 50 }),
      dependsOn: arr(str({ pattern: OPERATION_ID_PATTERN }), { maxItems: 20 }),
    }),
    { maxItems: 20 },
  ),
  preconditions: arr(
    obj({ id: str({ maxLength: 64 }), status: str({ enum: ['unmet', 'unknown'] }), reasonCode: reasonCode() }),
    { maxItems: 50 },
  ),
  verification: obj({
    strategy: str({ enum: ['read-back'] }),
    invokesFunction: lit(false),
    checks: arr(str({ maxLength: 64 }), { maxItems: 20 }),
    status: str({ enum: ['unproven'] }),
  }),
  blockingReasons: arr(reasonCode(), { minItems: 1, maxItems: 100 }),
  diagnostics: arr(diagnosticSchema, { maxItems: 500 }),
  planId: sha(),
  planHash: sha(),
});
