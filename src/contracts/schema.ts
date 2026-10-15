import { diag, escapePointer, type Diagnostic, type JsonValue, type ValidationPhaseName } from './common.js';
import { UTC_TIMESTAMP_PATTERN } from './patterns.js';
import type { ReasonCode } from './reasonCodes.js';

/**
 * Minimal strict schema DSL. Objects reject unknown properties; there is no coercion or defaulting.
 */
export type Schema =
  | StringSchema
  | IntegerSchema
  | BooleanSchema
  | LiteralSchema
  | NullableSchema
  | ArraySchema
  | ObjectSchema
  | OpaqueSchema;

export interface StringSchema {
  t: 'string';
  enum?: readonly string[];
  pattern?: RegExp;
  minLength?: number;
  maxLength?: number;
  timestamp?: boolean;
}
export interface IntegerSchema {
  t: 'integer';
  min?: number;
  max?: number;
}
export interface BooleanSchema {
  t: 'boolean';
}
export interface LiteralSchema {
  t: 'literal';
  value: string | boolean | number;
  code?: ReasonCode;
}
export interface NullableSchema {
  t: 'nullable';
  of: Schema;
}
export interface ArraySchema {
  t: 'array';
  items: Schema;
  minItems?: number;
  maxItems?: number;
  unique?: { key: (item: JsonValue) => string; code: ReasonCode };
}
export interface ObjectSchema {
  t: 'object';
  props: Readonly<Record<string, Schema>>;
  required: readonly string[];
}
/** Command-specific payloads validated by their own schema elsewhere. */
export interface OpaqueSchema {
  t: 'opaque';
}

export const str = (options: Omit<StringSchema, 't'> = {}): StringSchema => ({ t: 'string', ...options });
export const int = (options: Omit<IntegerSchema, 't'> = {}): IntegerSchema => ({ t: 'integer', ...options });
export const bool = (): BooleanSchema => ({ t: 'boolean' });
export const lit = (value: string | boolean | number, code?: ReasonCode): LiteralSchema =>
  code === undefined ? { t: 'literal', value } : { t: 'literal', value, code };
export const nullable = (of: Schema): NullableSchema => ({ t: 'nullable', of });
export const arr = (items: Schema, options: Omit<ArraySchema, 't' | 'items'> = {}): ArraySchema => ({
  t: 'array',
  items,
  ...options,
});
export const obj = (props: Record<string, Schema>, optional: readonly string[] = []): ObjectSchema => ({
  t: 'object',
  props,
  required: Object.keys(props).filter((k) => !optional.includes(k)),
});
export const opaque = (): OpaqueSchema => ({ t: 'opaque' });

export function isPlainObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isValidUtcTimestamp(value: string): boolean {
  if (!UTC_TIMESTAMP_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }
  // Round-trip the date part to reject values such as 2026-02-30.
  return parsed.toISOString().slice(0, 19) === value.slice(0, 19);
}

/** Validates a parsed JSON value. Messages never echo input values, only paths and allowed shapes. */
export function validateSchema(
  value: unknown,
  schema: Schema,
  phase: ValidationPhaseName = 'schema',
  path = '',
): Diagnostic[] {
  const out: Diagnostic[] = [];
  walk(value, schema, path, phase, out);
  return out;
}

function typeError(out: Diagnostic[], phase: ValidationPhaseName, path: string, expected: string): void {
  out.push(diag('SCHEMA_TYPE_MISMATCH', 'error', phase, `Expected ${expected}.`, path));
}

