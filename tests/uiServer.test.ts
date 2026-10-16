import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { startUiServer, type UiServer } from '../src/ui/server.js';
import { ENV_URL, examplePath, fakeAuth, fakeBrowser, fakeDataverse, fakePlatform } from './helpers.js';

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

describe('local UI server (fake sign-in and Dataverse)', () => {
  let server: UiServer;
  let token: string;
  const platform = fakePlatform();
  const browser = fakeBrowser();

  before(async () => {
    const auth = fakeAuth(platform.fetch, browser.openUrl);
    server = await startUiServer({ port: 0, auth, dataverse: fakeDataverse(platform.fetch, auth) });
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

  it('signs in through the browser, then lists environments with their type', async () => {
    const signedOut = JSON.parse((await get('/api/studio/environments')).body) as { environments: unknown[]; signInRequired: boolean };
    assert.deepEqual(signedOut.environments, []);
    assert.equal(signedOut.signInRequired, true);
    assert.equal((await post('/api/studio/login', { selectAccount: 'yes' })).status, 400);
    const started = JSON.parse((await post('/api/studio/login', {})).body) as { state: string; authorizeUrl: string };
    assert.ok(['pending', 'signed-in'].includes(started.state));
    assert.equal(browser.opened.length, 1);
    let session = { state: '' } as { state: string; active?: { id: string; username: string } };
    for (let i = 0; i < 50 && session.state !== 'signed-in'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      session = JSON.parse((await get('/api/studio/session')).body) as typeof session;
    }
    assert.equal(session.active?.username, 'maker@contoso.com');
    assert.ok(!/token-for|refresh-/.test(JSON.stringify(session)), 'tokens never reach the page');
    const envs = JSON.parse((await get('/api/studio/environments')).body) as { environments: { url: string; type: string }[] };
    assert.deepEqual(envs.environments.map((e) => [e.url, e.type]), [
      ['https://orgdefault.crm.dynamics.com/', 'Default'],
      [ENV_URL, 'Sandbox'],
      ['https://contoso.crm.dynamics.com/', 'Production'],
    ]);
  });

  it('deploys in the background, only with an exactly confirmed environment URL', async () => {
    const spec = await readFile(examplePath('instant.plugin.json'), 'utf8');
    assert.equal((await post('/api/studio/deploy', { spec, environmentUrl: ENV_URL, confirmEnvironmentUrl: 'https://other.crm.dynamics.com/' })).status, 400);
    assert.equal((await post('/api/studio/deploy', { spec, environmentUrl: ENV_URL })).status, 400);
    assert.ok(!platform.calls.some((c) => c.method === 'POST' && c.url.includes('/api/data/')));
    const started = await post('/api/studio/deploy', { spec, environmentUrl: ENV_URL, confirmEnvironmentUrl: ENV_URL });
    assert.equal(started.status, 202);
    let job = { running: true } as { running: boolean; result?: { status: string; solutionUrl?: string } };
    for (let i = 0; i < 100 && job.running; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      job = JSON.parse((await get('/api/studio/deploy')).body) as typeof job;
    }
    assert.equal(job.result?.status, 'succeeded', JSON.stringify(job));
    assert.match(job.result?.solutionUrl ?? '', /^https:\/\/make\.powerapps\.com\/environments\//);
    assert.ok(platform.calls.some((c) => c.url.endsWith('/ImportSolutionAsync')));
  });

  it('selects and forgets profiles', async () => {
    const session = JSON.parse((await get('/api/studio/session')).body) as { active: { id: string } };
    assert.equal((await post('/api/studio/profiles/select', { id: 'unknown.profile' })).status, 404);
    assert.equal((await post('/api/studio/profiles/select', { id: session.active.id })).status, 200);
    const removed = JSON.parse((await post('/api/studio/profiles/remove', { id: session.active.id })).body) as { state: string; profiles: unknown[] };
    assert.equal(removed.state, 'signed-out');
    assert.deepEqual(removed.profiles, []);
    assert.equal((JSON.parse((await get('/api/studio/environments')).body) as { signInRequired: boolean }).signInRequired, true);
  });
});
