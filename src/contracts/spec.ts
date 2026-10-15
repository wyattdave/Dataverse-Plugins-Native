import type { JsonValue } from './common.js';
import {
  DISPLAY_NAME_PATTERN,
  LOCALE_PATTERN,
  LOGICAL_NAME_PATTERN,
  PARAMETER_NAME_PATTERN,
  PUBLISHER_PREFIX_PATTERN,
  SOLUTION_UNIQUE_NAME_PATTERN,
  UNIQUE_NAME_PATTERN,
} from './patterns.js';
import { arr, isPlainObject, lit, obj, str, type Schema } from './schema.js';

export const SPEC_SCHEMA_VERSION = 'adapter.spec/v1';

/** Documented Function parameter type labels [S1]. A ceiling, not a promise of support. */
export const DOCUMENTED_PARAMETER_TYPES = ['Boolean', 'String', 'Float', 'Decimal', 'DateTime', 'Integer'] as const;
export type ParameterType = (typeof DOCUMENTED_PARAMETER_TYPES)[number];

/** Documented ceiling of five table references [S1]; the MVP profile allows zero. */
export const DOCUMENTED_MAX_TABLE_REFERENCES = 5;
export const MAX_FORMULA_LENGTH = 100_000;
export const MAX_PARAMETERS = 32;

export type SpecKind = 'function' | 'automated';
export type LineEndingPolicy = 'lf' | 'preserve';

export interface ParameterSpec {
  name: string;
  direction: 'input' | 'output';
  type: ParameterType;
}

export interface LogicalNameRef {
  logicalName: string;
}

export interface FunctionSpec {
  schemaVersion: typeof SPEC_SCHEMA_VERSION;
  kind: SpecKind;
  identity: { uniqueName: string; displayName: string };
  binding: 'unbound';
  solution: { uniqueName: string; publisherPrefix: string };
  parameters: ParameterSpec[];
  formula: { text: string; dialect: 'dataverse-function'; locale: string; lineEndings: LineEndingPolicy };
  tableReferences: LogicalNameRef[];
  connectionReferences: LogicalNameRef[];
}

const caseInsensitiveField =
  (field: string) =>
  (item: JsonValue): string =>
    isPlainObject(item) && typeof item[field] === 'string' ? (item[field] as string).toLowerCase() : JSON.stringify(item);

const logicalNameRef = obj({ logicalName: str({ pattern: LOGICAL_NAME_PATTERN }) });

export const specSchema: Schema = obj({
  schemaVersion: lit(SPEC_SCHEMA_VERSION, 'SCHEMA_VERSION_UNSUPPORTED'),
  kind: str({ enum: ['function', 'automated'] }),
  identity: obj({
    uniqueName: str({ pattern: UNIQUE_NAME_PATTERN }),
    displayName: str({ minLength: 1, maxLength: 100, pattern: DISPLAY_NAME_PATTERN }),
  }),
  binding: str({ enum: ['unbound'] }),
  solution: obj({
    uniqueName: str({ pattern: SOLUTION_UNIQUE_NAME_PATTERN }),
    publisherPrefix: str({ pattern: PUBLISHER_PREFIX_PATTERN }),
  }),
  parameters: arr(
    obj({
      name: str({ pattern: PARAMETER_NAME_PATTERN }),
      direction: str({ enum: ['input', 'output'] }),
      type: str({ enum: DOCUMENTED_PARAMETER_TYPES }),
    }),
    { maxItems: MAX_PARAMETERS, unique: { key: caseInsensitiveField('name'), code: 'AMBIGUOUS_IDENTIFIER' } },
  ),
  formula: obj({
    text: str({ minLength: 1, maxLength: MAX_FORMULA_LENGTH }),
    dialect: str({ enum: ['dataverse-function'] }),
    locale: str({ pattern: LOCALE_PATTERN }),
    lineEndings: str({ enum: ['lf', 'preserve'] }),
  }),
  tableReferences: arr(logicalNameRef, {
    maxItems: DOCUMENTED_MAX_TABLE_REFERENCES,
    unique: { key: caseInsensitiveField('logicalName'), code: 'AMBIGUOUS_IDENTIFIER' },
  }),
  connectionReferences: arr(logicalNameRef, {
    unique: { key: caseInsensitiveField('logicalName'), code: 'AMBIGUOUS_IDENTIFIER' },
  }),
});

/** The single MVP capability profile. Passing it does not mean the profile is proven deployable. */
export const MVP_FUNCTION_PROFILE = {
  id: 'function.unbound.decimal/v1',
  kinds: ['function'],
  bindings: ['unbound'],
  parameterTypes: ['Decimal'],
  locales: ['en-US'],
  maxTableReferences: 0,
  maxConnectionReferences: 0,
  requireOutputParameter: true,
  protocolEvidence: 'unverified',
  supportability: 'unverified',
} as const;
