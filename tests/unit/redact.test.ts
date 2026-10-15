import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLogger, redactFields, redactText } from '../../src/core/redact.js';

const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJodHRwczovL3gifQ.c2lnbmF0dXJlLXZhbHVl';

/** Synthetic fixture only; no real tokens, cookies, or business data. */
const FIXTURE = [
  `Authorization: Bearer ${JWT}`,
  'Cookie: CrmOwinAuth=abc123; ReqClientId=def456',
  'set-cookie: ARRAffinity=zzz; path=/',
  `token in text ${JWT} trailing`,
  '{"client_secret":"s3cr3t-value","refresh_token":"rt-value"}',
  'https://login.example/callback?code_verifier=verifier-value&access_token=at-value&state=ok',
  'Proxy-Authorization: Basic dXNlcjpwYXNz',
].join('\n');

const SECRETS = ['abc123', 'def456', 'zzz', 's3cr3t-value', 'rt-value', 'verifier-value', 'at-value', 'dXNlcjpwYXNz', JWT, 'c2lnbmF0dXJlLXZhbHVl'];

describe('redaction (T07)', () => {
  it('removes tokens, cookies, and secrets from free text', () => {
    const out = redactText(FIXTURE, 10_000);
    for (const secret of SECRETS) {
      assert.equal(out.includes(secret), false, `leaked ${secret}`);
    }
    assert.ok(out.includes('state=ok'));
  });

  it('bounds log length', () => {
    assert.ok(redactText('x'.repeat(5000)).length < 2100);
  });

  it('never logs formula bodies, payloads, or business record fields', () => {
    const fields = redactFields({
      formula: 'Amount * Rate',
      expression: 'Patch(...)',
      body: '{"name":"Contoso"}',
      record: { accountnumber: '123' },
      path: '/formula/text',
      count: 3,
    });
    assert.deepEqual(fields, {
      formula: '[REDACTED]',
      expression: '[REDACTED]',
      body: '[REDACTED]',
      record: '[REDACTED]',
      path: '/formula/text',
      count: 3,
    });
  });

  it('structured logger output contains no secrets', () => {
    const lines: string[] = [];
    const log = createLogger((line) => lines.push(line));
    log({ level: 'error', code: 'TRANSPORT_HTTP_ERROR', message: FIXTURE, fields: { headers: { authorization: JWT }, detail: `Bearer ${JWT}` } });
    const out = lines.join('\n');
    for (const secret of SECRETS) {
      assert.equal(out.includes(secret), false, `leaked ${secret}`);
    }
  });
});
