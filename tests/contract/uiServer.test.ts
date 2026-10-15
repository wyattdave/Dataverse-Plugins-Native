import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { validateSchema } from '../../src/contracts/schema.js';
import { resultSchema, type CommandResult } from '../../src/contracts/result.js';
import { startUiServer, type UiServer } from '../../src/ui/server.js';
import type { PacRunner } from '../../src/studio/pac.js';
import { examplePath } from '../helpers.js';

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** node:http is used (not fetch) so tests can forge Host/Origin headers like a hostile page or rebinding attack. */
function call(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { Host: `127.0.0.1:${port}`, ...options.headers } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

describe('local UI server', () => {
  let server: UiServer;
  let token: string;
  const now = new Date('2026-10-15T10:00:00Z');

  before(async () => {
    server = await startUiServer({ port: 0, now: () => now });
    token = new URL(server.launchUrl).searchParams.get('session')!;
  });
  after(async () => server.close());

  const api = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    call(server.port, path, { ...init, headers: { 'X-DV-Session': token, ...init.headers } });
  const run = (body: unknown) => api('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('binds to 127.0.0.1 and issues a long random session token', () => {
    assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(token, /^[0-9a-f]{64}$/);
  });

  it('serves only allowlisted static files with a strict CSP and no-store caching', async () => {
    const index = await call(server.port, '/');
    assert.equal(index.status, 200);
    assert.match(String(index.headers['content-security-policy']), /default-src 'none'; script-src 'self'/);
    assert.equal(index.headers['x-content-type-options'], 'nosniff');
    assert.equal(index.headers['x-frame-options'], 'DENY');
    assert.equal(index.headers['referrer-policy'], 'no-referrer');
    assert.equal(index.headers['cache-control'], 'no-store');
    assert.equal((await call(server.port, '/app.js')).status, 200);
    for (const path of ['/../package.json', '/%2e%2e/package.json', '/examples/calculation.spec.json', '/src/ui/server.ts', '/ui/app.js']) {
      assert.equal((await call(server.port, path)).status, 404, path);
    }
  });

  it('rejects foreign Host headers (DNS rebinding) even with a valid token', async () => {
    const response = await call(server.port, '/api/meta', { headers: { Host: `evil.example.com:${server.port}`, 'X-DV-Session': token } });
    assert.equal(response.status, 421);
    assert.deepEqual((JSON.parse(response.body) as CommandResult).reasonCodes, ['UI_HOST_REJECTED']);
  });

  it('rejects cross-origin API calls and calls without the session token', async () => {
    assert.equal((await api('/api/meta', { headers: { Origin: 'https://evil.example.com' } })).status, 403);
    assert.equal((await call(server.port, '/api/meta')).status, 401);
    assert.equal((await call(server.port, '/api/meta', { headers: { 'X-DV-Session': '0'.repeat(64) } })).status, 401);
    assert.equal((await api('/api/meta', { headers: { Origin: server.origin } })).status, 200);
  });

  it('exposes metadata: operations, capabilities, and synthetic examples', async () => {
    const meta = JSON.parse((await api('/api/meta')).body) as { operations: Record<string, unknown>; capabilities: unknown[]; examples: string[] };
    assert.ok(Object.hasOwn(meta.operations, 'apply'));
    assert.ok(meta.capabilities.length > 10);
    assert.ok(meta.examples.includes('calculation.spec.json'));
  });

  it('serves examples from a fixed allowlist only', async () => {
    const ok = JSON.parse((await api('/api/examples/calculation.spec.json')).body) as { content: string };
    assert.equal(ok.content, await readFile(examplePath('calculation.spec.json'), 'utf8'));
    for (const name of ['..%2Fpackage.json', 'synthetic.target.json%00', 'package.json']) {
      assert.equal((await api(`/api/examples/${name}`)).status, 404, name);
    }
  });

  it('runs operations with document text and returns adapter.result/v1', async () => {
    const spec = await readFile(examplePath('calculation.spec.json'), 'utf8');
    const response = await run({ operation: 'validate', documents: { spec }, offline: true });
    assert.equal(response.status, 200);
    const result = JSON.parse(response.body) as CommandResult;
    assert.deepEqual(validateSchema(result, resultSchema), []);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.executionReadiness, 'blocked');
  });

  it('keeps every mutation blocked through the UI', async () => {
    const spec = await readFile(examplePath('calculation.spec.json'), 'utf8');
    const snapshot = await readFile(examplePath('drifted.snapshot.json'), 'utf8');
    const planned = JSON.parse((await run({ operation: 'plan', documents: { spec, snapshot } })).body) as CommandResult;
    const plan = JSON.stringify((planned.data as { plan: unknown }).plan);
    const applied = JSON.parse((await run({ operation: 'apply', documents: { plan } })).body) as CommandResult;
    assert.equal(applied.status, 'blocked');
    assert.ok(applied.operations.length > 0 && applied.operations.every((o) => !o.dispatched));
    for (const operation of ['approve', 'test', 'package export', 'package import', 'recover', 'retire']) {
      const documents = operation === 'approve' ? { plan } : {};
      const result = JSON.parse((await run({ operation, documents })).body) as CommandResult;
      assert.equal(result.status, 'blocked', operation);
    }
  });

  it('rejects malformed, unexpected, and oversized requests', async () => {
    const asJson = { 'Content-Type': 'application/json' };
    assert.equal((await api('/api/run', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal((await api('/api/run', { method: 'POST', headers: asJson, body: '{"operation":"validate","operation":"plan","documents":{}}' })).status, 400);
    assert.equal((await run({ operation: 'deploy', documents: {} })).status, 400);
    assert.equal((await run({ operation: 'validate', documents: { spec: '{}' }, force: true })).status, 400);
    assert.equal((await run({ operation: 'validate', documents: { secrets: 'x' } })).status, 400);
    const unexpected = JSON.parse((await run({ operation: 'approve', documents: { plan: '{}', spec: '{}' } })).body) as CommandResult;
    assert.deepEqual(unexpected.reasonCodes, ['INPUT_DOCUMENT_UNEXPECTED']);
    const missing = JSON.parse((await run({ operation: 'plan', documents: {} })).body) as CommandResult;
    assert.deepEqual(missing.reasonCodes, ['INPUT_DOCUMENT_MISSING']);
    const big = await api('/api/run', { method: 'POST', headers: { ...asJson, 'Content-Length': String(100 * 1024 * 1024) }, body: '' });
    assert.equal(big.status, 413);
  });

  it('does not echo formula text outside the plan/validate payloads it computes from', async () => {
    const spec = (await readFile(examplePath('calculation.spec.json'), 'utf8')).replace('Amount * Rate', 'UI_FORMULA_MARKER * Rate');
    const body = (await run({ operation: 'plan', documents: { spec } })).body;
    assert.equal(body.includes('UI_FORMULA_MARKER'), false);
  });
});

describe('local UI server: four-step studio API (fake pac)', () => {
  let server: UiServer;
  let token: string;
  const pacCalls: string[][] = [];
  const ENV_URL = 'https://contoso-dev.crm.dynamics.com/';
  const pacRunner: PacRunner = async (args) => {
    pacCalls.push([...args]);
    const key = `${args[0]} ${args[1]}`;
    if (key === 'env list') {
      return { code: 0, output: `*  Contoso Dev  11111111-2222-3333-4444-555555555555 ${ENV_URL} unq1 Sandbox\n` };
    }
    if (key === 'auth list') {
      return { code: 0, output: `[1] * UNIVERSAL maker@contoso.com Public User Contoso Dev ${ENV_URL}\n` };
    }
    return { code: 0, output: 'ok' };
  };

  before(async () => {
    server = await startUiServer({ port: 0, pacRunner });
    token = new URL(server.launchUrl).searchParams.get('session')!;
  });
  after(async () => server.close());

  const post = (path: string, body: unknown) =>
    call(server.port, path, { method: 'POST', headers: { 'X-DV-Session': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const get = (path: string) => call(server.port, path, { headers: { 'X-DV-Session': token } });

  it('requires the session token for studio endpoints too', async () => {
    assert.equal((await call(server.port, '/api/studio/meta')).status, 401);
    assert.equal((await call(server.port, '/api/studio/environments')).status, 401);
  });

  it('serves meta and checks specs offline', async () => {
    const meta = JSON.parse((await get('/api/studio/meta')).body) as { examples: string[]; parameterTypes: string[] };
    assert.deepEqual(meta.examples, ['instant.plugin.json', 'automated.plugin.json']);
    assert.ok(meta.parameterTypes.includes('Decimal'));
    const spec = await readFile(examplePath('instant.plugin.json'), 'utf8');
    assert.equal((JSON.parse((await post('/api/studio/check', { spec })).body) as { ok: boolean }).ok, true);
    const broken = JSON.parse((await post('/api/studio/check', { spec: spec.replace('Amount * Rate }', 'Amount * Rate') })).body) as { ok: boolean };
    assert.equal(broken.ok, false);
  });

  it('lists profiles and environments through pac', async () => {
    const envs = JSON.parse((await get('/api/studio/environments')).body) as { environments: { url: string; type: string }[] };
    assert.deepEqual(envs.environments.map((e) => [e.url, e.type]), [[ENV_URL, 'Sandbox']]);
    const profiles = JSON.parse((await get('/api/studio/profiles')).body) as { profiles: { user: string }[] };
    assert.equal(profiles.profiles[0]?.user, 'maker@contoso.com');
  });

  it('deploys only with an exactly confirmed environment URL', async () => {
    const spec = await readFile(examplePath('instant.plugin.json'), 'utf8');
    pacCalls.length = 0;
    assert.equal((await post('/api/studio/deploy', { spec, environmentUrl: ENV_URL, confirmEnvironmentUrl: 'https://other.crm.dynamics.com/' })).status, 400);
    assert.equal((await post('/api/studio/deploy', { spec, environmentUrl: ENV_URL })).status, 400);
    assert.equal(pacCalls.length, 0);
    const result = JSON.parse((await post('/api/studio/deploy', { spec, environmentUrl: ENV_URL, confirmEnvironmentUrl: ENV_URL })).body) as { status: string };
    assert.equal(result.status, 'succeeded');
    assert.ok(pacCalls.some((c) => c[0] === 'solution' && c[1] === 'import'));
  });
});
