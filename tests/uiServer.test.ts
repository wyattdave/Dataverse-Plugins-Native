import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { startUiServer, type UiServer } from '../src/ui/server.js';
import type { PacRunner } from '../src/studio/pac.js';
import { examplePath } from './helpers.js';

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

describe('local UI server (fake pac)', () => {
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

  const get = (path: string, headers: Record<string, string> = {}) => call(server.port, path, { headers: { 'X-DV-Session': token, ...headers } });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    call(server.port, path, {
      method: 'POST',
      headers: { 'X-DV-Session': token, 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

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
    for (const path of ['/../package.json', '/%2e%2e/package.json', '/examples/instant.plugin.json', '/src/ui/server.ts', '/ui/app.js']) {
      assert.equal((await call(server.port, path)).status, 404, path);
    }
  });

  it('rejects foreign Host headers, cross-origin calls and missing tokens', async () => {
    assert.equal((await get('/api/studio/meta', { Host: `evil.example.com:${server.port}` })).status, 421);
    assert.equal((await get('/api/studio/meta', { Origin: 'https://evil.example.com' })).status, 403);
    assert.equal((await call(server.port, '/api/studio/meta')).status, 401);
    assert.equal((await call(server.port, '/api/studio/environments', { headers: { 'X-DV-Session': '0'.repeat(64) } })).status, 401);
    assert.equal((await get('/api/studio/meta', { Origin: server.origin })).status, 200);
  });

  it('serves examples from a fixed allowlist only', async () => {
    const ok = JSON.parse((await get('/api/examples/instant.plugin.json')).body) as { content: string };
    assert.equal(ok.content, await readFile(examplePath('instant.plugin.json'), 'utf8'));
    for (const name of ['..%2Fpackage.json', 'instant.plugin.json%00', 'package.json']) {
      assert.equal((await get(`/api/examples/${name}`)).status, 404, name);
    }
  });

  it('rejects malformed, unexpected and oversized requests', async () => {
    assert.equal((await post('/api/studio/check', '{}', { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await post('/api/studio/check', '{"spec":"a","spec":"b"}')).status, 400);
    assert.equal((await post('/api/studio/check', { spec: '{}', extra: true })).status, 400);
    assert.equal((await post('/api/studio/check', '', { 'Content-Length': String(100 * 1024 * 1024) })).status, 413);
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
