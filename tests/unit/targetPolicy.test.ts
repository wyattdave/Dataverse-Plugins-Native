import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { assessClassification, checkOwnership, parseExactOrigin, POLICY, writeGateReasons } from '../../src/core/policy.js';
import { validateTargetText } from '../../src/core/validators.js';
import { clone, exampleSpec, examplePath, exampleTarget } from '../helpers.js';

const codes = (text: string): string[] =>
  [...new Set(validateTargetText(text).diagnostics.filter((d) => d.severity === 'error').map((d) => d.code))].sort();

async function mutatedTarget(mutate: (t: Record<string, any>) => void): Promise<string> {
  const target = clone(await exampleTarget()) as unknown as Record<string, any>;
  mutate(target);
  return JSON.stringify(target);
}

describe('target configuration and environment policy (T04)', () => {
  it('accepts the synthetic target', async () => {
    const result = validateTargetText(JSON.stringify(await exampleTarget()));
    assert.equal(result.schemaPassed && result.policyPassed, true);
  });

  it('rejects unresolved template placeholders', async () => {
    const text = await readFile(examplePath('target.template.json'), 'utf8');
    assert.ok(codes(text).includes('TARGET_PLACEHOLDER_UNRESOLVED'));
    assert.equal(validateTargetText(text).value, undefined);
  });

  it('accepts only exact https origins', () => {
    assert.equal(parseExactOrigin('https://example-sandbox.crm.dynamics.com').origin, 'https://example-sandbox.crm.dynamics.com');
    assert.equal(parseExactOrigin('http://example-sandbox.crm.dynamics.com').reason, 'TARGET_URL_NOT_HTTPS');
    assert.equal(parseExactOrigin('https://example-sandbox.crm.dynamics.com/api').reason, 'TARGET_URL_NOT_ORIGIN');
    assert.equal(parseExactOrigin('https://user@example-sandbox.crm.dynamics.com').reason, 'TARGET_URL_NOT_ORIGIN');
    assert.equal(parseExactOrigin('https://example-sandbox.crm.dynamics.com:8443').reason, 'TARGET_URL_NOT_ORIGIN');
    assert.equal(parseExactOrigin('https://EXAMPLE-sandbox.crm.dynamics.com').reason, 'TARGET_URL_NOT_ORIGIN');
  });

  it('rejects http, unsupported clouds, unlisted origins, and authority tenant mismatches', async () => {
    assert.deepEqual(
      codes(await mutatedTarget((t) => (t['expectedTarget']['organizationUrl'] = 'http://example-sandbox.crm.dynamics.com'))),
      ['TARGET_URL_NOT_HTTPS'],
    );
    const evil = await mutatedTarget((t) => {
      t['expectedTarget']['organizationUrl'] = 'https://evil.example.com';
      t['allowedOrigins'] = ['https://evil.example.com'];
    });
    assert.deepEqual(codes(evil), ['TARGET_CLOUD_UNSUPPORTED']);
    assert.deepEqual(codes(await mutatedTarget((t) => (t['allowedOrigins'] = ['https://other.crm.dynamics.com']))), ['TARGET_ORIGIN_NOT_ALLOWLISTED']);
    assert.deepEqual(
      codes(await mutatedTarget((t) => (t['allowedOrigins'] = ['https://example-sandbox.crm.dynamics.com', 'https://other.crm.dynamics.com']))),
      ['SCHEMA_ITEM_COUNT_INVALID'],
    );
    assert.deepEqual(
      codes(await mutatedTarget((t) => (t['auth']['authorityTenantId'] = '00000000-0000-4000-8000-000000000099'))),
      ['TARGET_AUTHORITY_TENANT_MISMATCH'],
    );
  });

  it('only accepts sandbox as the expected class and delegated auth', async () => {
    assert.deepEqual(codes(await mutatedTarget((t) => (t['expectedEnvironmentClass'] = 'production'))), ['SCHEMA_ENUM_INVALID']);
    assert.deepEqual(codes(await mutatedTarget((t) => (t['auth']['mode'] = 'client-secret'))), ['SCHEMA_ENUM_INVALID']);
    assert.deepEqual(codes(await mutatedTarget((t) => (t['auth']['clientSecret'] = 'x'))), ['SCHEMA_UNKNOWN_PROPERTY']);
  });

  it('detects spec/target ownership mismatches', async () => {
    const target = await exampleTarget();
    target.ownership.solutionUniqueName = 'sample_Other';
    assert.deepEqual(
      checkOwnership(await exampleSpec(), target).map((d) => d.code),
      ['OWNERSHIP_MISMATCH'],
    );
  });

  it('never trusts offline classification and hard-blocks production', () => {
    assert.equal(assessClassification('production').reason, 'PRODUCTION_WRITE_BLOCKED');
    assert.equal(assessClassification('sandbox').reason, 'OFFLINE_CLASSIFICATION_NOT_TRUSTED');
    assert.equal(assessClassification('unknown').reason, 'ENVIRONMENT_CLASSIFICATION_UNKNOWN');
    assert.equal(assessClassification(null).effective, 'unknown');
  });

  it('write gate passes only for a live, authenticated sandbox classification; no override exists', () => {
    assert.deepEqual(writeGateReasons('production', 'live-authenticated'), ['PRODUCTION_WRITE_BLOCKED']);
    assert.deepEqual(writeGateReasons('unknown', 'live-authenticated'), ['ENVIRONMENT_CLASSIFICATION_UNKNOWN']);
    assert.deepEqual(writeGateReasons('sandbox', 'offline'), ['OFFLINE_CLASSIFICATION_NOT_TRUSTED']);
    assert.deepEqual(writeGateReasons('sandbox', 'live-authenticated'), []);
    assert.equal(writeGateReasons.length, 2);
    assert.equal(POLICY.overrides, 'none');
    assert.equal(POLICY.productionWrites, 'hard-blocked');
  });
});
