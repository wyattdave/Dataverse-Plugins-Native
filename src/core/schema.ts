/** Minimal strict schema DSL. Objects reject unknown properties; there is no coercion or defaulting. */
export type Schema = StringSchema | IntegerSchema | BooleanSchema | LiteralSchema | ArraySchema | ObjectSchema;

export interface StringSchema {
  t: 'string';
  enum?: readonly string[];
  pattern?: RegExp;
  minLength?: number;
  maxLength?: number;
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
}
export interface ArraySchema {
  t: 'array';
  items: Schema;
  maxItems?: number;
}
export interface ObjectSchema {
  t: 'object';
  props: Readonly<Record<string, Schema>>;
  required: readonly string[];
}

export interface SchemaProblem {
  code: string;
  message: string;
  path: string;
}

export const str = (options: Omit<StringSchema, 't'> = {}): StringSchema => ({ t: 'string', ...options });
export const int = (options: Omit<IntegerSchema, 't'> = {}): IntegerSchema => ({ t: 'integer', ...options });
export const bool = (): BooleanSchema => ({ t: 'boolean' });
export const lit = (value: string | boolean | number): LiteralSchema => ({ t: 'literal', value });
export const arr = (items: Schema, options: Omit<ArraySchema, 't' | 'items'> = {}): ArraySchema => ({ t: 'array', items, ...options });
export const obj = (props: Record<string, Schema>, optional: readonly string[] = []): ObjectSchema => ({
  t: 'object',
  props,
  required: Object.keys(props).filter((k) => !optional.includes(k)),
});

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const escapePointer = (segment: string): string => segment.replace(/~/g, '~0').replace(/\//g, '~1');

/** Validates a parsed JSON value. Messages never echo input values, only paths and allowed shapes. */
export function validateSchema(value: unknown, schema: Schema, path = ''): SchemaProblem[] {
  const out: SchemaProblem[] = [];
  walk(value, schema, path, out);
  return out;
}

function walk(value: unknown, schema: Schema, path: string, out: SchemaProblem[]): void {
  const fail = (code: string, message: string, at = path): void => {
    out.push({ code, message, path: at });
  };
  switch (schema.t) {
    case 'literal':
      if (value !== schema.value) fail('SCHEMA_ENUM_INVALID', `Expected the exact value ${JSON.stringify(schema.value)}.`);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') fail('SCHEMA_TYPE_MISMATCH', 'Expected a boolean.');
      return;
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        fail('SCHEMA_TYPE_MISMATCH', 'Expected an integer.');
      } else if ((schema.min !== undefined && value < schema.min) || (schema.max !== undefined && value > schema.max)) {
        fail('SCHEMA_INTEGER_RANGE', `Integer must be within [${schema.min ?? '-'}, ${schema.max ?? '-'}].`);
      }
      return;
    case 'string':
      if (typeof value !== 'string') {
        fail('SCHEMA_TYPE_MISMATCH', 'Expected a string.');
      } else if (schema.enum !== undefined && !schema.enum.includes(value)) {
        fail('SCHEMA_ENUM_INVALID', `Value must be one of: ${schema.enum.join(', ')}.`);
      } else if ((schema.minLength !== undefined && value.length < schema.minLength) || (schema.maxLength !== undefined && value.length > schema.maxLength)) {
        fail('SCHEMA_LENGTH_INVALID', `Length must be within [${schema.minLength ?? 0}, ${schema.maxLength ?? '-'}].`);
      } else if (schema.pattern !== undefined && !schema.pattern.test(value)) {
        fail('SCHEMA_PATTERN_MISMATCH', `Value does not match ${schema.pattern.source}.`);
      }
      return;
    case 'array':
      if (!Array.isArray(value)) {
        fail('SCHEMA_TYPE_MISMATCH', 'Expected an array.');
        return;
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        fail('SCHEMA_ITEM_COUNT_INVALID', `At most ${schema.maxItems} items are allowed.`);
      }
      value.forEach((item, index) => walk(item, schema.items, `${path}/${index}`, out));
      return;
    case 'object':
      if (!isPlainObject(value)) {
        fail('SCHEMA_TYPE_MISMATCH', 'Expected an object.');
        return;
      }
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.props, key)) fail('SCHEMA_UNKNOWN_PROPERTY', `Unknown property '${key}'.`, `${path}/${escapePointer(key)}`);
      }
      for (const key of schema.required) {
        if (!Object.hasOwn(value, key)) fail('SCHEMA_REQUIRED_PROPERTY_MISSING', `Missing required property '${key}'.`, `${path}/${escapePointer(key)}`);
      }
      for (const [key, child] of Object.entries(schema.props)) {
        if (Object.hasOwn(value, key)) walk(value[key], child, `${path}/${escapePointer(key)}`, out);
      }
      return;
  }
}
