import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { OPERATIONS, runOperation } from '../../src/app/operations.js';
import { validateSchema } from '../../src/contracts/schema.js';
import { resultSchema } from '../../src/contracts/result.js';
import { DEFAULT_MAX_INPUT_BYTES } from '../../src/core/documents.js';
import { examplePath } from '../helpers.js';

const now = new Date('2026-10-15T10:00:00Z');

describe('host-neutral operations layer', () => {
  it('fails closed on unknown operations, unexpected documents, missing documents, and stray options', async () => {
    assert.deepEqual((await runOperation({ operation: 'deploy', documents: {}, now })).reasonCodes, ['CLI_UNKNOWN_COMMAND']);
    assert.deepEqual((await runOperation({ operation: 'validate', documents: { spec: '{}', plan: '{}' }, now })).reasonCodes, ['INPUT_DOCUMENT_UNEXPECTED']);
    assert.deepEqual((await runOperation({ operation: 'apply', documents: {}, now })).reasonCodes, ['INPUT_DOCUMENT_MISSING']);
    assert.deepEqual((await runOperation({ operation: 'plan', documents: { spec: '{}' }, offline: true, now })).reasonCodes, ['INPUT_OPTION_UNEXPECTED']);
    assert.deepEqual((await runOperation({ operation: 'inspect', documents: {}, now })).reasonCodes, ['CLI_MODE_REQUIRED']);
    assert.deepEqual((await runOperation({ operation: 'retire', documents: { spec: '{}' }, now })).reasonCodes, ['INPUT_DOCUMENT_UNEXPECTED']);
  });

  it('bounds document size before parsing', async () => {
    const huge = `"${'x'.repeat(DEFAULT_MAX_INPUT_BYTES)}"`;
    assert.deepEqual((await runOperation({ operation: 'validate', documents: { spec: huge }, now })).reasonCodes, ['INPUT_TOO_LARGE']);
  });

  it('returns schema-valid results for every operation and never readiness other than blocked', async () => {
    const spec = await readFile(examplePath('calculation.spec.json'), 'utf8');
    const snapshot = await readFile(examplePath('drifted.snapshot.json'), 'utf8');
    const journal = await readFile(examplePath('interrupted.journal.json'), 'utf8');
    const planResult = await runOperation({ operation: 'plan', documents: { spec, snapshot }, now });
    const plan = JSON.stringify((planResult.data as { plan: unknown }).plan);
    const inputs: Record<string, Record<string, string>> = {
      validate: { spec },
      inspect: { snapshot },
      plan: { spec, snapshot },
      verify: { spec, snapshot },
      approve: { plan },
      apply: { plan },
      reconcile: { journal, snapshot },
    };
    for (const operation of Object.keys(OPERATIONS)) {
      const result = await runOperation({ operation, documents: inputs[operation] ?? {}, now });
      assert.deepEqual(validateSchema(result, resultSchema), [], operation);
      assert.equal(result.executionReadiness, 'blocked', operation);
      assert.ok(result.operations.every((o) => !o.dispatched || operation === 'reconcile'), operation);
    }
  });

  it('reconciles the synthetic interrupted journal as outcome_unknown', async () => {
    const journal = await readFile(examplePath('interrupted.journal.json'), 'utf8');
    const result = await runOperation({ operation: 'reconcile', documents: { journal }, now });
    assert.equal(result.status, 'outcome_unknown');
  });
});