function walk(value: unknown, schema: Schema, path: string, phase: ValidationPhaseName, out: Diagnostic[]): void {
  switch (schema.t) {
    case 'opaque':
      return;
    case 'nullable':
      if (value !== null) {
        walk(value, schema.of, path, phase, out);
      }
      return;
    case 'literal':
      if (value !== schema.value) {
        out.push(
          diag(
            schema.code ?? 'SCHEMA_ENUM_INVALID',
            'error',
            phase,
            `Expected the exact value ${JSON.stringify(schema.value)}.`,
            path,
          ),
        );
      }
      return;
    case 'boolean':
      if (typeof value !== 'boolean') {
        typeError(out, phase, path, 'a boolean');
      }
      return;
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        typeError(out, phase, path, 'an integer');
        return;
      }
      if ((schema.min !== undefined && value < schema.min) || (schema.max !== undefined && value > schema.max)) {
        out.push(
          diag('SCHEMA_INTEGER_RANGE', 'error', phase, `Integer must be within [${schema.min ?? '-'}, ${schema.max ?? '-'}].`, path),
        );
      }
      return;
    case 'string':
      walkString(value, schema, path, phase, out);
      return;
    case 'array':
      walkArray(value, schema, path, phase, out);
      return;
    case 'object':
      walkObject(value, schema, path, phase, out);
      return;
  }
}

function walkString(value: unknown, schema: StringSchema, path: string, phase: ValidationPhaseName, out: Diagnostic[]): void {
  if (typeof value !== 'string') {
    typeError(out, phase, path, 'a string');
    return;
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    out.push(diag('SCHEMA_ENUM_INVALID', 'error', phase, `Value must be one of: ${schema.enum.join(', ')}.`, path));
    return;
  }
  if (
    (schema.minLength !== undefined && value.length < schema.minLength) ||
    (schema.maxLength !== undefined && value.length > schema.maxLength)
  ) {
    out.push(
      diag('SCHEMA_LENGTH_INVALID', 'error', phase, `Length must be within [${schema.minLength ?? 0}, ${schema.maxLength ?? '-'}].`, path),
    );
    return;
  }
  if (schema.pattern !== undefined && !schema.pattern.test(value)) {
    out.push(diag('SCHEMA_PATTERN_MISMATCH', 'error', phase, `Value does not match ${schema.pattern.source}.`, path));
    return;
  }
  if (schema.timestamp === true && !isValidUtcTimestamp(value)) {
    out.push(diag('SCHEMA_TIMESTAMP_INVALID', 'error', phase, 'Expected a valid UTC timestamp (YYYY-MM-DDTHH:MM:SS[.fff]Z).', path));
  }
}

function walkArray(value: unknown, schema: ArraySchema, path: string, phase: ValidationPhaseName, out: Diagnostic[]): void {
  if (!Array.isArray(value)) {
    typeError(out, phase, path, 'an array');
    return;
  }
  if (
    (schema.minItems !== undefined && value.length < schema.minItems) ||
    (schema.maxItems !== undefined && value.length > schema.maxItems)
  ) {
    out.push(
      diag('SCHEMA_ITEM_COUNT_INVALID', 'error', phase, `Item count must be within [${schema.minItems ?? 0}, ${schema.maxItems ?? '-'}].`, path),
    );
  }
  const before = out.length;
  value.forEach((item, index) => walk(item, schema.items, `${path}/${index}`, phase, out));
  if (schema.unique !== undefined && out.length === before) {
    const seen = new Set<string>();
    value.forEach((item, index) => {
      const key = schema.unique!.key(item as JsonValue);
      if (seen.has(key)) {
        out.push(diag(schema.unique!.code, 'error', phase, 'Duplicate or ambiguous item identity.', `${path}/${index}`));
      }
      seen.add(key);
    });
  }
}

function walkObject(value: unknown, schema: ObjectSchema, path: string, phase: ValidationPhaseName, out: Diagnostic[]): void {
  if (!isPlainObject(value)) {
    typeError(out, phase, path, 'an object');
    return;
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(schema.props, key)) {
      out.push(diag('SCHEMA_UNKNOWN_PROPERTY', 'error', phase, `Unknown property '${key}'.`, `${path}/${escapePointer(key)}`));
    }
  }
  for (const key of schema.required) {
    if (!Object.hasOwn(value, key)) {
      out.push(
        diag('SCHEMA_REQUIRED_PROPERTY_MISSING', 'error', phase, `Missing required property '${key}'.`, `${path}/${escapePointer(key)}`),
      );
    }
  }
  for (const [key, child] of Object.entries(schema.props)) {
    if (Object.hasOwn(value, key)) {
      walk(value[key], child, `${path}/${escapePointer(key)}`, phase, out);
    }
  }
}
