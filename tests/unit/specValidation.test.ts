import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FunctionSpec } from '../../src/contracts/spec.js';
import { validateSpecText } from '../../src/core/validators.js';
import { clone, exampleSpec } from '../helpers.js';

const errorCodes = (text: string): string[] =>
  validateSpecText(text)
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => d.code);

async function mutated(mutate: (spec: Record<string, any>) => void): Promise<string> {
  const spec = clone(await exampleSpec()) as unknown as Record<string, any>;
  mutate(spec);
  return JSON.stringify(spec);
}

describe('spec validation (T01)', () => {
  it('accepts the example spec without modifying the formula source', async () => {
    const spec = await exampleSpec();
    const result = validateSpecText(JSON.stringify(spec));
    assert.equal(result.schemaPassed, true);
    assert.equal(result.policyPassed, true);
    assert.equal((result.value as FunctionSpec).formula.text, 'Amount * Rate');
  });

  it('rejects unknown properties, including the automated registration fragment', async () => {
    assert.deepEqual(errorCodes(await mutated((s) => (s['extra'] = true))), ['SCHEMA_UNKNOWN_PROPERTY']);
    assert.ok(errorCodes(await mutated((s) => (s['registration'] = { message: 'Update' }))).includes('SCHEMA_UNKNOWN_PROPERTY'));
    assert.deepEqual(errorCodes(await mutated((s) => (s['formula']['$schema'] = 'x'))), ['SCHEMA_UNKNOWN_PROPERTY']);
  });

  it('rejects duplicate keys and non-integer numbers before schema checks', async () => {
    const text = (await mutated(() => undefined)).replace('"binding":"unbound"', '"binding":"unbound","binding":"unbound"');
    assert.deepEqual(errorCodes(text), ['JSON_DUPLICATE_KEY']);
    assert.deepEqual(errorCodes((await mutated(() => undefined)).replace('"tableReferences":[]', '"tableReferences":[1.5]')), [
      'JSON_UNSUPPORTED_NUMBER',
    ]);
  });

  it('reports only the version error for unknown schema versions', async () => {
    assert.deepEqual(errorCodes(await mutated((s) => ((s['schemaVersion'] = 'adapter.spec/v2'), (s['bogus'] = 1)))), ['SCHEMA_VERSION_UNSUPPORTED']);
  });

  it('rejects invalid enums, types outside the documented six, and wrong value types', async () => {
    assert.deepEqual(errorCodes(await mutated((s) => (s['binding'] = 'bound'))), ['SCHEMA_ENUM_INVALID']);
    assert.deepEqual(errorCodes(await mutated((s) => (s['parameters'][0]['type'] = 'Money'))), ['SCHEMA_ENUM_INVALID']);
    assert.deepEqual(errorCodes(await mutated((s) => (s['parameters'] = 'Amount'))), ['SCHEMA_TYPE_MISMATCH']);
    assert.deepEqual(errorCodes(await mutated((s) => (s['formula']['lineEndings'] = 'crlf'))), ['SCHEMA_ENUM_INVALID']);
  });

  it('rejects documented types outside the MVP Decimal profile', async () => {
    assert.deepEqual(errorCodes(await mutated((s) => (s['parameters'][0]['type'] = 'Float'))), ['PARAMETER_TYPE_NOT_IN_PROFILE']);
  });

  it('rejects more than five table references by schema and any table reference by profile', async () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ logicalName: `sample_t${i}` }));
    assert.deepEqual(errorCodes(await mutated((s) => (s['tableReferences'] = six))), ['SCHEMA_ITEM_COUNT_INVALID']);
    assert.deepEqual(errorCodes(await mutated((s) => (s['tableReferences'] = [{ logicalName: 'sample_calculation' }]))), [
      'TABLE_REFERENCES_NOT_IN_PROFILE',
    ]);
  });

  it('rejects non-empty connection references', async () => {
    assert.deepEqual(errorCodes(await mutated((s) => (s['connectionReferences'] = [{ logicalName: 'sample_conn' }]))), [
      'CONNECTION_REFERENCES_NOT_SUPPORTED',
    ]);
  });

  it('rejects the automated kind until a profile is proven', async () => {
    assert.deepEqual(errorCodes(await mutated((s) => (s['kind'] = 'automated'))), ['AUTOMATED_PROFILE_NOT_SUPPORTED']);
  });

  it('rejects ambiguous identifiers', async () => {
    assert.deepEqual(errorCodes(await mutated((s) => (s['parameters'][1]['name'] = 'amount'))), ['AMBIGUOUS_IDENTIFIER']);
    assert.deepEqual(errorCodes(await mutated((s) => (s['identity']['uniqueName'] = 'CalculateFee'))), ['SCHEMA_PATTERN_MISMATCH']);
  });

  it('enforces namespace ownership and reserved prefixes', async () => {
    assert.deepEqual(errorCodes(await mutated((s) => (s['identity']['uniqueName'] = 'other_CalculateFee'))), ['NAMESPACE_PREFIX_MISMATCH']);
    const reserved = await mutated((s) => {
      s['solution']['publisherPrefix'] = 'msdyn';
      s['identity']['uniqueName'] = 'msdyn_CalculateFee';
    });
    assert.deepEqual(errorCodes(reserved), ['RESERVED_PUBLISHER_PREFIX']);
  });

  it('enforces locale and output rules of the MVP profile', async () => {
    assert.deepEqual(errorCodes(await mutated((s) => (s['formula']['locale'] = 'fr-FR'))), ['LOCALE_NOT_IN_PROFILE']);
    assert.deepEqual(errorCodes(await mutated((s) => (s['parameters'] = s['parameters'].slice(0, 2)))), ['OUTPUT_PARAMETER_REQUIRED']);
  });

  it('rejects empty formulas and control characters in display names', async () => {
    assert.deepEqual(errorCodes(await mutated((s) => (s['formula']['text'] = ''))), ['SCHEMA_LENGTH_INVALID']);
    assert.deepEqual(errorCodes(await mutated((s) => (s['identity']['displayName'] = 'a\u0007b'))), ['SCHEMA_PATTERN_MISMATCH']);
  });
});
