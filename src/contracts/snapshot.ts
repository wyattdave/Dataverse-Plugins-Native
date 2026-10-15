import type { JsonValue } from './common.js';
import {
  DISPLAY_NAME_PATTERN,
  EVIDENCE_ID_PATTERN,
  GUID_PATTERN,
  LOCALE_PATTERN,
  LOGICAL_NAME_PATTERN,
  PARAMETER_NAME_PATTERN,
  SHA256_PATTERN,
  SOLUTION_UNIQUE_NAME_PATTERN,
  UNIQUE_NAME_PATTERN,
} from './patterns.js';
import { arr, isPlainObject, lit, nullable, obj, str, type Schema } from './schema.js';

export const SNAPSHOT_SCHEMA_VERSION = 'adapter.snapshot/v1';
export const PROJECTION_VERSION = 'adapter.projection/v1';
export const MAX_SNAPSHOT_COMPONENTS = 200;

export type EnvironmentClass = 'sandbox' | 'production' | 'unknown';
export type ClassificationSource = 'unknown' | 'asserted' | 'authenticated-discovery';
export type ManagedState = 'unmanaged' | 'managed' | 'unknown';
export type SourceNormalization = 'lf' | 'none';

/** Adapter-owned projection of one observed Function. Formula bodies are represented by hash only. */
export interface ObservedFunction {
  kind: 'function';
  uniqueName: string;
  displayName: string;
  binding: 'unbound' | 'bound' | 'unknown';
  managedState: ManagedState;
  solutions: string[];
  parameters: { name: string; direction: 'input' | 'output'; type: string }[];
  formula: { sha256: string; normalization: SourceNormalization; dialect: string; locale: string } | null;
  tableReferences: { logicalName: string }[] | null;
  connectionReferences: { logicalName: string }[] | null;
  records: { role: 'customApi' | 'fxExpression' | 'functionIndex' | 'other'; id: string; version: string | null }[];
}

export interface Snapshot {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  projectionVersion: typeof PROJECTION_VERSION;
  acquiredAt: string;
  source: { kind: 'synthetic' | 'manual' | 'live-read'; mapping: 'unverified' };
  target: {
    tenantId: string;
    environmentId: string;
    organizationId: string;
    organizationUrl: string;
    environmentClass: EnvironmentClass;
    classificationSource: ClassificationSource;
  };
  scope: { kind: 'function'; uniqueNames: string[] };
  completeness: { status: 'complete' | 'partial' | 'unknown'; gaps: { code: string; detail: string }[] };
  evidence: { id: string; sha256: string; classification: 'synthetic' | 'tenant-schema' | 'tenant-definition' }[];
  components: ObservedFunction[];
}

const lowerString = (item: JsonValue): string => (typeof item === 'string' ? item.toLowerCase() : JSON.stringify(item));
const lowerLogicalName = (item: JsonValue): string =>
  isPlainObject(item) && typeof item['logicalName'] === 'string' ? (item['logicalName'] as string).toLowerCase() : JSON.stringify(item);
const logicalNameRefs = nullable(
  arr(obj({ logicalName: str({ pattern: LOGICAL_NAME_PATTERN }) }), {
    maxItems: 50,
    unique: { key: lowerLogicalName, code: 'AMBIGUOUS_IDENTIFIER' },
  }),
);

export const observedFunctionSchema: Schema = obj({
  kind: lit('function'),
  uniqueName: str({ pattern: UNIQUE_NAME_PATTERN }),
  displayName: str({ minLength: 1, maxLength: 100, pattern: DISPLAY_NAME_PATTERN }),
  binding: str({ enum: ['unbound', 'bound', 'unknown'] }),
  managedState: str({ enum: ['unmanaged', 'managed', 'unknown'] }),
  solutions: arr(str({ pattern: SOLUTION_UNIQUE_NAME_PATTERN }), { maxItems: 50 }),
  parameters: arr(
    obj({
      name: str({ pattern: PARAMETER_NAME_PATTERN }),
      direction: str({ enum: ['input', 'output'] }),
      type: str({ pattern: /^[A-Za-z][A-Za-z0-9]{0,63}$/ }),
    }),
    { maxItems: 64 },
  ),
  formula: nullable(
    obj({
      sha256: str({ pattern: SHA256_PATTERN }),
      normalization: str({ enum: ['lf', 'none'] }),
      dialect: str({ pattern: /^[a-z][a-z0-9-]{0,63}$/ }),
      locale: str({ pattern: LOCALE_PATTERN }),
    }),
  ),
  tableReferences: logicalNameRefs,
  connectionReferences: logicalNameRefs,
  records: arr(
    obj({
      role: str({ enum: ['customApi', 'fxExpression', 'functionIndex', 'other'] }),
      id: str({ pattern: GUID_PATTERN }),
      version: nullable(str({ minLength: 1, maxLength: 128, pattern: /^[\x21-\x7e]+$/ })),
    }),
    { maxItems: 20 },
  ),
});

export const snapshotSchema: Schema = obj({
  schemaVersion: lit(SNAPSHOT_SCHEMA_VERSION, 'SCHEMA_VERSION_UNSUPPORTED'),
  projectionVersion: lit(PROJECTION_VERSION, 'SCHEMA_VERSION_UNSUPPORTED'),
  acquiredAt: str({ timestamp: true }),
  source: obj({
    kind: str({ enum: ['synthetic', 'manual', 'live-read'] }),
    // v1 has no verified platform-to-projection mapping (U03); a file cannot claim otherwise.
    mapping: str({ enum: ['unverified'] }),
  }),
  target: obj({
    tenantId: str({ pattern: GUID_PATTERN }),
    environmentId: str({ pattern: GUID_PATTERN }),
    organizationId: str({ pattern: GUID_PATTERN }),
    organizationUrl: str({ minLength: 9, maxLength: 256 }),
    environmentClass: str({ enum: ['sandbox', 'production', 'unknown'] }),
    classificationSource: str({ enum: ['unknown', 'asserted', 'authenticated-discovery'] }),
  }),
  scope: obj({
    kind: lit('function'),
    uniqueNames: arr(str({ pattern: UNIQUE_NAME_PATTERN }), {
      minItems: 1,
      maxItems: MAX_SNAPSHOT_COMPONENTS,
      unique: { key: lowerString, code: 'AMBIGUOUS_IDENTIFIER' },
    }),
  }),
  completeness: obj({
    status: str({ enum: ['complete', 'partial', 'unknown'] }),
    gaps: arr(
      obj({ code: str({ pattern: /^[A-Z][A-Z0-9_]{1,63}$/ }), detail: str({ maxLength: 500, pattern: DISPLAY_NAME_PATTERN }) }),
      { maxItems: 100 },
    ),
  }),
  evidence: arr(
    obj({
      id: str({ pattern: EVIDENCE_ID_PATTERN }),
      sha256: str({ pattern: SHA256_PATTERN }),
      classification: str({ enum: ['synthetic', 'tenant-schema', 'tenant-definition'] }),
    }),
    { maxItems: 100 },
  ),
  // Duplicate identities are reported by the planner as SNAPSHOT_AMBIGUOUS_IDENTITY, not rejected here.
  components: arr(observedFunctionSchema, { maxItems: MAX_SNAPSHOT_COMPONENTS }),
});
